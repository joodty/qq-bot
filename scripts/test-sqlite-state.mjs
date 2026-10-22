import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSqliteState } from '../src/sqlite-state.js';
import { createConsoleAuth, canAccessConversation } from '../src/console-auth.js';
import { createConversationRoleStore } from '../src/conversation-roles.js';
import { createConversationSessionStore } from '../src/conversation-sessions.js';
import { createMemberPersonaService } from '../src/member-personas.js';
import { createBotManager } from '../src/bot-manager.js';

const password = 'sqlite-fixture-password'; let passed = 0;
async function test(name, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sqlite-state-test-'));
  fs.mkdirSync(path.join(root, 'state')); fs.mkdirSync(path.join(root, 'roles'));
  const opened = [];
  const open = (options = {}) => { const storage = createSqliteState({ root, file: path.join(root, 'state/bridge.sqlite'), ...options }); opened.push(storage); return storage; };
  try { await run({ root, open, file: name => path.join(root, 'state', name) }); passed++; console.log('PASS', name); }
  finally { for (const storage of opened.reverse()) storage.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const writer = (file, value) => json(file, value);
async function legacy(root) {
  const file = name => path.join(root, 'state', name);
  const auth = createConsoleAuth({ file: file('console-auth.json') });
  const admin = await auth.bootstrap({ password }, 'fixture');
  const principal = auth.authenticate('qq_console_session=' + admin.token);
  const user = await auth.create(principal, { username: 'reader', password, conversationKeys: ['group:456'] });
  const login = await auth.login({ username: 'reader', password }, 'fixture');
  // Actual old schema: no botScopes field, original IDs/password hashes/sessions.
  const accountData = JSON.parse(fs.readFileSync(file('console-auth.json')));
  for (const account of accountData.users) delete account.botScopes;
  json(file('console-auth.json'), accountData);
  json(file('conversation-roles.json'), { version: 1, roles: { 'group:456': 'A' } });
  const archive = createConversationSessionStore(file('conversation-sessions.json'), writer);
  const data = archive.read(), id = archive.choose(data, 'group:456', 'A', { policy: 'fixture-policy' });
  data.records[id].sessionId = 'old-model-a'; data.records[id].policy = 'fixture-policy'; archive.write(data);
  fs.writeFileSync(path.join(root, 'roles/A.md'), '# A\nOriginal card\n');
  fs.writeFileSync(path.join(root, 'roles/README.md'), 'documentation, not a role');
  return { admin, user, login, accountData, archive: JSON.parse(fs.readFileSync(file('conversation-sessions.json'))) };
}

await test('validated migration preserves raw originals, IDs, scrypt hashes and valid browser sessions', async ({ root, open, file }) => {
  const before = await legacy(root), authText = fs.readFileSync(file('console-auth.json'), 'utf8');
  const archiveText = fs.readFileSync(file('conversation-sessions.json'), 'utf8'); const s = open();
  assert.equal(s.readText(file('console-auth.json')), authText); assert.equal(fs.readFileSync(file('console-auth.json'), 'utf8'), authText);
  assert.equal(s.readText(file('conversation-sessions.json')), archiveText);
  const auth = createConsoleAuth({ file: file('console-auth.json'), storage: s });
  const principal = auth.authenticate('qq_console_session=' + before.login.token);
  assert.equal(principal.id, before.user.id); assert.equal(principal.username, 'reader');
  assert.equal(canAccessConversation(principal, 'group:456'), true); assert.equal(canAccessConversation(principal, 'group:456', 'beta'), false);
  assert.equal(s.db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(before.user.id).password_hash, before.accountData.users[1].password.key);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, before.accountData.sessions.length);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 2);
  assert.equal(s.db.prepare('SELECT bot_id FROM account_scopes WHERE account_id=?').get(before.user.id).bot_id, 'primary');
  assert.equal(s.db.prepare('SELECT session_id FROM archive_records').get().session_id, 'old-model-a');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM selected_sessions').get().n, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM role_cards').get().n, 1);
  assert.equal(fs.readFileSync(path.join(root, 'roles/README.md'), 'utf8'), 'documentation, not a role');
});

