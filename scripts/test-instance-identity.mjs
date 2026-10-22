import assert from 'node:assert/strict';
import { createInstanceIdentity } from '../src/instance-identity.js';
let passed = 0;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function test(name, fn) { await fn(); passed++; console.log('PASS', name); }
await test('legacy unpinned instance preserves previous allowed behavior without external probes', async () => {
  const identity = createInstanceIdentity(); assert.equal(identity.allowed(), true); assert.equal(identity.allowed({ self_id: 999 }), true); identity.assert(); await identity.assertHttp();
});
await test('both WS and HTTP must verify the expected account; event self_id is independently checked', async () => {
  const identity = createInstanceIdentity({ expectedQQ: '222', getWsInfo: async () => ({ user_id: 222 }), getHttpInfo: async () => ({ data: { user_id: '222' } }) });
  assert.equal(identity.allowed(), false); assert.throws(() => identity.assert());
  assert.equal(await identity.verify(), true); assert.equal(identity.verifiedQQ, '222'); assert.equal(identity.allowed({ self_id: 222 }), true); assert.equal(identity.allowed({ self_id: 333 }), false);
  const generation = identity.generation; identity.revoke(); assert.ok(identity.generation > generation); assert.equal(identity.allowed(), false); assert.equal(identity.verifiedQQ, null);
});
await test('HTTP and WS identity mismatch or unknown account cannot become verified', async () => {
  for (const [ws, http] of [[222,333],[333,222],[222,null],[null,222]]) {
    const identity = createInstanceIdentity({ expectedQQ: 222, getWsInfo: async () => ({ user_id: ws }), getHttpInfo: async () => ({ user_id: http }) });
    assert.equal(await identity.verify(), false); assert.equal(identity.allowed(), false);
  }
});
await test('a revoked old asynchronous verify cannot resurrect identity after reconnect', async () => {
  const gate = deferred();
  const identity = createInstanceIdentity({ expectedQQ: 222, getWsInfo: () => gate.promise, getHttpInfo: async () => ({ user_id: 222 }) });
  const pending = identity.verify(); identity.revoke(); gate.resolve({ user_id: 222 });
  assert.equal(await pending, false); assert.equal(identity.allowed(), false);
});
await test('an older failed verify cannot revoke a newer successful connection generation', async () => {
  const gate = deferred(); let calls = 0;
  const identity = createInstanceIdentity({ expectedQQ: 222, getWsInfo: () => ++calls === 1 ? gate.promise : Promise.resolve({ user_id: 222 }), getHttpInfo: async () => ({ user_id: 222 }) });
  const old = identity.verify(); assert.equal(await identity.verify(), true); const generation = identity.generation;
  gate.resolve({ user_id: 333 }); assert.equal(await old, false); assert.equal(identity.allowed(), true); assert.equal(identity.generation, generation);
});
await test('each HTTP send rechecks identity and revokes all further operations if the account changes', async () => {
  let qq = 222, calls = 0;
  const identity = createInstanceIdentity({ expectedQQ: 222, getWsInfo: async () => ({ user_id: 222 }), getHttpInfo: async () => { calls++; return { user_id: qq }; } });
  await identity.verify(); await identity.assertHttp(); await identity.assertHttp(); assert.equal(calls, 3);
  qq = 333; await assert.rejects(identity.assertHttp(), { code: 'INSTANCE_IDENTITY_REQUIRED' }); assert.equal(identity.allowed(), false); assert.throws(() => identity.assert());
});
await test('a delayed HTTP check from an old connection cannot authorize sending on a new generation', async () => {
  const gate = deferred(); let calls = 0;
  const identity = createInstanceIdentity({ expectedQQ: 222, getWsInfo: async () => ({ user_id: 222 }), getHttpInfo: () => ++calls === 2 ? gate.promise : Promise.resolve({ user_id: 222 }) });
  await identity.verify(); const send = identity.assertHttp(); identity.revoke(); await identity.verify();
  gate.resolve({ user_id: 222 }); await assert.rejects(send, { code: 'INSTANCE_IDENTITY_REQUIRED' }); assert.equal(identity.allowed(), true);
});
await test('probe errors fail closed without exposing raw HTTP or SDK errors', async () => {
  let broken = false;
  const identity = createInstanceIdentity({ expectedQQ: 222, getWsInfo: async () => ({ user_id: 222 }), getHttpInfo: async () => { if (broken) throw new Error('secret-token-from-provider'); return { user_id: 222 }; } });
  await identity.verify(); broken = true; await assert.rejects(identity.assertHttp(), error => !error.message.includes('secret-token-from-provider')); assert.equal(identity.allowed(), false); assert.equal(await identity.verify(), false);
});
console.log(JSON.stringify({ passed, liveQqMessages: 0, liveModelRequests: 0 }));
