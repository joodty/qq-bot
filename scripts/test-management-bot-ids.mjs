import assert from 'node:assert/strict';
import { createManagementRouter } from '../src/management-router.js';

const userId = 'a'.repeat(32), identifiers = ['7bot', '1'.repeat(64), 'a' + 'b'.repeat(63)];
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS', name); }
async function request(router, path, principal, { body, tokenMatches = false, headers = {} } = {}) {
  let response;
  assert.equal(await router({ req: { method: body === undefined ? 'GET' : 'POST', headers }, url: new URL(path, 'http://127.0.0.1'), principal,
    readBody: async () => body, tokenMatches, writeAllowed() {}, sendJson(data, status = 200) { response = { data, status }; } }), true);
  return response;
}

await test('numeric and 64-character owner bot IDs reach business proxy instead of returning 404', async () => {
  const calls = [], router = createManagementRouter({ manager: { proxy: async (id, options) => { calls.push({ id, options }); return { data: { ok: true, id }, status: 200 }; } } });
  for (const id of identifiers) {
    const result = await request(router, '/api/bots/' + id + '/api/status', { id: userId, role: 'user', ownedBotIds: [id] });
    assert.equal(result.status, 200); assert.equal(result.data.id, id);
  }
  assert.equal(calls.length, identifiers.length);
});

await test('long and numeric scope identifiers survive trusted member forwarding unchanged', async () => {
  const calls = [], router = createManagementRouter({ manager: { proxy: async (id, options) => { calls.push(options.body.principal); return { data: { ok: true }, status: 200 }; } } });
  for (const id of identifiers) {
    const result = await request(router, '/api/bots/' + id + '/member/personas', { id: userId, role: 'user', botScopes: [{ botId: id, key: 'group:123' }], ownedBotIds: [id] });
    assert.equal(result.status, 200); assert.deepEqual(calls.at(-1).botScopes, [{ botId: id, key: 'group:123' }]); assert.deepEqual(calls.at(-1).ownedBotIds, [id]);
  }
});

await test('worker member channel recognizes forwarded ownership for all runtime-compatible IDs', async () => {
  for (const id of identifiers) {
    let observed;
    const router = createManagementRouter({ worker: true, botId: id, memberService: { list: async principal => { observed = principal; return { ok: true }; } } });
    const result = await request(router, '/api/internal/member', { kind: 'token', role: 'admin' }, { tokenMatches: true, headers: { 'x-console-token': 'fixture-worker' },
      body: { action: 'list', principal: { id: userId, role: 'user', ownedBotIds: [id] } } });
    assert.equal(result.status, 200); assert.deepEqual(observed.ownedBotIds, [id]);
  }
});

await test('invalid IDs remain rejected and valid IDs still require ownership or a matching scope', async () => {
  let calls = 0; const router = createManagementRouter({ manager: { proxy: async () => { calls++; return { status: 200, data: { ok: true } }; } } });
  const admin = { role: 'admin' };
  for (const id of ['ABC', 'under_score', 'a'.repeat(65), '-leading']) assert.equal((await request(router, '/api/bots/' + id + '/api/status', admin)).status, 404);
  for (const id of identifiers) assert.equal((await request(router, '/api/bots/' + id + '/api/status', { id: userId, role: 'user', ownedBotIds: [] })).status, 403);
  assert.equal(calls, 0);
});

console.log(`Management bot IDs: ${passed} tests passed`);
