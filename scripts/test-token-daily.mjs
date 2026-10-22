import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenLedger } from '../src/token-ledger.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-token-daily-test-'));
let passed = 0;
const clock = Date.parse('2026-03-03T14:00:00+08:00');
const stamp = text => Date.parse(text + '+08:00');
const record = (sid, key, seq, time, b = { cacheMiss: 1000000 }, extra = {}) => ({ k: 'turn', sid, key, seq, turn: seq, step: 1, retry: 0, t: stamp(time), model: 'deepseek-flash', b, ...extra });
let serial = 0;
function ledger(records = [], opts = {}) {
  const file = path.join(dir, `ledger-${++serial}.jsonl`);
  fs.writeFileSync(file, records.map(row => JSON.stringify(row)).join('\n'));
  return createTokenLedger({ file, now: () => clock, ...opts });
}
async function test(name, fn) { await fn(); passed++; console.log('PASS', name); }
const range = { from: '2026-03-02', to: '2026-03-03' };
try {
  await test('Beijing midnight is an exact boundary independent of host timezone', () => {
    const l = ledger([
      record('a', 'group:1', 1, '2026-03-01T23:59:59.999'),
      record('a', 'group:1', 2, '2026-03-02T00:00:00.000'),
      record('a', 'group:1', 3, '2026-03-02T23:59:59.999'),
      record('a', 'group:1', 4, '2026-03-03T00:00:00.000'),
      record('a', 'group:1', 5, '2026-03-03T23:59:59.999'),
      record('a', 'group:1', 6, '2026-03-04T00:00:00.000')
    ]);
    const r = l.daily(range);
    assert.deepEqual(r.days.map(d => d.calls), [2, 2]);
    assert.equal(r.totals.calls, 4); assert.equal(r.totals.cost, 4);
    assert.equal(r.timezone, 'Asia/Shanghai');
    assert.equal(r.coverage.retainedTokens, 6000000);
  });
  await test('price at event time and distinct disjoint cost buckets reconcile', () => {
    const b = { cacheMiss: 1000000, cacheHit: 1000000, cacheWrite: 1000000, output: 1000000, reasoning: 999 };
    const r = ledger([
      record('a', 'group:1', 1, '2026-03-02T10:00:00', b),
      record('a', 'group:1', 2, '2026-03-02T20:00:00', b)
    ]).daily(range);
    assert.equal(r.totals.cost, 18.06); assert.equal(r.totals.tokens, 8000000);
    assert.deepEqual(r.totals.costs, { cacheMiss: 3, cacheHit: .06, cacheWrite: 3, output: 12 });
    assert.equal(r.days.reduce((n, d) => n + d.cost, 0), r.totals.cost);
    assert.equal(r.rows.reduce((n, d) => n + d.cost, 0), r.totals.cost);
    assert.equal(r.conversations.reduce((n, d) => n + d.cost, 0), r.totals.cost);
  });
  await test('retired and current sessions aggregate to the same QQ conversation', () => {
    const l = ledger([record('old', 'group:1', 1, '2026-03-02T01:00:00'), record('new', 'group:1', 1, '2026-03-02T02:00:00')]);
    assert.equal(l.daily(range).rows.length, 1); assert.equal(l.daily(range).rows[0].cost, 2);
  });
  await test('group, private, owner, and internal are independently filterable with available keys preserved', () => {
    const l = ledger(['group:1', 'private:2', 'owner:2', 'internal:job'].map((key, i) => record('s' + i, key, 1, '2026-03-02T01:00:00')));
    for (const key of ['group:1', 'private:2', 'owner:2', 'internal:job']) {
      const r = l.daily({ ...range, key });
      assert.equal(r.rows.length, 1); assert.equal(r.rows[0].key, key); assert.equal(r.coverage.ledgerTokens, 1000000);
      assert.equal(r.availableKeys.length, 4);
    }
    assert.equal(l.daily(range).totals.cost, 4);
  });
  await test('baseline history is never assigned to its snapshot receipt day', () => {
    const l = ledger([{ k: 'base', sid: 'a', key: 'group:1', seq: 50, t: clock, model: 'deepseek-flash', b: { cacheMiss: 5000000 } }]);
    const r = l.daily(range);
    assert.equal(r.totals.cost, 0); assert.equal(r.rows.length, 0); assert.equal(r.days.length, 2);
    assert.equal(r.coverage.unallocatedTokens, 5000000);
    assert.equal(r.conversations[0].unallocatedTokens, 5000000);
  });
  await test('baseline-covered details appear once and missing history is calculated per token bucket', () => {
    const l = ledger([
      { k: 'base', sid: 'a', key: 'group:1', seq: 50, t: clock, b: { cacheMiss: 5000000, output: 1000000 } },
      record('a', 'group:1', 1, '2026-03-02T01:00:00'),
      record('a', 'group:1', 51, '2026-03-02T02:00:00')
    ]);
    const r = l.daily(range);
    assert.equal(r.totals.cost, 2); assert.equal(r.totals.calls, 2);
    assert.equal(r.coverage.unallocatedTokens, 5000000); assert.equal(r.coverage.ledgerTokens, 7000000);
  });
  await test('evicted history remains undated coverage, without double counting a covering baseline', () => {
    const evict = { k: 'evict', sid: 'a', key: 'group:1', seq: 1, maxSeq: 1, dropped: 1, cost: 1, t: clock, b: { cacheMiss: 1000000 } };
    assert.equal(ledger([evict]).daily(range).coverage.unallocatedTokens, 1000000);
    assert.equal(ledger([evict, { k: 'base', sid: 'a', key: 'group:1', seq: 50, t: clock, b: { cacheMiss: 1000000 } }]).daily(range).coverage.unallocatedTokens, 1000000);
  });
  await test('timestamp missing on disk is reported and excluded from daily cost', () => {
    const r = ledger([record('a', 'group:1', 1, '2026-03-02T01:00:00', undefined, { t: 0 })]).daily(range);
    assert.equal(r.coverage.undatedTokens, 1000000); assert.equal(r.coverage.unallocatedTokens, 0); assert.equal(r.totals.calls, 0);
  });
  await test('unknown model and missing conversation remain visible with explicit coverage flags', () => {
    const r = ledger([record('a', undefined, 1, '2026-03-02T01:00:00', undefined, { model: null })]).daily(range);
    assert.equal(r.totals.estimated, true); assert.equal(r.coverage.estimatedSamples, 1);
    assert.equal(r.coverage.unknownConversationTokens, 1000000); assert.equal(r.rows[0].key, '未归属:a');
  });
  await test('replayed events with receipt-only time are not falsely assigned to reconnect day, even after compaction', () => {
    const l = ledger();
    l.ingestSnapshotRecords({ sessionId: 'a', records: [{ type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, usage: { inputTokens: 1000000 } } }] });
    assert.equal(l.daily(range).totals.calls, 0); assert.equal(l.daily(range).coverage.undatedTokens, 1000000);
    l.compact();
    const restarted = createTokenLedger({ file: l.file, now: () => clock });
    assert.equal(restarted.daily(range).totals.calls, 0); assert.equal(restarted.daily(range).coverage.undatedTokens, 1000000);
  });
  await test('snapshot replay and newer seq replacement are idempotent, including replacement date', () => {
    const l = ledger();
    const ingest = (seq, time, inputTokens) => l.ingestEvent({ sessionId: 'a', event: { seq, time: stamp(time), type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens } } }, model: 'deepseek-flash' });
    ingest(1, '2026-03-02T01:00:00', 1000000); ingest(1, '2026-03-02T01:00:00', 1000000);
    ingest(2, '2026-03-03T01:00:00', 2000000);
    const r = l.daily(range); assert.equal(r.totals.calls, 1); assert.equal(r.totals.cost, 2);
    assert.deepEqual(r.days.map(d => d.cost), [0, 2]);
    const restarted = createTokenLedger({ file: l.file, now: () => clock });
    assert.deepEqual(restarted.daily(range), r);
  });
  await test('retry axis counts separately billable calls', () => {
    const l = ledger();
    const event = (seq, type, data) => l.ingestEvent({ sessionId: 'a', event: { seq, time: stamp('2026-03-02T01:00:00'), type, data }, model: 'deepseek-flash' });
    event(1, 'assistant/message', { turn: 1, step: 1, usage: { inputTokens: 1000000 } });
    event(2, 'llm/retry-started', { turn: 1, step: 1 });
    event(3, 'assistant/message', { turn: 1, step: 1, usage: { inputTokens: 1000000 } });
    assert.equal(l.daily(range).totals.calls, 2);
  });
  await test('default is seven Beijing calendar days, zero dates stay present, range capped at90 inclusive', () => {
    const l = ledger(); const r = l.daily();
    assert.equal(r.from, '2026-02-25'); assert.equal(r.to, '2026-03-03'); assert.equal(r.days.length, 7);
    assert.ok(r.days.every(d => d.cost === 0));
    assert.equal(l.daily({ from: '2026-01-01', to: '2026-03-31' }).days.length, 90);
    for (const opts of [{ from: '2026-02-30' }, { to: 'hello' }, { from: '2026-03-04', to: '2026-03-03' }, { from: '2026-01-01', to: '2026-04-01' }, { key: {} }]) assert.throws(() => l.daily(opts), RangeError);
  });
  await test('queries never rewrite journal or current sessions', () => {
    const l = ledger([record('a', 'group:1', 1, '2026-03-02T01:00:00')]);
    const before = fs.readFileSync(l.file, 'utf8'); l.daily(range); l.daily({ ...range, key: 'group:1' });
    assert.equal(fs.readFileSync(l.file, 'utf8'), before);
    assert.equal(l.daily({ ...range, key: 'group:absent' }).totals.cost, 0);
  });
  await test('real bridge daily route requires console auth, rejects agent token, returns400 for invalid range', async () => {
    const rows = [record('a', 'group:1', 1, '2026-03-02T01:00:00')];
    const h = await bridgeHarness({ files: { 'state/token-usage.jsonl': rows.map(r => JSON.stringify(r)).join('\n') } });
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/tokens/daily?from=${range.from}&to=${range.to}`;
    const before = fs.readFileSync(path.join(h.temp, 'state/token-usage.jsonl'), 'utf8');
    try {
      assert.equal((await fetch(url)).status, 401);
      const good = await fetch(url, { headers: { 'x-console-token': 'fixture-console-token' } });
      assert.equal(good.status, 200); assert.equal((await good.json()).totals.cost, 1);
      const token = h.getSocialV2State('group:456').agentToken;
      assert.equal((await fetch(url, { headers: { 'x-agent-token': token, 'x-console-token': 'fixture-console-token' } })).status, 403);
      const bad = await fetch(url.replace('2026-03-02', '2026-02-30'), { headers: { 'x-console-token': 'fixture-console-token' } });
      assert.equal(bad.status, 400); assert.match((await bad.json()).error, /日期/);
      assert.equal(fs.readFileSync(path.join(h.temp, 'state/token-usage.jsonl'), 'utf8'), before);
      assert.equal(h.calls.sent.length, 0); assert.equal(h.calls.prompts.length, 0);
    } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`Daily usage: ${passed} tests passed`);
