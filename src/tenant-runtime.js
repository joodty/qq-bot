import path from 'node:path';
import { createTenantChat } from './tenant-chat.js';
import { priceUsage } from './model-prices.js';
import { beijingBudgetDate } from './group-budget.js';

/** Glue for direct, tool-free BYOK chat and its durable financial admission. */
export function createTenantRuntime({ storage, stateDir, botId, budget, ledger, priceTable, resolveFunding, getPersona, sendMessage, fetchImpl = fetch, now = Date.now }) {
  const file = path.join(stateDir, 'byok-uncertain.json');
  let raw, data;
  function load() {
    try { raw = storage.readText(file); } catch (e) { if(e.code !== 'ENOENT')throw e; raw = null; }
    data = raw === null ? {version:1,charges:[]} : JSON.parse(raw);
    if(data.version !== 1 || Object.keys(data).sort().join() !== 'charges,version' || !Array.isArray(data.charges)
      || data.charges.length>100000
      || data.charges.some(r=>!r || Object.keys(r).sort().join() !== 'amount,date,id,key' || typeof r.id !== 'string'
        || !r.id || r.id.length>200 || /[\x00-\x1f\x7f]/.test(r.id)
        || !/^(group|private):[1-9]\d*$/.test(r.key) || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(Date.parse(r.date+'T00:00:00Z'))
        || new Date(r.date+'T00:00:00Z').toISOString().slice(0,10)!==r.date || !Number.isFinite(r.amount) || r.amount < 0 || r.amount>1000000)
      || new Set(data.charges.map(r=>r.id)).size !== data.charges.length)throw new Error('自费待核对费用存储损坏');
    return data;
  }
  function uncertain(row) {
    storage.transaction(()=>{
      load();
      if(!data.charges.some(r=>r.id === row.id)) {
        data.charges.push({id:row.id,key:row.key,date:beijingBudgetDate(now()),amount:row.amountCny});
        storage.writeText(file,JSON.stringify(data),raw);
      }
      // Persisting the conservative charge precedes releasing the admission hold.
      budget.release(row.id);
    });
  }
  storage.transaction(load);
  for(const row of budget.active({includeExpired:true}))if(row.operationId?.startsWith('byok:'))uncertain(row);
  const costs = new Map();
  const chat = createTenantChat({storage,file:path.join(stateDir,'byok-conversations.json'),resolveFunding,getPersona,sendMessage,fetchImpl,now,
    admit(context) {
      const peakTable={...priceTable,peakWeekdays:[1,2,3,4,5,6,7],peakWindows:[[0,24]],holidays:[]};
      // Reserve peak cost even when an off-peak request finishes after a tariff boundary.
      const estimate=priceUsage({inputTokens:context.inputTokenUpperBound,outputTokens:context.maxTokens},{model:context.model,at:now(),table:peakTable});
      if(priceTable.currency!=='CNY' || estimate.rates.estimated)return {allowed:false};
      return budget.reserve(context.key,{operationId:'byok:'+context.requestId,
        estimatedMaxCost:Math.max(0.000001,Math.ceil(estimate.cost.total*1e6)/1e6)});
    },
    onUsage(context) {
      const sid='byok:'+context.key+':'+context.profileId+':'+context.requestId;
      ledger.ingestEvent({sessionId:sid,model:context.model,provider:'deepseek-official',at:context.at,
        event:{type:'assistant/message',seq:1,time:context.at,data:{turn:1,step:1,usage:context.usage}}});
      costs.set(context.requestId,priceUsage(context.usage,{model:context.model,at:context.at,table:priceTable}).cost.total);
    },
    settle(id, context) {
      if(!id)return;
      if(context.outcome==='uncertain') {
        const row=budget.active({includeExpired:true}).find(r=>r.id===id);if(row)uncertain(row);
      } else if(context.charged && !costs.has(context.requestId)) {
        const row=budget.active({includeExpired:true}).find(r=>r.id===id);if(row)uncertain(row);
      } else if(context.charged) budget.settle(id,{amount:costs.get(context.requestId),currency:'CNY'});
      else budget.release(id);
      costs.delete(context.requestId);
    },
  });
  return {
    chat: input=>input?.botId===botId?chat.chat(input):Promise.resolve({handled:true,ok:false,error:{code:'INVALID',message:'机器人身份不匹配，已停止调用。'}}),
    pending:()=>chat.pending(),
    uncertainCost(key,date) { return storage.transaction(()=>load().charges.filter(r=>r.key===key&&r.date===date).reduce((n,r)=>n+r.amount,0)); },
  };
}
