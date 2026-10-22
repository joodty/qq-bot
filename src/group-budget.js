import crypto from 'node:crypto';

const UNIT = 1_000_000;
const MAX_CNY = 1_000_000;
const DAY = 86_400_000;
const DEFAULT_LEASE = 30 * 60_000;
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => JSON.parse(JSON.stringify(value));
const validBot = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const groupKey = value => typeof value === 'string' && /^(group|private):[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.split(':')[1]));
const time = value => Number.isSafeInteger(value) && value >= 0;
const label = value => value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 2000 && !/[\x00-\x1f\x7f]/.test(value));
function money(value, positive = false, precise = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_CNY || (positive && value === 0)) return false;
  return !precise || Math.abs(value * UNIT - Math.round(value * UNIT)) < 0.00001;
}
const micros = value => value > 0 ? Math.max(1, Math.ceil(value * UNIT - 0.0000001)) : 0;
const cny = value => Math.round(value) / UNIT;
export function beijingBudgetDate(at = Date.now()) {
  if (!time(at)) throw error('预算时间无效');
  return new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function validOverride(value) {
  return exact(value, ['enabled', 'dailyLimitCny']) && (!own(value, 'enabled') || typeof value.enabled === 'boolean')
    && (!own(value, 'dailyLimitCny') || money(value.dailyLimitCny));
}
function fresh(botId) {
  return { version: 1, botId, configVersion: 1,
    config: { enabled: true, defaultDailyLimitCny: 1, defaultReservationCny: 0.1, leaseMs: DEFAULT_LEASE, groups: {} },
    reservations: [], days: [] };
}

/** Strict original-text validator shared with SQLite's relational projection. Never repairs unknown data. */
export function validateGroupBudgetText(text, botId) {
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw error('群预算文档损坏，已停止改写', 503); }
  const bad = () => { throw error('群预算文档格式、版本或引用不受支持，已停止改写', 503); };
  if (!exact(data, ['version', 'botId', 'configVersion', 'config', 'reservations', 'days']) || Object.keys(data).length !== 6
    || data.version !== 1 || !validBot(data.botId) || (botId && data.botId !== botId)
    || !Number.isSafeInteger(data.configVersion) || data.configVersion < 1) bad();
  const config = data.config;
  if (!exact(config, ['enabled', 'defaultDailyLimitCny', 'defaultReservationCny', 'leaseMs', 'groups']) || Object.keys(config).length !== 5
    || typeof config.enabled !== 'boolean' || !money(config.defaultDailyLimitCny) || !money(config.defaultReservationCny, true)
    || !Number.isSafeInteger(config.leaseMs) || config.leaseMs < 60_000 || config.leaseMs > DAY || !object(config.groups)
    || Object.keys(config.groups).length > 10000) bad();
  for (const [key, value] of Object.entries(config.groups)) if (!groupKey(key) || !validOverride(value)) bad();
  if (!Array.isArray(data.reservations) || data.reservations.length > 50000 || !Array.isArray(data.days) || data.days.length > 100000) bad();
  const ids = new Set(), operations = new Set(), days = new Set();
  for (const row of data.reservations) {
    if (!exact(row, ['id', 'key', 'date', 'amountCny', 'observedCostCny', 'createdAt', 'updatedAt', 'expiresAt', 'state', 'operationId', 'sessionId', 'turnId', 'actualCny', 'settledAt']) || Object.keys(row).length !== 14
      || typeof row.id !== 'string' || !/^[a-f0-9]{32}$/.test(row.id) || ids.has(row.id) || !groupKey(row.key) || !validDate(row.date)
      || !money(row.amountCny, true) || !money(row.observedCostCny) || !time(row.createdAt) || !time(row.updatedAt) || !time(row.expiresAt)
      || row.updatedAt < row.createdAt || row.expiresAt <= row.createdAt || beijingBudgetDate(row.createdAt) !== row.date
      || !['active', 'settled', 'released', 'expired'].includes(row.state) || !label(row.operationId) || !label(row.sessionId) || !label(row.turnId)
      || !(row.actualCny === null || money(row.actualCny)) || !(row.settledAt === null || time(row.settledAt))
      || (['settled', 'released'].includes(row.state) ? row.settledAt === null : row.settledAt !== null)
      || (row.settledAt !== null && row.settledAt < row.createdAt)) bad();
    ids.add(row.id);
    if (row.operationId !== null) { if (operations.has(row.operationId)) bad(); operations.add(row.operationId); }
  }
  for (const row of data.days) {
    if (!exact(row, ['key', 'date', 'spentCny']) || Object.keys(row).length !== 3 || !groupKey(row.key) || !validDate(row.date) || !money(row.spentCny)
      || days.has(row.key + '/' + row.date)) bad();
    days.add(row.key + '/' + row.date);
  }
  return data;
}

