import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSqliteState } from '../src/sqlite-state.js';
import { createConversationBudget, createGroupBudget, beijingBudgetDate, validateGroupBudgetText } from '../src/group-budget.js';

if (process.argv[2] === '--reserve-worker') {
  const root = process.argv[3], s = createSqliteState({ root, file: path.join(root, 'state/manager.sqlite') });
  const budget = createConversationBudget({ storage: s, file: path.join(root, 'state/conversation-budget.json'), getSpent: () => ({ amount: 0, currency: 'CNY', complete: true }) });
  let accepted = 0;
  for (let i = 0; i < 12; i++) if (budget.reserve('private:999', { operationId: process.argv[4] + '/' + i }).allowed) accepted++;
  s.close(); process.stdout.write(JSON.stringify({ accepted })); process.exit(0);
}

let passed = 0;
async function test(name, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-conversation-budget-'));
  fs.mkdirSync(path.join(root, 'state')); const opened = [];
  let clock = Date.parse('2026-10-21T04:00:00Z'); const spends = new Map();
  const file = path.join(root, 'state/conversation-budget.json');
  const getSpent = (key, date) => spends.get(key + '/' + date) ?? { amount: 0, currency: 'CNY', complete: true };
  const store = () => { const s = createSqliteState({ root, file: path.join(root, 'state/manager.sqlite') }); opened.push(s); return s; };
  const create = ({ botId = 'primary', storage = store(), ...options } = {}) => createConversationBudget({ storage: storage.forBot(botId), file: botId === 'primary' ? file : path.join(root, botId, 'state/conversation-budget.json'), botId, getSpent, now: () => clock, ...options });
  const setSpend = (key, amount, extra = {}) => spends.set(key + '/' + beijingBudgetDate(clock), { amount, currency: 'CNY', complete: true, ...extra });
  try { await run({ root, file, store, create, setSpend, getSpent, tick: ms => { clock += ms; }, at: value => { clock = Date.parse(value); } }); passed++; console.log('PASS', name); }
  finally { for (const s of opened.reverse()) s.close(); fs.rmSync(root, { force: true, recursive: true }); }
}

await test('one CNY default applies independently to groups, private contacts and the administrator contact', ({ create, setSpend }) => {
  assert.equal(createGroupBudget, createConversationBudget); const b = create();
  for (const key of ['group:123', 'private:123', 'private:999']) assert.equal(b.status(key).dailyLimitCny, 1);
  setSpend('private:999', 1); assert.equal(b.reserve('private:999', { sessionId: 'admin-private' }).allowed, false);
  assert.equal(b.reserve('group:123').allowed, true); assert.equal(b.status('private:123').reservedCny, 0);
  for (const key of ['private:001', 'group:0', 'private:-1', 'group:9007199254740992', 'owner:999']) assert.throws(() => b.status(key));
  assert.throws(() => b.reserve('private:999', { role: 'admin' }));
});

await test('Beijing natural day switches at UTC16 and never uses host local timezone', ({ create, setSpend, at }) => {
  const b = create(); at('2026-10-21T15:59:59.999Z'); setSpend('group:1', 1);
  assert.equal(b.status('group:1').date, '2026-10-21'); assert.equal(b.reserve('group:1').allowed, false);
  at('2026-10-21T16:00:00Z'); assert.equal(b.status('group:1').date, '2026-10-22'); assert.equal(b.reserve('group:1').allowed, true);
});

await test('thresholds include reservations, degrade at exactly 80 percent and reject at 100 percent', ({ create, setSpend }) => {
  const b = create(); setSpend('group:1', 0.7);
  const last = b.reserve('group:1'); assert.equal(last.allowed, true); assert.equal(last.action, 'degrade'); assert.equal(last.ratio, 0.8);
  b.release(last.id); setSpend('group:1', 0.9);
  const fill = b.reserve('group:1'); assert.equal(fill.allowed, true); assert.equal(fill.action, 'degrade'); assert.equal(fill.state, 'exhausted');
  assert.equal(b.reserve('group:1').allowed, false); b.release(fill.id); setSpend('group:1', 1);
  assert.equal(b.status('group:1').state, 'exhausted'); assert.equal(b.reserve('group:1', { estimatedMaxCost: 0.000001 }).allowed, false);
});

await test('a call whose reservation exceeds the remainder is refused before admission', ({ create, setSpend }) => {
  const b = create(); setSpend('group:1', 0.900001);
  assert.equal(b.reserve('group:1').allowed, false); assert.equal(b.active().length, 0);
  const r = b.reserve('group:1', { estimatedMaxCost: 0.099999 }); assert.equal(r.allowed, true); assert.equal(r.reservedCny, 0.099999);
});

