// Deterministic concurrency probes against the real bridge and isolated fake peers.
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0, failed = 0;
const success = value => ({ result: { ok: true, value } });
const event = id => ({ self_id: 999, user_id: id, message_id: id, sender: { nickname: 'fixture' }, message: [{ type: 'text', data: { text: 'hello' } }] });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function test(name, run) {
  const h = await bridgeHarness({ config: { allow: { private: ['123', '456'], groups: ['456'] }, socialV2: { sticker: { enabled: false }, proactive: { enabled: false } } }, files: {
    'state/current-role.json': { role: '旧', mode: 'active' }, 'roles/旧.md': 'OLD_CARD', 'roles/新.md': 'NEW_CARD',
  } });
  h.setMode('chat');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const cleanup = [];
  const pause = () => { const d = deferred(); cleanup.push(d.resolve); return d; };
  const save = async () => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/conversation-roles', {
      method: 'POST', headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' }, body: JSON.stringify({ key: 'private:456', role: '新' }),
    });
    assert.equal(response.status, 200); return response.json();
  };
  try { await run(h, save, pause); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.stack); }
  finally {
    for (const release of cleanup) release();
    await nextTurn();
    await new Promise(resolve => server.close(resolve)); await h.close();
  }
}
function assertNoOldCard(h, sessionId) {
  const prompts = sessionId ? h.calls.prompts.filter(prompt => prompt.sessionId === sessionId) : h.calls.prompts;
  assert.equal(prompts.filter(prompt => prompt.content.some(part => part.text?.includes('OLD_CARD'))).length, 0, 'old card was submitted after the new role was saved');
}

await test('first chat creation crossing a role save discards the old prompt and archives the old creation', async (h, save, pause) => {
  const started = deferred(), gate = pause();
  h.api.sessions.create = async params => { h.calls.created.push(params); started.resolve(); await gate.promise; return success({ sessionId: 'old-inflight' }); };
  const incoming = h.handleIncoming('private', 456, event(456), h.cfg).catch(error => error);
  await started.promise;
  try { await save(); } finally { gate.resolve(); }
  await incoming;
  assertNoOldCard(h);
  assert.notEqual(h.state.sessions['private:456'], 'old-inflight');
  assert.ok(h.calls.archived.includes('old-inflight'));
});

await test('offline queued first message is discarded when its effective role changes', async (h, save) => {
  h.setReady(false); await h.handleIncoming('private', 456, event(456), h.cfg);
  await save(); h.setReady(true); await h.flushQueue();
  assertNoOldCard(h);
});

await test('role save invalidates an offline entry already extracted by a flush waiting on another conversation', async (h, save, pause) => {
  h.setReady(false);
  await h.handleIncoming('private', 123, event(123), h.cfg);
  await h.handleIncoming('private', 456, event(456), h.cfg);
  const started = deferred(), gate = pause();
  const create = h.api.sessions.create;
  let count = 0;
  h.api.sessions.create = async params => { if (++count === 1) { started.resolve(); await gate.promise; } return create(params); };
  h.setReady(true); const flushing = h.flushQueue(); await started.promise;
  try { await save(); } finally { gate.resolve(); }
  await flushing;
  // The unchanged administrator conversation may legitimately receive OLD_CARD.
  const target = h.state.sessions['private:456'];
  if (target) assertNoOldCard(h, target);
  assert.equal(h.calls.prompts.length, 1, 'only the unchanged administrator entry may be submitted');
});

await test('agent token issued before any model session exists is revoked on effective role change', async (h, save) => {
  const token = h.getSocialV2State('private:456').agentToken;
  await save(); assert.notEqual(h.getSocialV2State('private:456').agentToken, token);
});

await test('reserved2 wake crossing first create does not retry a stale wake after role save', async (h, save, pause) => {
  h.setMode('reserved2');
  const started = deferred(), gate = pause();
  h.api.sessions.create = async params => { h.calls.created.push(params); started.resolve(); await gate.promise; return success({ sessionId: 'old-wake' }); };
  const delivery = h.deliverPrompt('private:456', 'OLD_CARD', { wakeReason: 'bootstrap' }).catch(error => error);
  await started.promise;
  try { await save(); } finally { gate.resolve(); }
  await delivery; await h.flushQueue(); await nextTurn();
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(h.calls.created.length, 1, 'cancelled old wake must not create a replacement automatically');
  assert.ok(h.calls.archived.includes('old-wake'));
});

await test('finishing an old create cannot delete a newer in-flight creation promise', async (h, save, pause) => {
  const started = deferred(), oldGate = pause(), freshGate = pause();
  let count = 0;
  h.api.sessions.create = async params => {
    h.calls.created.push(params); const own = ++count;
    if (own === 1) { started.resolve(); await oldGate.promise; }
    else await freshGate.promise;
    return success({ sessionId: own === 1 ? 'old-create' : 'fresh-create-' + own });
  };
  const old = h.ensureSession('private:456').catch(error => error);
  await started.promise; await save();
  const fresh = h.ensureSession('private:456'); await nextTurn();
  assert.equal(count, 2, 'fresh creation must not await the cancelled old promise');
  oldGate.resolve(); await old;
  const duplicate = h.ensureSession('private:456'); await nextTurn();
  assert.equal(count, 2, 'old finally must not remove the newer promise');
  freshGate.resolve();
  assert.equal(await fresh, 'fresh-create-2'); assert.equal(await duplicate, 'fresh-create-2');
  assert.equal(h.state.sessions['private:456'], 'fresh-create-2');
});

await test('finishing an old create cannot overwrite or retire a completed newer session mapping', async (h, save, pause) => {
  const started = deferred(), oldGate = pause();
  let count = 0;
  h.api.sessions.create = async params => {
    h.calls.created.push(params); const own = ++count;
    if (own === 1) { started.resolve(); await oldGate.promise; }
    return success({ sessionId: own === 1 ? 'old-create' : 'fresh-create' });
  };
  const old = h.ensureSession('private:456').catch(error => error);
  await started.promise; await save();
  const fresh = await h.ensureSession('private:456');
  oldGate.resolve(); await old;
  assert.equal(fresh, 'fresh-create');
  assert.equal(h.state.sessions['private:456'], fresh);
  assert.equal(await h.ensureSession('private:456'), fresh);
  assert.deepEqual(h.calls.archived, ['old-create']);
});

await test('chat create paused in selectModel is cancelled and cannot submit the old card', async (h, save, pause) => {
  const started = deferred(), gate = pause();
  h.api.sessions.selectModel = async () => { started.resolve(); await gate.promise; return success({ selected: { provider: 'fixture', model: 'fixture' } }); };
  const incoming = h.handleIncoming('private', 456, event(456), h.cfg).catch(error => error);
  await started.promise;
  try { await save(); } finally { gate.resolve(); }
  await incoming; assertNoOldCard(h);
  assert.equal(h.state.sessions['private:456'], undefined);
  assert.equal(h.calls.archived.includes('fixture-1'), false, 'created context is preserved as a paused archive');
  assert.ok(h.calls.cancelled.includes('fixture-1'));
});

console.log(JSON.stringify({ passed, failed, liveQqMessages: 0, liveModelRequests: 0 }));
if (failed) process.exitCode = 1;
