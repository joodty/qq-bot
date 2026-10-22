import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteState } from '../src/sqlite-state.js';
import { createConsoleAuth } from '../src/console-auth.js';
import { createTenantService, validateTenantText, TENANT_ENDPOINT, TENANT_MODELS } from '../src/tenant-service.js';

const keyA = 'sk-' + 'a'.repeat(32), keyB = 'sk-' + 'b'.repeat(32), password = 'tenant-fixture-password';
let passed = 0;
async function test(name, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tenant-service-')); fs.mkdirSync(path.join(root, 'state'));
  const file = path.join(root, 'state/tenants.json'), masterKeyFile = path.join(root, 'state/tenant-key'), database = path.join(root, 'state/manager.sqlite');
  const opened = [], store = () => { const s = createSqliteState({ root, file: database }); opened.push(s); return s; };
  const s = store(); let clock = Date.parse('2026-10-22T01:00:00Z');
  const auth = createConsoleAuth({ storage: s, file: path.join(root, 'state/console-auth.json'), now: () => clock });
  const login = await auth.bootstrap({ password }, 'fixture'); const admin = auth.authenticate('qq_console_session=' + login.token);
  const alice = await auth.create(admin, { username: 'alice', password, conversationKeys: ['group:123'] });
  const bob = await auth.create(admin, { username: 'bob', password });
  const make = (storage = s) => createTenantService({ storage, file, masterKeyFile, now: () => clock });
  const bind = (service, principal, value) => { const challenge = service.issueBinding(principal, { qq: value }); return service.consumeBinding({ qq: value, code: challenge.code }); };
  const profile = (service, principal, apiKey = keyA) => service.saveProfile(principal, { name: '自己的DeepSeek', model: 'deepseek-flash', apiKey, version: 0 });
  const claim = (service, principal, botId = 'alice-bot', value = '444') => service.claimBot(principal, { id: botId, name: '自有机器人', expectedQQ: value, actualQQ: value, verifiedAt: clock, qqOnline: true, dshReady: true });
  try { await run({ root, file, masterKeyFile, database, s, store, auth, admin, alice, bob, make, bind, profile, claim, tick: ms => { clock += ms; } }); passed++; console.log('PASS', name); }
  finally { for (const storage of opened.reverse()) storage.close(); fs.rmSync(root, { force: true, recursive: true }); }
}

await test('empty workspaces grant no QQ authority or bot ownership and do not create a key until needed', ({ make, alice, masterKeyFile }) => {
  const tenant = make(), view = tenant.overview(alice); assert.equal(view.mode, 'trial'); assert.equal(view.qqBinding, null); assert.deepEqual(view.ownedBots, []);
  assert.deepEqual(tenant.enrichPrincipal(alice).botScopes, [{ botId: 'primary', key: 'group:123' }]);
  assert.equal(view.trial.dailyLimitCny, 0.1); assert.equal(view.trial.totalDailyLimitCny, 1); assert.equal(fs.existsSync(masterKeyFile), false);
  assert.equal(tenant.resolvePrivateBinding('123'), null); assert.equal(tenant.getFunding({ botId: 'primary', key: 'private:123' }).mode, 'blocked');
});

await test('AES-GCM encrypted profiles never store plaintext and public metadata never contains credentials', ({ make, alice, s, file, masterKeyFile, profile }) => {
  const tenant = make(), p = profile(tenant, alice); const raw = s.readText(file); assert.equal(raw.includes(keyA), false);
  const sql = s.db.prepare('SELECT * FROM tenant_profiles').get(); assert.equal(sql.owner_user_id, alice.id); assert.equal(Object.values(sql).includes(keyA), false);
  const view = JSON.stringify(tenant.overview(alice)); assert.equal(view.includes(keyA), false); assert.equal(view.includes(sql.ciphertext), false); assert.equal(view.includes('encrypted'), false);
  assert.equal(fs.readFileSync(masterKeyFile).length, 32); if (process.platform !== 'win32') assert.equal(fs.statSync(masterKeyFile).mode & 0o777, 0o600);
  assert.equal(p.configured, true); assert.deepEqual(TENANT_MODELS, ['deepseek-flash', 'deepseek-v4-pro']); assert.equal(TENANT_ENDPOINT, 'https://api.deepseek.com');
});