await test('atomic reservations survive reopen with session and turn association', ({ create, store }) => {
  const b = create(), r = b.reserve('private:123', { operationId: 'request-1', sessionId: 'sid-1' });
  b.renew(r.id, { turnId: 'turn-7' }); const other = create({ storage: store() });
  assert.equal(other.status('private:123').reservedCny, 0.1); assert.equal(other.active()[0].sessionId, 'sid-1'); assert.equal(other.active()[0].turnId, 'turn-7');
  other.settle(r.id, { amount: 0.02, currency: 'CNY' }); assert.equal(b.status('private:123').reservedCny, 0);
});

await test('attributed observed cost reduces only the associated remaining hold and never increases it', ({ create, setSpend }) => {
  const b = create(), a = b.reserve('group:1', { operationId: 'a' }), other = b.reserve('group:1', { operationId: 'b' });
  setSpend('group:1', 0.04); b.renew(a.id, { observedCostCny: 0.04 });
  assert.equal(b.status('group:1').reservedCny, 0.16); assert.equal(b.status('group:1').spentCny, 0.04); assert.equal(b.status('group:1').remainingCny, 0.8);
  b.renew(a.id, { observedCostCny: 0.01 }); assert.equal(b.active().find(row => row.id === a.id).observedCostCny, 0.04);
  setSpend('group:1', 0.3); b.renew(a.id, { observedCostCny: 0.3 }); assert.equal(b.status('group:1').reservedCny, 0.1);
  b.release(other.id); assert.equal(b.status('group:1').reservedCny, 0);
});

await test('without attributable usage the full hold remains conservative until actual end', ({ create, setSpend }) => {
  const b = create(), r = b.reserve('group:1'); setSpend('group:1', 0.07); b.renew(r.id);
  assert.equal(b.status('group:1').reservedCny, 0.1); assert.equal(b.status('group:1').remainingCny, 0.83);
  b.settle(r.id); assert.equal(b.status('group:1').remainingCny, 0.93);
});

await test('daily observed high water persists through cost reset, restart and call completion', ({ create, setSpend, store, at }) => {
  const b = create(), r = b.reserve('private:9'); setSpend('private:9', 0.9); b.renew(r.id, { observedCostCny: 0.1 });
  setSpend('private:9', 0); const reopened = create({ storage: store() });
  assert.equal(reopened.status('private:9').spentCny, 0.9); assert.equal(reopened.status('private:9').observedLedgerCny, 0);
  assert.equal(reopened.reserve('private:9', { estimatedMaxCost: 0.100001 }).allowed, false);
  reopened.release(r.id); assert.equal(reopened.status('private:9').spentCny, 0.9);
  at('2026-10-21T16:00:00Z'); assert.equal(reopened.status('private:9').spentCny, 0);
});

await test('live turn remaining reservation conservatively follows it across midnight but spend does not', ({ create, setSpend, at }) => {
  const b = create(); at('2026-10-21T15:59:59Z'); const r = b.reserve('group:1', { estimatedMaxCost: 0.4 });
  setSpend('group:1', 0.2); b.renew(r.id, { observedCostCny: 0.2 }); at('2026-10-21T16:00:00Z');
  assert.equal(b.status('group:1').spentCny, 0); assert.equal(b.status('group:1').reservedCny, 0.2);
  assert.equal(b.status('group:1').remainingCny, 0.8); b.release(r.id); assert.equal(b.status('group:1').remainingCny, 1);
});

await test('lease expiry is reclaimable, discoverable after restart and renewable only for unclosed calls', ({ create, tick, store }) => {
  const b = create(), r = b.reserve('group:1', { sessionId: 'in-flight' });
  tick(29 * 60_000); assert.equal(b.status('group:1').reservedCny, 0.1); tick(60_000);
  assert.equal(b.status('group:1').reservedCny, 0); const next = create({ storage: store() });
  assert.equal(next.active().length, 0); assert.equal(next.active({ includeExpired: true })[0].sessionId, 'in-flight');
  next.reserve('group:2'); assert.equal(next.active({ includeExpired: true }).find(row => row.id === r.id).state, 'expired');
  next.renew(r.id); assert.equal(b.status('group:1').reservedCny, 0.1);
  b.release(r.id); assert.throws(() => b.renew(r.id), { statusCode: 409 });
});

