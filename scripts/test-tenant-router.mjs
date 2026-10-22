import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createSqliteState } from '../src/sqlite-state.js';
import { createConsoleAuth } from '../src/console-auth.js';
import { createTenantService } from '../src/tenant-service.js';
import { createTenantRouter } from '../src/tenant-router.js';
import { createBotManager } from '../src/bot-manager.js';
import { createBotOnboarding } from '../src/bot-onboarding.js';

const apiKey = 'sk-' + 'a'.repeat(32), visitorKey = 'sk-' + 'b'.repeat(32), machineToken = 'fixture-worker-token-1234567890', password = 'tenant-router-fixture-password';
let passed = 0;
async function test(name, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tenant-router-')); fs.mkdirSync(path.join(root, 'state'));
  const s = createSqliteState({ root, file: path.join(root, 'state/manager.sqlite') });
  const auth = createConsoleAuth({ storage: s, file: path.join(root, 'state/console-auth.json') });
  const initial = await auth.bootstrap({ password }, 'fixture'), admin = auth.authenticate('qq_console_session=' + initial.token);
  const alice = await auth.create(admin, { username: 'alice', password }), bob = await auth.create(admin, { username: 'bob', password });
  const cookies = { admin: 'qq_console_session=' + initial.token };
  for (const username of ['alice', 'bob']) cookies[username] = 'qq_console_session=' + (await auth.login({ username, password }, 'fixture')).token;
  const service = createTenantService({ storage: s, file: path.join(root, 'state/tenants.json'), masterKeyFile: path.join(root, 'state/tenant-key') });
  const registry = path.join(root, 'state/bot-registry.json'); let failIdentity = false, failAfterClaim = false, identityCalls = 0, duringVerify = null, budgetCalls = 0;
  const manager = createBotManager({ read: () => { try { return s.readText(registry); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    write: data => { let old; try { old = s.readText(registry); } catch (e) { if (e.code !== 'ENOENT') throw e; old = null; } s.writeText(registry, JSON.stringify(data), old); },
    primary: { port: 3100, actualQQ: '100' }, fetchImpl: async (target, options) => {
      const url = new URL(target); assert.equal(url.hostname, '127.0.0.1');
      if (url.pathname === '/api/instance/peers') return new Response('{"ok":true}');
      assert.equal(url.pathname, '/api/instance'); identityCalls++;
      if (duringVerify) { const work = duringVerify; duringVerify = null; await work(); }
      const raw = JSON.parse(s.readText(registry)), row = Object.values(raw.bots).find(row => row.port === Number(url.port));
      const invalid = failIdentity || failAfterClaim && identityCalls >= 3;
      return new Response(JSON.stringify({ ok: true, botId: row.id, expectedQQ: row.expectedQQ, actualQQ: invalid ? '999999' : row.expectedQQ, qqOnline: true, dshReady: true }));
    } });
  const onboarding=createBotOnboarding({storage:s,file:path.join(root,'state/bot-onboarding.json'),service,auth,manager});
  const router = createTenantRouter({ service, auth, manager, onboarding, platformBot: () => ({ id: 'primary', qq: '100' }),
    readUsage: () => ({ spentCny: 0.01, configVersion: 1, apiKey: 'fixture-never-return' }),
    updateBudget: (principal, body) => { budgetCalls++; assert.equal(body.dailyLimitCny, 2); return { configVersion: 2, dailyLimitCny: 2 }; } });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const sendJson = (value, code = 200) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const readBody = async () => { let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 16384) throw Object.assign(new Error('body too large'), { statusCode: 413 }); } return JSON.parse(text || '{}'); };
    try {
      if (await router.routeInternal({ req, url, readBody, sendJson })) return;
      const principal = auth.authenticate(req.headers.cookie) ?? (req.headers['x-console-token'] === 'platform-machine-token' ? { kind: 'token', role: 'admin' } : null);
      const writeAllowed = () => { if (req.headers.origin !== 'http://127.0.0.1:' + server.address().port) throw Object.assign(new Error('来源校验失败'), { statusCode: 403 }); };
      if (await router.route({ req, url, principal, readBody, sendJson, writeAllowed })) return;
      sendJson({ ok: false, error: 'not found' }, 404);
    } catch (e) { sendJson({ ok: false, error: e.message }, e.statusCode || 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  const request = async (suffix, { user = 'alice', body, headers = {}, method = body === undefined ? 'GET' : 'POST', rawPath, internal = false } = {}) => {
    const response = await fetch(origin + (rawPath || '/api/tenant/' + suffix), { method, headers: { ...(user ? { cookie: cookies[user] } : {}), ...(body === undefined ? {} : { ...(internal ? {} : { origin }), 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); return { status: response.status, data: JSON.parse(text), text };
  };
  const save = async (user = 'alice', suppliedKey = apiKey) => { const r = await request('profiles/save', { user, body: { name: '自己的模型', model: 'deepseek-flash', apiKey: suppliedKey, version: 0 } }); assert.equal(r.status, 200); return r.data.profile; };
  const bind = (principal, value) => { const issued = service.issueBinding(principal, { qq: value }); service.consumeBinding({ qq: value, code: issued.code }); };
  const register = async (profileId, extra = {}) => {
    if(!service.getBindingByUser(alice.id))bind(alice,'111');
    const applied=await request('bot-requests',{body:{name:'自有QQ',botQQ:'444',profileId,...extra}});if(applied.status!==200)return applied;
    manager.add({id:'alice-bot',name:'自有QQ',expectedQQ:'444',port:3210,machineToken});
    const prepared=await request('bot-requests/prepare',{user:'admin',body:{id:applied.data.request.id,version:applied.data.request.version,botId:'alice-bot'}});if(prepared.status!==200)return prepared;
    return request('bot-requests/activate',{user:'admin',body:{id:prepared.data.request.id,version:prepared.data.request.version}});
  };
  try { await run({ root, s, service, auth, manager, request, save, bind, register, admin, alice, bob, cookies,
    budgetCalls: () => budgetCalls, failIdentity: () => { failIdentity = true; }, failAfterClaim: () => { failAfterClaim = true; }, duringVerify: work => { duringVerify = work; } });
    passed++; console.log('PASS', name); }
  finally { await new Promise(resolve => server.close(resolve)); server.closeAllConnections(); s.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

await test('tenant HTTP requires account sessions, rejects machine and agent channels and validates write origin', async ({ request }) => {
  assert.equal((await request('overview', { user: null })).status, 401);
  assert.equal((await request('overview', { user: null, headers: { 'x-console-token': 'platform-machine-token' } })).status, 403);
  assert.equal((await request('overview', { headers: { 'x-agent-call': '1' } })).status, 403);
  assert.equal((await request('profiles/save', { body: {}, headers: { origin: 'https://evil.test' } })).status, 403);
  assert.equal((await request('profiles/save')).status, 405); assert.equal((await request('unknown', { body: {} })).status, 404);
});

await test('profile and overview browser responses hide all credentials and cross-user profiles', async ({ request, save }) => {
  const p = await save(); assert.equal(p.configured, true);
  const own = await request('overview'); assert.equal(own.status, 200); assert.equal(own.data.overview.platformBot.qq, '100'); assert.equal(own.data.overview.usage.spentCny, 0.01);
  assert.equal(own.text.includes(apiKey), false); assert.equal(own.text.includes('fixture-never-return'), false); assert.equal(own.text.includes('ciphertext'), false);
  assert.equal((await request('overview', { user: 'bob' })).data.overview.profiles.length, 0);
  assert.equal((await request('profiles/delete', { user: 'bob', body: { id: p.id, version: 1 } })).status, 404);
});

await test('binding issue is browser-only and consume is never a public HTTP action', async ({ request, service, alice }) => {
  const issued = await request('binding/issue', { body: { qq: '111' } }); assert.equal(issued.status, 200); assert.ok(issued.data.binding.code);
  assert.equal((await request('binding/consume', { body: { qq: '111', code: issued.data.binding.code } })).status, 404);
  assert.equal(service.getBindingByUser(alice.id), null); service.consumeBinding({ qq: '111', code: issued.data.binding.code });
  assert.equal((await request('overview')).data.overview.qqBinding.qq, '111');
});

await test('private budget changes require verified self BYOK and cannot target injected conversations', async ({ request, save, bind, alice, budgetCalls }) => {
  assert.equal((await request('budget', { body: { version: 1, dailyLimitCny: 2 } })).status, 403); assert.equal(budgetCalls(), 0);
  bind(alice, '111'); assert.equal((await request('budget', { body: { version: 1, dailyLimitCny: 2 } })).status, 403);
  const p = await save(); assert.equal((await request('funding', { body: { botId: 'primary', key: 'private:111', profileId: p.id, version: 0 } })).status, 200);
  assert.equal((await request('budget', { body: { version: 1, dailyLimitCny: 2, key: 'private:222' } })).status, 400);
  const changed = await request('budget', { body: { version: 1, dailyLimitCny: 2 } }); assert.equal(changed.status, 200); assert.equal(budgetCalls(), 1);
});

await test('platform trial allowance remains platform-admin only with version conflicts', async ({ request }) => {
  assert.equal((await request('trial', { body: { version: 1, dailyLimitCny: 100 } })).status, 403);
  assert.equal((await request('trial', { user: 'admin', body: { version: 1, dailyLimitCny: 0.2, totalDailyLimitCny: 1 } })).status, 200);
  assert.equal((await request('trial', { user: 'admin', body: { version: 1, dailyLimitCny: 0.3 } })).status, 409);
});

await test('owned bot registration verifies before claim/funding/enable and never echoes machine credentials', async ({ save, register, service, alice, manager, request }) => {
  const p = await save(), result = await register(p.id); assert.equal(result.status, 200); assert.equal(result.text.includes(machineToken), false); assert.equal(result.text.includes(apiKey), false);
  assert.equal(manager.authenticateWorker('alice-bot', machineToken), true); assert.equal(service.ownsBot(alice, 'alice-bot'), true);
  assert.equal(service.getFunding({ botId: 'alice-bot', key: 'group:1' }).apiKey, apiKey);
  const overview = await request('overview'); assert.equal(overview.data.overview.ownedBots[0].profileId, p.id);
});

await test('identity failure keeps the admin-prepared worker disabled and grants no ownership or funding', async ({ save, register, failIdentity, manager, service, alice, s, root }) => {
  const p = await save(); failIdentity(); const result = await register(p.id); assert.equal(result.status, 502);
  assert.equal(manager.list().some(row => row.id === 'alice-bot'), true); assert.equal(manager.authenticateWorker('alice-bot', machineToken), false); assert.equal(service.ownsBot(alice, 'alice-bot'), false);
  const row = JSON.parse(s.readText(path.join(root, 'state/bot-registry.json'))).bots['alice-bot']; assert.equal(row.deleted, false); assert.equal(row.enabled, false);
});

await test('failure after claim compensates tenant ownership and funding while keeping token tombstone', async ({ save, register, failAfterClaim, service, alice, manager, s }) => {
  const p = await save(); failAfterClaim(); const result = await register(p.id); assert.equal(result.status, 502);
  assert.equal(service.ownsBot(alice, 'alice-bot'), false); assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM tenant_funding').get().n, 0);
  assert.equal(manager.authenticateWorker('alice-bot', machineToken), false); assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM tenant_profiles').get().n, 1);
});

await test('account disabled during asynchronous bot verification cannot complete ownership claim', async ({ save, register, duringVerify, auth, admin, alice, manager }) => {
  const p = await save(); duringVerify(() => auth.update(admin, { id: alice.id, disabled: true }));
  const result = await register(p.id); assert.equal(result.status, 403); assert.equal(manager.authenticateWorker('alice-bot', machineToken), false);
});

await test('delegations resolve one exact username only after ownership authorization and retain stable account IDs', async ({ save, register, request, bob }) => {
  const p = await save(); await register(p.id);
  assert.equal((await request('delegations', { user: 'bob', body: { botId: 'alice-bot', username: 'alice', keys: ['group:1'], version: 0 } })).status, 403);
  assert.equal((await request('delegations', { body: { botId: 'alice-bot', username: 'bo', keys: ['group:1'], version: 0 } })).status, 400);
  assert.equal((await request('delegations', { body: { botId: 'alice-bot', username: 'nobody', keys: ['group:1'], version: 0 } })).status, 404);
  const granted = await request('delegations', { body: { botId: 'alice-bot', username: 'BOB', keys: ['group:1'], version: 0 } });
  assert.equal(granted.status, 200); assert.equal(granted.data.delegation.userId, bob.id); assert.equal(granted.data.delegation.username, 'bob');
  const rows = (await request('overview')).data.overview.delegations; assert.equal(rows[0].username, 'bob');
  assert.equal((await request('delegations', { body: { botId: 'alice-bot', username: 'bob', keys: [], version: 0 } })).status, 409);
});

await test('internal worker funding is bound to active worker token and returns only owner profile', async ({ save, register, request, bind, bob, service }) => {
  const p = await save(); await register(p.id); bind(bob, '222'); const other = await save('bob', visitorKey);
  service.setFunding(bob, { botId: 'primary', key: 'private:222', profileId: other.id, version: 0 });
  const body = { action: 'funding', botId: 'alice-bot', key: 'private:222' };
  const call = (extra = {}) => request('', { user: null, internal: true, rawPath: '/api/internal/tenant', body, headers: { 'x-console-token': machineToken }, ...extra });
  const result = await call(); assert.equal(result.status, 200); assert.equal(result.data.funding.apiKey, apiKey); assert.equal(result.text.includes(visitorKey), false);
  for (const change of [{ body: { ...body, botId: 'primary' } }, { body: { ...body, botId: 'other-bot' } }, { headers: { 'x-console-token': 'wrong' } },
    { user: 'alice' }, { headers: { 'x-console-token': machineToken, 'x-agent-call': '1' } }, { headers: { 'x-console-token': machineToken, origin: 'http://example.test' } },
    { headers: { 'x-console-token': machineToken, 'sec-fetch-site': 'same-origin' } }, { rawPath: '/api/internal/tenant?token=' + machineToken }]) assert.equal((await call(change)).status, 403);
  assert.equal((await call({ body: { ...body, action: 'consumeBinding' } })).status, 400);
});

await test('foreign profile or arbitrary connection fields cannot start bot registration', async ({ save, register, request, manager }) => {
  const p = await save('bob', visitorKey); assert.equal((await register(p.id)).status, 400); assert.equal(manager.list().length, 1);
  const own = await save(); assert.equal((await register(own.id, { baseURL: 'https://evil.test' })).status, 400); assert.equal(manager.list().length, 1);
});

await test('ordinary accounts cannot submit machine credentials while platform-admin internal setup remains available',async({request,save,manager})=>{
 const profile=await save('admin');const body={id:'admin-bot',name:'admin prepared',expectedQQ:'444',port:3210,machineToken,profileId:profile.id};
 assert.equal((await request('bots',{body})).status,403);assert.equal(manager.list().length,1);
 const result=await request('bots',{user:'admin',body});assert.equal(result.status,200);assert.equal(result.text.includes(machineToken),false);
});

console.log(`Tenant router HTTP: ${passed} tests passed`);