await test('profile update preserves key when omitted, rotates nonce for replacement and enforces version CAS', ({ make, alice, profile, s, file, store }) => {
  const a = make(), p = profile(a, alice); const before = JSON.parse(s.readText(file)).profiles[0].encrypted;
  const b = make(store()); const next = b.saveProfile(alice, { id: p.id, name: '改名', model: 'deepseek-v4-pro', version: 1 }); assert.equal(next.version, 2);
  assert.deepEqual(JSON.parse(s.readText(file)).profiles[0].encrypted, before);
  assert.throws(() => a.saveProfile(alice, { id: p.id, name: '冲突', model: 'deepseek-flash', apiKey: keyB, version: 1 }), { statusCode: 409 });
  a.saveProfile(alice, { id: p.id, name: '改名', model: 'deepseek-v4-pro', apiKey: keyA, version: 2 });
  assert.notEqual(JSON.parse(s.readText(file)).profiles[0].encrypted.iv, before.iv);
});

await test('other users and platform admin cannot read, overwrite or delete another persons API profile', ({ make, alice, bob, admin, profile }) => {
  const tenant = make(), p = profile(tenant, alice);
  for (const outsider of [bob, admin]) {
    assert.equal(tenant.overview(outsider).profiles.length, 0);
    assert.throws(() => tenant.saveProfile(outsider, { id: p.id, name: '抢占', model: p.model, apiKey: keyB, version: 1 }), { statusCode: 404 });
    assert.throws(() => tenant.deleteProfile(outsider, { id: p.id, version: 1 }), { statusCode: 404 });
  }
});

await test('SSRF fields, unsupported models and malformed keys are rejected before any key creation', ({ make, alice, masterKeyFile }) => {
  const tenant = make(); const valid = { name: '配置', model: 'deepseek-flash', apiKey: keyA, version: 0 };
  for (const change of [{ baseURL: 'http://127.0.0.1' }, { endpoint: 'https://evil.test' }, { model: 'deepseek-chat' }, { model: '../../model' },
    { apiKey: 'sk-short' }, { apiKey: keyA + '\n' }, { apiKey: 'Bearer ' + keyA }, { apiKey: 'sk-' + 'a'.repeat(257) }]) assert.throws(() => tenant.saveProfile(alice, { ...valid, ...change }), { statusCode: 400 });
  assert.equal(fs.existsSync(masterKeyFile), false);
});

await test('missing master key with existing ciphertext fails closed across restart without regenerating it', ({ make, alice, profile, masterKeyFile, s, file }) => {
  const tenant = make(); profile(tenant, alice); const before = s.readText(file); fs.unlinkSync(masterKeyFile);
  assert.throws(() => make(), { statusCode: 503 }); assert.equal(fs.existsSync(masterKeyFile), false); assert.equal(s.readText(file), before);
  assert.throws(() => tenant.saveProfile(alice, { name: '新配置', model: 'deepseek-flash', apiKey: keyB, version: 0 }), { statusCode: 503 });
});

await test('malformed or replaced master keys are refused without changing key or SQLite state', ({ make, alice, profile, masterKeyFile, s, file }) => {
  profile(make(), alice); const before = s.readText(file), original = fs.readFileSync(masterKeyFile);
  for (const replacement of [Buffer.alloc(0), Buffer.alloc(32, 9)]) {
    fs.writeFileSync(masterKeyFile, replacement); assert.throws(() => make(), { statusCode: 503 }); assert.deepEqual(fs.readFileSync(masterKeyFile), replacement); assert.equal(s.readText(file), before);
  }
  fs.writeFileSync(masterKeyFile, original); assert.equal(make().overview(alice).profiles.length, 1);
});

await test('ciphertext and cross-profile substitution cannot decrypt or fall back to platform funding', ({ make, alice, profile, bind, s, file }) => {
  const tenant = make(), p = profile(tenant, alice), other = profile(tenant, alice, keyB); bind(tenant, alice, '111');
  tenant.setFunding(alice, { botId: 'primary', key: 'private:111', profileId: p.id, version: 0 });
  let raw = s.readText(file), data = JSON.parse(raw); data.profiles[0].encrypted = data.profiles[1].encrypted; s.writeText(file, JSON.stringify(data), raw);
  assert.throws(() => tenant.getFunding({ botId: 'primary', key: 'private:111' }), { statusCode: 503 });
  raw = s.readText(file); data = JSON.parse(raw); data.profiles[0].encrypted = { ...data.profiles[1].encrypted, tag: '0'.repeat(32) }; s.writeText(file, JSON.stringify(data), raw);
  assert.throws(() => tenant.getFunding({ botId: 'primary', key: 'private:111' }), { statusCode: 503 }); assert.ok(other.id);
});