await test('after migration no stale, corrupt or future legacy file overwrites SQLite, and worker mirrors recover', async ({ root, open, file }) => {
  const before = await legacy(root), s = open(); s.close();
  for (const name of ['console-auth.json', 'conversation-roles.json', 'conversation-sessions.json']) fs.writeFileSync(file(name), '{"version":99}');
  fs.writeFileSync(path.join(root, 'roles/A.md'), 'stale legacy edit');
  const restarted = open();
  const auth = createConsoleAuth({ file: file('console-auth.json'), storage: restarted });
  assert.equal(auth.authenticate('qq_console_session=' + before.login.token).id, before.user.id);
  assert.equal(JSON.parse(restarted.readText(file('conversation-roles.json'))).roles['group:456'], 'A');
  assert.equal(fs.readFileSync(path.join(root, 'roles/A.md'), 'utf8'), '# A\nOriginal card\n');
  assert.equal(fs.readFileSync(file('console-auth.json'), 'utf8'), '{"version":99}');
});

await test('bad or future legacy formats are refused before database creation and preserve original bytes', async ({ root, open, file }) => {
  for (const name of ['console-auth.json', 'conversation-roles.json', 'conversation-sessions.json', 'member-personas.json', 'bot-registry.json', 'current-role.json']) {
    for (const content of ['{broken', '{"version":99}']) {
      fs.writeFileSync(file(name), content); assert.throws(() => open());
      assert.equal(fs.existsSync(file('bridge.sqlite')), false); assert.equal(fs.readFileSync(file(name), 'utf8'), content);
    }
    fs.unlinkSync(file(name));
  }
  json(file('group-roles.json'), { version: 99, groups: {} }); assert.throws(() => open());
  assert.equal(fs.existsSync(file('bridge.sqlite')), false);
  fs.unlinkSync(file('group-roles.json'));
  for (const target of [file('current-role.json'), path.join(root, 'roles/invalid.md')]) {
    const invalid = Buffer.from([0xc3, 0x28]); fs.writeFileSync(target, invalid);
    assert.throws(() => open(), /UTF-8/);
    assert.equal(fs.existsSync(file('bridge.sqlite')), false); assert.deepEqual(fs.readFileSync(target), invalid);
    fs.unlinkSync(target);
  }
});

await test('database version/application/schema mismatches are refused without changing database bytes', async ({ open, file }) => {
  const s = open(); s.db.exec('PRAGMA user_version=99'); s.close();
  const bytes = fs.readFileSync(file('bridge.sqlite'));
  assert.throws(() => open(), /格式或版本不受支持/); assert.deepEqual(fs.readFileSync(file('bridge.sqlite')), bytes);
});

await test('foreign schema is not adopted and current schema tampering fails closed', async ({ open, file }) => {
  const s = open(); s.db.exec('ALTER TABLE accounts ADD COLUMN unexpected TEXT'); s.close();
  assert.throws(() => open(), /结构校验失败/);
  const before = fs.readFileSync(file('bridge.sqlite')); assert.throws(() => open()); assert.deepEqual(fs.readFileSync(file('bridge.sqlite')), before);
});

await test('transactions roll back raw documents, relational projections and uncommitted role mirrors together', async ({ root, open, file }) => {
  const s = open(), target = path.join(root, 'roles/rollback.md');
  const before = s.readText(file('conversation-roles.json'));
  assert.throws(() => s.transaction(() => {
    s.writeText(file('conversation-roles.json'), JSON.stringify({ version: 1, roles: { 'group:456': 'A' } }), before);
    s.writeText(target, '# should rollback', null); throw new Error('fixture rollback');
  }), /fixture rollback/);
  assert.equal(s.readText(file('conversation-roles.json')), before); assert.equal(fs.existsSync(target), false);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM conversation_roles').get().n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM role_cards').get().n, 0);
});

