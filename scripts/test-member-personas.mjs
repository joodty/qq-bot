import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemberPersonaService } from '../src/member-personas.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-personas-'));
const users = { a: { id: 'user-a', role: 'user', conversationKeys: ['group:1'] }, b: { id: 'user-b', role: 'user', conversationKeys: ['group:1'] }, admin: { id: 'admin', role: 'admin' } };
let passed = 0;
function harness(botId = 'primary') {
  const db = new Map(), roles = new Map([['模板', 'TEMPLATE_CONTENT'], ['member_' + 'f'.repeat(32), 'PRIVATE_OTHER_CONTENT']]);
  const calls = [], bindings = []; let failWrite = false, committedFailure = false;
  const storage = {
    readText: file => db.get(file) ?? null,
    writeText(file, text, expected) { if (failWrite) throw new Error('fixture write failed'); if ((db.get(file) ?? null) !== expected) throw new Error('CAS conflict'); db.set(file, text); },
    transaction(run) { const before = new Map(db), beforeRoles = new Map(roles); let result; try { result = run(); } catch (error) { db.clear(); for (const [k, v] of before) db.set(k, v); roles.clear(); for (const [k, v] of beforeRoles) roles.set(k, v); throw error; } if (committedFailure) throw Object.assign(new Error('mirror failed after commit'), { committed: true }); return result; },
  };
  const options = { storage, rolesDir: path.join(dir, botId, 'roles'), botId, file: path.join(dir, botId, 'state', 'member-personas.json'), readRole: name => roles.get(name) ?? null, writeRole: (name, content) => roles.set(name, content), listTemplates: () => [...roles].map(([name, content]) => ({ name, content })), listBindings: () => bindings, activateRole: async (key, role) => { calls.push({ key, role }); return { sessionId: 'MUST_NOT_LEAK' }; } };
  return { service: createMemberPersonaService(options), options, roles, db, calls, bindings, failWrite: value => { failWrite = value; }, committedFailure: value => { committedFailure = value; } };
}
async function test(name, run) { await run(); passed++; console.log('PASS', name); }
try {
  await test('same display names remain separate stable cards for different owners', () => {
    const h = harness(), a = h.service.create(users.a, { name: '小橘', content: 'A_CARD' }).persona, b = h.service.create(users.b, { name: '小橘', content: 'B_CARD' }).persona;
    assert.notEqual(a.id, b.id); assert.equal(h.service.list(users.a).personas.length, 1); assert.equal(h.service.list(users.b).personas[0].content, 'B_CARD');
    assert.equal(h.service.list(users.admin).personas.length, 2); assert.equal(h.service.displayNameForRole('member_' + a.id), '小橘');
    assert.ok(!JSON.stringify(h.service.list(users.a)).includes(b.id));
  });
  await test('only administrator templates are listed; a template copy never edits its source', () => {
    const h = harness(); assert.deepEqual(h.service.list(users.a).templates, [{ name: '模板', content: 'TEMPLATE_CONTENT' }]);
    const copied = h.service.create(users.a, { name: '我的模板', copyFrom: '模板' }).persona;
    h.service.update(users.a, { id: copied.id, version: 1, content: 'COPY_EDITED' });
    assert.equal(h.roles.get('模板'), 'TEMPLATE_CONTENT'); assert.equal(h.roles.get('member_' + copied.id), 'COPY_EDITED');
  });
  await test('unassigned accounts cannot list, create, or apply cards', async () => {
    const h = harness(), empty = { id: 'empty', role: 'user', conversationKeys: [] };
    for (const action of [() => h.service.list(empty), () => h.service.create(empty, { name: 'x', content: 'x' })]) assert.throws(action, e => e.statusCode === 403);
    await assert.rejects(h.service.apply(empty, { templateName: '模板', key: 'group:1' }), e => e.statusCode === 403);
  });
  await test('precise bot and group/private scopes do not cross numeric ids or bots', async () => {
    const h = harness('robot-two'), user = { id: 'scoped', role: 'user', conversationKeys: ['group:1'], botScopes: [{ botId: 'robot-two', key: 'private:1' }] };
    const card = h.service.create(user, { name: '私聊', content: 'private' }).persona;
    await assert.rejects(h.service.apply(user, { id: card.id, key: 'group:1' }), e => e.statusCode === 403);
    await h.service.apply(user, { id: card.id, key: 'private:1' }); assert.equal(h.calls.length, 1);
    assert.throws(() => h.service.list(users.a), e => e.statusCode === 403);
    const other = harness('robot-three'); assert.throws(() => other.service.list(user), e => e.statusCode === 403);
  });
  await test('other owner ids cannot read history, update, restore or apply private cards', async () => {
    const h = harness(), card = h.service.create(users.a, { name: '私有', content: 'PRIVATE' }).persona;
    for (const action of [() => h.service.history(users.b, { id: card.id }), () => h.service.update(users.b, { id: card.id, version: 1, content: 'HACK' }), () => h.service.restore(users.b, { id: card.id, version: 1, targetVersion: 1 })]) assert.throws(action, e => e.statusCode === 404);
    await assert.rejects(h.service.apply(users.b, { id: card.id, key: 'group:1' }), e => e.statusCode === 404);
  });
  await test('save has no activation side effect and returns exactly authorized affected objects', async () => {
    const h = harness(), card = h.service.create(users.a, { name: 'A', content: 'A' }).persona;
    h.bindings.push({ key: 'group:1', internalRoleName: 'member_' + card.id });
    const result = h.service.update(users.a, { id: card.id, version: 1, content: 'B' });
    assert.deepEqual(result.affectedConversations, ['group:1']); assert.equal(h.calls.length, 0);
    h.bindings.push({ key: 'group:2', internalRoleName: 'member_' + card.id });
    assert.deepEqual(h.service.list(users.a).personas[0].affectedConversations, ['group:1']);
    assert.throws(() => h.service.update(users.a, { id: card.id, version: 2, content: 'C' }), e => e.statusCode === 409);
    assert.equal(h.service.update(users.admin, { id: card.id, version: 2, content: 'ADMIN' }).persona.version, 3);
  });
  await test('CAS rejects stale versions across service instances without overwriting', () => {
    const h = harness(), second = createMemberPersonaService(h.options), card = h.service.create(users.a, { name: 'CAS', content: 'v1' }).persona;
    second.update(users.a, { id: card.id, version: 1, content: 'v2' });
    assert.throws(() => h.service.update(users.a, { id: card.id, version: 1, content: 'STALE' }), e => e.statusCode === 409);
    assert.equal(h.service.list(users.a).personas[0].content, 'v2');
  });
  await test('restoring history appends a new version and keeps every former revision', () => {
    const h = harness(), card = h.service.create(users.a, { name: '旧名', content: 'v1' }).persona;
    h.service.update(users.a, { id: card.id, version: 1, name: '新名', content: 'v2' });
    const restored = h.service.restore(users.a, { id: card.id, version: 2, targetVersion: 1 }).persona;
    assert.equal(restored.name, '旧名'); assert.equal(restored.version, 3);
    assert.deepEqual(h.service.history(users.a, { id: card.id }).history.map(v => v.content), ['v1', 'v2', 'v1']);
  });
  await test('apply only returns public card information and never DSH identifiers', async () => {
    const h = harness(), card = h.service.create(users.a, { name: 'A', content: 'A' }).persona;
    const applied = await h.service.apply(users.a, { id: card.id, key: 'group:1' });
    assert.equal(applied.role, 'A'); assert.ok(!JSON.stringify(applied).includes('member_')); assert.ok(!JSON.stringify(applied).includes('sessionId')); assert.ok(!JSON.stringify(applied).includes('MUST_NOT_LEAK'));
    assert.equal(h.calls[0].role, 'member_' + card.id);
  });
  await test('restoring inherited global role still enforces the exact conversation scope', async () => {
    const h = harness(); const result = await h.service.apply(users.a, { inherit: true, key: 'group:1' });
    assert.equal(result.inherited, true); assert.equal(result.role, null); assert.deepEqual(h.calls, [{ key: 'group:1', role: null }]);
    await assert.rejects(h.service.apply(users.a, { inherit: true, key: 'private:1' }), e => e.statusCode === 403);
    await assert.rejects(h.service.apply(users.a, { inherit: true, templateName: '模板', key: 'group:1' }), e => e.statusCode === 400);
  });
  await test('path traversal and private template filename guessing never read or write outside cards', async () => {
    const h = harness();
    for (const name of ['../escape', '..', 'bad/name', 'bad\\name', 'line\nbreak']) assert.throws(() => h.service.create(users.a, { name, content: 'X' }), e => e.statusCode === 400);
    for (const name of ['../模板', 'member_' + 'f'.repeat(32)]) { assert.throws(() => h.service.create(users.a, { name: 'X', copyFrom: name }), e => e.statusCode === 400); await assert.rejects(h.service.apply(users.a, { templateName: name, key: 'group:1' }), e => e.statusCode === 404); }
    assert.equal(h.calls.length, 0); assert.equal(h.roles.size, 2);
  });
  await test('write failure rolls back card document and authoritative role content', () => {
    const h = harness(), card = h.service.create(users.a, { name: 'A', content: 'v1' }).persona;
    const before = [...h.db]; h.failWrite(true);
    assert.throws(() => h.service.update(users.a, { id: card.id, version: 1, content: 'v2' }));
    assert.deepEqual([...h.db], before); assert.equal(h.roles.get('member_' + card.id), 'v1');
  });
  await test('committed mirror failures never revert authoritative committed state', () => {
    const h = harness(), card = h.service.create(users.a, { name: 'A', content: 'v1' }).persona;
    h.committedFailure(true); assert.throws(() => h.service.update(users.a, { id: card.id, version: 1, content: 'v2' }), e => e.committed === true);
    assert.equal(h.service.list(users.a).personas[0].version, 2); assert.equal(h.roles.get('member_' + card.id), 'v2');
  });
  await test('corrupt and future documents fail closed without replacing existing bytes', () => {
    for (const raw of ['broken', '{"version":2,"cards":[]}', '{"version":1,"cards":[],"future":true}']) {
      const h = harness(); h.db.set(h.options.file, raw);
      assert.throws(() => h.service.list(users.a), e => e.statusCode === 503); assert.throws(() => h.service.create(users.a, { name: 'X', content: 'X' }), e => e.statusCode === 503);
      assert.equal(h.db.get(h.options.file), raw);
    }
  });
  await test('default filesystem adapter writes only generated files and repairs crash mirrors', () => {
    const h = harness(), options = { ...h.options, readRole: undefined, writeRole: undefined, listTemplates: undefined };
    const service = createMemberPersonaService(options), card = service.create(users.a, { name: '显示名字 🎈', content: 'SAFE' }).persona;
    const file = path.join(options.rolesDir, 'member_' + card.id + '.md'); assert.equal(fs.readFileSync(file, 'utf8'), 'SAFE');
    assert.equal(fs.existsSync(path.join(options.rolesDir, card.name + '.md')), false);
    fs.writeFileSync(file, 'UNCOMMITTED'); createMemberPersonaService(options); assert.equal(fs.readFileSync(file, 'utf8'), 'SAFE');
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(JSON.stringify({ passed, liveQqMessages: 0, paidModelCalls: 0 }));
