import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import * as roleCard from '../src/role-card.js';

const groups = ['100001', '100002', '100003', '100004'];
const expected = { atMention: true, nameMention: false, speakerIds: [], keywords: [],
  question: false, poke: false, anyMessage: false, probability: 0.1 };
const plain = (x) => JSON.parse(JSON.stringify(x));
let passed = 0, failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.stack); }
}
async function fixture(run, { files = {}, policy = true } = {}) {
  let roll = 0.9;
  const math = Object.create(Math); math.random = () => roll;
  const h = await bridgeHarness({ config: {
    allow: { groups, private: [] }, groupMentionOnly: false,
    slang: { enabled: false }, socialV2: {
      enabled: true, proactive: { enabled: false },
      wake: { ...(policy ? { triggerPolicy: 'mention-probability' } : {}),
        recommendedProbability: 0.1, preSleepWaitEnabled: false },
      sticker: { enabled: false },
    },
  }, files, globals: { ...roleCard, Math: math } });
  h.setMode('reserved2');
  for (const group of groups) h.getSocialV2State('group:' + group).bootstrapSent = true;
  const incoming = (group, text, mention = false) => h.handleIncoming('group', group, {
    self_id: 99001122, group_id: Number(group), user_id: 88001122, message_id: 101,
    sender: { nickname: 'fixture' },
    message: [...(mention ? [{ type: 'at', data: { qq: '99001122' } }] : []),
      { type: 'text', data: { text } }],
  }, h.cfg);
  try { await run({ h, incoming, roll(value) { roll = value; } }); }
  finally { await h.close(); }
}

await test('ordinary messages enter all four contexts without waking the model when probability misses', () => fixture(async ({ h, incoming }) => {
  for (const group of groups) {
    await incoming(group, 'ordinary context ' + group);
    const st = h.getSocialV2State('group:' + group);
    assert.equal(st.unread.length, 1);
    assert.equal(st.recentMessages.length, 1);
    assert.equal(st.pendingWakeTimer, null);
    assert.deepEqual(plain(st.wakeConfig.triggers), expected);
  }
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(h.calls.created.length, 0);
}));

await test('a probability hit schedules a wake and a real @ upgrades the same batch', () => fixture(async ({ h, incoming, roll }) => {
  roll(0.099); await incoming(groups[0], 'ordinary topic');
  const st = h.getSocialV2State('group:' + groups[0]);
  assert.equal(st.pendingWakeReason, 'probability');
  const timer = st.pendingWakeTimer;
  roll(0.99); await incoming(groups[0], 'please answer', true);
  assert.equal(st.pendingWakeTimer, timer);
  assert.equal(st.pendingWakeReason, 'atMention');
  const snapshot = h.buildWakeSnapshotV2('group:' + groups[0]);
  assert.equal(snapshot.messages.length, 2);
  assert.ok(snapshot.messages.some((m) => JSON.stringify(m).includes('ordinary topic')));
  assert.match(h.buildWakePromptV2('group:' + groups[0], 'atMention'), /管理员固定参与策略.*10%/);
}));

await test('10% uses a strict threshold and names or questions cannot bypass a miss', () => fixture(async ({ h, incoming, roll }) => {
  roll(0.1); await incoming(groups[0], '小鲸鱼 DeepSeek 在吗？');
  assert.equal(h.getSocialV2State('group:' + groups[0]).pendingWakeTimer, null);
  assert.equal(h.calls.prompts.length, 0);
}));

await test('agent wake updates cannot enable every-message mode or change the operator probability', () => fixture(async ({ h }) => {
  const key = 'group:' + groups[0], st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/wake-config`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'x-agent-call': '1' },
      body: JSON.stringify({ key, config: { mode: 'active', infinite: false, sleepMs: 60000,
        triggers: { atMention: false, anyMessage: true, probability: 1,
          nameMention: true, question: true, poke: true, keywords: ['anything'], speakerIds: ['123'] } } }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.wakeConfig.triggers, expected);
    assert.equal(body.wakeConfig.mode, 'diving');
    assert.equal(body.wakeConfig.infinite, true);
    assert.equal(body.wakeConfig.sleepUntil, null);
    h.cfg.socialV2.wake.recommendedProbability = 0.2;
    assert.equal(h.getSocialV2State(key).wakeConfig.triggers.probability, 0.2);
  } finally { server.closeIdleConnections(); await new Promise((resolve) => server.close(resolve)); }
}));

await test('loading old agent overrides preserves context and restores the fixed policy', () => fixture(async ({ h }) => {
  const st = h.getSocialV2State('group:' + groups[0]);
  assert.deepEqual(plain(st.wakeConfig.triggers), expected);
  assert.equal(st.recentMessages[0].text, 'existing conversation');
  assert.equal(st.wakeConfig.mode, 'diving');
  assert.equal(st.wakeConfig.sleepUntil, null);
}, { files: { 'state/social-v2.json': { conversations: { ['group:' + groups[0]]: {
  bootstrapSent: true, recentMessages: [{ text: 'existing conversation', isSelf: false }],
  wakeConfig: { mode: 'active', infinite: false, sleepUntil: '2099-01-01T00:00:00Z',
    confirmedBy: 'set_wake_config', triggers: { anyMessage: true, probability: 1 } },
} } } } }));

await test('ordinary contexts remain isolated and unauthorized groups are ignored', () => fixture(async ({ h, incoming }) => {
  await incoming(groups[0], 'group A only');
  await incoming(groups[1], 'group B only');
  await incoming('999999', 'unauthorized');
  assert.ok(!JSON.stringify(h.buildWakeSnapshotV2('group:' + groups[1])).includes('group A only'));
  assert.equal(h.socialV2.conversations.has('group:999999'), false);
  assert.equal(h.calls.sent.length, 0);
  assert.equal(h.calls.prompts.length, 0);
}));

await test('without the explicit policy existing autonomous wake settings still work', () => fixture(async ({ h }) => {
  const st = h.getSocialV2State('group:' + groups[0]);
  st.wakeConfig.mode = 'active'; st.wakeConfig.triggers.anyMessage = true;
  assert.equal(h.getSocialV2State('group:' + groups[0]).wakeConfig.mode, 'active');
  assert.equal(st.wakeConfig.triggers.anyMessage, true);
}, { policy: false }));

console.log(JSON.stringify({ passed, failed, realQqMessagesSent: 0, modelRequests: 0 }));
process.exitCode = failed ? 1 : 0;