await test('one-time QQ codes persist only hashes and require matching trusted QQ before binding', ({ make, alice, bob, s, file }) => {
  const tenant = make(), issued = tenant.issueBinding(alice, { qq: '111' });
  assert.equal(s.readText(file).includes(issued.code), false); assert.equal(s.db.prepare('SELECT code_hash FROM tenant_binding_challenges').get().code_hash.length, 64);
  assert.throws(() => tenant.consumeBinding({ qq: '222', code: issued.code }), { statusCode: 400 }); assert.equal(tenant.resolvePrivateBinding('111'), null);
  const binding = tenant.consumeBinding({ qq: '111', code: issued.code }); assert.equal(binding.userId, alice.id);
  assert.equal(tenant.getBindingByUser(alice.id).qq, '111'); assert.throws(() => tenant.consumeBinding({ qq: '111', code: issued.code }), { statusCode: 409 });
  assert.throws(() => tenant.issueBinding(bob, { qq: '111' }), { statusCode: 409 }); assert.throws(() => tenant.issueBinding(alice, { qq: '222' }), { statusCode: 409 });
});

await test('wrong-code attempt counters survive rollback boundaries and reopening; five guesses expire the code', ({ make, alice, store, s }) => {
  const tenant = make(), issued = tenant.issueBinding(alice, { qq: '111' });
  for (let i = 0; i < 5; i++) assert.throws(() => tenant.consumeBinding({ qq: '111', code: 'wrong' }), { statusCode: 400 });
  assert.equal(s.db.prepare('SELECT attempts FROM tenant_binding_challenges').get().attempts, 5);
  assert.throws(() => make(store()).consumeBinding({ qq: '111', code: issued.code }), { statusCode: 400 }); assert.equal(tenant.resolvePrivateBinding('111'), null);
});

await test('QQ challenges have cooldown, expiry and single-user replacement without stealing another account', ({ make, alice, bob, tick }) => {
  const tenant = make(), first = tenant.issueBinding(alice, { qq: '111' });
  assert.throws(() => tenant.issueBinding(alice, { qq: '111' }), { statusCode: 429 }); tick(30001);
  const latest = tenant.issueBinding(alice, { qq: '111' }); assert.throws(() => tenant.consumeBinding({ qq: '111', code: first.code }), { statusCode: 400 });
  tick(600000); assert.throws(() => tenant.consumeBinding({ qq: '111', code: latest.code }), { statusCode: 400 });
  const competing = tenant.issueBinding(bob, { qq: '111' }); tenant.consumeBinding({ qq: '111', code: competing.code });
  assert.equal(tenant.resolvePrivateBinding('111').userId, bob.id); assert.equal(tenant.getBindingByUser(alice.id), null);
});

await test('QQ bindings grant only verified self private scope even when bound account is platform admin', ({ make, admin, bind }) => {
  const tenant = make(); bind(tenant, admin, '999'); const bound = tenant.resolvePrivateBinding('999');
  assert.equal(bound.role, 'user'); assert.deepEqual(bound.botScopes, [{ botId: 'primary', key: 'private:999' }]); assert.equal(bound.key, 'private:999');
});

