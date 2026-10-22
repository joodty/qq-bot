import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTenantChat, TENANT_CHAT_ENDPOINT } from '../src/tenant-chat.js';
import { createSqliteState } from '../src/sqlite-state.js';

let passed = 0;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (answer = 'fixture answer') => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 20, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 15, completion_tokens: 6 } }) });
async function test(name, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tenant-chat-'));
  fs.mkdirSync(path.join(root, 'state'));
  const storage = createSqliteState({ root, file: path.join(root, 'state/test.sqlite') });
  const state = { mode: 'byok', ownerUserId: 'owner-a', profileId: 'profile-a', credentialVersion: 1, apiKey: 'fixture-secret-do-not-print', endpoint: 'https://api.deepseek.com', model: 'deepseek-flash' };
  const persona = { id: 'persona-a', content: 'You are fixture A' }, requests = [], sent = [], usage = [], settled = [];
  let clock = 1_792_641_600_000;
  const file = path.join(root, 'state/tenant-chat.json');
  const options = { storage, file, resolveFunding: async () => ({ ...state }), getPersona: async () => ({ ...persona }),
    admit: async () => ({ allowed: true, id: 'hold' }), settle: async (...args) => settled.push(args), onUsage: async data => usage.push(data),
    fetchImpl: async (url, init) => { requests.push({ url, init, body: JSON.parse(init.body) }); return response(); }, sendMessage: async (context, text) => sent.push({ context, text }), now: () => clock };
  const make = extras => createTenantChat({ ...options, ...extras });
  const input = (text = 'hello', extras = {}) => ({ botId: 'primary', key: 'private:456', text, ...extras });
  try { await run({ state, persona, requests, sent, usage, settled, options, make, input, storage, file, advance: ms => { clock += ms; } }); passed++; console.log('PASS', name); }
  finally { storage.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
await test('fixed official request and cache usage, secrets stay outside history and public result', async f => {
  const result = await f.make().chat(f.input()); assert.equal(result.ok, true);
  assert.equal(f.requests[0].url, TENANT_CHAT_ENDPOINT); assert.equal(f.requests[0].init.redirect, 'error');
  assert.equal(f.requests[0].body.max_tokens, 1024); assert.equal(f.requests[0].body.thinking.type, 'disabled'); assert.equal('tools' in f.requests[0].body, false);
  assert.equal(f.usage[0].usage.cacheReadTokens, 5); assert.equal(f.usage[0].usage.inputTokens, 15);
  assert.ok(!JSON.stringify([result, f.sent, f.usage, f.settled, f.storage.readText(f.file)]).includes(f.state.apiKey));
});
await test('A to B to A restores its own persona history while profile bot and owner remain isolated', async f => {
  const engine = f.make(); await engine.chat(f.input('A first'));
  f.persona.id = 'persona-b'; await engine.chat(f.input('B first')); assert.equal(f.requests.at(-1).body.messages.length, 2);
  f.persona.id = 'persona-a'; await engine.chat(f.input('A again')); assert.equal(f.requests.at(-1).body.messages[1].content, 'A first');
  f.state.profileId = 'profile-b'; await engine.chat(f.input()); assert.equal(f.requests.at(-1).body.messages.length, 2);
  f.state.profileId = 'profile-a'; await engine.chat(f.input('new bot', { botId: 'bot-b' })); assert.equal(f.requests.at(-1).body.messages.length, 2);
  f.state.ownerUserId = 'owner-b'; await engine.chat(f.input()); assert.equal(f.requests.at(-1).body.messages.length, 2);
});
await test('degraded has real 256 token cap and 60 second cooldown for private and group', async f => {
  const engine = f.make({ admit: async () => ({ allowed: true, id: 'hold', state: 'degraded' }) });
  await engine.chat(f.input()); assert.equal(f.requests[0].body.max_tokens, 256);
  assert.equal((await engine.chat(f.input())).error.code, 'BUDGET');
  f.advance(60_000); assert.equal((await engine.chat(f.input())).ok, true);
  assert.equal((await engine.chat(f.input('group', { key: 'group:456' }))).ok, true);
});
await test('explicit trial/platform delegate but unknown blocked profile and SSRF endpoint never fall back', async f => {
  for (const mode of ['trial', 'platform']) { f.state.mode = mode; assert.equal((await f.make().chat(f.input())).handled, false); }
  for (const funding of [null, { ...f.state, mode: 'blocked' }, { ...f.state, mode: 'byok', endpoint: 'http://127.0.0.1' }, { ...f.state, mode: 'byok', model: 'unknown' }]) {
    const result = await f.make({ resolveFunding: async () => funding }).chat(f.input()); assert.equal(result.handled, true); assert.equal(result.ok, false);
  }
  assert.equal(f.requests.length, 0);
});
await test('provider auth balance timeout and raw secret errors are safe and never fall back', async f => {
  for (const [status, code] of [[401, 'AUTH'], [402, 'BALANCE'], [500, 'PROVIDER']]) {
    const result = await f.make({ fetchImpl: async () => ({ ok: false, status }) }).chat(f.input()); assert.equal(result.error.code, code); assert.equal(result.handled, true);
  }
  const result = await f.make({ timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) }).chat(f.input()); assert.equal(result.error.code, 'TIMEOUT');
  const secret = await f.make({ fetchImpl: async () => { throw new Error(f.state.apiKey); } }).chat(f.input()); assert.ok(!JSON.stringify(secret).includes(f.state.apiKey));
  assert.equal(f.sent.length, 0);
});
await test('in flight funding and persona changes charge usage but prevent saving or sending wrong reply', async f => {
  for (const mutate of [() => f.state.credentialVersion++, () => { f.persona.id = 'different'; }]) {
    const engine = f.make({ fetchImpl: async () => { mutate(); return response(); } });
    const result = await engine.chat(f.input()); assert.equal(result.error.code, 'STALE');
  }
  assert.equal(f.sent.length, 0); assert.equal(f.usage.length, 2); assert.throws(() => f.storage.readText(f.file), error => error.code === 'ENOENT');
});
await test('root target guard prevents sending after target retirement', async f => {
  let valid = true;
  const engine = f.make({ fetchImpl: async () => { valid = false; return response(); } });
  const result = await engine.chat(f.input('test', { guard: () => valid })); assert.equal(result.error.code, 'STALE'); assert.equal(f.sent.length, 0);
});
await test('send callback receives an async guard that revalidates funding at the actual outbound boundary',async f=>{
  let sent=false;
  const engine=f.make({sendMessage:async(_context,_text,current)=>{assert.equal(typeof current,'function');f.state.credentialVersion++;await current();sent=true;}});
  const result=await engine.chat(f.input());assert.equal(result.error.code,'STALE');assert.equal(sent,false);
});
await test('same conversation serializes while global tenant limits reject excess concurrent work', async f => {
  const gate = deferred(), started = deferred(); let count = 0;
  const engine = f.make({ maxTenantConcurrent: 1, fetchImpl: async (...args) => { count++; if (count === 1) { started.resolve(); await gate.promise; } return response(); } });
  const first = engine.chat(f.input('first')); await started.promise;
  const second = engine.chat(f.input('second'));
  const other = await engine.chat(f.input('other', { key: 'private:789' })); assert.equal(other.error.code, 'BUSY'); assert.equal(count, 1);
  gate.resolve(); await first; await second; assert.equal(count, 2);
});
await test('history persists through restart and caps at 20 messages', async f => {
  for (let n = 0; n < 13; n++) assert.equal((await f.make().chat(f.input('turn ' + n))).ok, true);
  const archive = JSON.parse(f.storage.readText(f.file)); assert.equal(archive.archives[0].messages.length, 20);
  await f.make().chat(f.input('restart')); assert.equal(f.requests.at(-1).body.messages[1].content, 'turn 3');
});
await test('future or corrupt archive is preserved byte for byte with no paid request', async f => {
  for (const raw of ['{broken', '{"version":9,"archives":[]}']) {
    let writes = 0;
    const storage = { transaction: run => run(), readText: () => raw, writeText: () => { writes++; } };
    const result = await f.make({ storage }).chat(f.input()); assert.equal(result.error.code, 'STORAGE'); assert.equal(storage.readText(), raw); assert.equal(writes, 0);
  }
  assert.equal(f.requests.length, 0);
});
console.log(JSON.stringify({ passed, liveProviderRequests: 0, liveQqMessages: 0 }));