/** Paid-call admission control over observed ledger estimates plus leased in-flight reservations. */
export function createGroupBudget({ storage, file, botId = 'primary', getSpent, now = Date.now } = {}) {
  if (!storage?.transaction || !storage?.readText || !storage?.writeText || !file || !validBot(botId) || typeof getSpent !== 'function') throw error('群预算需要事务存储、路径、机器人标识及同步费用读取器', 503);
  function load() {
    let raw;
    try { raw = storage.readText(file); } catch (e) { if (e.code !== 'ENOENT') throw e; raw = null; }
    return { raw, data: raw === null ? fresh(botId) : validateGroupBudgetText(raw, botId) };
  }
  function transact(run) {
    return storage.transaction(() => {
      const { raw, data } = load(), at = now(); if (!time(at)) throw error('预算时间无效', 503);
      const result = run(data, at);
      const next = JSON.stringify(data, null, 2) + '\n';
      if (next !== raw) { validateGroupBudgetText(next, botId); storage.writeText(file, next, raw); }
      return result;
    });
  }
  const publicConfig = data => ({ configVersion: data.configVersion, botId, ...clone(data.config), overrides: clone(data.config.groups) });
  function amountFor(data, key, date) {
    let value;
    try { value = getSpent(key, date); } catch { return { supported: false, reason: '费用账本暂不可读，已暂停新的付费群调用' }; }
    if (!object(value) || value.currency !== 'CNY' || value.complete !== true || !money(value.amount, false, false)) {
      return { supported: false, reason: '今日费用缺少可用人民币估算或账本不完整，已暂停新的付费群调用' };
    }
    const amount = cny(micros(value.amount)); let row = data.days.find(row => row.key === key && row.date === date);
    if (!row) { row = { key, date, spentCny: amount }; data.days.push(row); }
    else row.spentCny = Math.max(row.spentCny, amount);
    return { supported: true, amount: row.spentCny, observed: amount };
  }
  function statusOf(data, key, at) {
    if (!groupKey(key)) throw error('会话预算仅支持规范的 group:群号 或 private:QQ号');
    const date = beijingBudgetDate(at), override = data.config.groups[key] ?? null;
    const enabled = override?.enabled ?? data.config.enabled;
    const dailyLimitCny = override?.dailyLimitCny ?? data.config.defaultDailyLimitCny;
    const spend = amountFor(data, key, date);
    const prior = data.days.find(row => row.key === key && row.date === date)?.spentCny ?? 0;
    const reserved = data.reservations.filter(row => row.key === key && row.state === 'active' && row.expiresAt > at);
    // Holds follow a live turn across Beijing midnight; historical observed spend does not.
    const reservedMicros = reserved.reduce((sum, row) => sum + Math.max(0, micros(row.amountCny) - micros(row.observedCostCny)), 0);
    const spentCny = spend.supported ? spend.amount : prior;
    const used = micros(spentCny) + reservedMicros, limit = micros(dailyLimitCny);
    const ratio = limit === 0 ? 1 : used / limit;
    const state = !enabled ? 'disabled' : !spend.supported ? 'unsupported' : used >= limit ? 'exhausted' : used * 5 >= limit * 4 ? 'degraded' : 'normal';
    return { key, botId, date, currency: 'CNY', enabled, dailyLimitCny, spentCny, observedLedgerCny: spend.supported ? spend.observed : null,
      reservedCny: cny(reservedMicros), remainingCny: Math.max(0, cny(limit - used)), ratio,
      state, action: ['exhausted', 'unsupported'].includes(state) ? 'reject' : state === 'degraded' ? 'degrade' : 'normal',
      supported: spend.supported, reason: spend.reason ?? null, configVersion: data.configVersion, override: clone(override),
      activeReservations: reserved.length, estimated: true,
      estimationBoundary: '人民币用量估算及在途预留；不是供应商账单硬上限。费用页重置不会退回今日已观察额度。' };
  }
  function prune(data, at) {
    for (const row of data.reservations) if (row.state === 'active' && row.expiresAt <= at) { row.state = 'expired'; row.updatedAt = Math.max(at, row.updatedAt); }
    data.reservations = data.reservations.filter(row => row.state === 'active' || (row.settledAt ?? row.updatedAt) >= at - 7 * DAY);
    const oldest = beijingBudgetDate(Math.max(0, at - 90 * DAY)); data.days = data.days.filter(row => row.date >= oldest);
  }
  function find(data, id) {
    const row = data.reservations.find(row => row.id === id); if (!row) throw error('预算预留不存在', 404); return row;
  }
  function attach(row, details = {}) {
    if (!exact(details, ['sessionId', 'turnId', 'observedCostCny'])) throw error('预算续租字段无效');
    for (const name of ['sessionId', 'turnId']) if (own(details, name)) {
      if (!label(details[name]) || details[name] === null) throw error('预算调用身份无效');
      if (row[name] !== null && row[name] !== details[name]) throw error('预算预留已绑定其他调用', 409);
      row[name] = details[name];
    }
    if (own(details, 'observedCostCny')) {
      if (!money(details.observedCostCny, false, false)) throw error('预算已归属费用无效');
      row.observedCostCny = Math.max(row.observedCostCny, cny(micros(details.observedCostCny)));
    }
  }
  // Initialize default state once under the same transaction/CAS as every later mutation.
  transact(() => {});
  return {
    config: () => transact(data => publicConfig(data)),
    status: key => transact((data, at) => statusOf(data, key, at)),
    overview(keys = []) {
      if (!Array.isArray(keys) || keys.length > 10000 || keys.some(key => !groupKey(key))) throw error('预算群列表无效');
      return transact((data, at) => {
        const conversations = [...new Set(keys)].map(key => statusOf(data, key, at));
        return { botId, date: beijingBudgetDate(at), currency: 'CNY', config: publicConfig(data), conversations, groups: conversations, estimated: true };
      });
    },
    update(patch) {
      if (!exact(patch, ['configVersion', 'enabled', 'defaultDailyLimitCny', 'defaultReservationCny', 'leaseMs', 'groups', 'overrides']) || !Number.isSafeInteger(patch.configVersion)
        || own(patch, 'groups') && own(patch, 'overrides')) throw error('预算配置及版本无效');
      return transact(data => {
        if (patch.configVersion !== data.configVersion) throw error('预算配置已被其他操作更新，请刷新后重试', 409);
        const next = clone(data.config);
        for (const key of ['enabled', 'defaultDailyLimitCny', 'defaultReservationCny', 'leaseMs']) if (own(patch, key)) next[key] = patch[key];
        if (own(patch, 'groups') || own(patch, 'overrides')) {
          const overrides = patch.overrides ?? patch.groups;
          if (!object(overrides) || Object.keys(overrides).length > 10000) throw error('会话预算覆盖配置无效');
          for (const [key, value] of Object.entries(overrides)) {
            if (!groupKey(key) || !(value === null || validOverride(value))) throw error('群预算覆盖配置无效');
            if (value === null) delete next.groups[key]; else next.groups[key] = clone(value);
          }
        }
        const probe = { ...data, config: next };
        try { validateGroupBudgetText(JSON.stringify(probe), botId); } catch { throw error('预算额度、启用状态或租约设置无效'); }
        if (JSON.stringify(next) !== JSON.stringify(data.config)) { data.config = next; data.configVersion++; }
        return publicConfig(data);
      });
    },
    reserve(key, options = {}) {
      if (!groupKey(key) || !exact(options, ['estimatedMaxCost', 'operationId', 'sessionId', 'turnId'])) throw error('预算预留参数无效');
      for (const name of ['operationId', 'sessionId', 'turnId']) if (own(options, name) && (!label(options[name]) || options[name] === null)) throw error('预算调用身份无效');
      if (own(options, 'estimatedMaxCost') && !money(options.estimatedMaxCost, true, false)) throw error('预算预留金额无效');
      return transact((data, at) => {
        prune(data, at);
        if (options.operationId) {
          const prior = data.reservations.find(row => row.operationId === options.operationId);
          if (prior) {
            if (prior.key !== key || (options.sessionId && prior.sessionId !== options.sessionId) || (options.turnId && prior.turnId !== options.turnId)) throw error('预算操作ID已用于其他调用', 409);
            const status = statusOf(data, key, at);
            return { ...status, allowed: prior.state === 'active', id: prior.id, reused: true, reservation: clone(prior) };
          }
        }
        const status = statusOf(data, key, at);
        if (!status.enabled) return { ...status, allowed: true, id: null, reservation: null };
        if (status.action === 'reject') return { ...status, allowed: false, id: null, reservation: null };
        const amount = cny(micros(options.estimatedMaxCost ?? data.config.defaultReservationCny));
        if (micros(amount) > micros(status.remainingCny)) return { ...status, allowed: false, action: 'reject', id: null, reservation: null, reason: '今日剩余额度不足以预留这次调用' };
        const row = { id: crypto.randomBytes(16).toString('hex'), key, date: status.date, amountCny: amount, observedCostCny: 0,
          createdAt: at, updatedAt: at, expiresAt: at + data.config.leaseMs, state: 'active', operationId: options.operationId ?? null,
          sessionId: options.sessionId ?? null, turnId: options.turnId ?? null, actualCny: null, settledAt: null };
        data.reservations.push(row); const after = statusOf(data, key, at);
        return { ...after, allowed: true, id: row.id, action: after.state === 'normal' ? 'normal' : 'degrade', reservation: clone(row) };
      });
    },
    active({ includeExpired = false } = {}) {
      if (typeof includeExpired !== 'boolean') throw error('预算预留筛选无效');
      return transact((data, at) => clone(data.reservations.filter(row => row.state === 'active' && (includeExpired || row.expiresAt > at) || includeExpired && row.state === 'expired')));
    },
    renew(id, details = {}) {
      return transact((data, at) => {
        const row = find(data, id);
        if (['settled', 'released'].includes(row.state)) throw error('已结束的预算预留不能续租', 409);
        amountFor(data, row.key, beijingBudgetDate(at));
        attach(row, details); row.state = 'active'; row.updatedAt = Math.max(at, row.updatedAt); row.expiresAt = Math.max(at + data.config.leaseMs, row.expiresAt);
        return clone(row);
      });
    },
    settle(id, actual) {
      if (actual !== undefined && (!exact(actual, ['amount', 'currency']) || actual.currency !== 'CNY' || !money(actual.amount, false, false))) throw error('预算结算只接受人民币估算');
      return transact((data, at) => {
        const row = find(data, id);
        if (['settled', 'released'].includes(row.state)) return clone(row);
        amountFor(data, row.key, beijingBudgetDate(at));
        row.state = 'settled'; row.settledAt = Math.max(at, row.createdAt); row.updatedAt = Math.max(at, row.updatedAt);
        row.actualCny = actual === undefined ? null : cny(micros(actual.amount)); return clone(row);
      });
    },
    release(id) {
      return transact((data, at) => {
        const row = find(data, id);
        if (['settled', 'released'].includes(row.state)) return clone(row);
        amountFor(data, row.key, beijingBudgetDate(at));
        row.state = 'released'; row.settledAt = Math.max(at, row.createdAt); row.updatedAt = Math.max(at, row.updatedAt); return clone(row);
      });
    },
  };
}

export const createConversationBudget = createGroupBudget;
