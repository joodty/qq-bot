// Controlled races against the real bridge, with temporary files and fake peers.
// No production credentials, QQ traffic, DSH process or paid model is accessed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createConversationSessionStore } from '../src/conversation-sessions.js';

let passed = 0, failed = 0;
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function test(name, run) {
  const h = await bridgeHarness({ config: {
    allow: { groups: ['456', '789'], private: ['123'] }, sendDelayMs: 0,
    socialV2: { enabled: true, sticker: { enabled: false }, proactive: { enabled: false } },
  }, files: {
    'state/current-role.json': { role: 'A', mode: 'active' },
    'roles/A.md': '# A\nA_FIXTURE_CARD', 'roles/B.md': '# B\nB_FIXTURE_CARD',
  } });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const gates = [], pending = [];
  const gate = () => { const value = deferred(); gates.push(value); return value; };
  const track = promise => { pending.push(promise); return promise; };
  const archive = () => JSON.parse(fs.readFileSync(path.join(h.temp, 'state/conversation-sessions.json'), 'utf8'));
  const request = async (route, body) => {
    const response = await fetch(url + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const select = (key, role) => request('/api/conversation-roles', { key, role });
  const seed = async key => {
    const a = await h.ensureSession(key);
    assert.equal((await select(key, 'B')).status, 200);
    const b = await h.ensureSession(key); assert.notEqual(a, b);
    const resumed = await select(key, 'A');
    assert.equal(resumed.status, 200); assert.equal(resumed.data.resumed, true);
    assert.equal(h.state.sessions[key], a);
    return { a, b };
  };
  try {
    await run({ h, gate, track, request, select, archive, seed });
    assert.equal(h.calls.prompts.length, 0, 'race probes must not invoke a model');
    passed++; console.log('PASS', name);
  } catch (error) { failed++; console.error('FAIL', name, error.stack); }
  finally {
    for (const value of gates) value.resolve();
    await bounded(Promise.allSettled(pending), 'pending requests after gate release');
    await new Promise(resolve => server.close(resolve)); await h.close();
  }
}

await test('workspace reset while activate awaits cancellation cannot resurrect a now-missing old session', async ({ h, seed, gate, track, request, select, archive }) => {
  const { a, b } = await seed('group:456');
  const entered = deferred(), stop = gate();
  const originalStop = h.api.stopSessionWork;
  h.api.stopSessionWork = async sid => {
    if (sid === a) { entered.resolve(); await stop.promise; }
    return originalStop(sid);
  };
  const switching = track(select('group:456', 'B'));
  await bounded(entered.promise, 'persona cancellation to enter');
  const reset = await request('/api/workspace/reset', {}); assert.equal(reset.status, 200);
  assert.equal(h.state.sessions['group:456'], undefined);
  const followCount = h.calls.follows.length;
  stop.resolve();
  const result = await bounded(switching, 'switch after reset');
  assert.equal(result.status, 409, 'reset must cancel the switch rather than report success');
  assert.match(result.data.error, /重置|失效/);
  assert.equal(h.state.sessions['group:456'], undefined, 'reset mapping must remain empty');
  assert.equal(h.calls.follows.length, followCount, 'the rejected switch must not re-follow a reset session');
  assert.ok(Object.values(archive().records).filter(record => [a, b].includes(record.sessionId)).every(record => record.missing));
  const fresh = await h.ensureSession('group:456');
  assert.ok(fresh !== a && fresh !== b, 'next normal wake must create a fresh session');
  assert.equal(h.calls.sent.length, 0);
});

await test('A to B to A reuses the original sid but discards sends queued during the first A generation', async ({ h, seed, gate, track, select }) => {
  const { a, b } = await seed('group:456');
  await h.ensureSession('group:789');
  const entered = deferred(), sending = gate();
  const originalSend = h.bot.sendGroupMessage.bind(h.bot);
  h.bot.sendGroupMessage = async (id, text) => {
    if (id === 789 && text === 'other-key-blocker') { entered.resolve(); await sending.promise; }
    return originalSend(id, text);
  };
  const blocking = track(h.sendToQQ('group:789', 'other-key-blocker'));
  await bounded(entered.promise, 'other conversation sendChain blocker');
  const stale = track(h.sendToQQ('group:456', 'first-A-generation-stale-send'));
  assert.equal(h.calls.sent.filter(item => item.id === 456).length, 0);
  assert.equal((await select('group:456', 'B')).status, 200); assert.equal(h.state.sessions['group:456'], b);
  const resumed = await select('group:456', 'A'); assert.equal(resumed.status, 200);
  assert.equal(resumed.data.resumed, true); assert.equal(h.state.sessions['group:456'], a);
  // sid, mode, permission and policy now match the old send again. Only the
  // captured role generation can distinguish that stale send from this fresh one.
  const fresh = track(h.sendToQQ('group:456', 'second-A-generation-fresh-send'));
  sending.resolve(); await bounded(Promise.all([blocking, stale, fresh]), 'queued sends to finish');
  assert.deepEqual(h.calls.sent.filter(item => item.id === 456).map(item => item.text), ['second-A-generation-fresh-send']);
  assert.deepEqual(h.calls.sent.filter(item => item.id === 789).map(item => item.text), ['other-key-blocker']);
  assert.equal(h.state.sessions['group:456'], a);
});

await test('two conversations waiting in stop concurrently preserve both JSON selections and all historical records', async ({ h, seed, gate, track, select, archive }) => {
  const first = await seed('group:456'), second = await seed('group:789');
  const initial = archive(); assert.equal(Object.keys(initial.records).length, 4);
  const gates = new Map([[first.a, gate()], [second.a, gate()]]);
  const entered = new Map([[first.a, deferred()], [second.a, deferred()]]);
  const originalStop = h.api.stopSessionWork;
  h.api.stopSessionWork = async sid => {
    if (gates.has(sid)) { entered.get(sid).resolve(); await gates.get(sid).promise; }
    return originalStop(sid);
  };
  const one = track(select('group:456', 'B')), two = track(select('group:789', 'B'));
  await bounded(Promise.all([...entered.values()].map(value => value.promise)), 'both independent cancellations to enter');
  const paused = archive();
  assert.equal(paused.records[paused.selected['group:456']].blocked, true);
  assert.equal(paused.records[paused.selected['group:789']].blocked, true);
  gates.get(first.a).resolve(); assert.equal((await bounded(one, 'first switch')).status, 200);
  const intermediate = archive();
  assert.equal(intermediate.records[intermediate.selected['group:456']].sessionId, first.b);
  assert.equal(intermediate.records[intermediate.selected['group:789']].blocked, true);
  gates.get(second.a).resolve(); assert.equal((await bounded(two, 'second switch')).status, 200);
  const saved = archive();
  assert.deepEqual(Object.keys(saved.records).sort(), Object.keys(initial.records).sort(), 'neither completion may overwrite the other key or its history');
  for (const [key, ids] of [['group:456', first], ['group:789', second]]) {
    const active = saved.records[saved.selected[key]];
    assert.equal(active.sessionId, ids.b); assert.equal(active.blocked, false); assert.equal(active.missing, false);
    assert.equal(saved.personas[active.personaId].name, 'B'); assert.equal(h.state.sessions[key], ids.b);
    assert.ok(Object.values(saved.records).some(record => record.key === key && record.sessionId === ids.a && !record.missing && !record.blocked));
  }
  const assignments = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/conversation-roles.json'), 'utf8'));
  assert.deepEqual(assignments.roles, { 'group:456': 'B', 'group:789': 'B' });
  assert.equal(h.calls.sent.length, 0);
});

await test('restart after suspension intent is persisted revokes the old token before any old-session follow or send', async ({ h, seed, archive }) => {
  // The social state must exist before switching so the old model genuinely
  // holds a persisted token, rather than a token freshly invented by this test.
  h.getSocialV2State('group:456');
  const { a, b } = await seed('group:456');
  const oldToken = h.getSocialV2State('group:456').agentToken;
  const savedState = JSON.parse(JSON.stringify(h.state));
  const snapshot = archive(); snapshot.records[snapshot.selected['group:456']].blocked = true;
  const social = fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8');
  assert.equal(JSON.parse(social).conversations['group:456'].agentToken, oldToken);
  // Exact crash cut: role B and blocked(A) have reached disk; sessions.json and
  // social-v2.json still contain the old A mapping and token. Cancellation has
  // not been confirmed. Restart must reconcile this before following anything.
  const restarted = await bridgeHarness({ config: {
    allow: { groups: ['456', '789'], private: ['123'] }, sendDelayMs: 0,
    socialV2: { enabled: true, sticker: { enabled: false }, proactive: { enabled: false } },
  }, savedState, files: {
    'state/current-role.json': { role: 'A', mode: 'active' },
    'roles/A.md': '# A\nA_FIXTURE_CARD', 'roles/B.md': '# B\nB_FIXTURE_CARD',
    'state/conversation-roles.json': { version: 1, roles: { 'group:456': 'B' } },
    'state/conversation-sessions.json': snapshot,
    'state/social-v2.json': social,
  } });
  restarted.setMode('reserved2');
  const server = restarted.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    assert.equal(restarted.state.sessions['group:456'], undefined);
    assert.ok(!restarted.calls.follows.includes(a), 'startup must never subscribe the unconfirmed old A mapping');
    assert.ok(restarted.calls.cancelled.includes(a), 'startup must confirm cancellation before making history resumable');
    assert.notEqual(restarted.getSocialV2State('group:456').agentToken, oldToken);
    const url = 'http://127.0.0.1:' + server.address().port;
    for (const route of ['/api/status', '/api/socialV2/prompt?key=group:456', '/api/socialV2/send-message']) {
      const sending = route.endsWith('send-message');
      const response = await fetch(url + route, {
        method: sending ? 'POST' : 'GET', headers: {
          'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': oldToken,
          ...(sending ? { 'content-type': 'application/json' } : {}),
        }, ...(sending ? { body: JSON.stringify({ key: 'group:456', messages: ['old-A-after-restart'] }) } : {}),
      });
      assert.equal(response.status, 403, route); await response.text();
    }
    assert.equal(restarted.calls.sent.length, 0);
    assert.equal(restarted.calls.http.filter(call => /send_(?:group|private)_msg/.test(call.url)).length, 0);
    assert.equal(restarted.calls.created.length, 0); assert.equal(restarted.calls.prompts.length, 0);
    assert.ok(!restarted.calls.archived.includes(a), 'suspension recovery must preserve the old model context');
    const retained = JSON.parse(fs.readFileSync(path.join(restarted.temp, 'state/conversation-sessions.json'), 'utf8'));
    assert.deepEqual(Object.keys(retained.records).sort(), Object.keys(snapshot.records).sort());
    assert.deepEqual(Object.keys(retained.personas).sort(), Object.keys(snapshot.personas).sort());
    for (const sid of [a, b]) {
      const row = Object.values(retained.records).find(record => record.sessionId === sid);
      assert.ok(row, 'history must retain ' + sid); assert.equal(row.missing, false);
    }
  } finally { await new Promise(resolve => server.close(resolve)); await restarted.close(); }
});

await test('an externally replaced archive rejects stale writes and preserves both valid and unknown-format replacements', async ({ h }) => {
  const file = path.join(h.temp, 'state/external-archive-test.json'); let writes = 0;
  const atomic = value => { const temporary = file + '.replacement'; fs.writeFileSync(temporary, value, { mode: 0o600 }); fs.renameSync(temporary, file); };
  const store = createConversationSessionStore(file, (_file, value) => { writes++; atomic(JSON.stringify(value)); });
  const first = store.read(); store.choose(first, 'group:456', 'A', { policy: 'fixture-policy' }); store.write(first);
  const stale = store.read(), outside = store.read();
  store.choose(outside, 'group:789', 'B', { policy: 'fixture-policy' });
  const replacement = JSON.stringify(outside); atomic(replacement);
  const previousWrites = writes;
  assert.throws(() => store.write(stale), /发生变化.*停止改写/);
  assert.equal(writes, previousWrites); assert.equal(fs.readFileSync(file, 'utf8'), replacement);
  const refreshed = store.read(); store.choose(refreshed, 'group:456', 'B', { policy: 'fixture-policy' }); store.write(refreshed);
  const merged = store.read(); assert.ok(merged.selected['group:456']); assert.ok(merged.selected['group:789']);
  const valid = fs.readFileSync(file, 'utf8');
  for (const changed of ['{"version":99,"personas":{},"records":{},"selected":{}}', '{broken']) {
    atomic(valid); const pending = store.read(); atomic(changed);
    assert.throws(() => store.write(pending), /发生变化.*停止改写/);
    assert.equal(fs.readFileSync(file, 'utf8'), changed);
    assert.throws(() => store.read(), /版本不受支持|损坏/);
  }
  assert.equal(h.calls.sent.length, 0);
});

await test('restart with an already-cleared mapping still rejects the old identity token and resumes only the selected persona history', async ({ h, seed, archive }) => {
  h.getSocialV2State('group:456');
  const { a, b } = await seed('group:456');
  const oldToken = h.getSocialV2State('group:456').agentToken;
  const snapshot = archive();
  assert.equal(snapshot.records[snapshot.selected['group:456']].blocked, false);
  assert.equal(snapshot.personas[snapshot.records[snapshot.selected['group:456']].personaId].name, 'A');
  // A repeated crash may leave sessions.json cleared before token rotation, with
  // role B persisted but the selected A history not marked blocked. The missing
  // active mapping must not turn that stale persona token into an allowed one.
  const restarted = await bridgeHarness({ config: {
    allow: { groups: ['456', '789'], private: ['123'] }, sendDelayMs: 0,
    socialV2: { enabled: true, sticker: { enabled: false }, proactive: { enabled: false } },
  }, savedState: { sessions: {}, sessionPolicies: {} }, files: {
    'state/current-role.json': { role: 'A', mode: 'active' },
    'roles/A.md': '# A\nA_FIXTURE_CARD', 'roles/B.md': '# B\nB_FIXTURE_CARD',
    'state/conversation-roles.json': { version: 1, roles: { 'group:456': 'B' } },
    'state/conversation-sessions.json': snapshot,
    'state/social-v2.json': fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'),
  } });
  restarted.setMode('reserved2');
  const server = restarted.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    assert.equal(restarted.state.sessions['group:456'], undefined);
    assert.ok(!restarted.calls.follows.includes(a));
    assert.ok(restarted.calls.cancelled.includes(a), 'selected history must be reconciled even without an active mapping');
    assert.notEqual(restarted.getSocialV2State('group:456').agentToken, oldToken);
    const url = 'http://127.0.0.1:' + server.address().port;
    for (const route of ['/api/status', '/api/socialV2/prompt?key=group:456', '/api/socialV2/send-message']) {
      const sending = route.endsWith('send-message');
      const response = await fetch(url + route, {
        method: sending ? 'POST' : 'GET', headers: {
          'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': oldToken,
          ...(sending ? { 'content-type': 'application/json' } : {}),
        }, ...(sending ? { body: JSON.stringify({ key: 'group:456', messages: ['stale-unmapped-A'] }) } : {}),
      });
      assert.equal(response.status, 403, route); await response.text();
    }
    assert.equal(await restarted.ensureSession('group:456'), b, 'normal wake may resume the matching B history without creating a new model session');
    assert.ok(!restarted.calls.follows.includes(a));
    assert.equal(restarted.calls.created.length, 0); assert.equal(restarted.calls.prompts.length, 0); assert.equal(restarted.calls.sent.length, 0);
    assert.equal(restarted.calls.http.filter(call => /send_(?:group|private)_msg/.test(call.url)).length, 0);
    const retained = JSON.parse(fs.readFileSync(path.join(restarted.temp, 'state/conversation-sessions.json'), 'utf8'));
    assert.deepEqual(Object.keys(retained.records).sort(), Object.keys(snapshot.records).sort());
    for (const sid of [a, b]) assert.ok(Object.values(retained.records).some(record => record.sessionId === sid && !record.missing));
  } finally { await new Promise(resolve => server.close(resolve)); await restarted.close(); }
});

console.log(JSON.stringify({ passed, failed, liveQqMessages: 0, liveModelRequests: 0 }));
if (failed) process.exitCode = 1;