await test('bot isolation keeps the same group and private number independent and forbids cross-bot IDs', ({ create }) => {
  const a = create(), b = create({ botId: 'secondary' });
  for (let i = 0; i < 10; i++) assert.equal(a.reserve('private:1', { operationId: 'a-' + i }).allowed, true);
  assert.equal(a.reserve('private:1').allowed, false);
  assert.equal(a.reserve('group:1').allowed, true); const rb = b.reserve('private:1', { operationId: 'a-0' }); assert.equal(rb.allowed, true);
  assert.throws(() => a.release(rb.id), { statusCode: 404 }); assert.equal(b.status('group:1').reservedCny, 0);
});

await test('settings CAS and per-conversation patch/reset preserve unrelated scopes', ({ create, store }) => {
  const a = create(), b = create({ storage: store() });
  const config = a.update({ configVersion: 1, defaultDailyLimitCny: 2, overrides: { 'group:1': { dailyLimitCny: 0 }, 'private:1': { dailyLimitCny: 0.5 } } });
  assert.equal(config.configVersion, 2); assert.deepEqual(config.groups, config.overrides);
  assert.throws(() => b.update({ configVersion: 1, enabled: false }), { statusCode: 409 });
  assert.equal(b.reserve('group:1').allowed, false); assert.equal(b.status('private:1').dailyLimitCny, 0.5);
  b.update({ configVersion: 2, groups: { 'group:1': null } });
  assert.equal(a.status('group:1').dailyLimitCny, 2); assert.equal(a.status('private:1').dailyLimitCny, 0.5);
});

await test('disable defaults and individual overrides obey explicit policy without administrator exceptions', ({ create, setSpend }) => {
  const b = create(); setSpend('private:9', 10); b.update({ configVersion: 1, enabled: false });
  assert.equal(b.reserve('private:9').allowed, true); assert.equal(b.reserve('private:9').id, null);
  b.update({ configVersion: 2, overrides: { 'private:9': { enabled: true, dailyLimitCny: 1 } } });
  assert.equal(b.reserve('private:9').allowed, false); assert.equal(b.status('private:9').state, 'exhausted');
});

await test('unknown currency, unpriced or unreadable ledger safely refuse new paid work but allow cancellation', ({ create, setSpend }) => {
  const b = create(), r = b.reserve('group:1');
  for (const extra of [{ currency: 'USD' }, { complete: false }, { currency: null }, { amount: NaN }]) {
    setSpend('group:1', 0.1, extra); assert.equal(b.status('group:1').state, 'unsupported'); assert.equal(b.reserve('group:1').allowed, false);
  }
  b.release(r.id); assert.equal(b.active().length, 0);
  const broken = create({ getSpent: () => { throw new Error('bad ledger'); } }); assert.equal(broken.reserve('group:1').allowed, false);
  const asynchronous = create({ getSpent: async () => ({ amount: 0, currency: 'CNY', complete: true }) }); assert.equal(asynchronous.reserve('group:1').allowed, false);
});

await test('idempotent operations never duplicate holds and immutable call IDs cannot be rebound', ({ create }) => {
  const b = create(), r = b.reserve('group:1', { operationId: 'op', sessionId: 'sid' });
  assert.equal(b.reserve('group:1', { operationId: 'op', sessionId: 'sid' }).id, r.id); assert.equal(b.active().length, 1);
  assert.throws(() => b.reserve('private:1', { operationId: 'op', sessionId: 'sid' }), { statusCode: 409 });
  assert.throws(() => b.renew(r.id, { sessionId: 'other' }), { statusCode: 409 });
  b.renew(r.id, { turnId: 'turn' }); assert.throws(() => b.renew(r.id, { turnId: 'other' }), { statusCode: 409 });
  b.settle(r.id, { amount: 0.04, currency: 'CNY' }); assert.equal(b.settle(r.id).actualCny, 0.04);
  assert.equal(b.release(r.id).state, 'settled'); assert.equal(b.reserve('group:1', { operationId: 'op', sessionId: 'sid', turnId: 'turn' }).allowed, false);
});

