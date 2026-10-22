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
import {createHostedLoginClient,publicLoginState} from '../src/hosted-login-client.js';
import {createHostedLoginService,validateHostedLoginConfig} from './hosted-login-service.mjs';
import {findQQLoginWindow,loginWindowPng} from '../src/qq-login-frame.js';

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
function hosted(f){
 f.workers.delete('worker-a');const p=setup(f),calls=[];
 f.manager.add=input=>{f.actions.push('add');const row={...input,actualQQ:null,verifiedAt:null,enabled:false,isPrimary:false};f.workers.set(row.id,row);return {...row};};
 f.manager.remove=id=>{f.actions.push('remove');f.workers.delete(id);};
 const driver={state:'waiting_scan',onStart:null,onStatus:null,
  start:async input=>{calls.push({action:'start',input});if(driver.onStart)await driver.onStart();return {connection:{id:'hosted-'+input.requestId,name:input.name,expectedQQ:input.botQQ,port:32112,machineToken:'fixture-worker-machine-token'},login:{state:'starting'}};},
  status:async input=>{calls.push({action:'status',input});if(driver.onStatus)await driver.onStatus();return {state:driver.state};},
  refresh:async input=>{calls.push({action:'refresh',input});return {state:'waiting_scan'};},
  cancel:async input=>{calls.push({action:'cancel',input});return {state:'stopped'};}};
 const app=f.open({loginProvider:driver}),row=app.create(f.alice,{botQQ:'55555',name:'自己的机器人',profileId:p.id});
 return {app,row,p,driver,calls,input:r=>({id:r.id,version:r.version})};
}
await test('web login starts an isolated disabled worker and never returns a machine credential',async f=>{
 const h=hosted(f),result=await h.app.startLogin(f.alice,h.input(h.row));assert.equal(result.request.status,'awaiting_scan');assert.equal(result.request.botId,'hosted-'+h.row.id);assert.equal(f.service.botOwner(result.request.botId),null);assert.equal(f.workers.get(result.request.botId).enabled,false);assert.equal(h.calls[0].input.ownerQQ,'12345');assert.ok(!JSON.stringify(result).includes('fixture-worker-machine-token'));assert.equal(h.app.list(f.alice).loginAvailable,true);
 const again=await h.app.startLogin(f.alice,h.input(result.request));assert.equal(again.request.botId,result.request.botId);assert.equal(f.actions.filter(a=>a==='add').length,1);
});
await test('other users and even the platform admin cannot obtain an applicant login picture',async f=>{
 const h=hosted(f),started=await h.app.startLogin(f.alice,h.input(h.row));
 for(const user of [f.bob,f.admin])for(const method of ['startLogin','checkLogin','refreshLogin','cancelLogin'])await assert.rejects(h.app[method](user,h.input(started.request)),rejects(404));
 assert.equal(h.calls.length,1);assert.equal(f.service.botOwner(started.request.botId),null);
});
await test('stale and injected login parameters are rejected before contacting the broker',async f=>{
 const h=hosted(f);
 for(const extra of [{botId:'primary'},{ownerUserId:f.bob.id},{port:3100},{machineToken:'fixture-user-forgery'}])await assert.rejects(h.app.startLogin(f.alice,{...h.input(h.row),...extra}),rejects(400));
 await assert.rejects(h.app.startLogin(f.alice,{id:h.row.id,version:999}),rejects(409));assert.equal(h.calls.length,0);
});
await test('waiting, expired and mismatched QQ never grant ownership or enable a bot',async f=>{
 const h=hosted(f),started=await h.app.startLogin(f.alice,h.input(h.row));
 for(const state of ['waiting_scan','waiting_confirm','expired','mismatch']){h.driver.state=state;const result=await h.app.checkLogin(f.alice,h.input(started.request));assert.equal(result.login.state,state);assert.equal(f.service.botOwner(started.request.botId),null);assert.equal(f.workers.get(started.request.botId).enabled,false);}
 assert.equal(f.actions.some(a=>a.startsWith('verify:')),false);
});
await test('successful scan independently verifies live identity then assigns only the applicant and their own API funding',async f=>{
 const h=hosted(f),started=await h.app.startLogin(f.alice,h.input(h.row));h.driver.state='ready';const result=await h.app.checkLogin(f.alice,h.input(started.request));assert.equal(result.request.status,'active');assert.equal(f.service.botOwner(result.request.botId).ownerUserId,f.alice.id);assert.equal(f.service.getFunding({botId:result.request.botId,key:'group:456'}).profileId,h.p.id);assert.equal(f.workers.get(result.request.botId).enabled,true);assert.equal(f.auth.list(f.admin).find(r=>r.id===f.alice.id).role,'user');await assert.rejects(h.app.cancelLogin(f.alice,h.input(result.request)),rejects(409));
});
await test('broker ready status cannot bypass a failing independent worker identity check',async f=>{
 const h=hosted(f),started=await h.app.startLogin(f.alice,h.input(h.row));h.driver.state='ready';f.setVerify(()=>{throw Error('wrong QQ identity');});await assert.rejects(h.app.checkLogin(f.alice,h.input(started.request)));assert.equal(f.service.botOwner(started.request.botId),null);assert.equal(f.workers.get(started.request.botId).enabled,false);
});
await test('reconnecting an active bot uses current funding and preserves ownership without claiming or enabling again',async f=>{
 const h=hosted(f),started=await h.app.startLogin(f.alice,h.input(h.row));h.driver.state='ready';const active=(await h.app.checkLogin(f.alice,h.input(started.request))).request;
 const current=f.service.overview(f.alice).ownedBots.find(r=>r.botId===active.botId),next=f.service.saveProfile(f.alice,{name:'新费用配置',model:'deepseek-flash',apiKey:secret,version:0});f.service.setFunding(f.alice,{botId:active.botId,profileId:next.id,version:current.fundingVersion});f.service.deleteProfile(f.alice,{id:h.p.id,version:h.p.version});
 const before=f.actions.length,owner=f.service.botOwner(active.botId);h.driver.state='waiting_scan';await h.app.startLogin(f.alice,h.input(active));const checked=await h.app.checkLogin(f.alice,h.input(active));assert.equal(checked.request.status,'active');assert.equal(checked.login.state,'waiting_scan');assert.equal(f.actions.length,before);assert.deepEqual(f.service.botOwner(active.botId),owner);assert.equal(f.service.getFunding({botId:active.botId,key:'group:456'}).profileId,next.id);
});
await test('a former owner cannot reopen the login window after a platform ownership transfer',async f=>{
 const h=hosted(f),started=await h.app.startLogin(f.alice,h.input(h.row));h.driver.state='ready';const active=(await h.app.checkLogin(f.alice,h.input(started.request))).request;f.service.assignBot(f.admin,{botId:active.botId,userId:f.bob.id,version:1});const count=h.calls.length;
 for(const method of ['startLogin','checkLogin','refreshLogin'])await assert.rejects(h.app[method](f.alice,h.input(active)),rejects(404));assert.equal(h.calls.length,count);assert.equal(f.workers.get(active.botId).enabled,true);
});
await test('cancelling an unclaimed login locks out concurrent administrative activation',async f=>{
 const h=hosted(f),started=await h.app.startLogin(f.alice,h.input(h.row));let entered,release;const waiting=new Promise(r=>entered=r);h.driver.cancel=async()=>{entered();await new Promise(r=>release=r);return {state:'stopped'};};const cancellation=h.app.cancelLogin(f.alice,h.input(started.request));await waiting;await assert.rejects(h.app.activate(f.admin,h.input(started.request)),rejects(409));release();await cancellation;assert.equal(f.service.botOwner(started.request.botId),null);
});
await test('logout during provisioning cancels the newly prepared environment before it is registered',async f=>{
 const h=hosted(f),login=await f.auth.login({username:'alice',password},'fixture-login'),actor=f.auth.authenticate('qq_console_session='+login.token);Object.defineProperty(actor,'cookieHeader',{value:'qq_console_session='+login.token});h.driver.onStart=()=>f.auth.logout(actor);
 await assert.rejects(h.app.startLogin(actor,h.input(h.row)),rejects(401));assert.equal(f.actions.includes('add'),false);assert.equal(h.calls.at(-1).action,'cancel');
});
await test('deleting a funding profile during preparation cannot create a claim',async f=>{
 const h=hosted(f);h.driver.onStart=()=>f.service.deleteProfile(f.alice,{id:h.p.id,version:h.p.version});await assert.rejects(h.app.startLogin(f.alice,h.input(h.row)),rejects(400));assert.equal(f.actions.includes('add'),false);assert.equal(h.calls.at(-1).action,'cancel');
});
await test('account revocation during a status await prevents automatic activation',async f=>{
 const h=hosted(f),started=await h.app.startLogin(f.alice,h.input(h.row));h.driver.state='ready';h.driver.onStatus=()=>f.auth.update(f.admin,{id:f.alice.id,disabled:true});await assert.rejects(h.app.checkLogin(f.alice,h.input(started.request)),rejects(403));assert.equal(f.service.botOwner(started.request.botId),null);
});
await test('ownership transfer during automatic activation is not undone by compensation',async f=>{
 const h=hosted(f),started=await h.app.startLogin(f.alice,h.input(h.row));h.driver.state='ready';const other=f.profile(f.bob);
 f.setEnable(()=>{f.service.assignBot(f.admin,{botId:started.request.botId,userId:f.bob.id,version:1});f.service.setFunding(f.bob,{botId:started.request.botId,profileId:other.id,version:2});});
 await assert.rejects(h.app.checkLogin(f.alice,h.input(started.request)),rejects(409));assert.equal(f.service.botOwner(started.request.botId).ownerUserId,f.bob.id);assert.equal(f.workers.get(started.request.botId).enabled,true);
});
await test('an unclaimed scan can be cancelled after the user deletes their API profile',async f=>{
 const h=hosted(f),started=await h.app.startLogin(f.alice,h.input(h.row));f.service.deleteProfile(f.alice,{id:h.p.id,version:h.p.version});const result=await h.app.cancelLogin(f.alice,h.input(started.request));assert.equal(result.request.status,'rejected');assert.equal(h.calls.at(-1).action,'cancel');assert.equal(f.workers.has(started.request.botId),false);
});
await test('a stale state change during preparation does not overwrite rejection or leave a registered worker',async f=>{
 const h=hosted(f);h.driver.onStart=()=>h.app.reject(f.admin,{...h.input(h.row),reason:'资源暂不可用'});await assert.rejects(h.app.startLogin(f.alice,h.input(h.row)),rejects(409));assert.equal(h.app.list(f.alice).requests[0].status,'rejected');assert.equal(f.actions.includes('add'),false);
});
await test('browser-safe login responses omit URLs, SVG, secrets and unsupported states',async()=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';assert.deepEqual(publicLoginState({state:'waiting_scan',qrImage:png,token:'fixture-hidden',port:3100,url:'http://example.invalid'}),{state:'waiting_scan',qrImage:png});assert.equal(publicLoginState({state:'waiting_scan',qrImage:'data:image/png;base64,aGVsbG8='}).qrImage,undefined);assert.equal(publicLoginState({state:'waiting_scan',qrImage:'data:image/svg+xml;base64,abc'}).qrImage,undefined);assert.throws(()=>publicLoginState({state:'unknown'}),rejects(502));
});
await test('the private client fixes its destination, refuses redirects and redacts unexpected broker errors',async()=>{
 const read=()=>JSON.stringify({port:32109,token:'fixture-private-broker-token-32-chars'}),calls=[];
 const client=createHostedLoginClient({file:'unused',read,fetchImpl:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({ok:true,login:{state:'expired',machineToken:'fixture-hidden'}}));}});
 assert.equal(client.available(),true);assert.deepEqual(await client.status({requestId:'a'.repeat(32),botId:'hosted-'+ 'a'.repeat(32),botQQ:'55555'}),{state:'expired'});assert.equal(calls[0].url,'http://127.0.0.1:32109/internal/login/status');
 const bad=createHostedLoginClient({file:'unused',read,fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://example.invalid'}})});await assert.rejects(bad.status({requestId:'a'.repeat(32)}),rejects(502));
 const hidden=createHostedLoginClient({file:'unused',read,fetchImpl:async()=>new Response(JSON.stringify({ok:false,error:'fixture-private-secret'}),{status:500})});await assert.rejects(hidden.status({requestId:'a'.repeat(32)}),e=>!e.message.includes('fixture-private-secret'));
});
await test('X11 capture selects a bounded QQ login window and rejects desktop, oversized and invalid image bounds',async()=>{
 const window=findQQLoginWindow('  0x123 "QQ": ("qq" "QQ")  320x460+0+0  +352+144');assert.equal(window.width,320);assert.equal(findQQLoginWindow(' 0x123 "QQ": () 900x700+0+0 +0+0'),null);assert.equal(findQQLoginWindow(' 0x123 "Terminal": () 320x460+0+0 +0+0'),null);
 const frame=Buffer.alloc(104+4*4*4);for(const [field,value]of [[0,104],[1,7],[2,2],[4,4],[5,4],[7,0],[11,32],[12,16],[14,0xff0000],[15,0xff00],[16,0xff]])frame.writeUInt32BE(value,field*4);frame[106]=255;
 const png=loginWindowPng(frame,{x:0,y:0,width:2,height:2});assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),2);assert.throws(()=>loginWindowPng(frame,{x:3,y:0,width:2,height:2}));assert.throws(()=>loginWindowPng(Buffer.alloc(10),window));
});
await test('the loopback broker rejects browser channels, foreign tokens, query paths and injected parameters',async f=>{
 const config={root:path.join(f.root,'broker'),codeRoot:path.join(f.root,'code'),dockerBin:'/usr/bin/false',dockerSocket:'/run/example.sock',image:'example.invalid/qq@sha256:'+'a'.repeat(64),startScript:'/example/start.sh',nodeBin:'/usr/bin/node',dshBin:'/example/dsh',dshModules:'/example/node_modules',slirpBin:'/example/slirp',slirpLib:'/example/lib',setprivBin:'/usr/bin/setpriv',nsenterBin:'/usr/bin/nsenter',ipBin:'/usr/sbin/ip',port:32109,basePort:32400,maxBots:1,uidBase:62000,gidBase:62000,token:'fixture-private-broker-token-32-chars'};
 assert.throws(()=>validateHostedLoginConfig({...config,root:config.codeRoot}));const {server}=createHostedLoginService(config);server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  for(const headers of [{},{'x-login-service-token':config.token,origin:'https://example.invalid'},{'x-login-service-token':config.token,cookie:'fixture-cookie'},{'x-login-service-token':'fixture-other-token'}])assert.equal((await fetch(url+'/internal/login/start',{method:'POST',headers,body:'{}'})).status,403);
  const headers={'x-login-service-token':config.token};assert.equal((await fetch(url+'/internal/login/status?requestId=x',{method:'POST',headers,body:'{}'})).status,403);assert.equal((await fetch(url+'/internal/login/status',{method:'POST',headers,body:JSON.stringify({requestId:'a'.repeat(32),botId:'primary',botQQ:'55555',command:'fixture-forbidden'})})).status,400);
  assert.equal((await fetch(url+'/internal/login/status',{method:'POST',headers,body:JSON.stringify({requestId:'a'.repeat(32),botId:'hosted-'+ 'a'.repeat(32),botQQ:'55555'})})).status,404);
 }finally{await new Promise(r=>server.close(r));}
});
console.log(JSON.stringify({passed,realQqLogins:0,liveModelRequests:0}));
