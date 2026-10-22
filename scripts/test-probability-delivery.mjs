// Run the deployed probability -> batch timer -> session prompt path with fake
// QQ/DSH peers. Never post a test message to a real group or call a paid model.
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import * as roleCard from '../src/role-card.js';

const key = 'group:100002';
let passed = 0;
async function run(name, { draw, mention, expectedPrompts }) {
  const math = Object.create(Math); math.random = () => draw;
  const h = await bridgeHarness({
    config: {
      groupMentionOnly: false, allow: { groups: ['100002'], private: [] },
      socialV2: { enabled: true, sticker: { enabled: false }, proactive: { enabled: false },
        wake: { triggerPolicy: 'mention-probability', recommendedProbability: 0.2,
          batchWindowMs: 1000, maxWakePerMinute: 1, maxWakePerHour: 12 } },
    }, globals: { ...roleCard, Math: math },
  });
  h.setMode('reserved2');
  const state = h.getSocialV2State(key); state.bootstrapSent = true;
  try {
    await h.handleIncoming('group', '100002', {
      self_id: 99001122, group_id: 100002, user_id: 88001122, message_id: 1001,
      sender: { nickname: 'fixture' }, message: [
        ...(mention ? [{ type: 'at', data: { qq: '99001122' } }] : []),
        { type: 'text', data: { text: 'probability delivery fixture' } },
      ],
    }, h.cfg);
    assert.equal(state.unread.length, 1, 'a miss must still preserve context');
    for (let n = 0; n < 30 && h.calls.prompts.length < expectedPrompts; n++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!expectedPrompts) await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(h.calls.prompts.length, expectedPrompts);
    if (expectedPrompts) {
      assert.equal(state.lastWakeReason, mention ? 'atMention' : 'probability');
      assert.equal(h.calls.created[0].agentPreset, 'qq-chat-v2');
      assert.match(JSON.stringify(h.calls.prompts[0].content), /probability delivery fixture/);
      assert.match(JSON.stringify(h.calls.prompts[0].content), /20%/);
    }
    assert.equal(h.calls.sent.length, 0); assert.equal(h.calls.http.length, 0);
    passed++; console.log('PASS', name);
  } finally { await h.close(); }
}
await run('20% miss buffers the ordinary message without a prompt', { draw: 0.8, mention: false, expectedPrompts: 0 });
await run('20% hit passes the batch timer and reaches the qq-chat-v2 prompt', { draw: 0.19, mention: false, expectedPrompts: 1 });
await run('a real @ reaches the prompt even when the random value would miss', { draw: 0.99, mention: true, expectedPrompts: 1 });
console.log(JSON.stringify({ passed, realQqMessagesSent: 0, paidModelRequests: 0 }));
