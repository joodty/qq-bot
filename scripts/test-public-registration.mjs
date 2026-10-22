import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { createSqliteState } from '../src/sqlite-state.js';
import { createConsoleAuth, canAccessConversation } from '../src/console-auth.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const password = 'Fixture_10', cookie = token => 'qq_console_session=' + token;
let passed = 0;
async function test(name, run, { bootstrap = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-public-register-')); fs.mkdirSync(path.join(root, 'state'));
  const file = path.join(root, 'state/console-auth.json'), opened = [];
  let clock = Date.now();
  const store = () => { const s = createSqliteState({ root, file: path.join(root, 'state/manager.sqlite') }); opened.push(s); return s; };
  const s = store(), make = (storage = s, options = {}) => createConsoleAuth({ file, storage, now: () => clock, ...options });
  const auth = make(); let admin;
  if (bootstrap) { const result = await auth.bootstrap({ password }, 'bootstrap-fixture'); admin = auth.authenticate(cookie(result.token)); }
  try { await run({ root, file, s, store, make, auth, admin, tick: ms => { clock += ms; } }); passed++; console.log('PASS', name); }
  finally { for (const storage of opened.reverse()) storage.close(); fs.rmSync(root, { force: true, recursive: true }); }
}

await test('public registration persists exactly one ordinary empty-scope account and auto-login cookie in SQLite', async ({ auth, s, file }) => {
  assert.equal(auth.registrationEnabled(), true);
  const result = await auth.register({ username: 'New.User', password }, 'registration-client');
  assert.equal(result.user.role, 'user'); assert.equal(result.user.username, 'new.user'); assert.equal(result.user.disabled, false);
  assert.deepEqual(result.user.conversationKeys, []); assert.deepEqual(result.user.botScopes, []);
  const principal = auth.authenticate(cookie(result.token)); assert.equal(principal.id, result.user.id); assert.equal(principal.role, 'user');
  assert.equal(canAccessConversation(principal, 'private:123'), false); assert.equal(canAccessConversation(principal, 'group:123', 'secondary'), false);
  const data = JSON.parse(s.readText(file)); assert.equal(data.users.filter(user => user.role === 'admin').length, 1); assert.equal(data.users.length, 2);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM account_scopes WHERE account_id=?').get(principal.id).n, 0);
  assert.equal(s.readText(file).includes(password), false); assert.equal(s.readText(file).includes(result.token), false);
  assert.equal(data.users.find(user => user.id === principal.id).password.algorithm, 'scrypt-v1');
  assert.match(auth.cookie(result.token, true), /HttpOnly; SameSite=Strict; Max-Age=2592000; Secure/);
});

await test('registration cannot initialize or replace the sole admin and waits for internal setup', async ({ auth, s, file }) => {
  assert.equal(auth.registrationEnabled(), false);
  await assert.rejects(auth.register({ username: 'admin', password }, 'fixture'), { statusCode: 409 });
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 0);
  assert.throws(() => s.readText(file), { code: 'ENOENT' });
  const initial = await auth.bootstrap({ password }, 'internal-init'); assert.equal(initial.user.role, 'admin');
  await assert.rejects(auth.register({ username: 'ADMIN', password }, 'fixture'), { statusCode: 409 });
  const ordinary = await auth.register({ username: 'friend', password }, 'fixture'); assert.equal(ordinary.user.role, 'user');
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM accounts WHERE role='admin'").get().n, 1);
}, { bootstrap: false });

await test('every role ownership scope and identity injection is rejected rather than silently accepted', async ({ auth, s, file }) => {
  const before = s.readText(file);
  const injections = [ ['role', 'admin'], ['disabled', false], ['owner', true], ['ownerUserId', 'a'.repeat(32)], ['ownerQQ', '123'],
    ['conversationKeys', ['group:123']], ['botScopes', [{ botId: 'primary', key: 'private:123' }]], ['scopes', ['*']],
    ['ownedBotIds', ['primary']], ['permissions', { admin: true }], ['id', 'a'.repeat(32)], ['passwordVersion', 10], ['token', 'secret'] ];
  for (const [index, [field, value]] of injections.entries()) await assert.rejects(auth.register({ username: 'inject-' + index, password, [field]: value }, 'fixture'), { statusCode: 400 });
  for (const input of [null, [], {}, { username: 'missing' }, { password }, JSON.parse('{"username":"proto-test","password":"Fixture_10","__proto__":{"role":"admin"}}')]) await assert.rejects(auth.register(input, 'fixture'), { statusCode: 400 });
  assert.equal(s.readText(file), before); assert.equal(s.db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 1);
});

