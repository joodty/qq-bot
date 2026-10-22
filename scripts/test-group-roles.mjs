import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0, failed = 0;
const defaults = {
  'state/current-role.json': { role: '默认', mode: 'active' },
  'roles/默认.md': '# 默认\nGLOBAL_CARD_ONLY',
  'roles/温柔.md': '# 温柔\nGENTLE_CARD_ONLY',
  'roles/朋友.md': '# 朋友\nFRIENDS_CARD_ONLY',
};
export async function groupRoleFixture(run, { files = {}, globals = {}, config = {} } = {}) {
  const h = await bridgeHarness({ config: {
    allow: { groups: ['456', '789'], private: ['123'] },
    socialV2: { enabled: true, sticker: { enabled: false }, proactive: { enabled: false } },
    ...config,
  }, files: { ...defaults, ...files }, globals });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, body, extra = {}, auth = true) => {
    const r = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(auth ? { 'x-console-token': 'fixture-console-token' } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, data: await r.json() };
  };
  try { await run({ h, request, url }); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}
async function test(name, fn, options) {
  try { await groupRoleFixture(fn, options); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.stack); }
}
await test('legacy installation inherits global without writing configuration or touching sessions', async ({ h, request }) => {
  const configBefore = fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8');
  const r = await request('/api/group-roles'); assert.equal(r.status, 200);
  assert.deepEqual(r.data.groups, ['456', '789'].map(groupId => ({ groupId, role: null, effectiveRole: '默认', inherited: true })));
  assert.equal(fs.existsSync(path.join(h.temp, 'state/group-roles.json')), false);
  assert.equal(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'), configBefore);
  assert.equal(h.calls.created.length, 0);
});
await test('group-specific name and full card agree across wake, reminder, tool, status; other groups and private remain global', async ({ h, request }) => {
  assert.equal((await request('/api/group-roles', { groupId: '000456', role: '温柔' })).status, 200);
  for (const key of ['group:456', 'group:789', 'private:123']) {
    const expected = key === 'group:456' ? '温柔' : '默认';
    const prompt = h.buildWakePromptV2(key, 'bootstrap');
    assert.ok(prompt.includes('【当前角色】' + expected));
    assert.ok(h.buildWakeReminderPromptV2(key).includes('【当前角色】' + expected));
    const token = h.getSocialV2State(key).agentToken;
    const headers = { 'x-agent-token': token, 'x-agent-call': '1' };
    const result = await request('/api/socialV2/prompt?key=' + key, undefined, headers);
    assert.equal(result.status, 200); assert.equal(result.data.role.name, expected);
    assert.ok(result.data.role.hint.includes(expected === '温柔' ? 'GENTLE_CARD_ONLY' : 'GLOBAL_CARD_ONLY'));
    assert.ok(!result.data.role.hint.includes(expected === '温柔' ? 'GLOBAL_CARD_ONLY' : 'GENTLE_CARD_ONLY'));
    const status = await request('/api/status?key=group:999', undefined, headers);
    assert.equal(status.data.role, expected); assert.equal(status.data.allowGroups, undefined);
  }
  const token = h.getSocialV2State('group:456').agentToken;
  assert.equal((await request('/api/socialV2/prompt?key=group:789', undefined, { 'x-agent-token': token })).status, 403);
});
await test('chat and first-generation prompts use the selected group card', async ({ h, request }) => {
  await request('/api/group-roles', { groupId: '456', role: '温柔' });
  h.setMode('chat');
  for (const id of ['456', '789']) {
    await h.handleIncoming('group', id, { self_id: 999, user_id: 555, message_id: Number(id), sender: { nickname: 'fixture' }, message: [{ type: 'text', data: { text: 'hello' } }] }, h.cfg);
    const prompt = h.calls.prompts.at(-1).content[0].text;
    assert.ok(prompt.includes(id === '456' ? 'GENTLE_CARD_ONLY' : 'GLOBAL_CARD_ONLY'));
    assert.ok(!prompt.includes(id === '456' ? 'GLOBAL_CARD_ONLY' : 'GENTLE_CARD_ONLY'));
  }
});
await test('changing one group pauses only its model session, revokes its old token, and preserves group messages/memory', async ({ h, request }) => {
  const a = await h.ensureSession('group:456'), b = await h.ensureSession('group:789');
  const st = h.getSocialV2State('group:456');
  st.activeTopics.push({ text: 'fixture topic' });
  st.memberImpressions['fixture'] = { traits: ['fixture trait'] };
  h.appendSocialV2Message('group:456', 'fixture', 'buffered text', 'buffered text', false, false, '42');
  const preserved = JSON.stringify([st.recentMessages, st.unread, st.activeTopics, st.memberImpressions]);
  const token = st.agentToken;
  const changed = await request('/api/group-roles', { groupId: '456', role: '温柔' });
  assert.equal(changed.data.sessionReset, true);
  assert.equal(h.state.sessions['group:456'], undefined); assert.equal(h.state.sessions['group:789'], b);
  assert.deepEqual(h.calls.archived, []); assert.ok(h.calls.cancelled.includes(a));
  assert.equal(JSON.stringify([st.recentMessages, st.unread, st.activeTopics, st.memberImpressions]), preserved);
  assert.notEqual(st.agentToken, token); assert.equal(st.bootstrapSent, false);
  assert.equal((await request('/api/socialV2/prompt?key=group:456', undefined, { 'x-agent-token': token })).status, 403);
  const next = await h.ensureSession('group:456'); assert.notEqual(next, a);
  await request('/api/group-roles', { groupId: '456', role: '温柔' });
  assert.equal(h.state.sessions['group:456'], next, 'same selection must keep context');
  await request('/api/group-roles', { groupId: '456', role: null });
  assert.equal(h.buildWakePromptV2('group:456', 'bootstrap').includes('【当前角色】默认'), true);
  assert.equal(h.state.sessions['group:789'], b);
});
await test('global changes affect inherited groups/private, while an explicit identical role stays pinned', async ({ h, request }) => {
  const original = await h.ensureSession('group:456');
  const pinned = await request('/api/group-roles', { groupId: '456', role: '默认' });
  assert.equal(pinned.data.sessionReset, false); assert.equal(h.state.sessions['group:456'], original);
  await request('/api/role', { role: '朋友' });
  assert.ok(h.buildWakePromptV2('group:456', 'bootstrap').includes('【当前角色】默认'));
  for (const key of ['group:789', 'private:123']) assert.ok(h.buildWakePromptV2(key, 'bootstrap').includes('【当前角色】朋友'));
  await request('/api/role', { role: null });
  const list = (await request('/api/group-roles')).data.groups;
  assert.equal(list[0].effectiveRole, '默认'); assert.equal(list[1].effectiveRole, null);
});
await test('only the administrator can list/write mappings, including when an agent omits its token', async ({ h, request }) => {
  const token = h.getSocialV2State('group:456').agentToken;
  for (const headers of [{ 'x-agent-token': token }, { 'x-agent-token': token, 'x-agent-call': '1' }, { 'x-agent-call': '1' }, { 'x-agent-token': '' }]) {
    assert.equal((await request('/api/group-roles', undefined, headers)).status, 403);
    assert.equal((await request('/api/group-roles', { groupId: '456', role: '温柔' }, headers)).status, 403);
  }
  assert.equal((await request('/api/group-roles', undefined, {}, false)).status, 401);
  assert.equal(fs.existsSync(path.join(h.temp, 'state/group-roles.json')), false);
});
await test('invalid targets/cards and missing or malformed role inputs never write or reset', async ({ h, request }) => {
  const id = await h.ensureSession('group:456');
  for (const body of [{ groupId: '456' }, { groupId: '456', role: false }, { groupId: '456', role: {} },
    { groupId: '456', role: '' }, { groupId: '456', role: '../温柔' }, { groupId: '456', role: '不存在' }, { groupId: '456', role: 'README' },
    { groupId: '999', role: '温柔' }, { groupId: 'private:123', role: '温柔' }, { groupId: true, role: '温柔' }, { groupId: 0, role: '温柔' }, { groupId: '9007199254740992', role: '温柔' }]) {
    assert.equal((await request('/api/group-roles', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(h.state.sessions['group:456'], id); assert.equal(h.calls.archived.length, 0);
  assert.equal(fs.existsSync(path.join(h.temp, 'state/group-roles.json')), false);
});
await test('saved mappings survive reload and rename; deletion is blocked until all group references are removed', async ({ h, request }) => {
  await request('/api/group-roles', { groupId: '456', role: '温柔' });
  const saved = fs.readFileSync(path.join(h.temp, 'state/conversation-roles.json'), 'utf8');
  const other = await bridgeHarness({ files: { ...defaults, 'state/conversation-roles.json': saved } });
  try { assert.ok(other.buildWakePromptV2('group:456', 'bootstrap').includes('【当前角色】温柔')); } finally { await other.close(); }
  assert.equal((await request('/api/roles/delete', { name: '温柔' })).status, 409);
  assert.equal((await request('/api/roles/rename', { from: '温柔', to: '温暖' })).status, 200);
  const role = (await request('/api/socialV2/prompt?key=group:456')).data.role;
  assert.equal(role.name, '温暖'); assert.ok(role.hint.includes('GENTLE_CARD_ONLY'));
  assert.equal((await request('/api/roles/delete', { name: '温暖' })).status, 409);
  await request('/api/group-roles', { groupId: '456', role: null });
  assert.equal((await request('/api/roles/delete', { name: '温暖' })).status, 200);
});
for (const raw of ['broken-json', 'null', '[]', '{"version":2,"groups":{"456":"温柔"}}', '{"version":1,"groups":[]}', '{"version":1,"groups":{"__proto__":"温柔"}}', '{"version":1,"groups":{"456":"../温柔"}}']) {
  await test('corrupt/future mappings are preserved and cannot silently fall back: ' + raw.slice(0, 30), async ({ h, request }) => {
    assert.equal((await request('/api/group-roles')).status, 500);
    assert.equal((await request('/api/group-roles', { groupId: '456', role: '朋友' })).status, 500);
    assert.throws(() => h.buildWakePromptV2('group:456', 'bootstrap'));
    assert.equal(fs.readFileSync(path.join(h.temp, 'state/group-roles.json'), 'utf8'), raw);
    assert.equal(h.calls.archived.length, 0);
  }, { files: { 'state/group-roles.json': raw } });
}
await test('failed atomic writes retain original file and model session', async ({ h, request }) => {
  const id = await h.ensureSession('group:456');
  fs.mkdirSync(path.join(h.temp, 'state/group-roles.json'));
  assert.equal((await request('/api/group-roles', { groupId: '456', role: '温柔' })).status, 500);
  assert.equal(h.state.sessions['group:456'], id); assert.ok(fs.statSync(path.join(h.temp, 'state/group-roles.json')).isDirectory());
});
const deniedWrites = new Proxy(fs, { get(target, name) {
  if (name === 'writeFileSync') return (file, ...args) => {
    if (/(?:group|conversation)-roles\.json\./.test(String(file))) { const error = new Error('fixture denied write'); error.code = 'EACCES'; throw error; }
    return target.writeFileSync(file, ...args);
  };
  return target[name];
} });
await test('an actual write failure leaves saved mappings, tokens and sessions intact', async ({ h, request }) => {
  const id = await h.ensureSession('group:456'), token = h.getSocialV2State('group:456').agentToken;
  const file = path.join(h.temp, 'state/group-roles.json'), before = fs.readFileSync(file, 'utf8');
  assert.equal((await request('/api/group-roles', { groupId: '456', role: '朋友' })).status, 500);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(h.state.sessions['group:456'], id); assert.equal(h.getSocialV2State('group:456').agentToken, token);
  assert.equal(h.calls.archived.length, 0);
}, { files: { 'state/group-roles.json': { version: 1, groups: { '456': '温柔' } } }, globals: { fs: deniedWrites } });
await test('rename write failure rolls back the card filename without damaging assignments', async ({ h, request }) => {
  assert.equal((await request('/api/roles/rename', { from: '温柔', to: '温暖' })).status, 500);
  assert.equal(fs.existsSync(path.join(h.temp, 'roles/温柔.md')), true);
  assert.equal(fs.existsSync(path.join(h.temp, 'roles/温暖.md')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/group-roles.json'), 'utf8')).groups['456'], '温柔');
}, { files: { 'state/group-roles.json': { version: 1, groups: { '456': '温柔' } } }, globals: { fs: deniedWrites } });
console.log(JSON.stringify({ passed, failed, liveQqMessages: 0, liveModelRequests: 0 }));
if (failed) process.exitCode = 1;