await test('nested savepoints isolate an inner failure while the outer transaction commits', async ({ open, file }) => {
  const s = open();
  s.transaction(() => {
    s.writeText(file('outer.json'), '{"version":1,"value":"outer"}', null);
    assert.throws(() => s.transaction(() => { s.writeText(file('inner.json'), '{"version":1}', null); throw new Error('inner'); }), /inner/);
    s.writeText(file('other.json'), '{"version":1}', null);
  });
  assert.match(s.readText(file('outer.json')), /outer/); assert.throws(() => s.readText(file('inner.json')), error => error.code === 'ENOENT');
  assert.throws(() => s.transaction(async () => {}), /必须同步/);
});

await test('two connections enforce CAS and never replace a newer document from an older snapshot', async ({ open, file }) => {
  const one = open(), two = open(), old = one.readText(file('conversation-roles.json'));
  one.writeText(file('conversation-roles.json'), '{"version":1,"roles":{"group:456":"B"}}', old);
  assert.throws(() => two.writeText(file('conversation-roles.json'), '{"version":1,"roles":{"group:789":"A"}}', old), /发生变化/);
  assert.equal(two.db.prepare('SELECT role_name FROM conversation_roles').get().role_name, 'B');
  assert.throws(() => one.writeText(file('other.json'), '{"version":1}'), /expectedText/);
});

await test('foreign keys and busy timeout are enabled and database mode is restricted', async ({ open, file }) => {
  const s = open(); assert.equal(s.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1); assert.equal(s.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.throws(() => s.db.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?,?)').run('hash', 'missing-account', 1, 1, 2), /FOREIGN KEY/);
  assert.throws(() => s.db.prepare('INSERT INTO selected_sessions VALUES (?,?,?,?)').run('primary', 'group:1', 'missing', 'missing'), /FOREIGN KEY/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file('bridge.sqlite')).mode & 0o777, 0o600);
});

await test('account SQL updates retain dependent identities and bot scopes stay separate while revoking sessions', async ({ root, open, file }) => {
  const old = await legacy(root), s = open(); const auth = createConsoleAuth({ file: file('console-auth.json'), storage: s });
  const admin = auth.authenticate('qq_console_session=' + old.admin.token);
  s.db.exec('CREATE TABLE test_account_dependents (account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE)');
  s.db.prepare('INSERT INTO test_account_dependents VALUES (?)').run(old.user.id);
  const changed = await auth.update(admin, { id: old.user.id, botScopes: [{ botId: 'beta', key: 'group:456' }], conversationKeys: ['private:123'] });
  assert.equal(changed.id, old.user.id); assert.equal(auth.authenticate('qq_console_session=' + old.login.token), null);
  const login = await auth.login({ username: 'reader', password }, 'fixture'); const user = auth.authenticate('qq_console_session=' + login.token);
  assert.equal(canAccessConversation(user, 'group:456', 'primary'), false); assert.equal(canAccessConversation(user, 'group:456', 'beta'), true);
  assert.equal(canAccessConversation(user, 'private:123'), true); assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM test_account_dependents').get().n, 1);
  assert.deepEqual(s.db.prepare('SELECT bot_id,conversation_key FROM account_scopes WHERE account_id=? ORDER BY bot_id').all(user.id).map(row => [row.bot_id, row.conversation_key]), [['beta', 'group:456'], ['primary', 'private:123']]);
  await auth.update(admin, { id: old.user.id, conversationKeys: [] });
  const next = await auth.login({ username: 'reader', password }, 'fixture');
  assert.equal(canAccessConversation(next.user, 'group:456', 'beta'), true); assert.equal(canAccessConversation(next.user, 'private:123'), false);
});