await test('username normalization duplicates and password minimum ten characters are enforced', async ({ auth }) => {
  await assert.rejects(auth.register({ username: 'short', password: '123456789' }, 'fixture'), { statusCode: 400 });
  for (const username of ['ab', 'with spaces', 'bad/name', 'a'.repeat(33)]) await assert.rejects(auth.register({ username, password }, 'fixture'), { statusCode: 400 });
  const result = await auth.register({ username: 'TEN-CHARS', password: '1234567890' }, 'fixture'); assert.equal(result.user.username, 'ten-chars');
  await assert.rejects(auth.register({ username: 'ten-chars', password }, 'fixture'), { statusCode: 409 });
});

await test('registered cookie and scrypt hash survive a new SQLite connection without changing legacy files', async ({ auth, make, store, s, file }) => {
  const result = await auth.register({ username: 'persistent', password }, 'fixture'); const before = s.readText(file);
  const reopened = make(store()); const principal = reopened.authenticate(cookie(result.token)); assert.equal(principal.id, result.user.id);
  assert.equal((await reopened.login({ username: 'persistent', password }, 'fixture')).user.id, result.user.id);
  assert.equal(JSON.parse(before).users.find(user => user.id === principal.id).password.key, s.db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(principal.id).password_hash);
  assert.equal(fs.existsSync(file), false);
});

await test('registered user cannot list create update or disable accounts and disabled names cannot register again', async ({ auth, admin, s }) => {
  const result = await auth.register({ username: 'ordinary', password }, 'fixture'), principal = auth.authenticate(cookie(result.token));
  assert.throws(() => auth.list(principal), { statusCode: 403 });
  await assert.rejects(auth.create(principal, { username: 'forged', password }), { statusCode: 403 });
  await assert.rejects(auth.update(principal, { id: admin.id, disabled: true }), { statusCode: 403 });
  await auth.update(admin, { id: result.user.id, disabled: true }); assert.equal(auth.authenticate(cookie(result.token)), null);
  await assert.rejects(auth.login({ username: 'ordinary', password }, 'fixture'), { statusCode: 401 });
  await assert.rejects(auth.register({ username: 'ordinary', password }, 'fixture'), { statusCode: 409 });
  assert.equal(s.db.prepare('SELECT disabled FROM accounts WHERE id=?').get(result.user.id).disabled, 1);
});

await test('simultaneous normalized same-name registrations create one account and one cookie only', async ({ auth, s }) => {
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => auth.register({ username: i % 2 ? 'same-user' : 'SAME-USER', password }, 'fixture')));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.statusCode, 409);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM accounts WHERE username='same-user'").get().n, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM auth_sessions WHERE account_id IN (SELECT id FROM accounts WHERE username=?)').get('same-user').n, 1);
});

