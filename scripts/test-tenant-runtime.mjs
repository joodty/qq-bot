import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSqliteState} from '../src/sqlite-state.js';
import {createConversationBudget} from '../src/group-budget.js';
import {createTokenLedger} from '../src/token-ledger.js';
import {createTenantRuntime} from '../src/tenant-runtime.js';
import {createTrialBudget} from '../src/trial-budget.js';
import {DEFAULT_PRICE_TABLE} from '../src/model-prices.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-tenant-runtime-')),stateDir=path.join(root,'state');fs.mkdirSync(stateDir);
const storage=createSqliteState({file:path.join(stateDir,'manager.sqlite'),root}).forBot('primary');
let runtime,clock=Date.parse('2026-10-22T13:00:00Z'),calls=0;
const priceTable=DEFAULT_PRICE_TABLE,now=()=>clock;
const ledger=createTokenLedger({file:path.join(stateDir,'token-usage.jsonl'),priceTable,now,resolveKey:sid=>/^byok:((?:group|private):\d+):/.exec(sid)?.[1]});
const budget=createConversationBudget({storage,file:path.join(stateDir,'conversation-budget.json'),now,getSpent:(key,date)=>({amount:ledger.daily({key,from:date,to:date}).totals.cost+(runtime?.uncertainCost(key,date)||0),currency:'CNY',complete:true})});
const funding={mode:'byok',ownerUserId:'owner',profileId:'profile',credentialVersion:1,apiKey:'sk-fixture-1234567890',model:'deepseek-flash',endpoint:'https://api.deepseek.com'};
const deps={storage,stateDir,botId:'primary',budget,ledger,priceTable,now,resolveFunding:()=>funding,getPersona:()=>({id:'persona-a',prompt:'简短答复'}),sendMessage:async()=>{},fetchImpl:async()=>{calls++;return new Response(JSON.stringify({usage:{prompt_tokens:100,completion_tokens:20},choices:[{message:{content:'你好'}}]}),{status:200});}};
let passed=0;async function test(name,run){await run();passed++;console.log('PASS',name);}
try{
 runtime=createTenantRuntime(deps);
 await test('direct provider usage reaches the same per-conversation ledger and releases its hold',async()=>{assert.equal((await runtime.chat({botId:'primary',key:'private:789',text:'你好'})).ok,true);assert.equal(calls,1);assert.ok(budget.status('private:789').spentCny>0);assert.equal(budget.active().length,0);assert.equal(ledger.daily({key:'private:789'}).totals.tokens,120);});
 await test('a zero private limit rejects before any provider request',async()=>{budget.update({configVersion:budget.config().configVersion,overrides:{'private:790':{dailyLimitCny:0}}});assert.equal((await runtime.chat({botId:'primary',key:'private:790',text:'你好'})).error.code,'BUDGET');assert.equal(calls,1);});
 await test('an unknown provider result consumes the conservative reservation persistently',async()=>{runtime=createTenantRuntime({...deps,fetchImpl:async()=>{throw new Error('connection reset');}});assert.equal((await runtime.chat({botId:'primary',key:'private:791',text:'你好'})).ok,false);assert.ok(budget.status('private:791').spentCny>0);const spent=budget.status('private:791').spentCny;runtime=createTenantRuntime(deps);assert.equal(budget.status('private:791').spentCny,spent);});
 await test('process interruption recovers a persisted direct hold as an uncertain charge',async()=>{budget.reserve('private:792',{operationId:'byok:interrupted',estimatedMaxCost:.05});runtime=createTenantRuntime(deps);assert.equal(budget.active().length,0);assert.equal(budget.status('private:792').spentCny,.05);});
 let prompts=0;const trial=createTrialBudget({storage,stateDir,priceTable,now,sendPrompt:async()=>{prompts++;return{result:{ok:true,value:{accepted:true}}};},stopSession:async()=>({result:{ok:true}})});
 const subsidy={mode:'trial',enabled:true,dailyLimitCny:.1,totalDailyLimitCny:.01};
 await test('platform trial global reservation excludes a second user before a paid call',async()=>{assert.equal((await trial.prompt('private:800',{sessionId:'trial-800',content:[]},subsidy)).result.ok,true);assert.equal((await trial.prompt('private:801',{sessionId:'trial-801',content:[]},subsidy)).result.ok,false);assert.equal(prompts,1);});
 await test('trial autonomous learning is rejected and private quota remains independent',async()=>{assert.equal((await trial.prompt('private:802',{sessionId:'trial-802'},subsidy,{direct:false})).result.ok,false);assert.equal(trial.status('private:800',subsidy).dailyLimitCny,.1);assert.equal(trial.status('private:800',subsidy).platformTotal.dailyLimitCny,.01);});
 await test('unknown cancellation converts holds into persistent conservative spend in both quotas',async()=>{trial.cancelled('trial-800');clock+=61000;assert.equal((await trial.prompt('private:801',{sessionId:'trial-801',content:[]},subsidy)).result.ok,false);assert.equal(prompts,1);assert.equal(trial.status('private:800',subsidy).spentCny,.01);assert.equal(trial.status('private:800',subsidy).platformTotal.spentCny,.01);});
 await test('real trial usage settles both quotas and event plus snapshot replay never doubles spend',async()=>{
   const eventTime=clock-61000;
   const records=[{type:'turn/start',seq:1,time:eventTime,data:{turn:1}},{type:'assistant/message',seq:2,time:eventTime,data:{turn:1,step:1,usage:{outputTokens:1000}}},{type:'turn/end',seq:3,time:eventTime,data:{turn:1}}];
   for(const record of records)await trial.event('trial-800',record,'deepseek-flash','fixture');
   const before=trial.status('private:800',subsidy);assert.equal(before.reservedCny,0);assert.equal(before.platformTotal.reservedCny,0);assert.equal(before.spentCny,.01);
   for(const record of records)await trial.event('trial-800',record,'deepseek-flash','fixture');
   await trial.snapshot('trial-800',{records:records.map(event=>({type:'event',event}))},'deepseek-flash','fixture');
   const after=trial.status('private:800',subsidy);assert.equal(after.spentCny,before.spentCny);assert.equal(after.platformTotal.spentCny,before.platformTotal.spentCny);
 });
 await test('BYOK general spend cannot consume or refund independent platform subsidy accounting',async()=>{
   const before=trial.status('private:801',subsidy);runtime=createTenantRuntime(deps);
   assert.equal((await runtime.chat({botId:'primary',key:'private:801',text:'self paid'})).ok,true);
   const after=trial.status('private:801',subsidy);assert.equal(after.spentCny,before.spentCny);assert.equal(after.platformTotal.spentCny,before.platformTotal.spentCny);
 });
 await test('direct runtime rejects a mismatching bot identity before any model request',async()=>{
   const before=calls;assert.equal((await runtime.chat({botId:'other-bot',key:'private:789',text:'wrong bot'})).ok,false);assert.equal(calls,before);
 });
 function trialFixture(name,extra={}) {
   const dir=path.join(stateDir,name);fs.mkdirSync(dir,{recursive:true});let sent=0;const stopped=[];
   const options={storage,stateDir:dir,priceTable,now,sendPrompt:async()=>{sent++;return{result:{ok:true,value:{accepted:true}}};},stopSession:async sid=>{stopped.push(sid);return{result:{ok:true}};},...extra};
   return {dir,stopped,get sent(){return sent;},open:()=>createTrialBudget(options),funding:{mode:'trial',enabled:true,dailyLimitCny:.1,totalDailyLimitCny:1}};
 }
 await test('new trial ledger with unknown model or undated usage stops fresh funding without fallback prices',async()=>{
   for(const [name,model,undated] of [['unknown-model','alien-paid-model',false],['unknown-date','deepseek-flash',true]]) {
     const f=trialFixture(name),service=f.open(),key='private:811',sid=name;
     assert.equal((await service.prompt(key,{sessionId:sid,content:[]},f.funding)).result.ok,true);
     await service.event(sid,{type:'turn/start',seq:1,time:clock,data:{turn:1}},model,'fixture');
     await service.event(sid,{type:'assistant/message',seq:2,...(undated?{}:{time:clock}),data:{turn:1,step:1,usage:{outputTokens:20}}},model,'fixture');
     assert.equal(service.status(key,f.funding).state,'unsupported');
     const restarted=f.open();assert.equal((await restarted.prompt('private:812',{sessionId:'another',content:[]},f.funding)).result.ok,false);assert.equal(f.sent,1);
   }
 });
 await test('a persisted trial hold restores session attribution even when its mapping document disappeared',async()=>{
   const f=trialFixture('recover-mapping'),service=f.open(),sid='recover-sid',key='private:820';
   assert.equal((await service.prompt(key,{sessionId:sid,content:[]},f.funding)).result.ok,true);
   const mapping=path.join(f.dir,'trial-sessions.json');const old=storage.readText(mapping);storage.writeText(mapping,JSON.stringify({version:1,sessions:{}}),old);
   const restarted=f.open();assert.ok(restarted.sessionIds().includes(sid));
   clock+=1;await restarted.snapshot(sid,{records:[{type:'turn/start',seq:1,time:clock,data:{turn:1}},{type:'assistant/message',seq:2,time:clock,data:{turn:1,step:1,usage:{outputTokens:10}}},{type:'turn/end',seq:3,time:clock,data:{turn:1}}]},'deepseek-flash','fixture');
   assert.ok(restarted.status(key,f.funding).spentCny>0);assert.equal(restarted.status(key,f.funding).reservedCny,0);
 });
 await test('trial ledger write failure persists a failclosed health marker across process recreation',async()=>{
   const f=trialFixture('write-failure'),service=f.open(),sid='broken-file',key='private:830';
   await service.prompt(key,{sessionId:sid,content:[]},f.funding);
   const ledgerPath=path.join(f.dir,'trial-usage.jsonl');fs.mkdirSync(ledgerPath);
   await service.event(sid,{type:'assistant/message',seq:1,time:clock,data:{turn:1,step:1,usage:{outputTokens:10}}},'deepseek-flash','fixture');
   fs.rmdirSync(ledgerPath);const restarted=f.open();assert.equal(restarted.status(key,f.funding).state,'unsupported');assert.equal((await restarted.prompt('private:831',{sessionId:'no-fallback',content:[]},f.funding)).result.ok,false);
 });
 await test('trial per-user cap and platform total reject independently across different users',async()=>{
   const f=trialFixture('separate-caps'),service=f.open(),limits={...f.funding,dailyLimitCny:.01,totalDailyLimitCny:.02};
   assert.equal((await service.prompt('private:840',{sessionId:'one',content:[]},limits)).result.ok,true);
   assert.equal((await service.prompt('private:840',{sessionId:'two',content:[]},limits)).result.ok,false);
   clock+=61000;assert.equal((await service.prompt('private:841',{sessionId:'three',content:[]},limits)).result.ok,true);
   assert.equal((await service.prompt('private:842',{sessionId:'four',content:[]},limits)).result.ok,false);assert.equal(f.sent,2);
 });
 await test('normal wrapped turn completion releases reservations and persists only actual trial usage',async()=>{
   const f=trialFixture('normal-completion'),service=f.open(),key='private:850',sid='normal-completion';
   await service.prompt(key,{sessionId:sid,content:[]},f.funding);clock++;
   const records=[{type:'turn/start',seq:1,time:clock,data:{turn:1}},{type:'assistant/message',seq:2,time:clock,data:{turn:1,step:1,usage:{outputTokens:10}}},{type:'turn/end',seq:3,time:clock,data:{turn:1}}];
   await service.snapshot(sid,{records:records.map(event=>({type:'event',event}))},'deepseek-flash','fixture');
   const before=service.status(key,f.funding);assert.equal(before.reservedCny,0);assert.ok(before.spentCny>0&&before.spentCny<.01);assert.equal(before.spentCny,before.platformTotal.spentCny);
   const restarted=f.open();await restarted.snapshot(sid,{records:records.map(event=>({type:'event',event}))},'deepseek-flash','fixture');
   assert.equal(restarted.status(key,f.funding).spentCny,before.spentCny);
 });
 await test('two unknown queued prompts consume one conservative total and late shared-turn usage offsets it once',async()=>{
   const f=trialFixture('unknown-queue'),service=f.open(),key='private:860',sid='unknown-queue';
   await service.prompt(key,{sessionId:sid,content:[]},f.funding);await service.prompt(key,{sessionId:sid,content:[]},f.funding);
   service.cancelled(sid);assert.equal(service.status(key,f.funding).spentCny,.02);
   const records=[{type:'turn/start',seq:1,time:clock,data:{turn:1}},{type:'assistant/message',seq:2,time:clock,data:{turn:1,step:1,usage:{outputTokens:3750}}},{type:'turn/end',seq:3,time:clock,data:{turn:1}}];
   await service.snapshot(sid,{records},'deepseek-flash','fixture');assert.equal(service.status(key,f.funding).spentCny,.02);
   const restarted=f.open();await restarted.snapshot(sid,{records},'deepseek-flash','fixture');assert.equal(restarted.status(key,f.funding).spentCny,.02);
 });
 await test('BYOK real usage and uncertain charges survive a fresh ledger object and are not replay billed',async()=>{
   let currentRuntime;
   const resumedLedger=createTokenLedger({file:path.join(stateDir,'token-usage.jsonl'),priceTable,now,resolveKey:sid=>/^byok:((?:group|private):\d+):/.exec(sid)?.[1]});
   const resumedBudget=createConversationBudget({storage,file:path.join(stateDir,'conversation-budget.json'),now,getSpent:(key,date)=>({amount:resumedLedger.daily({key,from:date,to:date}).totals.cost+(currentRuntime?.uncertainCost(key,date)||0),currency:'CNY',complete:true})});
   currentRuntime=createTenantRuntime({...deps,budget:resumedBudget,ledger:resumedLedger});
   assert.equal(resumedBudget.status('private:792').spentCny,.05);
   const before=resumedLedger.daily({key:'private:789'}).totals.tokens;assert.equal(before,120);
   assert.equal((await currentRuntime.chat({botId:'primary',key:'private:789',text:'after restart'})).ok,true);
   assert.equal(resumedLedger.daily({key:'private:789'}).totals.tokens,240);
 });
 console.log(`${passed}/${passed} tenant runtime checks passed`);
}finally{storage.close();fs.rmSync(root,{recursive:true,force:true});}
