import crypto from 'node:crypto';

const UNKNOWN_MS = 30 * 60_000;
const COOLDOWN_MS = 60_000;
const validKey = key => /^(group|private):[1-9]\d*$/.test(String(key));
const turnOf = event => event?.data?.turn == null ? null : String(event.data.turn);
const restriction = '\n\n【今日会话预算节流】本轮最多回复120个汉字，只发一条消息。只简短回答当前明确请求，不主动开启话题，不做自主跟进、联网搜索或额外研究。遵守原有审批、权限和安全规则。';
const rejected = (status, message) => ({ result: { ok: false, error: { code: 'CONVERSATION_BUDGET_EXCEEDED', message: message || status?.reason || '此会话今日预算不足，已暂停新的付费调用', status } } });

/** Coordinates durable budget holds with DSH admission and replayable turn events.
 * Missing admission/event evidence keeps money reserved until confirmed stop.
 */
export function createBudgetController({ budget, ledger, sendPrompt, stopSession, now = Date.now, log = () => {} } = {}) {
  if (!budget?.reserve || !budget?.active || typeof sendPrompt !== 'function' || typeof stopSession !== 'function') throw new Error('预算控制器缺少依赖');
  const holds = new Map(), cursors = new Map(), lastDirect = new Map(), stopping = new Map();
  for (const row of budget.active({ includeExpired: true })) {
    // Direct HTTP model calls have their own crash recovery and never have a DSH session to stop.
    if (row.operationId?.startsWith('byok:')) continue;
    holds.set(row.id, { ...row, floorSeq: -1, recovered: true });
    if (row.key) lastDirect.set(row.key, Math.max(lastDirect.get(row.key) ?? -Infinity, row.createdAt));
  }
  const rowsFor = sid => [...holds.values()].filter(row => row.sessionId === sid);
  const cursorFor = sid => { if (!cursors.has(sid)) cursors.set(sid, { seq: -1, ended: new Set() }); return cursors.get(sid); };
  function forget(row, method) { budget[method](row.id); holds.delete(row.id); }
  function cancelled(sid) { for (const row of rowsFor(sid)) forget(row, 'release'); }
  async function stop(sid) {
    if (stopping.has(sid)) return stopping.get(sid);
    const pending = (async () => {
      const result = await stopSession(sid);
      if (result?.result?.ok === false || result?.ok === false) throw new Error('预算停止操作未确认');
      cancelled(sid);
      return result;
    })();
    stopping.set(sid, pending);
    try { return await pending; } finally { if (stopping.get(sid) === pending) stopping.delete(sid); }
  }
  function renewObserved(sid, turn) {
    const rows = rowsFor(sid).filter(row => row.turnId === turn);
    if (!rows.length) return;
    let observed = null;
    // A turn may absorb multiple queue submissions. Allocate its usage once.
    try {
      const turns = ledger?.conversation(rows[0].key)?.turns;
      if (Array.isArray(turns)) {
        const match = turns.find(row => row.sessionId === sid && String(row.turn) === turn);
        if (match && Number.isFinite(match.cost) && match.cost >= 0) observed = match.cost;
      }
    } catch (error) { log('预算读取回合费用失败', error?.message); }
    for (const row of rows) {
      const portion = observed === null ? null : Math.min(row.amountCny, observed);
      if (portion !== null) observed = Math.max(0, observed - portion);
      const updated = budget.renew(row.id, { ...(portion === null ? {} : { observedCostCny: portion }) });
      Object.assign(row, updated);
    }
  }
  async function event(sid, record, replay = false) {
    if (!record || typeof record !== 'object') return;
    const cursor = cursorFor(sid), seq = Number(record.seq);
    const hasSeq = record.seq != null && Number.isSafeInteger(seq) && seq >= 0;
    if (hasSeq && seq <= cursor.seq) return;
    if (hasSeq) cursor.seq = seq;
    const turn = turnOf(record), at = Number(record.time);
    if (record.type === 'turn/start' && turn !== null && !cursor.ended.has(turn)) {
      for (const row of rowsFor(sid)) {
        const timely = record.time != null && Number.isFinite(at) ? at >= row.createdAt : !replay && !row.recovered;
        if (row.turnId !== null || !timely
          || hasSeq && seq <= row.floorSeq) continue;
        Object.assign(row, budget.renew(row.id, { turnId: turn }));
      }
    }
    if (turn !== null) renewObserved(sid, turn);
    if (record.type === 'turn/end' && turn !== null) {
      cursor.ended.add(turn);
      for (const row of rowsFor(sid).filter(row => row.turnId === turn)) forget(row, 'settle');
    }
    for (const key of new Set(rowsFor(sid).map(row => row.key))) {
      const status = budget.status(key);
      if (status.enabled && (status.state === 'unsupported' || status.spentCny >= status.dailyLimitCny)) {
        try { await stop(sid); } catch (error) { log('预算停止在途会话失败，保留预留', error?.message); }
        break;
      }
    }
  }
  async function maintain() {
    const at = now();
    for (const sid of new Set([...holds.values()].map(row => row.sessionId).filter(Boolean))) {
      const rows = rowsFor(sid);
      const unknownTooOld = rows.some(row => row.turnId === null && at - row.createdAt >= UNKNOWN_MS);
      if (unknownTooOld) {
        try { await stop(sid); } catch (error) {
          log('预算未知调用停止失败，继续保守预留', error?.message);
          for (const row of rowsFor(sid)) Object.assign(row, budget.renew(row.id));
        }
      } else {
        for (const row of rows) Object.assign(row, budget.renew(row.id));
      }
    }
  }
  return {
    status: key => budget.status(key),
    active: () => [...holds.values()].map(row => ({ ...row })),
    cancelled,
    event,
    async snapshot(sid, records = []) {
      for (const record of records.map(row => row?.type === 'event' ? row.event : row).filter(Boolean).sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))) await event(sid, record, true);
    },
    async prompt(key, params, { direct = true, source = 'chat' } = {}) {
      if (!validKey(key) || typeof params?.sessionId !== 'string' || !params.sessionId) return rejected(null, '预算调用缺少有效会话身份');
      if (stopping.has(params.sessionId)) return rejected(null, '此会话正在确认停止，请稍后再试');
      // Renew before admission, so a live hold never silently expires into fresh money.
      try { await maintain(); } catch { return rejected(null, '预算状态暂不可用，已暂停新的付费调用'); }
      let status;
      try { status = budget.status(key); } catch (error) { return rejected(null, error?.message); }
      if (status.action === 'reject') return rejected(status);
      const at = now();
      const throttled = () => status.enabled && (status.state === 'degraded' || status.action === 'degrade');
      if (throttled() && (!direct || at - (lastDirect.get(key) ?? -Infinity) < COOLDOWN_MS)) return rejected(status, direct ? '预算节流中，请间隔至少60秒再发起回复' : '预算达到80%，已暂停自主参与');
      let reservation;
      try { reservation = budget.reserve(key, { sessionId: params.sessionId, operationId: `${source}:${crypto.randomUUID()}` }); }
      catch (error) { return rejected(null, error?.message); }
      if (!reservation.allowed) return rejected(reservation);
      status = reservation;
      if (throttled() && (!direct || at - (lastDirect.get(key) ?? -Infinity) < COOLDOWN_MS)) {
        if (reservation.id) budget.release(reservation.id);
        return rejected(status, direct ? '预算节流中，请间隔至少60秒再发起回复' : '预算达到80%，已暂停自主参与');
      }
      const row = reservation.reservation ? { ...reservation.reservation, floorSeq: cursorFor(params.sessionId).seq } : null;
      if (row) holds.set(row.id, row);
      if (direct) lastDirect.set(key, at);
      const outgoing = { ...params, requestId: params.requestId || crypto.randomUUID() };
      if (throttled()) outgoing.content = [...(params.content || []), { type: 'text', text: restriction }];
      // Exceptions and unknown replies can mean accepted-but-disconnected. Keep the hold.
      const response = await sendPrompt(outgoing);
      const result = response?.result ?? response;
      if (row && (result?.ok === false || result?.value?.command)) forget(row, 'release');
      return response;
    },
    maintain,
  };
}
