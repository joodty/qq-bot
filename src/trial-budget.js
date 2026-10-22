import path from 'node:path';
import fs from 'node:fs';
import { createTokenLedger } from './token-ledger.js';
import { createConversationBudget, beijingBudgetDate } from './group-budget.js';
import { createBudgetController } from './budget-controller.js';

const TOTAL = 'private:1';
const reject = message => ({ result: { ok: false, error: { code: 'CONVERSATION_BUDGET_EXCEEDED', message } } });
/** Separate subsidy accounting prevents BYOK spending, or resetting the general
 * usage page, from refunding a user's or the platform's daily trial allowance. */
export function createTrialBudget({ storage, stateDir, sendPrompt, stopSession, priceTable, now = Date.now, log = () => {} }) {
  const file = path.join(stateDir, 'trial-sessions.json');
  let raw = null, sessions;
  const load = () => {
    try { raw = storage.readText(file); } catch (e) { if (e.code !== 'ENOENT') throw e; raw = null; }
    const data = raw === null ? { version: 1, sessions: {} } : JSON.parse(raw);
    if (data?.version !== 1 || !data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions) || Object.keys(data).sort().join() !== 'sessions,version'
        || Object.entries(data.sessions).some(([sid, key]) => !sid || sid.length > 200 || /[\x00-\x1f\x7f]/.test(sid) || !/^private:[1-9]\d*$/.test(key))) throw new Error('体验费用归属存储损坏，已停止调用');
    return data;
  };
  sessions = storage.transaction(load).sessions;
  function mark(sid, key) {
    storage.transaction(() => {
      const data = load();
      if (Object.hasOwn(data.sessions,sid) && data.sessions[sid] !== key) throw new Error('体验会话费用归属冲突');
      if (!Object.hasOwn(data.sessions,sid)) { Object.defineProperty(data.sessions,sid,{value:key,enumerable:true,writable:true,configurable:true}); storage.writeText(file, JSON.stringify(data), raw); }
      sessions = data.sessions;
    });
  }
  const healthFile=path.join(stateDir,'trial-ledger-health.json');
  function readHealth() {
    let text; try{text=storage.readText(healthFile);}catch(error){if(error.code!=='ENOENT')throw error;text=null;}
    const data=text===null?{version:1,complete:true}:JSON.parse(text);
    if(!data || data.version!==1 || typeof data.complete!=='boolean' || Object.keys(data).sort().join()!=='complete,version')throw new Error('体验费用账本健康状态损坏');
    return {text,data};
  }
  let healthy = storage.transaction(readHealth).data.complete;
  function unhealthy() {
    healthy=false;
    storage.transaction(()=>{const {text,data}=readHealth();if(data.complete){data.complete=false;storage.writeText(healthFile,JSON.stringify(data),text);}});
  }
  const ledgerFile = path.join(stateDir, 'trial-usage.jsonl');
  try { const existing = fs.statSync(ledgerFile); if (!existing.isFile()) throw new Error('体验费用账本不是常规文件'); fs.accessSync(ledgerFile,fs.constants.R_OK); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ledger = createTokenLedger({ file: ledgerFile, resolveKey: sid => Object.hasOwn(sessions,sid) ? sessions[sid] : undefined, priceTable, now,
    log: (...args) => { unhealthy(); log(...args); } });
  const uncertainFile=path.join(stateDir,'trial-uncertain.json');
  function readUncertain() {
    let text;try{text=storage.readText(uncertainFile);}catch(error){if(error.code!=='ENOENT')throw error;text=null;}
    const data=text===null?{version:1,charges:[]}:JSON.parse(text);
    if(!data || data.version!==1 || Object.keys(data).sort().join()!=='charges,version' || !Array.isArray(data.charges) || data.charges.length>100000
      || new Set(data.charges.map(row=>row?.id)).size!==data.charges.length || data.charges.some(row=>!row
        || Object.keys(row).sort().join()!=='amountCny,createdAt,date,id,key,sessionId,throughAt,turnId' || !/^[a-f0-9]{32}$/.test(row.id)
        || !/^private:[1-9]\d*$/.test(row.key) || typeof row.sessionId!=='string' || !row.sessionId || row.sessionId.length>200
        || !(row.turnId===null || typeof row.turnId==='string') || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.throughAt)
        || row.createdAt<0 || row.throughAt<row.createdAt || row.date!==beijingBudgetDate(row.throughAt)
        || !Number.isFinite(row.amountCny) || row.amountCny<=0 || row.amountCny>1000000))throw new Error('体验待核对费用存储损坏');
    return {text,data};
  }
  storage.transaction(readUncertain);
  function conservativeExtra(key,date) {
    const charges=storage.transaction(readUncertain).data.charges.filter(row=>row.date===date&&(!key||row.key===key));
    const byKey=new Map();for(const row of charges){if(!byKey.has(row.key))byKey.set(row.key,[]);byKey.get(row.key).push(row);}
    let total=0;
    for(const [key,rows] of byKey) {
      const remaining=rows.map(row=>Math.ceil(row.amountCny*1e6-0.0000001));
      for(const turn of ledger.conversation(key,{turnLimit:1000})?.turns||[]) {
        if(!Number.isFinite(turn.cost)||turn.cost<=0||!Number.isFinite(turn.endedAt)||beijingBudgetDate(turn.endedAt)!==date)continue;
        let cost=Math.floor(turn.cost*1e6+0.0000001);
        for(let index=0;index<rows.length&&cost>0;index++) {
          const row=rows[index];
          if(row.sessionId!==turn.sessionId || (row.turnId!==null ? row.turnId!==String(turn.turn) : !(turn.endedAt>=row.createdAt&&turn.startedAt<=row.throughAt)))continue;
          const used=Math.min(cost,remaining[index]);remaining[index]-=used;cost-=used;
        }
      }
      total+=remaining.reduce((sum,amount)=>sum+amount,0);
    }
    return total/1e6;
  }
  const spent = (key, date) => {
    if (!healthy || ledger.stats().droppedLines) throw new Error('体验费用账本不完整');
    const daily = ledger.daily({ ...(key ? { key } : {}), from: date, to: date });
    const complete = daily.totals.estimated !== true && daily.coverage.undatedTokens === 0 && daily.coverage.unallocatedTokens === 0 && daily.coverage.unknownConversationTokens === 0;
    return { amount: daily.totals.cost+conservativeExtra(key,date), currency: daily.currency, complete };
  };
  const perUser = createConversationBudget({ storage, file: path.join(stateDir, 'trial-private-quota.json'), botId: 'primary', now, getSpent: spent });
  const total = createConversationBudget({ storage, file: path.join(stateDir, 'trial-total-quota.json'), botId: 'primary', now, getSpent: (_key, date) => spent(null, date) });
  for (const row of perUser.active({includeExpired:true})) if (row.sessionId) mark(row.sessionId,row.key);
  function recordUnknown(sid) {
    const rows=perUser.active({includeExpired:true}).filter(row=>row.sessionId===sid);
    if(!rows.length)return;
    storage.transaction(()=>{
      const {text,data}=readUncertain();
      for(const row of rows)if(!data.charges.some(old=>old.id===row.id)) {
        const throughAt=Math.max(now(),row.createdAt);
        data.charges.push({id:row.id,key:row.key,sessionId:sid,turnId:row.turnId,createdAt:row.createdAt,throughAt,date:beijingBudgetDate(throughAt),amountCny:row.amountCny});
      }
      if(data.charges.length>100000)throw new Error('体验待核对费用记录达到上限，已保留原记录');
      const next=JSON.stringify(data);if(next!==text)storage.writeText(uncertainFile,next,text);
    });
  }
  async function conservativeStop(sid) {
    const result=await stopSession(sid);
    if(result?.result?.ok===false||result?.ok===false)return result;
    recordUnknown(sid);return result;
  }
  const globalLedger = { conversation: () => ({ turns: ledger.summary().conversations.flatMap(row => ledger.conversation(row.key)?.turns || []) }) };
  const globalControl = createBudgetController({ budget: total, ledger: globalLedger, sendPrompt, stopSession:conservativeStop, now, log });
  const privateControl = createBudgetController({ budget: perUser, ledger, sendPrompt: params => globalControl.prompt(TOTAL, params, { direct: true, source: 'trial-total' }), stopSession:conservativeStop, now, log });
  function sync(key, funding) {
    for (const [budget, cap, overrides] of [[total, funding.totalDailyLimitCny, null], [perUser, 0.1, { [key]: { enabled: true, dailyLimitCny: funding.dailyLimitCny } }]]) {
      const config = budget.config();
      if (config.enabled !== true || config.defaultDailyLimitCny !== cap || config.defaultReservationCny !== 0.01
          || overrides && JSON.stringify(config.groups[key]) !== JSON.stringify(overrides[key])) {
        budget.update({ configVersion: config.configVersion, enabled: true, defaultDailyLimitCny: cap, defaultReservationCny: 0.01, ...(overrides ? { overrides } : {}) });
      }
    }
  }
  return {
    async prompt(key, params, funding, options = {}) {
      if (funding.mode !== 'trial' || !key.startsWith('private:') || options.direct === false || options.source === 'learning') return reject('体验额度仅用于本人主动私聊');
      if (funding.enabled === false || funding.dailyLimitCny <= 0 || funding.totalDailyLimitCny <= 0) return reject('平台体验额度已暂停');
      sync(key, funding); mark(params.sessionId, key);
      return privateControl.prompt(key, params, { direct: true, source: 'trial' });
    },
    status(key, funding) { if(!/^private:[1-9]\d*$/.test(key))throw new Error('体验额度仅支持私聊'); sync(key, funding); return { ...perUser.status(key), platformTotal: total.status(TOTAL) }; },
    async event(sid, event, model, provider) {
      if (!Object.hasOwn(sessions,sid)) return;
      try { ledger.ingestEvent({ sessionId: sid, event, model, provider }); await privateControl.event(sid, event); await globalControl.event(sid, event); }
      catch (e) { unhealthy(); throw e; }
    },
    async snapshot(sid, snapshot, model, provider) {
      if (!Object.hasOwn(sessions,sid)) return;
      try {
        ledger.ingestBaseline({ sessionId: sid, projection: snapshot.projections, at: now(), model, provider });
        const records=(snapshot.records||[]).map(row=>row?.type==='event'?row.event:row).filter(Boolean);
        for(const event of records)ledger.ingestEvent({sessionId:sid,event,model,provider,origin:'snapshot'});
        await privateControl.snapshot(sid, records); await globalControl.snapshot(sid, records);
      } catch (e) { unhealthy(); throw e; }
    },
    cancelled(sid) { recordUnknown(sid); privateControl.cancelled(sid); globalControl.cancelled(sid); },
    async maintain() { await privateControl.maintain(); await globalControl.maintain(); },
    sessionIds: () => Object.keys(sessions),
  };
}