await test('independent auth instances use CAS for the same username and leave no orphan sessions', async ({ auth, make, store, s }) => {
  const other = make(store()); const results = await Promise.allSettled([auth.register({ username: 'cross-instance', password }, 'a'), other.register({ username: 'CROSS-INSTANCE', password }, 'b')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 409);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM accounts WHERE username='cross-instance'").get().n, 1);
  assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

await test('parallel different-name writers preserve the winner and refuse stale snapshots without overwriting', async ({ auth, make, store, s }) => {
  const other = make(store()); const results = await Promise.allSettled([auth.register({ username: 'first-one', password }, 'a'), other.register({ username: 'second-one', password }, 'b')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 503);
  const winner = results.find(result => result.status === 'fulfilled').value;
  assert.equal(auth.authenticate(cookie(winner.token)).id, winner.user.id); assert.equal(s.db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 2);
});

await test('explicit closed registration leaves existing cookies and login usable', async ({ auth, make, admin }) => {
  const registered = await auth.register({ username: 'existing', password }, 'fixture'); const closed = make(undefined, { allowRegistration: false });
  assert.equal(closed.registrationEnabled(), false); await assert.rejects(closed.register({ username: 'new-one', password }, 'fixture'), { statusCode: 403 });
  assert.equal(closed.authenticate(cookie(registered.token)).id, registered.user.id); assert.equal((await closed.login({ username: 'existing', password }, 'fixture')).user.id, registered.user.id);
  assert.equal(auth.list(admin).length, 2); assert.throws(() => make(undefined, { allowRegistration: 'false' }));
});

await test('registration shares actual-remote and normalized-name rate limits before password work', async ({ auth, tick }) => {
  for (let i = 0; i < 12; i++) await assert.rejects(auth.register({ username: 'rate-name', password: 'short' }, 'fixture'), { statusCode: 400 });
  await assert.rejects(auth.register({ username: 'RATE-NAME', password }, 'different-client'), { statusCode: 429 });
  tick(15 * 60000); assert.equal((await auth.register({ username: 'rate-name', password }, 'fixture')).user.role, 'user');
});

await test('damaged future or missing-admin SQLite source fails closed and preserves exact input', async ({ auth, s }) => {
  for (const raw of ['{broken', '{"version":99,"users":[],"sessions":[]}', '{"version":1,"users":[],"sessions":[]}']) {
    s.db.prepare('UPDATE state_documents SET raw_text=? WHERE path=?').run(raw, 'state/console-auth.json');
    await assert.rejects(auth.register({ username: 'new-person', password }, 'fixture'), { statusCode: 503 });
    assert.equal(s.db.prepare('SELECT raw_text FROM state_documents WHERE path=?').get('state/console-auth.json').raw_text, raw);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 1);
  }
});

await test('external future state during asynchronous registration scrypt is not downgraded or overwritten', async ({ auth, s }) => {
  const pending = auth.register({ username: 'future-race', password }, 'fixture'); await immediate();
  const future = '{"version":99,"users":[],"sessions":[]}';
  s.db.prepare('UPDATE state_documents SET raw_text=? WHERE path=?').run(future, 'state/console-auth.json');
  await assert.rejects(pending, { statusCode: 503 }); assert.equal(s.db.prepare('SELECT raw_text FROM state_documents WHERE path=?').get('state/console-auth.json').raw_text, future);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 1);
});

{
  const machineToken = 'fixture-registration-machine-token';
  const h = await bridgeHarness({ config: { storage: { driver: 'sqlite' }, consoleToken: machineToken } });
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, { body, headers = {} } = {}) => {
    const response = await fetch(base + route, { redirect: 'manual', method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, data: await response.json().catch(() => null), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    assert.equal((await request('/api/auth/bootstrap', { body: { password }, headers: { 'x-console-token': machineToken, origin: base } })).status, 403);
    assert.equal((await request('/api/auth/bootstrap', { body: { password }, headers: { 'x-console-token': machineToken } })).status, 200);
    const registered = await request('/api/auth/register', { body: { username: 'web-user', password }, headers: { origin: base } });
    assert.equal(registered.status, 200); assert.equal(registered.data.user.role, 'user'); assert.deepEqual(registered.data.user.botScopes, []);
    assert.ok(registered.cookie); assert.match(registered.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await request('/api/auth/status', { headers: { cookie: registered.cookie } })).data.authenticated, true);
    assert.equal((await request('/api/status?token=' + machineToken)).status, 401);
    assert.equal((await request('/api/status', { headers: { 'x-console-token': machineToken, origin: base } })).status, 401);
    assert.equal((await request('/api/status', { headers: { 'x-console-token': machineToken, 'sec-fetch-site': 'same-origin' } })).status, 401);
    assert.equal((await request('/api/status', { headers: { 'x-console-token': machineToken, cookie: registered.cookie } })).status, 403);
    assert.equal((await request('/api/status', { headers: { 'x-console-token': machineToken, cookie: registered.cookie, 'x-agent-call': '1' } })).status, 403);
    assert.equal((await request('/api/auth/register', { body: { username: 'agent-user', password }, headers: { 'x-console-token': machineToken, 'x-agent-call': '1' } })).status, 403);
    assert.equal((await request('/api/status', { headers: { 'x-console-token': machineToken } })).status, 200);
    assert.equal((await request('/', { headers: { 'x-console-token': machineToken } })).headers.get('location'), '/login');
    assert.equal((await request('/api/auth/register', { body: { username: 'evil-origin', password }, headers: { origin: 'https://evil.test' } })).status, 403);
    assert.equal(h.calls.prompts.length, 0); assert.equal(h.calls.sent.length, 0);
    passed++; console.log('PASS real HTTP registration uses cookie only; query, browser machine headers and agent combinations never elevate authority');
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}

console.log(`Public registration: ${passed} tests passed`);
