import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const h=await bridgeHarness({config:{storage:{driver:'sqlite'},dsh:{authToken:'fixture-only',model:'fixture',provider:'fixture'},
  pricing:{peakMultiplier:1,models:{fixture:{label:'fixture',off:{cacheMiss:10000,cacheHit:10000,cacheWrite:10000,output:10000}}}},
  allow:{groups:['456'],private:['123','456']},sendDelayMs:0},files:{'roles/A.md':'# A\n温柔','state/current-role.json':{role:'A',mode:'active'}}});
h.setMode('reserved2');const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port;
const req=async(path,body)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'x-console-token':'fixture-console-token',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS',name);}
try{
  await test('actual budget API defaults to one CNY for group, private and administrator private',async()=>{
    const r=await req('/api/conversation-budgets');assert.equal(r.status,200);assert.equal(r.data.config.defaultDailyLimitCny,1);
    assert.deepEqual(r.data.conversations.map(x=>x.key).sort(),['group:456','private:123','private:456']);
    for(const row of r.data.conversations)assert.equal(row.dailyLimitCny,1);
    assert.equal((await req('/api/group-budgets')).status,200);
  });
  await test('configuration CAS and zero limit block a new private paid call without touching the group',async()=>{
    const config=(await req('/api/conversation-budgets')).data.config;
    assert.equal((await req('/api/conversation-budgets',{configVersion:config.configVersion,groups:{'private:456':{dailyLimitCny:0}}})).status,200);
    assert.equal((await req('/api/conversation-budgets',{configVersion:config.configVersion,defaultDailyLimitCny:99})).status,409);
    const sid=await h.ensureSession('private:456'),count=h.calls.prompts.length;
    const result=await h.budgetedPrompt('private:456',{sessionId:sid,mode:'queue',content:[{type:'text',text:'你好'}]});
    assert.equal(result.result.ok,false);assert.equal(result.result.error.code,'CONVERSATION_BUDGET_EXCEEDED');assert.equal(h.calls.prompts.length,count);
    assert.equal(h.getBudget().status('group:456').state,'normal');
  });
  await test('80 percent disables autonomous participation and permits only a short direct reply',async()=>{
    const sid=await h.ensureSession('group:456');const now=Date.now();
    await h.recordSessionUsage(sid,{type:'assistant/message',time:now,seq:1,data:{turn:1,step:1,usage:{outputTokens:80},model:'fixture'}});
    const status=h.getBudget().status('group:456');assert.ok(status.spentCny>=0.8&&status.spentCny<1,JSON.stringify(status));assert.equal(status.state,'degraded');
    let count=h.calls.prompts.length;await h.sendWakePromptV2('group:456','proactiveCheck');assert.equal(h.calls.prompts.length,count);
    const accepted=await h.budgetedPrompt('group:456',{sessionId:sid,mode:'queue',content:[{type:'text',text:'直接提问'}]},{direct:true});
    assert.equal(accepted.result.ok,true);assert.match(h.calls.prompts.at(-1).content.at(-1).text,/120/);
    count=h.calls.prompts.length;const next=await h.budgetedPrompt('group:456',{sessionId:sid,mode:'queue',content:[{type:'text',text:'再问'}]},{direct:true});
    assert.equal(next.result.ok,false);assert.equal(h.calls.prompts.length,count);
  });
  await test('observed exhausted spend stops the in-flight session, reset never returns its daily allowance',async()=>{
    const sid=h.state.sessions['group:456'];await h.recordSessionUsage(sid,{type:'turn/start',time:Date.now(),seq:2,data:{turn:2}});
    await h.recordSessionUsage(sid,{type:'assistant/message',time:Date.now(),seq:3,data:{turn:2,step:1,usage:{outputTokens:30},model:'fixture'}});
    assert.equal(h.getBudget().status('group:456').state,'exhausted');assert.ok(h.calls.cancelled.includes(sid));
    assert.equal((await req('/api/tokens/reset',{})).status,409);assert.equal(h.getBudget().status('group:456').state,'exhausted');
  });
  await test('administrator private is subject to the same quota and agent cannot edit the quota',async()=>{
    const c=h.getBudget().config();await req('/api/conversation-budgets',{configVersion:c.configVersion,overrides:{'private:123':{dailyLimitCny:0}}});
    const sid=await h.ensureSession('private:123'),before=h.calls.prompts.length;
    assert.equal((await h.budgetedPrompt('private:123',{sessionId:sid,content:[{type:'text',text:'管理员不豁免'}]})).result.ok,false);
    assert.equal(h.calls.prompts.length,before);
    const r=await fetch(base+'/api/conversation-budgets',{headers:{'x-console-token':'fixture-console-token','x-agent-call':'1'}});assert.equal(r.status,403);
  });
  console.log(JSON.stringify({passed,realMessages:0,paidCalls:0}));
}finally{await new Promise(r=>server.close(r));await h.close();}