await test('private funding requires verified self ownership and deleted or rejected credentials never fall back', ({ make, alice, bob, profile, bind }) => {
  const tenant = make(); assert.equal(tenant.getFunding({ botId: 'primary', key: 'group:1' }).mode, 'platform');
  const p = profile(tenant, alice), bp = profile(tenant, bob, keyB); bind(tenant, alice, '111'); bind(tenant, bob, '222');
  assert.equal(tenant.getFunding({ botId: 'primary', key: 'private:111' }).mode, 'trial');
  assert.throws(() => tenant.setFunding(alice, { botId: 'primary', key: 'private:222', profileId: p.id, version: 0 }), { statusCode: 403 });
  assert.throws(() => tenant.setFunding(alice, { botId: 'primary', key: 'private:111', profileId: bp.id, version: 0 }), { statusCode: 404 });
  tenant.setFunding(alice, { botId: 'primary', key: 'private:111', profileId: p.id, version: 0 });
  const funding = tenant.getFunding({ botId: 'primary', key: 'private:111' }); assert.equal(funding.apiKey, keyA); assert.equal(funding.endpoint, TENANT_ENDPOINT);
  tenant.invalidateProfile(p.id); assert.throws(() => tenant.getFunding({ botId: 'primary', key: 'private:111' }), { statusCode: 503 });
  tenant.saveProfile(alice, { id: p.id, name: p.name, model: p.model, version: 2, apiKey: keyB });
  assert.equal(tenant.getFunding({ botId: 'primary', key: 'private:111' }).apiKey, keyB);
  tenant.deleteProfile(alice, { id: p.id, version: 3 }); assert.throws(() => tenant.getFunding({ botId: 'primary', key: 'private:111' }), { statusCode: 503 });
  tenant.setFunding(alice, { botId: 'primary', key: 'private:111', profileId: null, version: 1 }); assert.equal(tenant.getFunding({ botId: 'primary', key: 'private:111' }).mode, 'trial');
});

await test('verified bot ownership grants business identity without changing global user role', ({ make, alice, bob, claim, auth, admin }) => {
  const tenant = make(), row = claim(tenant, alice); assert.equal(row.ownerUserId, alice.id);
  assert.equal(tenant.ownsBot(alice, 'alice-bot'), true); assert.equal(tenant.ownsBot(bob, 'alice-bot'), false);
  assert.deepEqual(tenant.userBotIds(alice), ['alice-bot']); assert.deepEqual(tenant.enrichPrincipal(alice).ownedBotIds, ['alice-bot']); assert.equal(tenant.enrichPrincipal(alice).role, 'user');
  assert.equal(auth.list(admin).find(user => user.id === alice.id).role, 'user');
  assert.throws(() => claim(tenant, bob), { statusCode: 409 });
  assert.throws(() => tenant.claimBot(alice, { id: 'primary', name: '主机器人', expectedQQ: '4', actualQQ: '4', verifiedAt: Date.now() }), { statusCode: 400 });
  assert.throws(() => tenant.claimBot(alice, { id: 'bad', name: '错误身份', expectedQQ: '4', actualQQ: '5', verifiedAt: Date.now() }), { statusCode: 400 });
});

await test('owned worker receives only its owner profile and cannot obtain a visitors personal BYOK', ({ make, alice, bob, claim, profile, bind }) => {
  const tenant = make(); claim(tenant, alice); const a = profile(tenant, alice), b = profile(tenant, bob, keyB);
  assert.equal(tenant.getFunding({ botId: 'alice-bot', key: 'group:1' }).mode, 'blocked');
  tenant.setFunding(alice, { botId: 'alice-bot', profileId: a.id, version: 0 }); assert.equal(tenant.getFunding({ botId: 'alice-bot', key: 'group:1' }).apiKey, keyA);
  tenant.delegate(alice, { botId: 'alice-bot', userId: bob.id, keys: ['group:1'], version: 0 });
  assert.throws(() => tenant.setFunding(bob, { botId: 'alice-bot', profileId: b.id, version: 1 }), { statusCode: 403 });
  bind(tenant, bob, '222'); tenant.setFunding(bob, { botId: 'primary', key: 'private:222', profileId: b.id, version: 0 });
  assert.equal(tenant.getFunding({ botId: 'alice-bot', key: 'private:222' }).apiKey, keyA);
  assert.equal(tenant.getFunding({ botId: 'primary', key: 'private:222' }).apiKey, keyB);
  tenant.deleteProfile(bob, { id: b.id, version: 1 }); assert.equal(tenant.getFunding({ botId: 'alice-bot', key: 'private:222' }).apiKey, keyA);
});

await test('delegated conversation scopes are narrow, revocable with CAS and do not alter original account scopes', ({ make, alice, bob, claim, auth, admin }) => {
  const tenant = make(); claim(tenant, alice);
  tenant.delegate(alice, { botId: 'alice-bot', userId: bob.id, keys: ['private:2', 'group:1', 'group:1'], version: 0 });
  assert.deepEqual(tenant.enrichPrincipal(bob).botScopes, [{ botId: 'alice-bot', key: 'group:1' }, { botId: 'alice-bot', key: 'private:2' }]);
  assert.deepEqual(auth.list(admin).find(user => user.id === bob.id).botScopes, []);
  assert.throws(() => tenant.delegate(bob, { botId: 'alice-bot', userId: alice.id, keys: ['group:3'], version: 0 }), { statusCode: 403 });
  assert.throws(() => tenant.delegate(alice, { botId: 'alice-bot', userId: bob.id, keys: [], version: 0 }), { statusCode: 409 });
  tenant.delegate(alice, { botId: 'alice-bot', userId: bob.id, keys: [], version: 1 }); assert.deepEqual(tenant.enrichPrincipal(bob).botScopes, []);
});

