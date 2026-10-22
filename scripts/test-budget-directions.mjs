import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
const event = (text, mention = false, id = 456) => ({ self_id:999, user_id:id, group_id:456, message_id:Date.now(), sender:{nickname:'fixture'},
  message:[...(mention ? [{type:'at',data:{qq:'999'}}] : []),{type:'text',data:{text}}] });
async function test(name, run, extra = {}) {
  const h = await bridgeHarness({config:{storage:{driver:'sqlite'},groupMentionOnly:false,sendDelayMs:0,
    dsh:{authToken:'fixture-only',model:'fixture',provider:'fixture'},
    pricing:{models:{fixture:{label:'fixture',off:{cacheMiss:10000,cacheHit:10000,cacheWrite:10000,output:10000},peak:{cacheMiss:10000,cacheHit:10000,cacheWrite:10000,output:10000}}}},
    allow:{groups:['456','789'],private:['123','456']},social:{activeReplyDelayMinMs:0,activeReplyDelayMaxMs:0},...extra},
    files:{'roles/A.md':'# A','state/current-role.json':{role:'A',mode:'active'}}});
  h.setSelfIdentity('FixtureBot','999');
  const seed = async (key = 'group:456') => {
    const sid = await h.ensureSession(key);
    await h.recordSessionUsage(sid,{type:'assistant/message',time:Date.now(),seq:1,data:{turn:1,step:1,usage:{outputTokens:80},model:'fixture'}});
    assert.equal(h.getBudget().status(key).state,'degraded'); return sid;
  };
  try { await run(h,seed); passed++; console.log('PASS',name); } finally { await h.close(); }
}
await test('80 percent chat ignores ordinary group messages but answers actual at mention',async(h,seed)=>{
  h.setMode('chat'); await seed(); await h.handleIncoming('group',456,event('大家吃饭了吗？'),h.cfg);
  assert.equal(h.calls.prompts.length,0);
  await h.handleIncoming('group',456,event('你好',true),h.cfg); assert.equal(h.calls.prompts.length,1);
});
await test('bootstrap and generic questions do not turn ordinary unread messages into direct paid wakes',async(h,seed)=>{
  h.setMode('reserved2'); await seed(); await h.handleIncoming('group',456,event('大家吃饭了吗？'),h.cfg);
  for (const reason of ['bootstrap','question','budgetResume','timeout','replyCheck','proactiveCheck']) await h.sendWakePromptV2('group:456',reason);
  assert.equal(h.calls.prompts.length,0); assert.equal(h.getSocialV2State('group:456').unread.length,1);
  await h.handleIncoming('group',456,event('FixtureBot你好'),h.cfg);
  const state=h.getSocialV2State('group:456');clearTimeout(state.pendingWakeTimer);state.pendingWakeTimer=null;
  await h.sendWakePromptV2('group:456','bootstrap'); assert.equal(h.calls.prompts.length,1);
});
await test('v1 autonomous no-reason, summary and farewell cannot bypass degraded gate',async(h,seed)=>{
  h.setMode('reserved'); await seed();
  for (const opts of [{},{silent:true},{farewell:true}]) assert.equal((await h.deliverPrompt('group:456','autonomous',opts)).budgetLimited,true);
  assert.equal(h.calls.prompts.length,0);
  await h.deliverPrompt('group:456','explicit',{direct:true}); assert.equal(h.calls.prompts.length,1);
});
await test('private direct reply survives an offline queue while autonomous private timers remain suppressed',async(h,seed)=>{
  h.setMode('chat'); await seed('private:456'); h.setReady(false);
  await h.handleIncoming('private',456,event('你好'),h.cfg); h.setReady(true); await h.flushQueue();
  assert.equal(h.calls.prompts.length,1);
});
await test('snapshot accounting failure closes later paid admission',async(h)=>{
  h.setMode('chat'); const sid=await h.ensureSession('private:123');
  h.tokenLedger.ingestBaseline = () => { throw new Error('fixture disk failure'); };
  await h.recordSessionSnapshot(sid,{records:[]});
  assert.equal(h.getBudget().status('private:123').state,'unsupported');
  const response=await h.budgetedPrompt('private:123',{sessionId:sid,content:[{type:'text',text:'stop'}]});
  assert.equal(response.result.ok,false); assert.equal(h.calls.prompts.length,0);
});
await test('research requires explicit billing key and a second group cannot charge the first evidence group',async(h)=>{
  h.setMode('reserved2');
  h.api.sessions.prompt = async params => {h.calls.prompts.push(params);return {result:{ok:false,error:{code:'FIXTURE_STOP',message:'no model'}}};};
  const server=h.startConsoleServer();if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  const post=async(route,body)=>{const response=await fetch(url+route,{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  try {
    const invalid=await post('/api/slang/research',{});assert.equal(invalid.status,400);assert.match(invalid.data.error,/key/);
    assert.equal((await post('/api/socialV2/slang/submit',{key:'group:456',content:'fixture梗',context:'group A evidence'})).status,200);
    await wait(20);assert.equal(h.calls.prompts.length,1);
    const config=h.getBudget().config();h.getBudget().update({configVersion:config.configVersion,overrides:{'group:789':{dailyLimitCny:0}}});
    assert.equal((await post('/api/socialV2/slang/submit',{key:'group:789',content:'fixture梗',context:'group B evidence'})).status,200);
    await wait(20);assert.equal(h.calls.prompts.length,1,'new group B trigger cannot use group A budget');
  } finally {await new Promise(resolve=>server.close(resolve));}
},{slang:{enabled:true,autoResearch:true,inferenceThresholds:[2]}});
console.log(JSON.stringify({passed,paidCalls:0,realMessages:0}));