await test('strict settings validation rejects malformed/future state and never replaces original data', ({ create, store, file }) => {
  const s = store(), b = create({ storage: s }); const before = s.readText(file);
  const patches = [{ defaultDailyLimitCny: -1 }, { defaultDailyLimitCny: 0.0000001 }, { defaultDailyLimitCny: 1000001 }, { defaultReservationCny: 0 },
    { enabled: 'true' }, { leaseMs: 10 }, { groups: { 'group:01': {} } }, { groups: { 'private:1': { bypass: true } } }, { groups: null }, { overrides: null }, { groups: {}, overrides: {} }];
  for (const patch of patches) { assert.throws(() => b.update({ configVersion: 1, ...patch })); assert.equal(s.readText(file), before); }
  for (const text of ['{broken', '{"version":99}', JSON.stringify({ ...JSON.parse(before), extra: true })]) {
    assert.throws(() => validateGroupBudgetText(text)); assert.throws(() => s.writeText(file, text, before)); assert.equal(s.readText(file), before);
  }
  assert.throws(() => b.settle('bad', { amount: 1, currency: 'USD' }));
});

await test('real SQL projections include settings, overrides, leases, metadata and spend high water', ({ create, store, setSpend }) => {
  const s = store(), b = create({ storage: s });
  b.update({ configVersion: 1, overrides: { 'private:1': { dailyLimitCny: 2, enabled: true } } });
  const r = b.reserve('private:1', { operationId: 'sql-op', sessionId: 'sid', turnId: 't1' }); setSpend('private:1', 0.04); b.renew(r.id, { observedCostCny: 0.04 });
  assert.equal(s.db.prepare('SELECT default_limit_micros FROM budget_settings').get().default_limit_micros, 1000000);
  assert.equal(s.db.prepare('SELECT limit_micros FROM budget_overrides').get().limit_micros, 2000000);
  const row = s.db.prepare('SELECT * FROM budget_reservations').get(); assert.equal(row.observed_micros, 40000); assert.equal(row.session_id, 'sid'); assert.equal(row.turn_id, 't1');
  assert.equal(s.db.prepare('SELECT spent_micros FROM budget_days').get().spent_micros, 40000);
  assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

await test('outer transaction rollback removes admissions from both source text and SQL projection', ({ create, store, file }) => {
  const s = store(), b = create({ storage: s }); const before = s.readText(file);
  assert.throws(() => s.transaction(() => { b.reserve('group:1'); throw new Error('rollback'); }), /rollback/);
  assert.equal(s.readText(file), before); assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM budget_reservations').get().n, 0);
});

await test('micro-CNY arithmetic does not leave floating-point gaps and tiny positive estimates still reserve', ({ create }) => {
  const b = create(); for (let i = 0; i < 10; i++) assert.equal(b.reserve('group:1').allowed, true);
  assert.equal(b.status('group:1').reservedCny, 1); assert.equal(b.reserve('group:1', { estimatedMaxCost: Number.MIN_VALUE }).allowed, false);
  const tiny = b.reserve('private:1', { estimatedMaxCost: Number.MIN_VALUE }); assert.equal(tiny.allowed, true); assert.equal(tiny.reservation.amountCny, 0.000001);
});

await test('completed reservation audit ages out while a still-renewed turn and today high water remain', ({ create, tick, setSpend }) => {
  const b = create(), done = b.reserve('group:1'), live = b.reserve('private:1'); b.release(done.id);
  tick(8 * 86400000); b.renew(live.id); setSpend('private:1', 0.2); b.status('private:1'); b.reserve('group:2');
  assert.throws(() => b.release(done.id), { statusCode: 404 }); assert.equal(b.active()[0].id, live.id); assert.equal(b.status('private:1').spentCny, 0.2);
});

await test('invalid legacy budget fails before database creation; migrated JSON is never authoritative again', ({ root, file, store, create }) => {
  fs.writeFileSync(file, '{"version":99}'); assert.throws(() => store()); assert.equal(fs.existsSync(path.join(root, 'state/manager.sqlite')), false);
  fs.unlinkSync(file); const b = create(); b.update({ configVersion: 1, defaultDailyLimitCny: 2 });
  fs.writeFileSync(file, '{broken'); const reopened = create({ storage: store() }); assert.equal(reopened.config().defaultDailyLimitCny, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

await test('independent Node processes cannot over-admit a shared private-contact budget', async ({ root, create }) => {
  create({ now: Date.now });
  const children = Array.from({ length: 4 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--reserve-worker', root, String(i)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostic = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { diagnostic += data; });
    child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(new Error('worker failed: ' + diagnostic)); else { try { resolve(JSON.parse(output).accepted); } catch (e) { reject(e); } } });
  }));
  assert.equal((await Promise.all(children)).reduce((sum, n) => sum + n, 0), 10);
  assert.equal(create({ now: Date.now }).status('private:999').reservedCny, 1);
});

console.log(`Conversation budgets: ${passed} tests passed`);
