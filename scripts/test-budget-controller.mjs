import assert from 'node:assert/strict';
import { createConversationBudget } from '../src/group-budget.js';
import { createBudgetController } from '../src/budget-controller.js';

let passed = 0;
const accepted = () => ({ result: { ok: true, value: { accepted: true } } });
function fixture() {
  let clock = Date.parse('2026-10-22T04:00:00Z'), raw = null;
  const spent = new Map(), turns = [], sends = [], stops = [];
  const storage = { transaction: run => run(), readText: () => raw, writeText: (_file, text, expected) => { assert.equal(raw, expected); raw = text; } };
  const budget = createConversationBudget({ storage, file: 'fixture', getSpent: key => ({ amount: spent.get(key) || 0, currency: 'CNY', complete: true }), now: () => clock });
  const options = { budget, ledger: { conversation: () => ({ turns }) }, now: () => clock,
    sendPrompt: async params => { sends.push(params); return accepted(); }, stopSession: async sid => { stops.push(sid); return { removed: 0 }; } };
  let controller = createBudgetController(options);
  return { budget, spent, turns, sends, stops, options, get controller() { return controller; }, restart() { controller = createBudgetController(options); },
    now: () => clock, advance: ms => { clock += ms; }, prompt: (key = 'group:456', sid = 'sid', opts) => controller.prompt(key, { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: 'fixture' }] }, opts),
    event: (type, turn, seq, extra = {}) => controller.event('sid', { type, seq, time: clock, data: { turn }, ...extra }) };
}
async function test(name, run) { await run(fixture()); passed++; console.log('PASS', name); }

await test('all conversation types including owner private reject exhausted budget before paid call', async f => {
  for (const key of ['group:456', 'private:456', 'private:123']) {
    f.spent.set(key, 1);
    assert.equal((await f.prompt(key)).result.error.code, 'CONVERSATION_BUDGET_EXCEEDED');
  }
  assert.equal(f.sends.length, 0);
});
await test('degraded autonomy is suppressed; direct replies are instructed briefly and cooled for 60 seconds', async f => {
  f.spent.set('group:456', 0.8);
  assert.equal((await f.prompt(undefined, undefined, { direct: false })).result.ok, false);
  assert.equal(f.controller.active().length, 0);
  await f.prompt(); assert.match(f.sends[0].content.at(-1).text, /120/);
  assert.equal((await f.prompt()).result.ok, false);
  f.advance(60_000); assert.equal((await f.prompt()).result.ok, true);
  assert.equal(f.sends.length, 2);
});
await test('same numeric group and private remain isolated and low-budget private direct request is allowed', async f => {
  f.spent.set('group:456', 1); f.spent.set('private:456', 0.8);
  assert.equal((await f.prompt()).result.ok, false);
  assert.equal((await f.prompt('private:456')).result.ok, true);
});
await test('explicit failure and slash command release; ambiguous transport failure retains durable hold', async f => {
  f.options.sendPrompt = async () => ({ result: { ok: false, error: { code: 'bad' } } }); f.restart();
  await f.prompt(); assert.equal(f.controller.active().length, 0);
  f.options.sendPrompt = async () => ({ result: { ok: true, value: { command: { text: 'done' } } } }); f.restart();
  await f.prompt(); assert.equal(f.controller.active().length, 0);
  f.options.sendPrompt = async () => { throw new Error('timeout'); }; f.restart();
  await assert.rejects(f.prompt(), /timeout/); assert.equal(f.controller.active().length, 1);
  f.restart(); assert.equal(f.controller.active().length, 1);
});
await test('queued prompts share a turn and its cost offsets total reservations exactly once', async f => {
  await f.prompt(); await f.prompt();
  await f.event('turn/start', 1, 1);
  f.turns.push({ sessionId: 'sid', turn: 1, cost: 0.06 }); f.spent.set('group:456', 0.06);
  await f.event('assistant/message', 1, 2);
  assert.equal(f.budget.status('group:456').reservedCny, 0.14);
  await f.event('turn/end', 1, 3);
  assert.equal(f.controller.active().length, 0);
  assert.equal(f.budget.status('group:456').spentCny, 0.06);
});
await test('old replay cannot bind or end a newly queued prompt', async f => {
  await f.prompt(); await f.event('turn/start', 1, 1); await f.event('turn/end', 1, 2);
  f.advance(1); await f.prompt();
  await f.controller.snapshot('sid', [
    { type: 'turn/start', seq: 1, time: f.now() - 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: f.now() - 1, data: { turn: 1 } },
  ]);
  assert.equal(f.controller.active().length, 1); assert.equal(f.controller.active()[0].turnId, null);
  await f.event('turn/start', 2, 3); await f.event('turn/end', 2, 4);
  assert.equal(f.controller.active().length, 0);
});
await test('restart snapshots settle only timely known turns and keep unknown historical evidence conservative', async f => {
  await f.prompt(); const created = f.now(); f.restart();
  await f.controller.snapshot('sid', [{ type: 'turn/start', seq: 1, time: created - 1, data: { turn: 1 } }, { type: 'turn/end', seq: 2, time: created, data: { turn: 1 } }]);
  assert.equal(f.controller.active().length, 1);
  await f.controller.snapshot('sid', [
    { type: 'event', event: { type: 'turn/start', seq: 3, time: created + 1, data: { turn: 2 } } },
    { type: 'event', event: { type: 'turn/end', seq: 4, time: created + 2, data: { turn: 2 } } },
  ]);
  assert.equal(f.controller.active().length, 0);
});
await test('observed exhaustion cancels in-flight work once and failed cancellation keeps reservation', async f => {
  await f.prompt(); await f.event('turn/start', 1, 1); f.spent.set('group:456', 1);
  await f.event('assistant/message', 1, 2); assert.deepEqual(f.stops, ['sid']); assert.equal(f.controller.active().length, 0);
  await f.event('assistant/message', 1, 2); assert.deepEqual(f.stops, ['sid']);
});
await test('long confirmed turn renews past its lease; old unknown calls require confirmed stop', async f => {
  await f.prompt(); await f.event('turn/start', 1, 1); f.advance(31 * 60_000);
  await f.controller.maintain(); assert.equal(f.controller.active().length, 1); assert.equal(f.budget.status('group:456').reservedCny, 0.1); assert.equal(f.stops.length, 0);
  await f.prompt('private:123', 'unknown'); f.advance(31 * 60_000);
  await f.controller.maintain(); assert.deepEqual(f.stops, ['unknown']);
  assert.equal(f.controller.active().length, 1);
});
await test('unconfirmed cancellation never frees money and a subsequent admission renews expired holds first', async f => {
  f.options.stopSession = async () => { throw new Error('unavailable'); }; f.restart();
  await f.prompt(); f.advance(31 * 60_000);
  await f.prompt('private:123', 'other');
  assert.equal(f.budget.status('group:456').reservedCny, 0.1);
  assert.equal(f.controller.active().length, 2);
  f.controller.cancelled('sid'); assert.equal(f.controller.active().length, 1);
});
console.log(JSON.stringify({ passed, liveModelRequests: 0, liveQqMessages: 0 }));
