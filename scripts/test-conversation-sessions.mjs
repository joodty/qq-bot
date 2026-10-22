import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const config = { ownerQQ: 123, allow: { groups: ['456', '789'], private: ['123', '456'] }, socialV2: { sticker: { enabled: false }, proactive: { enabled: false } } };
const defaults = { 'state/current-role.json': { role: '甲', mode: 'active' }, 'roles/甲.md': 'CARD_A', 'roles/乙.md': 'CARD_B', 'roles/丙.md': 'CARD_C' };
let passed = 0, failed = 0;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(run, { files = {}, savedState, globals = {} } = {}) {
  const h = await bridgeHarness({ config, files: { ...defaults, ...files }, savedState, globals });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = async (route, body, { token = true, cookie, headers = {} } = {}) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route, {
      method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { 'x-console-token': 'fixture-console-token' } : {}), ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const list = async () => { const result = await request('/api/conversation-sessions'); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
  const select = async (key, role) => { const result = await request('/api/conversation-roles', { key, role }); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
  const fresh = async key => { const result = await request('/api/conversation-sessions/new', { key }); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
  try { await run({ h, request, list, select, fresh }); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}
async function test(name, run, options) {
  try { await fixture(run, options); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.stack); }
}
const recordFor = (data, sessionId) => data.sessions.find(record => record.sessionId === sessionId);
const activeFor = (data, key) => data.sessions.find(record => record.id === data.active[key]);

await test('viewing a legacy installation is read-only and preserves its existing model mapping', async ({ h, list }) => {
  const before = fs.readFileSync(path.join(h.temp, 'state/sessions.json'), 'utf8');
  const first = await list(), second = await list();
  assert.equal(first.sessions.length, 1); assert.equal(first.sessions[0].sessionId, 'legacy-model');
  assert.equal(first.sessions[0].id, second.sessions[0].id);
  assert.equal(fs.existsSync(path.join(h.temp, 'state/conversation-sessions.json')), false);
  assert.equal(fs.readFileSync(path.join(h.temp, 'state/sessions.json'), 'utf8'), before);
  assert.equal(await h.ensureSession('group:456'), 'legacy-model');
  assert.equal(h.calls.created.length, 0); assert.equal(h.calls.archived.length, 0);
}, { savedState: { sessions: { 'group:456': 'legacy-model' }, sessionPolicies: { 'group:456': '["reserved2","qq-chat-v2",null]' } } });

await test('A to B to A restores the same model session, preserves messages, and revokes the old token', async ({ h, list, select }) => {
  const a = await h.ensureSession('group:456');
  const st = h.getSocialV2State('group:456'), token = st.agentToken;
  h.appendSocialV2Message('group:456', 'fixture', 'kept message', 'kept message', false, false, '88');
  st.activeTopics.push({ text: 'kept topic' }); st.memberImpressions.fixture = { traits: ['kept impression'] };
  const memory = JSON.stringify([st.recentMessages, st.unread, st.activeTopics, st.memberImpressions]);
  await select('group:456', '乙'); const b = await h.ensureSession('group:456');
  assert.notEqual(a, b); assert.notEqual(st.agentToken, token);
  assert.equal(recordFor(await list(), a).status, 'paused');
  await select('group:456', '甲'); assert.equal(await h.ensureSession('group:456'), a);
  assert.equal(h.calls.created.length, 2); assert.deepEqual(h.calls.archived, []);
  assert.ok(h.calls.cancelled.includes(a)); assert.ok(h.calls.cancelled.includes(b));
  assert.equal(JSON.stringify([st.recentMessages, st.unread, st.activeTopics, st.memberImpressions]), memory);
  assert.equal(h.calls.prompts.length, 0); assert.equal(h.calls.sent.length, 0);
});

await test('same-number group and private conversation keep separate histories and active mappings', async ({ h, list, select }) => {
  const group = await h.ensureSession('group:456'), privateId = await h.ensureSession('private:456');
  await select('group:456', '乙'); const secondGroup = await h.ensureSession('group:456');
  assert.notEqual(group, secondGroup); assert.equal(await h.ensureSession('private:456'), privateId);
  const data = await list();
  assert.equal(activeFor(data, 'private:456').sessionId, privateId);
  assert.equal(recordFor(data, group).key, 'group:456'); assert.equal(recordFor(data, privateId).key, 'private:456');
});

await test('global default switches only inherited conversations while an explicit same-persona pin stays fixed', async ({ h, request, list, select }) => {
  const inheritedA = await h.ensureSession('group:456'), pinnedA = await h.ensureSession('group:789');
  await select('group:789', '甲');
  assert.equal((await request('/api/role', { role: '乙' })).status, 200);
  const inheritedB = await h.ensureSession('group:456');
  assert.notEqual(inheritedB, inheritedA); assert.equal(await h.ensureSession('group:789'), pinnedA);
  assert.equal(activeFor(await list(), 'group:789').role, '甲');
  assert.equal((await request('/api/role', { role: '甲' })).status, 200);
  assert.equal(await h.ensureSession('group:456'), inheritedA); assert.equal(await h.ensureSession('group:789'), pinnedA);
  assert.equal(h.calls.created.length, 3);
});

await test('registry, assignments and active model sessions survive restart without model recreation', async ({ h, list, select }) => {
  const a = await h.ensureSession('group:456'); await select('group:456', '乙');
  const b = await h.ensureSession('group:456'); const before = await list();
  const files = {};
  for (const rel of ['state/conversation-sessions.json', 'state/conversation-roles.json', 'state/current-role.json', 'state/sessions.json']) files[rel] = fs.readFileSync(path.join(h.temp, rel), 'utf8');
  await fixture(async restarted => {
    const after = await restarted.list(); assert.deepEqual(after.sessions.map(r => [r.id, r.personaId, r.sessionId]), before.sessions.map(r => [r.id, r.personaId, r.sessionId]));
    assert.equal(await restarted.h.ensureSession('group:456'), b);
    await restarted.select('group:456', '甲'); assert.equal(await restarted.h.ensureSession('group:456'), a);
    assert.equal(restarted.h.calls.created.length, 0);
  }, { files });
});

await test('renaming a persona keeps its stable identity, existing history and DSH model session', async ({ h, request, list, select }) => {
  await select('group:456', '乙'); const sessionId = await h.ensureSession('group:456');
  const before = recordFor(await list(), sessionId);
  assert.equal((await request('/api/roles/rename', { from: '乙', to: '乙改名' })).status, 200);
  const after = recordFor(await list(), sessionId);
  assert.equal(after.personaId, before.personaId); assert.equal(after.id, before.id); assert.equal(after.role, '乙改名');
  assert.equal(await h.ensureSession('group:456'), sessionId);
  await select('group:456', '甲'); await h.ensureSession('group:456');
  assert.equal((await request('/api/conversation-sessions/activate', { id: before.id })).status, 200);
  assert.equal(await h.ensureSession('group:456'), sessionId);
});

await test('deleting and recreating the same persona name never resurrects its deleted identity or model context', async ({ h, request, list, select }) => {
  await select('group:456', '乙'); const oldSession = await h.ensureSession('group:456');
  const old = recordFor(await list(), oldSession);
  await select('group:456', null); await h.ensureSession('group:456');
  assert.equal((await request('/api/roles/delete', { name: '乙' })).status, 200);
  assert.equal(recordFor(await list(), oldSession).status, 'missing');
  assert.equal((await request('/api/roles/create', { name: '乙', content: 'RECREATED_CARD_B' })).status, 200);
  await select('group:456', '乙'); const recreated = await h.ensureSession('group:456');
  const current = recordFor(await list(), recreated);
  assert.notEqual(recreated, oldSession); assert.notEqual(current.personaId, old.personaId);
  assert.ok((await request('/api/conversation-sessions/activate', { id: old.id })).status >= 400);
  assert.equal(h.state.sessions['group:456'], recreated);
});

await test('new session retains same-persona history and creates a model context only on the next normal wake', async ({ h, list, fresh }) => {
  const first = await h.ensureSession('group:456'), before = recordFor(await list(), first);
  const created = h.calls.created.length;
  const result = await fresh('group:456'); const data = await list();
  const next = activeFor(data, 'group:456');
  assert.equal(data.sessions.length, 2); assert.equal(recordFor(data, first).status, 'paused');
  assert.equal(next.id, result.id); assert.equal(next.personaId, before.personaId); assert.equal(next.sessionId, null);
  assert.equal(h.calls.created.length, created); assert.equal(h.state.sessions['group:456'], undefined);
  const second = await h.ensureSession('group:456'); assert.notEqual(second, first);
  assert.equal(activeFor(await list(), 'group:456').id, next.id);
});

await test('reset invalidates cleared model context and explicit archive activation cannot restore it', async ({ h, request, list }) => {
  const oldSession = await h.ensureSession('group:456'); const old = recordFor(await list(), oldSession);
  assert.equal((await request('/api/session/reset', { key: 'group:456' })).status, 200);
  assert.equal(recordFor(await list(), oldSession).status, 'missing');
  assert.ok((await request('/api/conversation-sessions/activate', { id: old.id })).status >= 400);
  const next = await h.ensureSession('group:456'); assert.notEqual(next, oldSession);
  assert.ok(h.calls.archived.includes(oldSession));
});

await test('switching chat mode never restores a session with incompatible local-tool permissions', async ({ h, request, list }) => {
  const restricted = await h.ensureSession('private:123'); const old = recordFor(await list(), restricted);
  h.setMode('closed-agent');
  const privileged = await h.ensureSession('private:123'); assert.notEqual(privileged, restricted);
  assert.ok((await request('/api/conversation-sessions/activate', { id: old.id })).status >= 400);
  h.setMode('reserved2'); const safe = await h.ensureSession('private:123'); assert.notEqual(safe, privileged);
  const unsafe = recordFor(await list(), privileged);
  assert.notEqual(unsafe.status, 'active');
  assert.ok((await request('/api/conversation-sessions/activate', { id: unsafe.id })).status >= 400);
  assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-v2');
});

for (const raw of ['{broken', '{"version":99,"personas":{},"records":{},"selected":{}}', '{"version":1,"personas":{},"records":{},"selected":{},"unknown":true}']) {
  await test('corrupt or future registry rejects writes and preserves original bytes: ' + raw, async ({ h, request }) => {
    const file = path.join(h.temp, 'state/conversation-sessions.json'); fs.writeFileSync(file, raw);
    assert.ok((await request('/api/conversation-sessions')).status >= 400);
    assert.ok((await request('/api/conversation-sessions/new', { key: 'group:456' })).status >= 400);
    assert.ok((await request('/api/conversation-roles', { key: 'group:456', role: '乙' })).status >= 400);
    await assert.rejects(h.ensureSession('group:456'));
    assert.equal(fs.readFileSync(file, 'utf8'), raw); assert.equal(h.calls.created.length, 0);
  });
}

await test('unreadable registry refuses operations without replacing an existing valid registry', async ({ h, request, fresh }) => {
  await fresh('group:456');
  const file = path.join(h.temp, 'state/conversation-sessions.json'), original = fs.readFileSync(file, 'utf8');
  const read = fs.readFileSync;
  fs.readFileSync = function (target, ...args) {
    if (typeof target === 'string' && path.resolve(target) === file) throw Object.assign(new Error('fixture EACCES'), { code: 'EACCES' });
    return read.call(this, target, ...args);
  };
  try {
    assert.ok((await request('/api/conversation-sessions')).status >= 400);
    assert.ok((await request('/api/conversation-sessions/new', { key: 'group:456' })).status >= 400);
    await assert.rejects(h.ensureSession('group:456'));
  } finally { fs.readFileSync = read; }
  assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(h.calls.created.length, 0);
});

await test('failed stopSessionWork blocks old context; a confirmed new session can recover without reviving it', async ({ h, request, list, fresh }) => {
  const oldSession = await h.ensureSession('group:456'); const stop = h.api.stopSessionWork;
  h.api.stopSessionWork = async () => { throw new Error('fixture pause failure'); };
  const failure = await request('/api/conversation-roles', { key: 'group:456', role: '乙' });
  assert.ok(failure.status >= 400); assert.equal(h.state.sessions['group:456'], undefined);
  await assert.rejects(h.ensureSession('group:456'), /暂停尚未确认|正在切换/);
  assert.equal(recordFor(await list(), oldSession).status, 'incompatible');
  h.api.stopSessionWork = stop; await fresh('group:456');
  const next = await h.ensureSession('group:456'); assert.notEqual(next, oldSession);
  assert.equal(h.calls.archived.includes(oldSession), false);
});

await test('concurrent switches in different conversations reread the registry and retain both histories', async ({ h, request, list }) => {
  await h.ensureSession('group:456'); await h.ensureSession('private:456');
  const firstEntered = deferred(), bothEntered = deferred(), gate = deferred(); let count = 0;
  const stop = h.api.stopSessionWork;
  h.api.stopSessionWork = async sessionId => {
    if (++count === 1) firstEntered.resolve(); if (count === 2) bothEntered.resolve();
    await gate.promise; return stop(sessionId);
  };
  const group = request('/api/conversation-roles', { key: 'group:456', role: '乙' });
  await firstEntered.promise;
  const privateChat = request('/api/conversation-roles', { key: 'private:456', role: '丙' });
  try { await bothEntered.promise; } finally { gate.resolve(); }
  assert.equal((await group).status, 200); assert.equal((await privateChat).status, 200);
  await h.ensureSession('group:456'); await h.ensureSession('private:456');
  const data = await list();
  assert.equal(data.sessions.filter(record => record.key === 'group:456').length, 2);
  assert.equal(data.sessions.filter(record => record.key === 'private:456').length, 2);
  assert.equal(activeFor(data, 'group:456').role, '乙'); assert.equal(activeFor(data, 'private:456').role, '丙');
});

await test('agent requests and scoped ordinary browser users cannot read or manage session archives', async ({ h, request, fresh }) => {
  await fresh('group:456');
  const token = h.getSocialV2State('group:456').agentToken;
  for (const headers of [{ 'x-agent-token': token }, { 'x-agent-call': '1' }]) {
    assert.equal((await request('/api/conversation-sessions', undefined, { headers })).status, 403);
    for (const route of ['/api/conversation-sessions/new', '/api/conversation-sessions/activate']) assert.equal((await request(route, { key: 'group:456', id: 'nonexistent' }, { headers })).status, 403);
  }
  const password = 'fixture-archive-password-123';
  const setup = await request('/api/auth/bootstrap', { password }); assert.equal(setup.status, 200);
  assert.equal((await request('/api/auth/users', { username: 'reader', password, conversationKeys: ['group:456'] }, { token: false, cookie: setup.cookie })).status, 200);
  const login = await request('/api/auth/login', { username: 'reader', password }, { token: false }); assert.equal(login.status, 200);
  const auth = { token: false, cookie: login.cookie };
  assert.equal((await request('/api/conversation-sessions', undefined, auth)).status, 403);
  for (const route of ['/api/conversation-sessions/new', '/api/conversation-sessions/activate']) assert.equal((await request(route, { key: 'group:456', id: 'nonexistent' }, auth)).status, 403);
  assert.equal((await request('/api/conversation-roles', { key: 'group:456', role: '乙' }, auth)).status, 403);
});

console.log(JSON.stringify({ passed, failed, liveQqMessages: 0, liveModelRequests: 0 }));
if (failed) process.exitCode = 1;