await test('admin ownership transfer clears prior delegations and previous owner funding', ({ make, alice, bob, admin, claim, profile }) => {
  const tenant = make(); claim(tenant, alice); const p = profile(tenant, alice);
  tenant.setFunding(alice, { botId: 'alice-bot', profileId: p.id, version: 0 }); tenant.delegate(alice, { botId: 'alice-bot', userId: bob.id, keys: ['group:1'], version: 0 });
  assert.throws(() => tenant.assignBot(alice, { botId: 'alice-bot', userId: bob.id, version: 1 }), { statusCode: 403 });
  tenant.assignBot(admin, { botId: 'alice-bot', userId: bob.id, version: 1 });
  assert.deepEqual(tenant.userBotIds(alice), []); assert.deepEqual(tenant.userBotIds(bob), ['alice-bot']); assert.equal(tenant.overview(bob).delegations.length, 0);
  assert.equal(tenant.getFunding({ botId: 'alice-bot', key: 'group:1' }).mode, 'blocked');
  assert.throws(() => tenant.setFunding(alice, { botId: 'alice-bot', profileId: p.id, version: 2 }), { statusCode: 403 });
});

await test('only platform admin controls trial allowance and global total cannot be raised by a user', ({ make, alice, bob, admin, bind }) => {
  const tenant = make(); bind(tenant, alice, '111'); bind(tenant, bob, '222');
  assert.throws(() => tenant.updateTrial(alice, { version: 1, dailyLimitCny: 100 }), { statusCode: 403 });
  assert.throws(() => tenant.setUserTrial(alice, { userId: alice.id, enabled: true, dailyLimitCny: 100, version: 0 }), { statusCode: 403 });
  tenant.updateTrial(admin, { version: 1, dailyLimitCny: 0.2, totalDailyLimitCny: 0.8 });
  tenant.setUserTrial(admin, { userId: alice.id, enabled: true, dailyLimitCny: 0.3, version: 0 });
  assert.equal(tenant.getFunding({ botId: 'primary', key: 'private:111' }).dailyLimitCny, 0.3); assert.equal(tenant.getFunding({ botId: 'primary', key: 'private:222' }).dailyLimitCny, 0.2);
  assert.equal(tenant.getFunding({ botId: 'primary', key: 'private:111' }).totalDailyLimitCny, 0.8);
  tenant.updateTrial(admin, { version: 2, enabled: false }); assert.equal(tenant.getFunding({ botId: 'primary', key: 'private:111' }).mode, 'blocked');
});

await test('disabled accounts lose QQ authority, ownership routing and funding immediately', async ({ make, alice, admin, auth, claim, profile, bind }) => {
  const tenant = make(); bind(tenant, alice, '111'); claim(tenant, alice); const p = profile(tenant, alice);
  tenant.setFunding(alice, { botId: 'alice-bot', profileId: p.id, version: 0 }); await auth.update(admin, { id: alice.id, disabled: true });
  assert.equal(tenant.resolvePrivateBinding('111'), null); assert.throws(() => tenant.overview(alice), { statusCode: 403 });
  assert.throws(() => tenant.getFunding({ botId: 'alice-bot', key: 'group:1' }), { statusCode: 403 });
});

