import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0, failed = 0;
async function test(name, fn, { files = {}, config = {} } = {}) {
  const h = await bridgeHarness({ config: { ownerQQ: 123, allow: { groups: ['456', '789'], private: ['123', '456'] }, socialV2: { sticker: { enabled: false }, proactive: { enabled: false } }, ...config }, files: {
    'state/current-role.json': { role: '默认', mode: 'active' },
    'roles/默认.md': '# 默认\nGLOBAL_CARD', 'roles/温柔.md': '# 温柔\nGENTLE_CARD', 'roles/朋友.md': '# 朋友\nFRIEND_CARD', ...files,
  } });
  h.setMode('reserved2'); const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = async (route, body, headers = {}) => {
    const r = await fetch('http://127.0.0.1:' + server.address().port + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, data: await r.json() };
  };
  try { await fn(h, request); passed++; console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, e.stack); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}
await test('groups, ordinary private and administrator private are distinct; owner listed once', async (h, req) => {
  const rows = (await req('/api/conversation-roles')).data.conversations;
  assert.deepEqual(rows.map(r => r.key), ['group:456', 'group:789', 'private:123', 'private:456']);
  assert.equal(rows.filter(r => r.isOwner).length, 1); assert.match(rows.find(r => r.isOwner).label, /管理员私聊/);
  for (const [key, role] of [['group:456', '朋友'], ['private:456', '温柔'], ['private:123', '温柔']]) assert.equal((await req('/api/conversation-roles', { key, role })).status, 200);
  for (const [key, role, card] of [['group:456', '朋友', 'FRIEND_CARD'], ['group:789', '默认', 'GLOBAL_CARD'], ['private:456', '温柔', 'GENTLE_CARD'], ['private:123', '温柔', 'GENTLE_CARD']]) {
    assert.ok(h.buildWakePromptV2(key, 'bootstrap').includes('【当前角色】' + role));
    assert.ok(h.buildWakeReminderPromptV2(key).includes('【当前角色】' + role));
    const headers = { 'x-agent-token': h.getSocialV2State(key).agentToken };
    const result = await req('/api/socialV2/prompt?key=' + key, undefined, headers);
    assert.equal(result.data.role.name, role); assert.ok(result.data.role.hint.includes(card));
    assert.equal((await req('/api/status', undefined, headers)).data.role, role);
  }
  assert.equal(h.calls.sent.length, 0); assert.equal(h.calls.prompts.length, 0);
});
await test('private changes reset only their model context, preserve memory, revoke token and survive reload', async (h, req) => {
  const privateId = await h.ensureSession('private:456'), groupId = await h.ensureSession('group:456'), adminId = await h.ensureSession('private:123');
  const st = h.getSocialV2State('private:456'), oldToken = st.agentToken;
  h.appendSocialV2Message('private:456', 'friend', 'private buffer', 'private buffer', false, false, '77');
  st.activeTopics.push({ text: 'private topic' });
  const before = JSON.stringify([st.recentMessages, st.unread, st.activeTopics, st.memberImpressions]);
  const result = await req('/api/conversation-roles', { key: 'private:000456', role: '温柔' });
  assert.equal(result.data.sessionReset, true); assert.equal(h.state.sessions['private:456'], undefined);
  assert.equal(h.state.sessions['group:456'], groupId); assert.equal(h.state.sessions['private:123'], adminId);
  assert.deepEqual(h.calls.archived, []); assert.ok(h.calls.cancelled.includes(privateId));
  assert.equal(JSON.stringify([st.recentMessages, st.unread, st.activeTopics, st.memberImpressions]), before);
  assert.notEqual(st.agentToken, oldToken);
  assert.equal((await req('/api/socialV2/prompt?key=private:456', undefined, { 'x-agent-token': oldToken })).status, 403);
  const next = await h.ensureSession('private:456'); await req('/api/conversation-roles', { key: 'private:456', role: '温柔' });
  assert.equal(h.state.sessions['private:456'], next);
  const saved = fs.readFileSync(path.join(h.temp, 'state/conversation-roles.json'), 'utf8');
  const other = await bridgeHarness({ files: { 'state/conversation-roles.json': saved, 'roles/温柔.md': 'GENTLE_CARD' } });
  try { assert.ok(other.buildWakePromptV2('private:456', 'bootstrap').includes('【当前角色】温柔')); } finally { await other.close(); }
});
await test('owner can be configured when chat is blocked; assignment never grants chat or tool permission', async (h, req) => {
  const before = fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8');
  const rows = (await req('/api/conversation-roles')).data.conversations;
  assert.equal(rows.find(r => r.key === 'private:123').allowed, false);
  assert.equal((await req('/api/conversation-roles', { key: 'private:123', role: '温柔' })).status, 200);
  assert.equal(h.modeAllowed('private:123', 'private', 123, h.cfg, 'reserved2'), false);
  assert.equal(h.modeAllowed('private:456', 'private', 456, h.cfg, 'closed-agent'), false);
  h.setMode('closed-agent');
  const closed = (await req('/api/conversation-roles')).data.conversations;
  assert.deepEqual(closed.filter(r => r.allowed).map(r => r.key), ['private:123']);
  assert.equal(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'), before);
  assert.equal(h.calls.sent.length, 0); assert.equal(h.calls.prompts.length, 0);
}, { config: { allow: { groups: ['456'], private: [] } } });
await test('private chat and closed-agent prompts inject the correct complete card', async (h, req) => {
  await req('/api/conversation-roles', { key: 'private:456', role: '温柔' });
  await req('/api/conversation-roles', { key: 'private:123', role: '朋友' });
  for (const [mode, id, card] of [['chat', 456, 'GENTLE_CARD'], ['closed-agent', 123, 'FRIEND_CARD']]) {
    h.setMode(mode);
    await h.handleIncoming('private', id, { self_id: 999, user_id: id, message_id: id, sender: { nickname: 'fixture' }, message: [{ type: 'text', data: { text: 'hello' } }] }, h.cfg);
    assert.ok(h.calls.prompts.at(-1).content[0].text.includes(card));
  }
});
await test('legacy group migration is read-only until a changed save and retains all old assignments', async (h, req) => {
  const file = path.join(h.temp, 'state/group-roles.json'), original = fs.readFileSync(file, 'utf8');
  assert.equal((await req('/api/conversation-roles')).data.conversations.find(r => r.key === 'group:456').role, '朋友');
  await req('/api/conversation-roles', { key: 'group:456', role: '朋友' });
  assert.equal(fs.existsSync(path.join(h.temp, 'state/conversation-roles.json')), false);
  await req('/api/conversation-roles', { key: 'private:456', role: '温柔' });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const stored = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/conversation-roles.json'), 'utf8'));
  assert.deepEqual(stored.roles, { 'group:456': '朋友', 'group:999': '朋友', 'private:456': '温柔' });
  assert.equal((await req('/api/group-roles')).data.groups[0].role, '朋友');
}, { files: { 'state/group-roles.json': { version: 1, groups: { '456': '朋友', '999': '朋友' } } } });
await test('rename and delete track private and group references together', async (h, req) => {
  for (const key of ['group:456', 'private:456', 'private:123']) await req('/api/conversation-roles', { key, role: '温柔' });
  assert.equal((await req('/api/roles/rename', { from: '温柔', to: '温暖' })).status, 200);
  const blocked = await req('/api/roles/delete', { name: '温暖' });
  assert.equal(blocked.status, 409); assert.equal(blocked.data.conversations.length, 3);
  await req('/api/conversation-roles', { key: 'group:456', role: null });
  assert.equal((await req('/api/roles/delete', { name: '温暖' })).status, 409);
  for (const key of ['private:456', 'private:123']) await req('/api/conversation-roles', { key, role: null });
  assert.equal((await req('/api/roles/delete', { name: '温暖' })).status, 200);
});
await test('agent requests cannot access management endpoints or other private cards; bad targets never write', async (h, req) => {
  const token = h.getSocialV2State('private:456').agentToken;
  for (const headers of [{ 'x-agent-token': token }, { 'x-agent-call': '1' }]) {
    assert.equal((await req('/api/conversation-roles', undefined, headers)).status, 403);
    assert.equal((await req('/api/conversation-roles', { key: 'private:456', role: '温柔' }, headers)).status, 403);
  }
  assert.equal((await req('/api/socialV2/prompt?key=private:123', undefined, { 'x-agent-token': token })).status, 403);
  for (const key of ['admin:123', 'guild:456', 'private:999', 'group:0', 'private:-1', 'private:9007199254740992', '__proto__', 456, null]) assert.equal((await req('/api/conversation-roles', { key, role: '温柔' })).status, 400);
  assert.equal(fs.existsSync(path.join(h.temp, 'state/conversation-roles.json')), false);
});
for (const raw of ['bad-json', '{"version":2,"roles":{}}', '{"version":1,"roles":{"private:000123":"温柔"}}', '{"version":1,"roles":{"admin:123":"温柔"}}']) {
  await test('corrupt new file never falls back to legacy or overwrites data: ' + raw, async (h, req) => {
    assert.equal((await req('/api/conversation-roles')).status, 500);
    assert.equal((await req('/api/conversation-roles', { key: 'private:456', role: '温柔' })).status, 500);
    assert.throws(() => h.buildWakePromptV2('private:456', 'bootstrap'));
    assert.equal(fs.readFileSync(path.join(h.temp, 'state/conversation-roles.json'), 'utf8'), raw);
  }, { files: { 'state/conversation-roles.json': raw, 'state/group-roles.json': { version: 1, groups: { '456': '朋友' } } } });
}
console.log(JSON.stringify({ passed, failed, liveQqMessages: 0, liveModelRequests: 0 }));
if (failed) process.exitCode = 1;
