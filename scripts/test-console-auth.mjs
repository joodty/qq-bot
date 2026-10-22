import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConsoleAuth, canAccessConversation } from '../src/console-auth.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const password = 'fixture-10';
const secondPassword = 'fixture-11';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-console-auth-test-'));
let count = 0, serial = 0;
function fixture() {
  const file = path.join(root, `auth-${++serial}.json`); let clock = Date.now();
  const auth = createConsoleAuth({ file, now: () => clock, sessionTtlMs: 60000 });
  const cookie = token => auth.cookie(token).split(';')[0];
  return { auth, file, cookie, clock: value => { clock = value; }, advance: ms => { clock += ms; } };
}
async function test(name, run) { await run(); count++; console.log('PASS', name); }
const statusIs = code => error => error.statusCode === code;
async function admin(f) { const login = await f.auth.bootstrap({ password }, 'local'); return { login, principal: f.auth.authenticate(f.cookie(login.token)) }; }
try {
  await test('legacy absence stays untouched until explicit administrator activation', () => {
    const f = fixture(); assert.equal(f.auth.configured(), false); assert.equal(f.auth.authenticate(''), null);
    assert.deepEqual(f.auth.status(null), { ok: true, configured: false, authenticated: false, user: null });
    assert.equal(fs.existsSync(f.file), false);
  });
  await test('activation stores salted scrypt only and random session hashes, with strict browser cookie flags', async () => {
    const f = fixture(); const { login, principal } = await admin(f);
    const text = fs.readFileSync(f.file, 'utf8'), stored = JSON.parse(text);
    assert.ok(!text.includes(password)); assert.ok(!text.includes(login.token));
    assert.equal(stored.users[0].password.algorithm, 'scrypt-v1'); assert.equal(stored.users[0].password.salt.length, 32);
    assert.equal(stored.sessions[0].hash.length, 64); assert.equal(principal.role, 'admin');
    assert.match(f.auth.cookie(login.token, true), /HttpOnly; SameSite=Strict; Max-Age=60; Secure$/);
    assert.doesNotMatch(f.auth.cookie(login.token), /; Secure/);
    assert.match(f.auth.clearCookie(true), /Max-Age=0; Secure$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  });
  await test('single administrator and simultaneous bootstrap cannot create two administrators', async () => {
    const f = fixture(); const results = await Promise.allSettled([f.auth.bootstrap({ password }, 'local'), f.auth.bootstrap({ password }, 'local')]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.statusCode, 409);
    assert.equal(JSON.parse(fs.readFileSync(f.file)).users.filter(u => u.role === 'admin').length, 1);
  });
  await test('login survives service restart, rotates random session tokens, rejects wrong password uniformly', async () => {
    const f = fixture(); const { login } = await admin(f);
    const restarted = createConsoleAuth({ file: f.file });
    assert.equal(restarted.authenticate(f.cookie(login.token)).username, 'admin');
    await assert.rejects(restarted.login({ username: 'admin', password: 'incorrect' }, 'local'), statusIs(401));
    await assert.rejects(restarted.login({ username: 'absent', password }, 'local'), statusIs(401));
    const next = await restarted.login({ username: 'ADMIN', password }, 'local'); assert.notEqual(next.token, login.token);
    assert.notEqual(JSON.parse(fs.readFileSync(f.file)).sessions[0].hash, next.token);
  });
  await test('sessions expire at the exact boundary and malformed/duplicate cookies grant nothing', async () => {
    const f = fixture(); const { login } = await admin(f);
    assert.equal(f.auth.authenticate('qq_console_session=garbage'), null);
    assert.equal(f.auth.authenticate(f.cookie(login.token) + '; ' + f.cookie(login.token)), null);
    f.advance(60000); assert.equal(f.auth.authenticate(f.cookie(login.token)), null);
  });
  await test('logout persists revocation across restarts without revoking other valid sessions', async () => {
    const f = fixture(); const { login, principal } = await admin(f);
    const second = await f.auth.login({ username: 'admin', password }, 'local');
    await f.auth.logout(principal);
    assert.equal(createConsoleAuth({ file: f.file }).authenticate(f.cookie(login.token)), null);
    assert.equal(f.auth.authenticate(f.cookie(second.token)).role, 'admin');
  });
  await test('ordinary account defaults to empty scope and can access only canonical assigned conversations', async () => {
    const f = fixture(); const { principal } = await admin(f);
    const user = await f.auth.create(principal, { username: 'reader', password }); assert.deepEqual(user.conversationKeys, []);
    const session = await f.auth.login({ username: 'reader', password }, 'local'); const p = f.auth.authenticate(f.cookie(session.token));
    assert.equal(canAccessConversation(p, 'group:123'), false); assert.equal(canAccessConversation(null, 'group:123'), false);
    const changed = await f.auth.update(principal, { id: user.id, conversationKeys: ['group:00123', 'private:99', 'group:123'] });
    assert.deepEqual(changed.conversationKeys, ['group:123', 'private:99']);
    const next = await f.auth.login({ username: 'reader', password }, 'local'); const nextP = f.auth.authenticate(f.cookie(next.token));
    assert.equal(canAccessConversation(nextP, 'group:123'), true); assert.equal(canAccessConversation(nextP, 'group:456'), false);
    assert.equal(canAccessConversation(nextP, 'internal:job'), false); assert.equal(canAccessConversation(principal, 'group:123'), true);
    await assert.rejects(f.auth.update(principal, { id: user.id, conversationKeys: ['internal:job'] }), statusIs(400));
  });
  await test('usernames rename by stable ID; scope changes, rename, disable, and password reset revoke sessions', async () => {
    const f = fixture(); const { principal } = await admin(f);
    const user = await f.auth.create(principal, { username: 'reader', password, conversationKeys: ['group:1'] });
    let login = await f.auth.login({ username: 'reader', password }, 'local');
    const renamed = await f.auth.update(principal, { id: user.id, username: 'renamed' });
    assert.equal(renamed.id, user.id); assert.equal(f.auth.authenticate(f.cookie(login.token)), null);
    login = await f.auth.login({ username: 'renamed', password }, 'local');
    await f.auth.update(principal, { id: user.id, disabled: true }); assert.equal(f.auth.authenticate(f.cookie(login.token)), null);
    await assert.rejects(f.auth.login({ username: 'renamed', password }, 'local'), statusIs(401));
    await f.auth.update(principal, { id: user.id, disabled: false, password: secondPassword });
    await assert.rejects(f.auth.login({ username: 'renamed', password }, 'local'), statusIs(401));
    assert.equal((await f.auth.login({ username: 'renamed', password: secondPassword }, 'local')).user.id, user.id);
  });
  await test('ordinary users cannot manage accounts or disable/demote the unique administrator', async () => {
    const f = fixture(); const { principal } = await admin(f);
    await f.auth.create(principal, { username: 'reader', password });
    const login = await f.auth.login({ username: 'reader', password }, 'local'); const user = f.auth.authenticate(f.cookie(login.token));
    assert.throws(() => f.auth.list(user), statusIs(403));
    await assert.rejects(f.auth.create(user, { username: 'other', password }), statusIs(403));
    await assert.rejects(f.auth.update(user, { id: principal.id, disabled: true }), statusIs(403));
    await assert.rejects(f.auth.update(principal, { id: principal.id, disabled: true }), statusIs(403));
    await assert.rejects(f.auth.update(principal, { id: principal.id, role: 'user' }), statusIs(400));
    assert.equal(f.auth.list(principal).filter(u => u.role === 'admin' && !u.disabled).length, 1);
  });
  await test('changing own password verifies the current password and revokes all sessions atomically', async () => {
    const f = fixture(); const { principal, login } = await admin(f);
    const other = await f.auth.login({ username: 'admin', password }, 'local');
    await assert.rejects(f.auth.changePassword(principal, { currentPassword: 'wrong', newPassword: secondPassword }, 'local'), statusIs(401));
    assert.ok(f.auth.authenticate(f.cookie(login.token)));
    await f.auth.changePassword(principal, { currentPassword: password, newPassword: secondPassword }, 'local');
    assert.equal(f.auth.authenticate(f.cookie(login.token)), null); assert.equal(f.auth.authenticate(f.cookie(other.token)), null);
    assert.equal((await f.auth.login({ username: 'admin', password: secondPassword }, 'local')).user.role, 'admin');
    await assert.rejects(f.auth.login({ username: 'admin', password }, 'local'), statusIs(401));
  });
  await test('credential validation, name uniqueness, and random salts prevent accidental ambiguous accounts', async () => {
    const f = fixture(); const { principal } = await admin(f);
    await assert.rejects(f.auth.create(principal, { username: 'xy', password }), statusIs(400));
    await assert.rejects(f.auth.create(principal, { username: 'reader', password: '123456789' }), statusIs(400));
    await f.auth.create(principal, { username: 'Reader', password });
    await assert.rejects(f.auth.create(principal, { username: 'READER', password }), statusIs(409));
    const data = JSON.parse(fs.readFileSync(f.file)); assert.notEqual(data.users[0].password.salt, data.users[1].password.salt);
    assert.notEqual(data.users[0].password.key, data.users[1].password.key);
    assert.ok(f.auth.list(principal).every(u => !('password' in u) && !('passwordVersion' in u)));
  });
  await test('corrupt, future, missing-admin, invalid sessions and unknown-field stores never downgrade or overwrite', async () => {
    const f = fixture(); await admin(f); const valid = JSON.parse(fs.readFileSync(f.file));
    const variants = ['{broken', JSON.stringify({ ...valid, version: 99 }), JSON.stringify({ version: 1, users: [], sessions: [] }),
      JSON.stringify({ ...valid, unknown: true }), JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], hash: 'not-a-hash' }] }),
      JSON.stringify({ ...valid, users: [{ ...valid.users[0], disabled: true }] })];
    for (const content of variants) {
      f.advance(15 * 60000);
      fs.writeFileSync(f.file, content);
      assert.throws(() => f.auth.configured(), statusIs(503));
      await assert.rejects(f.auth.bootstrap({ password }, 'local'), statusIs(503));
      await assert.rejects(f.auth.login({ username: 'admin', password }, 'local'), statusIs(503));
      assert.equal(fs.readFileSync(f.file, 'utf8'), content);
    }
  });
  await test('external store replacement during asynchronous hashing is preserved instead of silently overwritten', async () => {
    const f = fixture(); const pending = f.auth.bootstrap({ password }, 'local');
    await new Promise(resolve => setImmediate(resolve));
    fs.writeFileSync(f.file, '{"version":99,"users":[],"sessions":[]}');
    await assert.rejects(pending, statusIs(503));
    assert.equal(JSON.parse(fs.readFileSync(f.file)).version, 99);
  });
  await test('login rate limit applies before expensive password work and expires after15min', async () => {
    const f = fixture(); await admin(f);
    for (let i = 0; i < 12; i++) await assert.rejects(f.auth.login({ username: 'absent', password: 'wrong' }, 'same-peer'), statusIs(401));
    await assert.rejects(f.auth.login({ username: 'absent', password: 'wrong' }, 'different-peer'), statusIs(429));
    f.advance(15 * 60000); await assert.rejects(f.auth.login({ username: 'absent', password: 'wrong' }, 'same-peer'), statusIs(401));
  });

  async function serverFixture(run, { config = {} } = {}) {
    const h = await bridgeHarness({ config, files: { 'public/login.html': '<!doctype html><title>Fixture login</title>', 'public/viewer.html': '<!doctype html><title>Fixture viewer</title>', 'public/console.html': '<!doctype html><title>Fixture console</title>' } });
    const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const request = async (route, { body, cookie, token = false, headers = {} } = {}) => {
      const response = await fetch(url + route, { redirect: 'manual', method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-console-token': 'fixture-console-token' } : {}), ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    try { await run({ h, request, url }); }
    finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
  }
  await test('public login page and account status never accept URL credentials or expose a token login', () => serverFixture(async ({ request }) => {
    assert.equal((await request('/')).headers.get('location'), '/login');
    assert.equal((await request('/login')).status, 200);
    assert.equal((await request('/api/auth/status')).data.configured, false);
    assert.equal((await request('/?token=fixture-console-token')).headers.get('location'), '/login');
    assert.equal((await request('/api/status?token=fixture-console-token')).status, 401);
    assert.equal((await request('/', { token:true })).headers.get('location'), '/login');
    assert.equal((await request('/api/status', { token: true })).status, 200);
    const state = await request('/api/auth/status', { token: true }); assert.equal(state.data.authenticated, false); assert.equal(state.data.user, null);
    assert.equal((await request('/api/auth/bootstrap', { body: { password } })).status, 401);
    assert.equal((await request('/api/auth/bootstrap?token=fixture-console-token', { body: { password } })).status, 401);
  }));
  await test('real routes bootstrap and cookie refresh admin, create reader and enforce all legacy API boundaries', () => serverFixture(async ({ request, h }) => {
    const setup = await request('/api/auth/bootstrap', { token: true, body: { password } }); assert.equal(setup.status, 200);
    const cookie = setup.cookie; assert.ok(cookie); assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await request('/api/status', { cookie })).status, 200); assert.equal((await request('/', { cookie })).status, 200);
    assert.equal((await request('/login', { cookie })).headers.get('location'), '/');
    assert.equal((await request('/api/auth/status', { cookie })).data.user.username, 'admin');
    assert.equal((await request('/api/auth/bootstrap', { token: true, body: { password } })).status, 409);
    const created = await request('/api/auth/users', { cookie, body: { username: 'reader', password, conversationKeys: ['group:456'] } }); assert.equal(created.status, 200);
    const login = await request('/api/auth/login', { body: { username: 'reader', password } }); assert.equal(login.status, 200);
    const reader = login.cookie;
    assert.equal((await request('/', { cookie: reader })).headers.get('location'), '/workspace');
    assert.equal((await request('/viewer', { cookie: reader })).status, 200);
    for (const route of ['/api/status', '/api/sessions', '/api/roles', '/api/security', '/api/tokens/summary', '/api/auth/users']) assert.equal((await request(route, { cookie: reader })).status, 403, route);
    assert.equal((await request('/api/role', { cookie: reader, body: { role: '无权' } })).status, 403);
    assert.equal((await request('/api/auth/users', { cookie: reader, body: { username: 'other', password } })).status, 403);
    assert.equal(h.calls.sent.length, 0); assert.equal(h.calls.prompts.length, 0);
  }));
  await test('cookie plus forged agent headers never borrows legacy MCP privilege, but existing MCP token channel works', () => serverFixture(async ({ request, h }) => {
    const setup = await request('/api/auth/bootstrap', { token: true, body: { password } });
    const agentToken = h.getSocialV2State('group:456').agentToken;
    for (const headers of [{ 'x-agent-call': '1' }, { 'x-agent-token': agentToken }, { 'x-agent-call': '1', 'x-agent-token': agentToken }]) {
      assert.equal((await request('/api/status', { cookie: setup.cookie, token: true, headers })).status, 403);
      assert.equal((await request('/api/auth/bootstrap', { token: true, headers, body: { password } })).status, 403);
      assert.equal((await request('/api/auth/users', { token: true, headers })).status, 403);
    }
    const minimal = await request('/api/status', { token: true, headers: { 'x-agent-call': '1' } });
    assert.equal(minimal.status, 200); assert.equal(minimal.data.activity, undefined);
    assert.equal((await request('/api/status', { headers: { 'x-agent-call': '1', 'x-agent-token': agentToken } })).status, 403);
  }));
  await test('JSON and same-origin rules cover login/bootstrap/password before authentication', () => serverFixture(async ({ request, url }) => {
    assert.equal((await request('/api/auth/login', { body: { username: 'admin', password }, headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await request('/api/auth/bootstrap', { token: true, body: { password }, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request('/api/auth/login', { body: { username: 'admin', password }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await request('/api/auth/bootstrap', { token: true, body: { password }, headers: { origin: url } })).status, 403);
    assert.equal((await request('/api/auth/bootstrap', { token: true, body: { password } })).status, 200);
  }));
  await test('public registration logs in a zero-scope user and machine headers cannot elevate a browser or cookie', () => serverFixture(async ({request,url,h}) => {
    assert.equal((await request('/api/auth/status')).data.registrationEnabled,false);
    assert.equal((await request('/api/auth/register',{body:{username:'reader',password}})).status,409);
    const setup=await request('/api/auth/bootstrap',{token:true,body:{password}});assert.equal(setup.status,200);
    assert.equal((await request('/api/auth/status')).data.registrationEnabled,true);
    assert.equal((await request('/api/auth/register',{body:{username:'reader',password,role:'admin'}})).status,400);
    assert.equal((await request('/api/auth/register',{body:{username:'reader',password},headers:{origin:'https://evil.example'}})).status,403);
    const created=await request('/api/auth/register',{body:{username:'reader',password},headers:{origin:url,'sec-fetch-site':'same-origin'}});
    assert.equal(created.status,200);assert.equal(created.data.user.role,'user');assert.deepEqual(created.data.user.botScopes,[]);assert.deepEqual(created.data.user.conversationKeys,[]);
    assert.match(created.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    assert.equal((await request('/api/auth/status',{cookie:created.cookie})).data.user.username,'reader');
    for(const headers of [{origin:url},{'sec-fetch-site':'same-origin'},{'sec-fetch-dest':'empty'}])assert.equal((await request('/api/status',{token:true,headers})).status,401);
    assert.equal((await request('/api/status',{cookie:created.cookie,token:true})).status,403);
    assert.equal((await request('/api/auth/users',{cookie:created.cookie,token:true})).status,403);
    assert.equal((await request('/api/auth/users',{cookie:setup.cookie,token:true})).status,200);
    assert.equal((await request('/api/auth/register',{body:{username:'reader',password}})).status,409);
    assert.equal(h.calls.sent.length,0);assert.equal(h.calls.prompts.length,0);
  },{config:{storage:{driver:'sqlite'}}}));
  await test('registration may be closed without disabling existing account login', () => serverFixture(async ({request}) => {
    await request('/api/auth/bootstrap',{token:true,body:{password}});
    assert.equal((await request('/api/auth/status')).data.registrationEnabled,false);
    assert.equal((await request('/api/auth/register',{body:{username:'reader',password}})).status,403);
    assert.equal((await request('/api/auth/login',{body:{username:'admin',password}})).status,200);
  },{config:{consoleAuth:{registrationEnabled:false}}}));
  await test('Secure is explicit server configuration and cannot be forged via forwarded protocol headers', () => serverFixture(async ({ request }) => {
    const result = await request('/api/auth/bootstrap', { token: true, body: { password }, headers: { 'x-forwarded-proto': 'https' } });
    assert.doesNotMatch(result.headers.get('set-cookie'), /; Secure/);
  }));
  await test('explicit HTTPS deployment setting adds Secure cookies even behind loopback reverse proxy', () => serverFixture(async ({ request }) => {
    const setup = await request('/api/auth/bootstrap', { token: true, body: { password } }); assert.match(setup.headers.get('set-cookie'), /; Secure/);
  }, { config: { consoleAuth: { secureCookie: true } } }));
  await test('real password and logout endpoints revoke persistent sessions and return a cleared cookie', () => serverFixture(async ({ request }) => {
    const setup = await request('/api/auth/bootstrap', { token: true, body: { password } });
    const second = await request('/api/auth/login', { body: { username: 'admin', password } });
    const changed = await request('/api/auth/password', { cookie: setup.cookie, body: { currentPassword: password, newPassword: secondPassword } });
    assert.equal(changed.status, 200); assert.match(changed.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request('/api/status', { cookie: second.cookie })).status, 401);
    const next = await request('/api/auth/login', { body: { username: 'admin', password: secondPassword } });
    assert.equal(next.status, 200);
    const out = await request('/api/auth/logout', { cookie: next.cookie, body: {} }); assert.equal(out.status, 200);
    assert.equal((await request('/api/status', { cookie: next.cookie })).status, 401);
  }));
  await test('damaged auth store blocks cookie and machine management routes without resetting persisted bytes', () => serverFixture(async ({ request, h }) => {
    const setup = await request('/api/auth/bootstrap', { token: true, body: { password } });
    const file = path.join(h.temp, 'state/console-auth.json'); const future = '{"version":99,"users":[],"sessions":[]}';
    fs.writeFileSync(file, future);
    for (const route of ['/api/auth/status', '/api/status', '/api/auth/users']) {
      assert.equal((await request(route, { cookie: setup.cookie })).status, 503);
      assert.equal((await request(route, { token: true })).status, 503);
    }
    assert.equal((await request('/api/auth/bootstrap', { token: true, body: { password } })).status, 503);
    assert.equal(fs.readFileSync(file, 'utf8'), future);
  }));
  await test('forged X-Forwarded-For values cannot escape actual socket rate limit', () => serverFixture(async ({ request }) => {
    for (let i = 0; i < 30; i++) {
      const r = await request('/api/auth/login', { body: { username: 'absent' + i, password: 'wrong' }, headers: { 'x-forwarded-for': '198.51.100.' + i } });
      assert.equal(r.status, 401);
    }
    assert.equal((await request('/api/auth/login', { body: { username: 'another-absent', password: 'wrong' }, headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 429);
  }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`Console auth: ${count} tests passed`);