await test('auth account creation rename and fresh login preserve all tenant foreign-key identities', async ({ make, alice, admin, auth, claim, profile, bind, s }) => {
  const tenant = make(); bind(tenant, alice, '111'); claim(tenant, alice); const p = profile(tenant, alice);
  tenant.setFunding(alice, { botId: 'primary', key: 'private:111', profileId: p.id, version: 0 });
  await auth.create(admin, { username: 'fourth', password }); await auth.update(admin, { id: alice.id, username: 'renamed-alice' });
  const logged = await auth.login({ username: 'renamed-alice', password }, 'fixture'); const principal = auth.authenticate('qq_console_session=' + logged.token);
  assert.equal(principal.id, alice.id); assert.equal(tenant.overview(principal).profiles[0].id, p.id);
  assert.equal(tenant.getFunding({ botId: 'primary', key: 'private:111' }).apiKey, keyA);
  assert.equal(s.db.prepare('SELECT owner_user_id FROM tenant_profiles').get().owner_user_id, alice.id);
  assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

await test('relational tenant tables retain only encrypted profiles, hash challenges and verified scope metadata', ({ make, alice, bob, admin, profile, bind, claim, s }) => {
  const tenant = make(), p = profile(tenant, alice); bind(tenant, alice, '111'); claim(tenant, alice);
  tenant.delegate(alice, { botId: 'alice-bot', userId: bob.id, keys: ['group:1'], version: 0 }); tenant.setFunding(alice, { botId: 'alice-bot', profileId: p.id, version: 0 });
  tenant.setUserTrial(admin, { userId: alice.id, enabled: true, dailyLimitCny: 0.2, version: 0 });
  for (const table of ['tenant_settings', 'tenant_profiles', 'tenant_qq_bindings', 'tenant_binding_challenges', 'tenant_owned_bots', 'tenant_delegations', 'tenant_funding', 'tenant_trial_overrides']) assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n, 1);
  assert.equal(s.db.prepare('SELECT conversation_key FROM tenant_delegations').get().conversation_key, 'group:1');
  assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

await test('transaction rollback leaves no partial profile or SQL projection and an already-created key can be safely reused', ({ make, alice, s, file, masterKeyFile, profile }) => {
  const tenant = make(), before = s.readText(file);
  assert.throws(() => s.transaction(() => { profile(tenant, alice); throw new Error('rollback'); }), /rollback/);
  assert.equal(s.readText(file), before); assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM tenant_profiles').get().n, 0);
  assert.equal(fs.readFileSync(masterKeyFile).length, 32); assert.equal(profile(tenant, alice).configured, true);
});

await test('future, unknown, malformed and wrong-reference tenant state cannot replace the current document', ({ make, s, file }) => {
  make(); const before = s.readText(file), data = JSON.parse(before);
  for (const text of ['{broken', '{"version":99}', JSON.stringify({ ...data, unknown: true }), JSON.stringify({ ...data, bindings: [{ qq: '01', userId: 'a'.repeat(32), verifiedAt: 1 }] })]) {
    assert.throws(() => validateTenantText(text)); assert.throws(() => s.writeText(file, text, before)); assert.equal(s.readText(file), before);
  }
});

await test('malformed or future legacy tenant documents are refused before creating a database', ({ root }) => {
  const directory = path.join(root, 'legacy-refusal'); fs.mkdirSync(path.join(directory, 'state'), { recursive: true });
  const legacy = path.join(directory, 'state/tenants.json'), database = path.join(directory, 'state/manager.sqlite');
  for (const raw of ['{broken', '{"version":99}']) {
    fs.writeFileSync(legacy, raw); assert.throws(() => createSqliteState({ root: directory, file: database }), { statusCode: 503 });
    assert.equal(fs.existsSync(database), false); assert.equal(fs.readFileSync(legacy, 'utf8'), raw);
  }
});

await test('reopening preserves valid auth cookies and tenant data while stale legacy JSON remains frozen', async ({ make, alice, admin, auth, store, file, root, profile, bind }) => {
  const tenant = make(), p = profile(tenant, alice); bind(tenant, alice, '111'); tenant.setFunding(alice, { botId: 'primary', key: 'private:111', profileId: p.id, version: 0 });
  fs.writeFileSync(file, '{"version":99}'); const s = store(), reopened = make(s); assert.equal(reopened.getFunding({ botId: 'primary', key: 'private:111' }).apiKey, keyA);
  const logged = await auth.login({ username: 'alice', password }, 'fixture'); const otherAuth = createConsoleAuth({ storage: s, file: path.join(root, 'state/console-auth.json') });
  assert.equal(otherAuth.authenticate('qq_console_session=' + logged.token).id, alice.id); assert.equal(otherAuth.list(admin).length, 3); assert.equal(fs.readFileSync(file, 'utf8'), '{"version":99}');
});

console.log(`Tenant service: ${passed} tests passed`);
