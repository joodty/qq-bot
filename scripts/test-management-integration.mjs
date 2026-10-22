// Actual Bridge routes + SQLite against isolated QQ/DSH fixtures. No paid calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS', name); }
const password = 'Fixture_10';
const cards = { 'roles/A.md': '# A\nPERSONA_A', 'roles/B.md': '# B\nPERSONA_B',
  'state/current-role.json': { role: 'A', mode: 'active' } };
const h = await bridgeHarness({ config: { storage: { driver: 'sqlite' }, allow: { groups: ['456','789'], private: ['123'] } }, files: cards });
h.setMode('reserved2');
const server = h.startConsoleServer();
if (!server.listening) await new Promise(r => server.once('listening', r));
const base = 'http://127.0.0.1:' + server.address().port;
async function request(route, body, { cookie, machine = false, headers = {} } = {}) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(machine ? { 'x-console-token': 'fixture-console-token' } : {}), ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
let admin, user, other, userId, ownId;
try {
  await test('SQLite boot imports cards and preserves legacy files while initializing real tables', async () => {
    const db = h.getStorage().db;
    assert.equal(db.prepare('select count(*) n from role_cards').get().n, 2);
    assert.equal(fs.readFileSync(path.join(h.temp,'roles/A.md'),'utf8'), cards['roles/A.md']);
    const response = await request('/api/roles', undefined, { machine: true });
    assert.equal(response.status,200); assert.deepEqual(response.data.roles,['A','B']);
  });
  await test('account bootstrap/login and scoped ordinary users are persisted in SQLite', async () => {
    const boot = await request('/api/auth/bootstrap', { username:'admin',password }, { machine:true });
    assert.equal(boot.status,200); admin = boot.cookie;
    const created = await request('/api/auth/users', { username:'friend',password,conversationKeys:['group:456'] }, { cookie:admin });
    assert.equal(created.status,200); userId = created.data.user.id;
    user = (await request('/api/auth/login',{username:'friend',password})).cookie;
    await request('/api/auth/users',{username:'another',password,conversationKeys:['group:789']},{cookie:admin});
    other=(await request('/api/auth/login',{username:'another',password})).cookie;
    assert.equal(h.getStorage().db.prepare('select count(*) n from accounts').get().n,3);
    assert.equal(h.getStorage().db.prepare('select count(*) n from account_scopes').get().n,2);
    assert.equal(fs.existsSync(path.join(h.temp,'state/console-auth.json')),false);
  });
  await test('ordinary users see only granted groups and cannot read admin, archive, or worker credentials', async () => {
    const r=await request('/api/member/overview',undefined,{cookie:user});
    assert.equal(r.status,200); assert.deepEqual(r.data.conversations.map(x=>x.key),['group:456']);
    for(const route of ['/api/status','/api/conversation-sessions','/api/auth/users','/api/instance']) {
      assert.equal((await request(route,undefined,{cookie:user})).status,403,route);
    }
    assert.equal((await request('/api/bots',undefined,{cookie:user})).data.bots.length,1);
    assert.equal((await request('/api/bots/bot-other/member/personas',undefined,{cookie:user})).status,403);
    assert.equal((await request('/api/member/personas',undefined,{cookie:user,headers:{'x-agent-call':'1'}})).status,403);
  });
  await test('member cards have independent ownership, stable identity and SQL-backed exact content', async () => {
    const created=await request('/api/member/personas/create',{name:'我的小鲸鱼',content:'# 专属人设\n友好又幽默'},{cookie:user});
    assert.equal(created.status,200); ownId=created.data.persona.id;
    const row=h.getStorage().db.prepare('select name,content from member_cards where id=?').get(ownId);
    assert.equal(row.name,'我的小鲸鱼'); assert.equal(row.content,'# 专属人设\n友好又幽默');
    assert.equal((await request('/api/member/personas',undefined,{cookie:other})).data.personas.length,0);
    assert.equal((await request('/api/member/personas/update',{id:ownId,version:1,content:'越权'},{cookie:other})).status,404);
  });
  await test('apply changes only the authorized group; A to member to A resumes the original DSH session', async () => {
    const first=await h.ensureSession('group:456');
    const otherSession=await h.ensureSession('group:789');
    const applied=await request('/api/member/personas/apply',{id:ownId,key:'group:456'},{cookie:user});
    assert.equal(applied.status,200); assert.equal(applied.data.sessionId,undefined);
    assert.equal((await request('/api/member/personas/apply',{id:ownId,key:'group:789'},{cookie:user})).status,403);
    await h.ensureSession('group:456');
    assert.equal((await request('/api/member/personas/apply',{templateName:'A',key:'group:456'},{cookie:user})).status,200);
    assert.equal(h.state.sessions['group:456'],first); assert.equal(h.state.sessions['group:789'],otherSession);
    assert.ok(h.getStorage().db.prepare('select count(*) n from archive_records').get().n>=3);
    assert.equal((await request('/api/member/personas/apply',{inherit:true,key:'group:456'},{cookie:user})).status,200);
  });
  await test('version CAS rejects stale edit, history restores content and original template remains unchanged', async () => {
    const update=await request('/api/member/personas/update',{id:ownId,version:1,content:'新版本',name:'新名字'},{cookie:user});
    assert.equal(update.status,200); assert.equal(update.data.persona.version,2);
    assert.equal((await request('/api/member/personas/update',{id:ownId,version:1,content:'过时覆盖'},{cookie:user})).status,409);
    const history=await request('/api/member/personas/history?id='+ownId,undefined,{cookie:user});
    assert.equal(history.data.history.length,2);
    const restored=await request('/api/member/personas/restore',{id:ownId,version:2,targetVersion:1},{cookie:user});
    assert.equal(restored.status,200); assert.equal(restored.data.persona.version,3);
    assert.equal(h.getStorage().db.prepare('select count(*) n from member_revisions where card_id=?').get(ownId).n,3);
    assert.equal(h.getStorage().readText(path.join(h.temp,'roles/A.md')),cards['roles/A.md']);
  });
  await test('scope revocation invalidates member cookie immediately and keeps stored card/history', async () => {
    const revoked=await request('/api/auth/users/update',{id:userId,conversationKeys:[]},{cookie:admin});
    assert.equal(revoked.status,200);
    assert.equal((await request('/api/member/personas',undefined,{cookie:user})).status,401);
    user=(await request('/api/auth/login',{username:'friend',password})).cookie;
    assert.equal((await request('/api/bots',undefined,{cookie:user})).data.bots.length,0);
    assert.equal((await request('/api/member/personas',undefined,{cookie:user})).status,403);
    assert.equal(h.getStorage().db.prepare('select count(*) n from member_cards where id=?').get(ownId).n,1);
  });
  assert.equal(h.calls.prompts.length,0); assert.equal(h.calls.sent.length,0);
  console.log(JSON.stringify({passed,realQqMessages:0,paidModelCalls:0}));
} finally {
  await new Promise(r=>server.close(r)); await h.close();
}
