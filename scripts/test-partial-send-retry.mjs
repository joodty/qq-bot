// Reproduce a gateway partial failure without contacting QQ, DSH or a model.
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.stack); }
}

async function fixture(run, { fail = (n) => n === 1, quota = 0, globals = {} } = {}) {
  const attempts = [], delivered = [];
  const h = await bridgeHarness({
    config: {
      allow: { groups: ['456', '789'], private: [] },
      socialV2: { enabled: true, proactive: { enabled: false }, send: {
        burstIntervalMinMs: 100, burstIntervalMaxMs: 100, maxGapMs: 100,
        longGapProbability: 0, maxSendPerMinute: quota, maxSendPerHour: 0,
      } },
    },
    globals: { ...globals, fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      const text = body.message.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
      const entry = { group: body.group_id, text, segments: body.message };
      attempts.push(entry);
      if (fail(attempts.length, entry)) {
        return { ok: true, status: 200, json: async () => ({
          status: 'failed', retcode: 100, wording: 'fixture network connection failed',
        }) };
      }
      delivered.push(entry);
      return { ok: true, status: 200, json: async () => ({
        status: 'ok', retcode: 0, data: { message_id: attempts.length },
      }) };
    } },
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const send = async (messages, { key = 'group:456', route = 'send-message', ...extra } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${route}`, {
      method: 'POST', headers: {
        'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
        'x-agent-call': '1', 'x-agent-token': h.getSocialV2State(key).agentToken,
      },
      body: JSON.stringify({ key, messages, gapMode: 'fixed', gapMs: 100, ...extra }),
    });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ h, send, attempts, delivered }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('partial failure reports delivered and remaining items; whole-batch retry sends only the missing item', () => fixture(async ({ h, send, attempts, delivered }) => {
  const messages = ['first question', 'study reply'];
  const initial = await send(messages);
  assert.equal(initial.status, 500);
  assert.deepEqual(initial.body.deliveredIndices, [1]);
  assert.deepEqual(initial.body.failedIndices, [0]);
  assert.deepEqual(initial.body.remainingMessages, ['first question']);
  assert.match(initial.body.error, /发送回执.*remainingMessages/);
  assert.equal(h.getSocialV2State('group:456').sendTimes.length, 1);
  const retry = await send(messages);
  assert.equal(retry.status, 200, 'one remaining quota slot must allow this retry');
  assert.equal(retry.body.sent, 1);
  assert.equal(retry.body.alreadySent, 1);
  assert.equal(retry.body.failed, 0);
  assert.deepEqual(delivered.map((x) => x.text), ['study reply', 'first question']);
  assert.equal(attempts.length, 3);
  const replay = await send(messages);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.sent, 0);
  assert.equal(replay.body.alreadySent, 2);
  assert.equal(attempts.length, 3);
  const st = h.getSocialV2State('group:456');
  assert.equal(st.sendTimes.length, 2, 'retries must not consume duplicate quota');
  assert.equal(st.recentMessages.filter((m) => m.isSelf).length, 2, 'history records only real sends');
}, { quota: 2 }));

await test('send-burst uses indices, preserving deliberately repeated strings within one batch', () => fixture(async ({ send, delivered }) => {
  const opts = { route: 'send-burst' };
  assert.equal((await send(['same', 'same', 'last'], opts)).status, 500);
  const result = await send(['same', 'same', 'last'], opts);
  assert.equal(result.body.sent, 1);
  assert.equal(result.body.alreadySent, 2);
  assert.deepEqual(delivered.map((x) => x.text), ['same', 'last', 'same']);
}, { fail: (n) => n === 2 }));

await test('normally successful repeated batches are not globally suppressed', () => fixture(async ({ send, delivered }) => {
  await send(['yes', 'fine']); await send(['yes', 'fine']);
  assert.equal(delivered.length, 4);
}, { fail: () => false }));

await test('a new incoming message permits the same legitimate answer', () => fixture(async ({ h, send, delivered }) => {
  await send(['first', 'second']); await send(['first', 'second']);
  h.getSocialV2State('group:456').lastUnreadSeq += 1;
  const result = await send(['first', 'second']);
  assert.equal(result.body.sent, 2); assert.equal(delivered.length, 4);
}));

await test('retry receipts never cross groups', () => fixture(async ({ send, delivered }) => {
  await send(['first', 'second']);
  const result = await send(['first', 'second'], { key: 'group:789' });
  assert.equal(result.body.sent, 2);
  assert.equal(delivered.filter((x) => x.group === 789).length, 2);
}));

await test('different mention targets are different deliveries', () => fixture(async ({ send, delivered }) => {
  await send(['first', 'second'], { atUserId: '111' });
  const result = await send(['first', 'second'], { atUserId: '222' });
  assert.equal(result.body.sent, 2);
  assert.equal(delivered.length, 3);
  assert.equal(delivered.at(-2).segments[0].data.qq, '222');
}));

await test('concurrent whole-batch retries share confirmations without double sending', () => fixture(async ({ h, send, attempts }) => {
  await send(['first', 'second']);
  const responses = await Promise.all([send(['first', 'second']), send(['first', 'second'])]);
  assert.ok(responses.every((x) => x.status === 200));
  assert.equal(responses.reduce((sum, x) => sum + x.body.sent, 0), 1);
  assert.equal(attempts.length, 3);
  assert.equal(h.getSocialV2State('group:456').sendTimes.length, 2);
}));

await test('a fully failed batch can retry all items and refunds its quota', () => fixture(async ({ h, send, delivered }) => {
  const initial = await send(['first', 'second']);
  assert.deepEqual(initial.body.deliveredIndices, []);
  assert.deepEqual(initial.body.remainingMessages, ['first', 'second']);
  assert.equal(h.getSocialV2State('group:456').sendTimes.length, 0);
  assert.equal((await send(['first', 'second'])).body.sent, 2);
  assert.equal(delivered.length, 2);
}, { fail: (n) => n <= 2, quota: 2 }));

await test('expired receipts do not suppress future intentional sends', async () => {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  await fixture(async ({ send, delivered }) => {
    await send(['first', 'second']); await send(['first', 'second']);
    now += 120001;
    assert.equal((await send(['first', 'second'])).body.sent, 2);
    assert.equal(delivered.length, 4);
  }, { globals: { Date: Clock } });
});

await test('permission revocation rejects even an already-delivered replay', () => fixture(async ({ h, send, attempts }) => {
  await send(['first', 'second']); await send(['first', 'second']);
  h.cfg.allow.groups = [];
  const before = attempts.length;
  assert.equal((await send(['first', 'second'])).status, 403);
  assert.equal(attempts.length, before);
}));

console.log(JSON.stringify({ passed, failed, realQqMessagesSent: 0, modelRequests: 0 }));
process.exitCode = failed ? 1 : 0;