await test('role and archive adapters isolate the same conversation and model identifiers by bot', async ({ root, open, file }) => {
  await legacy(root); const s = open(), beta = s.forBot('beta'); const directory = path.join(root, 'workers/beta/state'); fs.mkdirSync(directory, { recursive: true });
  const roles = createConversationRoleStore(path.join(directory, 'conversation-roles.json'), path.join(directory, 'group-roles.json'), writer, { storage: beta });
  roles.set('group:456', 'B');
  const sessions = createConversationSessionStore(path.join(directory, 'conversation-sessions.json'), writer, { storage: beta });
  const state = sessions.read(), id = sessions.choose(state, 'group:456', 'B', { policy: 'beta-policy' }); state.records[id].sessionId = 'old-model-a'; sessions.write(state);
  assert.deepEqual(s.db.prepare('SELECT bot_id,role_name FROM conversation_roles ORDER BY bot_id').all().map(row => [row.bot_id, row.role_name]), [['beta', 'B'], ['primary', 'A']]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM archive_records WHERE session_id=?').get('old-model-a').n, 2);
  assert.throws(() => s.readText(path.join(directory, 'conversation-roles.json')), /不属于当前机器人/);
  assert.equal(JSON.parse(s.readText(file('conversation-roles.json'))).roles['group:456'], 'A');
});

await test('worker initial migration assigns its actual bot ID and missing archive migration runs only once', async ({ root, open, file }) => {
  json(file('conversation-roles.json'), { version: 1, roles: { 'group:456': 'B' } }); fs.writeFileSync(path.join(root, 'roles/B.md'), '# B');
  const s = open({ botId: 'beta' }); assert.equal(s.db.prepare('SELECT bot_id FROM conversation_roles').get().bot_id, 'beta');
  let calls = 0; const archive = createConversationSessionStore(file('conversation-sessions.json'), writer, { storage: s, legacy: () => { calls++; return [{ key: 'group:456', sessionId: 'legacy-beta', role: 'B', policy: 'p' }]; } });
  assert.equal(Object.values(archive.read().records)[0].sessionId, 'legacy-beta'); archive.read(); assert.equal(calls, 1);
  assert.equal(fs.existsSync(file('conversation-sessions.json')), false); assert.equal(s.db.prepare('SELECT bot_id FROM archive_records').get().bot_id, 'beta');
});

await test('role MD create/rename/delete mirrors files, ignores stale legacy after tombstones, and commits outer-transaction mirrors', async ({ root, open }) => {
  const s = open(), a = path.join(root, 'roles/A.md'), b = path.join(root, 'roles/B.md');
  s.transaction(() => s.writeText(a, '# A\ntext', null)); assert.equal(fs.readFileSync(a, 'utf8'), '# A\ntext');
  s.renameText(a, b, '# A\ntext'); assert.equal(fs.existsSync(a), false); assert.equal(fs.readFileSync(b, 'utf8'), '# A\ntext');
  s.deleteText(b, '# A\ntext'); fs.writeFileSync(b, 'stale recreated file');
  assert.throws(() => s.readText(b), error => error.code === 'ENOENT'); s.close(); const restarted = open();
  assert.equal(fs.existsSync(b), false); assert.equal(restarted.listDocuments(path.join(root, 'roles')).length, 0);
  assert.throws(() => restarted.readText(path.join(root, '../outside.json')), /根目录内/);
});

await test('member card/revision and bot-registry documents have validated relational projections', async ({ root, open, file }) => {
  const s = open(), owner = { id: 'fixture-owner', role: 'user', botScopes: [{ botId: 'primary', key: 'group:456' }] };
  const cards = createMemberPersonaService({ storage: s, rolesDir: path.join(root, 'roles'), readRole: name => { try { return s.readText(path.join(root, 'roles', name + '.md')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    writeRole(name, text) { const target = path.join(root, 'roles', name + '.md'); let old = null; try { old = s.readText(target); } catch (error) { if (error.code !== 'ENOENT') throw error; } s.writeText(target, text, old); }, listBindings: () => [], activateRole: async () => ({}) });
  const created = cards.create(owner, { name: 'My card', content: 'A friendly card' });
  const id = created.persona.id;
  cards.update(owner, { id, version: created.persona.version, name: 'Renamed card', content: 'A revised friendly card' });
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM member_cards').get().n, 1); assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM member_revisions').get().n, 2);
  assert.equal(s.db.prepare('SELECT owner_user_id FROM member_cards').get().owner_user_id, owner.id);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM role_cards').get().n, 1);
  const registry = file('bot-registry.json'); let revision = null;
  const bots = createBotManager({ read() { try { revision = s.readText(registry); return revision; } catch (error) { if (error.code !== 'ENOENT') throw error; revision = null; return null; } }, write(value) { const text = JSON.stringify(value); s.writeText(registry, text, revision); revision = text; } });
  bots.add({ id: 'beta', name: 'Beta', expectedQQ: '222222', port: 3201, machineToken: 'fixture-machine-token-only' });
  assert.equal(s.db.prepare('SELECT expected_qq FROM bots WHERE id=?').get('beta').expected_qq, '222222');
  const original = s.readText(registry);
  assert.throws(() => s.writeText(registry, '{"version":99,"bots":{}}', original)); assert.equal(s.readText(registry), original);
});

await test('SQL projection constraint failures roll back document text and do not corrupt the prior projection', async ({ root, open, file }) => {
  await legacy(root); const s = open(), other = path.join(root, 'other/conversation-roles.json');
  assert.throws(() => s.writeText(other, '{"version":1,"roles":{"group:456":"B"}}', null), /UNIQUE constraint/);
  assert.equal(s.db.prepare('SELECT role_name FROM conversation_roles WHERE bot_id=? AND conversation_key=?').get('primary', 'group:456').role_name, 'A');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM state_documents WHERE path=?').get('other/conversation-roles.json').n, 0);
  assert.equal(JSON.parse(s.readText(file('conversation-roles.json'))).roles['group:456'], 'A');
});

await test('failed role-file materialization keeps committed SQLite truth and a retryable outbox', async ({ root, open }) => {
  const s = open(), target = path.join(root, 'roles/blocked.md');
  assert.throws(() => s.readText(target), error => error.code === 'ENOENT');
  fs.mkdirSync(target); // The document exists in SQLite, but this mirror path is unusable.
  assert.throws(() => s.writeText(target, '# Committed card', null), error => error.committed === true);
  assert.equal(s.readText(target), '# Committed card');
  assert.equal(s.db.prepare('SELECT content FROM role_cards WHERE name=?').get('blocked').content, '# Committed card');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM role_materializations').get().n, 1);
  fs.rmdirSync(target); s.materializeText(target);
  assert.equal(fs.readFileSync(target, 'utf8'), '# Committed card');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM role_materializations').get().n, 0);
});

await test('independent asynchronous account writers cannot overwrite a concurrent committed account', async ({ root, open, file }) => {
  const old = await legacy(root), s = open(), second = open();
  const one = createConsoleAuth({ file: file('console-auth.json'), storage: s }), two = createConsoleAuth({ file: file('console-auth.json'), storage: second });
  const principal = one.authenticate('qq_console_session=' + old.admin.token);
  const results = await Promise.allSettled([one.create(principal, { username: 'concurrent-a', password }), two.create(principal, { username: 'concurrent-b', password })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 503);
  assert.equal(one.list(principal).length, 3); assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 3);
});

await test('a live external database version change also blocks further adapter reads and writes', async ({ open, file }) => {
  const one = open(), two = open();
  two.db.exec('PRAGMA user_version=99');
  const before = fs.readFileSync(file('bridge.sqlite'));
  assert.throws(() => one.readText(file('conversation-roles.json')), /版本已变化/);
  assert.throws(() => one.writeText(file('conversation-roles.json'), '{"version":1,"roles":{}}', null), /版本已变化/);
  assert.deepEqual(fs.readFileSync(file('bridge.sqlite')), before);
});

console.log(`SQLite state: ${passed} tests passed`);
