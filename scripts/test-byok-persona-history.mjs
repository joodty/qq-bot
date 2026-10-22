// The real Bridge's first BYOK request must establish a durable persona identity.
// One local primary instance, fake QQ and provider only; no DSH conversation is created.
import assert from 'node:assert/strict';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const userQQ = '999777', password = 'Fixture_10', key = 'private:' + userQQ;
const apiKey = 'sk-' + 'a'.repeat(32), requests = [];
let passed = 0, messageId = 100;
const h = await bridgeHarness({ config: { storage: { driver: 'sqlite' }, botId: 'primary', expectedQQ: '111',
  consoleToken: 'fixture-byok-history-token', ownerQQ: '123456789', allow: { groups: [], private: [] } },
  files: { 'roles/A.md': '# A\nPERSONA_A_HISTORY', 'roles/B.md': '# B\nPERSONA_B_HISTORY',
    'state/current-role.json': { role: 'A', mode: 'active' } },
  globals: { fetch: async (target, init = {}) => {
    const url = new URL(String(target));
    if (url.href === 'https://api.deepseek.com/chat/completions') {
      const body = JSON.parse(init.body); requests.push(body);
      const answers = { TEXT_A_1: 'REPLY_A_1', TEXT_B_1: 'REPLY_B_1', TEXT_A_2: 'REPLY_A_2' };
      const answer = answers[body.messages.at(-1).content]; assert.ok(answer, 'provider receives the expected local fixture message');
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80 } }), { status: 200 });
    }
    if (url.pathname.endsWith('/get_login_info')) return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: '111', nickname: 'fixture' } }));
    throw new Error('External network forbidden by BYOK persona fixture: ' + url.origin);
  } } });
h.setMode('reserved2'); await h.verifyIdentity();
const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
async function request(route, body, { cookie, machine = false } = {}) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(machine ? { 'x-console-token': 'fixture-byok-history-token' } : {}), ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); assert.equal(response.status, 200, route + ': ' + JSON.stringify(data));
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function incoming(text) {
  await h.handleIncoming('private', userQQ, { self_id: 111, user_id: Number(userQQ), message_id: ++messageId,
    sender: { user_id: Number(userQQ), nickname: 'fixture person' }, raw_message: text, message: [{ type: 'text', data: { text } }] }, h.cfg);
}
async function test(name, run) { await run(); passed++; console.log('PASS', name); }
const archives = () => JSON.parse(h.getStorage().readText(path.join(h.temp, 'state/byok-conversations.json'))).archives;
let cookie, personaA, personaB;
try {
  await test('a newly verified QQ chooses BYOK while global A has never created any DSH session', async () => {
    const admin = (await request('/api/auth/bootstrap', { password }, { machine: true })).cookie;
    await request('/api/auth/users', { username: 'fresh-user', password, conversationKeys: [] }, { cookie: admin });
    cookie = (await request('/api/auth/login', { username: 'fresh-user', password })).cookie;
    const challenge = (await request('/api/tenant/binding/issue', { qq: userQQ }, { cookie })).data.binding;
    await incoming('/bind ' + challenge.code);
    const p = (await request('/api/tenant/profiles/save', { name: 'fixture', model: 'deepseek-flash', apiKey, version: 0 }, { cookie })).data.profile;
    await request('/api/tenant/funding', { botId: 'primary', key, profileId: p.id, version: 0 }, { cookie });
    assert.equal(h.state.sessions[key], undefined); assert.equal(h.calls.created.length, 0); assert.equal(requests.length, 0);
  });
  await test('first global-A BYOK chat persists its stable persona ID before any persona switch', async () => {
    await incoming('TEXT_A_1'); assert.equal(requests.length, 1);
    assert.match(requests[0].messages[0].content, /PERSONA_A_HISTORY/);
    assert.deepEqual(requests[0].messages.slice(1), [{ role: 'user', content: 'TEXT_A_1' }]);
    const record = archives().find(row => row.key === key); personaA = record.personaId;
    assert.match(personaA, /^p_[a-f0-9]{32}$/);
    assert.equal(h.getStorage().db.prepare('SELECT name FROM persona_identities WHERE bot_id=? AND id=?').get('primary', personaA).name, 'A');
    assert.equal(h.calls.created.length, 0);
  });
  await test('switching to template B starts an independent BYOK history and prompt', async () => {
    await request('/api/member/personas/apply', { key, templateName: 'B' }, { cookie }); await incoming('TEXT_B_1');
    assert.equal(requests.length, 2); assert.match(requests[1].messages[0].content, /PERSONA_B_HISTORY/);
    assert.deepEqual(requests[1].messages.slice(1), [{ role: 'user', content: 'TEXT_B_1' }]);
    personaB = archives().find(row => row.messages.some(message => message.content === 'TEXT_B_1')).personaId;
    assert.notEqual(personaB, personaA);
  });
  await test('returning to global A restores its first BYOK exchange without leaking B history', async () => {
    await request('/api/member/personas/apply', { key, inherit: true }, { cookie }); await incoming('TEXT_A_2');
    assert.equal(requests.length, 3); assert.match(requests[2].messages[0].content, /PERSONA_A_HISTORY/);
    assert.deepEqual(requests[2].messages.slice(1), [
      { role: 'user', content: 'TEXT_A_1' }, { role: 'assistant', content: 'REPLY_A_1' }, { role: 'user', content: 'TEXT_A_2' },
    ]);
    assert.equal(JSON.stringify(requests[2]).includes('TEXT_B_1'), false);
    const all = archives().filter(row => row.key === key); assert.equal(all.length, 2);
    assert.equal(all.find(row => row.personaId === personaA).messages.length, 4); assert.equal(all.find(row => row.personaId === personaB).messages.length, 2);
    assert.equal(h.calls.created.length, 0); assert.equal(h.calls.prompts.length, 0); assert.equal(h.state.sessions[key], undefined);
    assert.equal(h.getBudget().status(key).reservedCny, 0); assert.ok(h.getBudget().status(key).spentCny > 0);
    assert.equal(JSON.stringify(all).includes(apiKey), false);
  });
  console.log(JSON.stringify({ passed, providerStubCalls: requests.length, dshSessionsCreated: h.calls.created.length, realQQMessages: 0, paidCalls: 0 }));
} finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
