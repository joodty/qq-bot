// Two independent real Bridge HTTP workers, fake QQ/DSH peers, actual SQLite.
import assert from 'node:assert/strict';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed=0;
async function test(name,run){await run();passed++;console.log('PASS',name);}
const peers=[],servers=[];
async function fixture(id,qq,token,worker=false){
  const h=await bridgeHarness({config:{storage:{driver:'sqlite'},botId:id,expectedQQ:qq,managerWorker:worker,
    consoleToken:token,allow:{groups:['456','789'],private:[]}},files:{'roles/A.md':'# A\n身份A','roles/B.md':'# B\n身份B','state/current-role.json':{role:'A',mode:'active'}}});
  peers.push(h);h.setMode('reserved2');assert.equal(await h.verifyIdentity(),true);
  const server=h.startConsoleServer();servers.push(server);if(!server.listening)await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const request=async(route,body,{cookie,machine=true,headers={}}={})=>{
    const res=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...(machine?{'x-console-token':token}:{}),...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return{status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
  };
  return{h,base,port:server.address().port,request};
}
try{
  const a=await fixture('bot-a','222','fixture-worker-a-token',true),b=await fixture('bot-b','333','fixture-worker-b-token',true);
  const m=await fixture('primary','111','fixture-manager-token');
  let user,admin;
  await test('workers start with no public login or chat permission before peer synchronization',async()=>{
    assert.equal(a.h.hasVerifiedIdentity(),false);
    assert.equal((await a.request('/api/auth/status')).status,403);
    assert.equal((await a.request('/api/bots')).status,403);
    assert.equal((await a.request('/api/member/personas')).status,403);
    assert.equal((await a.request('/api/instance')).data.actualQQ,'222');
  });
  await test('one manager registers two workers and verifies actual distinct QQs before enabling',async()=>{
    for(const [id,qq,port,token]of[['bot-a','222',a.port,'fixture-worker-a-token'],['bot-b','333',b.port,'fixture-worker-b-token']]){
      assert.equal((await m.request('/api/bots',{id,name:id,expectedQQ:qq,port,machineToken:token})).status,200);
      assert.equal((await m.request('/api/bots/'+id+'/verify',{})).status,200);
      assert.equal((await m.request('/api/bots/'+id+'/update',{enabled:true})).status,200);
    }
    const listed=await m.request('/api/bots');assert.equal(listed.data.bots.length,3);
    assert.equal(JSON.stringify(listed.data).includes('fixture-worker'),false);
    assert.equal(a.h.hasVerifiedIdentity(),true);assert.equal(b.h.hasVerifiedIdentity(),true);
    assert.equal(m.h.getStorage().db.prepare('select count(*) n from bots').get().n,2);
    assert.deepEqual(JSON.parse(a.h.getStorage().readText(path.join(a.h.temp,'state/bot-peers.json'))).qqs,['111','222','333']);
  });
  await test('scope is the exact bot and conversation pair; same-number groups are not shared',async()=>{
    admin=(await m.request('/api/auth/bootstrap',{username:'admin',password:'Fixture_10'})).cookie;
    const created=await m.request('/api/auth/users',{username:'member',password:'Fixture_10',botScopes:[{botId:'bot-a',key:'group:456'}]}, {cookie:admin,machine:false});
    assert.equal(created.status,200);
    user=(await m.request('/api/auth/login',{username:'member',password:'Fixture_10'},{machine:false})).cookie;
    const list=await m.request('/api/bots',undefined,{cookie:user,machine:false});assert.deepEqual(list.data.bots.map(x=>x.id),['bot-a']);
    const overview=await m.request('/api/bots/bot-a/member/overview',undefined,{cookie:user,machine:false});
    assert.equal(overview.status,200);assert.deepEqual(overview.data.conversations.map(x=>x.key),['group:456']);
    assert.equal((await m.request('/api/bots/bot-b/member/overview',undefined,{cookie:user,machine:false})).status,403);
    assert.equal((await m.request('/api/member/overview',undefined,{cookie:user,machine:false})).status,403);
    assert.equal((await m.request('/api/bots/bot-a/api/status',undefined,{cookie:user,machine:false})).status,403);
  });
  await test('member creation and switching use only the selected worker; original sessions survive A-B-A',async()=>{
    const oldA=await a.h.ensureSession('group:456'),oldB=await b.h.ensureSession('group:456');
    const created=await m.request('/api/bots/bot-a/member/personas/create',{name:'温柔',content:'只属于 A 群的人设'},{cookie:user,machine:false});
    assert.equal(created.status,200);const id=created.data.persona.id;
    assert.equal(a.h.getStorage().db.prepare('select count(*) n from member_cards').get().n,1);
    assert.equal(b.h.getStorage().db.prepare('select count(*) n from member_cards').get().n,0);
    assert.equal((await m.request('/api/bots/bot-a/member/personas/apply',{id,key:'group:456'},{cookie:user,machine:false})).status,200);
    const newA=await a.h.ensureSession('group:456');assert.notEqual(newA,oldA);
    assert.equal((await m.request('/api/bots/bot-a/member/personas/apply',{templateName:'A',key:'group:456'},{cookie:user,machine:false})).status,200);
    assert.equal(a.h.state.sessions['group:456'],oldA);assert.equal(b.h.state.sessions['group:456'],oldB);
    assert.equal((await m.request('/api/bots/bot-a/member/personas/apply',{id,key:'group:789'},{cookie:user,machine:false})).status,403);
  });
  await test('registered bots are filtered before unread, pending answers, wake or model calls',async()=>{
    const before=a.h.getSocialV2State('group:456').recentMessages.length;
    await a.h.handleIncoming('group','456',{self_id:222,user_id:333,sender:{user_id:333},message:[{type:'text',data:{text:'@222 你好？'}}]},a.h.cfg);
    await a.h.handleIncoming('group','456',{self_id:333,user_id:444,sender:{user_id:444},message:[{type:'text',data:{text:'错误账号事件'}}]},a.h.cfg);
    assert.equal(a.h.getSocialV2State('group:456').recentMessages.length,before);
    assert.equal(a.h.calls.prompts.length,0);assert.equal(a.h.calls.sent.length,0);
  });
  await test('remote auth and machine credential rotation cannot be proxied by any browser account',async()=>{
    for(const suffix of ['auth/status','console/token','bots','internal/member','instance']){
      const r=await m.request('/api/bots/bot-a/api/'+suffix,undefined,{cookie:admin,machine:false});
      assert.ok([400,403].includes(r.status),suffix+': '+r.status);
    }
    assert.equal((await m.request('/api/internal/member',{action:'list',principal:{role:'admin',id:'forged'}})).status,403);
    assert.equal((await a.request('/api/internal/member',{action:'list',principal:{role:'user',id:'f'.repeat(32),botScopes:[{botId:'bot-b',key:'group:456'}]}})).status,403);
  });
  await test('a disabled worker refuses routing while the other worker and primary stay available',async()=>{
    assert.equal((await m.request('/api/bots/bot-a/update',{enabled:false})).status,200);
    assert.equal((await m.request('/api/bots/bot-a/member/overview',undefined,{cookie:user,machine:false})).status,409);
    assert.equal((await m.request('/api/bots/bot-b/api/status')).status,200);
    assert.equal((await m.request('/api/status')).status,200);
    assert.ok(JSON.parse(a.h.getStorage().readText(path.join(a.h.temp,'state/bot-peers.json'))).qqs.includes('333'));
  });
  for(const h of peers){assert.equal(h.calls.prompts.length,0);assert.equal(h.calls.sent.length,0);}
  console.log(JSON.stringify({passed,realQQMessages:0,paidCalls:0,workerCount:2}));
}finally{for(const server of servers)await new Promise(r=>server.close(r));for(const h of peers)await h.close();}
