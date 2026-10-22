import assert from 'node:assert/strict';
import path from 'node:path';
import { createEngineHandoff, normalizeEngineHandoff } from '../src/engine-handoff.js';
import { createConsoleAuth } from '../src/console-auth.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let count = 0;
const check = async (name, run) => { await run(); count++; console.log('PASS', name); };
const disabled = error => error.code === 'ENGINE_HANDOFF_MANAGEMENT_ONLY' && error.statusCode === 503;
await check('handoff requires a strict explicit configuration and defaults to legacy behavior', () => {
  assert.equal(normalizeEngineHandoff().managementOnly, false);
  for (const value of [null, true, {}, { managementOnly: 'true' }, { managementOnly: true, unknown: true }]) {
    assert.throws(() => normalizeEngineHandoff(value));
  }
  const legacy = createEngineHandoff({});
  legacy.assertChatEnabled(); legacy.assertSendAllowed('group:456');
  assert.equal(legacy.requestAllowed({ method: 'POST', pathname: '/api/send/group' }), true);
});
await check('one policy stops every AI route while retaining accounts, read-only data and ownership verification', () => {
  const handoff = createEngineHandoff({ engineHandoff: { managementOnly: true } });
  assert.throws(() => handoff.assertChatEnabled(), disabled);
  assert.throws(() => handoff.assertSendAllowed('private:123'), disabled);
  assert.throws(() => handoff.assertSendAllowed('group:456', { verification: true }), disabled);
  handoff.assertSendAllowed('private:123', { verification: true });
  for (const pathname of ['/api/send/group', '/api/socialV2/activity', '/api/tenant/profiles/save', '/api/tenant/funding', '/api/role']) {
    assert.equal(handoff.requestAllowed({ method: 'POST', pathname }), false);
  }
  assert.equal(handoff.requestAllowed({ method: 'GET', pathname: '/api/socialV2/recent' }), true);
  assert.equal(handoff.requestAllowed({ method: 'GET', pathname: '/api/status', isAgent: true }), false);
  assert.equal(handoff.requestAllowed({ method: 'POST', pathname: '/api/auth/login' }), true);
  assert.equal(handoff.requestAllowed({ method: 'POST', pathname: '/api/tenant/binding/issue' }), true);
});
await check('only unique QQ-associated legacy session work is stopped without deleting histories', async () => {
  const handoff = createEngineHandoff({ engineHandoff: { managementOnly: true } });
  const ids = ['fixture-a', null, 'fixture-a', 'fixture-b'];
  const calls = [];
  const result = await handoff.stopLegacyWork(ids, async id => { calls.push(id); if (id === 'fixture-b') throw new Error('fixture failure'); });
  assert.deepEqual(result, { stopped: 1, failed: 1 });
  assert.deepEqual(calls, ['fixture-a', 'fixture-b']);
  assert.deepEqual(ids, ['fixture-a', null, 'fixture-a', 'fixture-b']);
});

const h = await bridgeHarness({ config: { engineHandoff: { managementOnly: true }, storage: { driver: 'sqlite' } } });
let server;
try {
  await h.verifyIdentity();
  await check('actual legacy incoming BYOK, ordinary chat, proactive and prompt queues cannot invoke any paid engine', async () => {
    let byokCalls = 0;
    h.getTenantRuntime().chat = async () => { byokCalls++; return { handled: true, ok: true }; };
    const tenant = h.getTenantService();
    const getFunding = tenant.getFunding;
    tenant.getFunding = () => ({ mode: 'byok', identity: 'fixture-own-key' });
    for (const mode of ['chat', 'reserved', 'reserved2', 'closed-agent']) {
      h.setMode(mode);
      await h.handleIncoming('private', 123, { user_id: 123, self_id: 999, message: [{ type: 'text', data: { text: 'fixture user message' } }] }, h.cfg);
      await h.handleIncoming('group', 456, { user_id: 123, self_id: 999, group_id: 456, message: [{ type: 'text', data: { text: 'fixture group message' } }] }, h.cfg);
    }
    h.setMode('reserved2');
    await h.sendWakePromptV2('group:456', 'manual');
    await assert.rejects(h.budgetedPrompt('group:456', { sessionId: 'fixture-a', content: [] }), disabled);
    await assert.rejects(h.deliverPrompt('group:456', 'fixture prompt'), disabled);
    h.setupSleepTimerV2('group:456');
    assert.equal(byokCalls, 0);
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.calls.created.length, 0);
    assert.equal(h.calls.sent.length, 0);
    tenant.getFunding = getFunding;
  });
  await check('actual outgoing legacy AI is blocked at enqueue and after a queued permission change', async () => {
    assert.throws(() => h.sendToQQ('private:123', 'fixture stale output'), disabled);
    h.cfg.engineHandoff.managementOnly = false;
    const queued = h.sendToQQ('private:123', 'fixture queued before handoff');
    h.cfg.engineHandoff.managementOnly = true;
    await queued;
    assert.equal(h.calls.sent.length, 0);
  });
  const auth = createConsoleAuth({ file: path.join(h.temp, 'state', 'console-auth.json'), storage: h.getStorage() });
  const login = await auth.bootstrap({ password: 'fixture-password-for-testing' }, 'fixture');
  const cookie = auth.cookie(login.token).split(';')[0];
  const principal = auth.authenticate(cookie);
  server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (pathname, { body, headers = {} } = {}) => fetch(origin + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', origin }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  await check('existing SQLite account cookie still authorizes auth/status and read-only data', async () => {
    const status = await request('/api/auth/status');
    assert.equal(status.status, 200);
    const body = await status.json(); assert.equal(body.authenticated, true); assert.equal(body.user.role, 'admin');
    const response = await request('/api/status'); assert.equal(response.status, 200);
    assert.equal((await response.json()).engineHandoff.managementOnly, true);
    assert.equal((await request('/api/socialV2/activity', { body: { paused: false } })).status, 503);
  });
  await check('actual machine/MCP send request is rejected before legacy sender or paid dispatch', async () => {
    const response = await fetch(origin + '/api/send/group', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': 'fixture'
    }, body: JSON.stringify({ groupId: 456, message: 'fixture output' }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'ENGINE_HANDOFF_MANAGEMENT_ONLY');
    assert.equal(h.calls.sent.length, 0); assert.equal(h.calls.prompts.length, 0);
  });
  await check('non-paid QQ ownership verification remains usable without enabling legacy AI', async () => {
    const response = await request('/api/tenant/binding/issue', { body: { qq: '124' } });
    assert.equal(response.status, 200);
    const { binding } = await response.json();
    assert.equal(typeof binding.code, 'string');
    await h.handleIncoming('private', 124, { user_id: 124, self_id: 999,
      message: [{ type: 'text', data: { text: '绑定 ' + binding.code } }] }, h.cfg);
    assert.equal(h.getTenantService().getBindingByUser(principal.id).qq, '124');
    assert.equal(h.calls.sent.length, 1);
    assert.equal(h.calls.prompts.length, 0);
  });
  await check('logout revokes the same preserved account cookie immediately', async () => {
    assert.equal((await request('/api/auth/logout', { body: {} })).status, 200);
    assert.equal((await (await request('/api/auth/status')).json()).authenticated, false);
  });
} finally {
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  await h.close();
}
console.log(`engine handoff: ${count} passed, 0 skipped`);
