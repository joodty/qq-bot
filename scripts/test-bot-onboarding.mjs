import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSqliteState } from '../src/sqlite-state.js';
import { createConsoleAuth } from '../src/console-auth.js';
import { createTenantService } from '../src/tenant-service.js';
import { createTenantRouter } from '../src/tenant-router.js';
import { createBotOnboarding } from '../src/bot-onboarding.js';

const password='onboarding-fixture-password',secret='sk-'+ 'f'.repeat(32);
let passed=0;
async function test(name,run) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-onboarding-'));fs.mkdirSync(path.join(root,'state'));
 const storage=createSqliteState({root,file:path.join(root,'state/manager.sqlite')});
 const auth=createConsoleAuth({storage,file:path.join(root,'state/console-auth.json')});const activated=await auth.bootstrap({password},'fixture');
 const admin=auth.authenticate('qq_console_session='+activated.token);const alice=await auth.create(admin,{username:'alice',password}),bob=await auth.create(admin,{username:'bob',password});
 const service=createTenantService({storage,file:path.join(root,'state/tenants.json'),masterKeyFile:path.join(root,'state/tenant-master')});
 const bind=(user,qq)=>{const issued=service.issueBinding(user,{qq});service.consumeBinding({qq,code:issued.code});};
 const profile=(user)=>service.saveProfile(user,{name:'自己的模型',model:'deepseek-flash',apiKey:secret,version:0});
 const workers=new Map([['worker-a',{id:'worker-a',name:'prepared',expectedQQ:'55555',actualQQ:null,verifiedAt:null,enabled:false,isPrimary:false}],['primary',{id:'primary',name:'primary',expectedQQ:'99999',enabled:true,isPrimary:true}]]);
 let verifyAction=null,enableAction=null,afterChanges=0;const actions=[];
 const manager={list:()=>[...workers.values()].map(row=>({...row})),verify:async id=>{actions.push('verify:'+id);if(verifyAction)await verifyAction();const row=workers.get(id);row.actualQQ=row.expectedQQ;row.verifiedAt=Date.now();return {...row};},update:async(id,patch)=>{actions.push('enable:'+patch.enabled);if(patch.enabled&&enableAction)await enableAction();Object.assign(workers.get(id),patch);return {...workers.get(id)};}};
 const file=path.join(root,'state/bot-onboarding.json');const deps={storage,file,service,auth,manager,afterRegistryChange:async()=>{afterChanges++;}};
 const open=extras=>createBotOnboarding({...deps,...extras});const app=open();
 try{await run({root,storage,auth,admin,alice,bob,service,bind,profile,workers,manager,actions,app,open,file,afterChanges:()=>afterChanges,setVerify:fn=>{verifyAction=fn;},setEnable:fn=>{enableAction=fn;}});passed++;console.log('PASS',name);}
 finally{storage.close();fs.rmSync(root,{recursive:true,force:true});}
}
const rejects=code=>error=>error.statusCode===code;
function apply(f,user=f.alice,profileId){return f.app.create(user,{botQQ:'55555',name:'我的机器人',profileId});}
function setup(f){f.bind(f.alice,'12345');return f.profile(f.alice);}
await test('requires verified own QQ and own valid profile, and rejects authority or credential fields',async f=>{
 const p=f.profile(f.alice);assert.throws(()=>apply(f,f.alice,p.id),rejects(403));f.bind(f.alice,'12345');
 const other=f.profile(f.bob);assert.throws(()=>apply(f,f.alice,other.id),rejects(400));
 for(const extra of [{port:3210},{machineToken:'untrusted'},{ownerUserId:f.bob.id},{role:'admin'}])assert.throws(()=>f.app.create(f.alice,{botQQ:'55555',name:'test',profileId:p.id,...extra}),rejects(400));
 const row=apply(f,f.alice,p.id);assert.equal(row.status,'pending');assert.equal(f.service.botOwner('worker-a'),null);assert.equal(f.actions.length,0);
});
await test('ordinary users see only their own requests and never see prepared instance connections',async f=>{
 const p=setup(f);apply(f,f.alice,p.id);assert.equal(f.app.list(f.alice).requests.length,1);assert.equal(f.app.list(f.bob).requests.length,0);assert.deepEqual(f.app.list(f.alice).availableWorkers,[]);
 const admin=f.app.list(f.admin);assert.equal(admin.requests[0].username,'alice');assert.equal(admin.availableWorkers[0].botId,'worker-a');assert.ok(!JSON.stringify(admin).includes(secret));assert.ok(!('port' in admin.availableWorkers[0]));
});
await test('only admin can associate a matching unowned instance, and stale versions cannot override it',async f=>{
 const p=setup(f),row=apply(f,f.alice,p.id);const input={id:row.id,botId:'worker-a',version:row.version};
 assert.throws(()=>f.app.prepare(f.alice,input),rejects(403));f.workers.get('worker-a').expectedQQ='77777';assert.throws(()=>f.app.prepare(f.admin,input),rejects(409));f.workers.get('worker-a').expectedQQ='55555';
 const prepared=f.app.prepare(f.admin,input);assert.equal(prepared.status,'awaiting_scan');assert.equal(f.service.botOwner('worker-a'),null);assert.throws(()=>f.app.prepare(f.admin,input),rejects(409));
});
await test('admin activation attributes a verified bot to the stored applicant and their funding, never the admin',async f=>{
 const p=setup(f),row=apply(f,f.alice,p.id),prepared=f.app.prepare(f.admin,{id:row.id,botId:'worker-a',version:row.version});
 const active=await f.app.activate(f.admin,{id:row.id,version:prepared.version});assert.equal(active.status,'active');assert.equal(f.service.botOwner('worker-a').ownerUserId,f.alice.id);assert.equal(f.service.ownsBot(f.admin,'worker-a'),false);assert.equal(f.service.getFunding({botId:'worker-a',key:'group:12345'}).profileId,p.id);assert.equal(f.workers.get('worker-a').enabled,true);assert.equal(f.afterChanges(),1);
 assert.equal(f.auth.list(f.admin).find(user=>user.id===f.alice.id).role,'user');
});
await test('writing an existing bot QQ does not claim it and does not disable someone else during a race',async f=>{
 const p=setup(f),row=apply(f,f.alice,p.id),prepared=f.app.prepare(f.admin,{id:row.id,botId:'worker-a',version:row.version});
 const metadata=await f.manager.verify('worker-a');f.service.claimBot(f.admin,{...metadata,ownerUserId:f.bob.id});f.workers.get('worker-a').enabled=true;const before=f.actions.length;
 await assert.rejects(f.app.activate(f.admin,{id:row.id,version:prepared.version}),rejects(409));assert.equal(f.workers.get('worker-a').enabled,true);assert.equal(f.actions.length,before);assert.equal(f.service.botOwner('worker-a').ownerUserId,f.bob.id);
});
await test('QQ scan failure leaves the application waiting and never creates a claim',async f=>{
 const p=setup(f),row=apply(f,f.alice,p.id),prepared=f.app.prepare(f.admin,{id:row.id,botId:'worker-a',version:row.version});
 f.setVerify(()=>{throw new Error('offline');});await assert.rejects(f.app.activate(f.admin,{id:row.id,version:prepared.version}));assert.equal(f.service.botOwner('worker-a'),null);assert.equal(f.app.list(f.alice).requests[0].status,'awaiting_scan');assert.equal(f.workers.get('worker-a').enabled,false);
});
await test('post-claim failure compensates only this new claim and can be retried safely',async f=>{
 const p=setup(f),row=apply(f,f.alice,p.id),prepared=f.app.prepare(f.admin,{id:row.id,botId:'worker-a',version:row.version});
 f.setEnable(()=>{throw new Error('identity changed');});await assert.rejects(f.app.activate(f.admin,{id:row.id,version:prepared.version}));assert.equal(f.service.botOwner('worker-a'),null);assert.equal(f.workers.get('worker-a').enabled,false);
 const updated=f.app.list(f.alice).requests[0];assert.equal(updated.status,'awaiting_scan');f.setEnable(null);assert.equal((await f.app.activate(f.admin,{id:row.id,version:updated.version})).status,'active');
});
await test('disabled applicants or lost profiles cannot finish an in-flight admin verification',async f=>{
 const p=setup(f),row=apply(f,f.alice,p.id),prepared=f.app.prepare(f.admin,{id:row.id,botId:'worker-a',version:row.version});
 f.setVerify(()=>f.service.deleteProfile(f.alice,{id:p.id,version:p.version}));await assert.rejects(f.app.activate(f.admin,{id:row.id,version:prepared.version}));assert.equal(f.service.botOwner('worker-a'),null);assert.equal(f.workers.get('worker-a').enabled,false);
});
await test('an admin ownership transfer during enable is never compensated by disabling the new owner bot',async f=>{
 const p=setup(f),row=apply(f,f.alice,p.id),prepared=f.app.prepare(f.admin,{id:row.id,botId:'worker-a',version:row.version});
 const bobProfile=f.profile(f.bob);
 f.setEnable(()=>{f.service.assignBot(f.admin,{botId:'worker-a',userId:f.bob.id,version:1});f.service.setFunding(f.bob,{botId:'worker-a',profileId:bobProfile.id,version:2});});
 await assert.rejects(f.app.activate(f.admin,{id:row.id,version:prepared.version}),rejects(409));
 assert.equal(f.service.botOwner('worker-a').ownerUserId,f.bob.id);assert.equal(f.workers.get('worker-a').enabled,true);assert.equal(f.app.list(f.alice).requests[0].status,'rejected');assert.equal(f.service.getFunding({botId:'worker-a',key:'group:12345'}).profileId,bobProfile.id);
});
await test('admin logout during verification revokes the in-flight activation before ownership or enable',async f=>{
 const p=setup(f),row=apply(f,f.alice,p.id),prepared=f.app.prepare(f.admin,{id:row.id,botId:'worker-a',version:row.version});
 f.setVerify(()=>f.auth.logout(f.admin));await assert.rejects(f.app.activate(f.admin,{id:row.id,version:prepared.version}),rejects(401));assert.equal(f.service.botOwner('worker-a'),null);assert.equal(f.workers.get('worker-a').enabled,false);
});
await test('post-registry async profile changes cannot mark the request active',async f=>{
 const p=setup(f),app=f.open({afterRegistryChange:async()=>f.service.deleteProfile(f.alice,{id:p.id,version:p.version})});
 const row=app.create(f.alice,{botQQ:'55555',name:'test',profileId:p.id}),prepared=app.prepare(f.admin,{id:row.id,botId:'worker-a',version:row.version});
 await assert.rejects(app.activate(f.admin,{id:row.id,version:prepared.version}));assert.equal(f.service.botOwner('worker-a'),null);assert.equal(f.workers.get('worker-a').enabled,false);assert.equal(app.list(f.alice).requests[0].status,'awaiting_scan');
});
await test('a changed QQ returned by enable never grants application ownership',async f=>{
 const p=setup(f),row=apply(f,f.alice,p.id),prepared=f.app.prepare(f.admin,{id:row.id,botId:'worker-a',version:row.version});
 f.setEnable(()=>{f.workers.get('worker-a').actualQQ='66666';});await assert.rejects(f.app.activate(f.admin,{id:row.id,version:prepared.version}));assert.equal(f.service.botOwner('worker-a'),null);assert.equal(f.workers.get('worker-a').enabled,false);
});
await test('a disabled existing owner is not mistaken for an unassigned prepared worker',async f=>{
 const metadata=await f.manager.verify('worker-a');f.service.claimBot(f.admin,{...metadata,ownerUserId:f.bob.id});await f.auth.update(f.admin,{id:f.bob.id,disabled:true});
 assert.equal(f.app.list(f.admin).availableWorkers.some(row=>row.botId==='worker-a'),false);
});
await test('future or corrupt onboarding data stops writes and survives unchanged',async f=>{
 for(const raw of ['{broken','{"version":99,"requests":[]}']){let writes=0;const storage={transaction:fn=>fn(),readText:()=>raw,writeText:()=>writes++};assert.throws(()=>f.open({storage}),rejects(503));assert.equal(writes,0);}
});
await test('HTTP route protects requests, rejects legacy user credentials and never accepts a client owner',async f=>{
 const p=setup(f),router=createTenantRouter({service:f.service,auth:f.auth,manager:f.manager,onboarding:f.app});let actor=f.alice,originOK=true;
 const server=http.createServer(async(req,res)=>{const sendJson=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};const readBody=async()=>{let text='';for await(const chunk of req)text+=chunk;return JSON.parse(text||'{}');};await router.route({req,url:new URL(req.url,'http://127.0.0.1'),principal:actor,readBody,sendJson,writeAllowed:()=>{if(!originOK)throw Object.assign(new Error('origin'),{statusCode:403});}});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const post=async(route,body)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/tenant/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:response.status,data:await response.json()};};
 try{assert.equal((await post('bots',{port:3210,machineToken:'never-send'})).status,403);assert.equal((await post('bot-requests',{botQQ:'55555',name:'test',profileId:p.id,ownerUserId:f.bob.id})).status,400);
  originOK=false;assert.equal((await post('bot-requests',{botQQ:'55555',name:'test',profileId:p.id})).status,403);originOK=true;
  const applied=await post('bot-requests',{botQQ:'55555',name:'test',profileId:p.id});assert.equal(applied.status,200);assert.equal(applied.data.request.ownerUserId,f.alice.id);
  assert.equal((await post('bot-requests/activate',{id:applied.data.request.id,version:1})).status,403);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
console.log(JSON.stringify({passed,realQqLogins:0,liveModelRequests:0}));
