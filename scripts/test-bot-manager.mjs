import assert from 'node:assert/strict';
import http from 'node:http';
import { createBotManager } from '../src/bot-manager.js';

let passed = 0;
const reject = code => error => error.statusCode === code;
const token = 'fixture-machine-token-not-live';
const tokenFor = id => id === 'bot-a' ? token : token + '-b';
async function worker(id, qq) {
  const state = { id, qq, online: true, ready: true, requests: [], peers: [], redirect: false, denyPeers: false };
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    state.requests.push({ path: req.url, token: req.headers['x-console-token'], cookie: req.headers.cookie, agent: req.headers['x-agent-token'] });
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers['x-console-token'] !== tokenFor(id)) return send({ ok: false }, 401);
    if (state.redirect) { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); return res.end(); }
    if (req.url === '/api/instance') return send({ ok: true, botId: state.id, expectedQQ: qq, actualQQ: state.qq, qqOnline: state.online, dshReady: state.ready });
    if (req.url === '/api/instance/peers') { if (state.denyPeers) return send({ ok: false }, 500); state.peers = JSON.parse(text).qqs; return send({ ok: true }); }
    send({ ok: true, botId: id, path: req.url, ...(state.extra || {}) });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { ...state, state, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}
const a = await worker('bot-a', '222'), b = await worker('bot-b', '333');
let raw = null;
const manager = createBotManager({ read: () => raw, write: value => { raw = JSON.stringify(value); }, primary: { expectedQQ: '111', actualQQ: '111', port: 3100 }, timeoutMs: 1000 });
async function test(name, run) { await run(); passed++; console.log('PASS', name); }
try {
  await test('primary needs no network and new records never expose machine credentials', () => {
    assert.equal(manager.list()[0].id, 'primary');
    for (const [id, qq, port] of [['bot-a', '222', a.port], ['bot-b', '333', b.port]]) {
      const row = manager.add({ id, expectedQQ: qq, name: id, port, machineToken: tokenFor(id) });
      assert.equal(row.enabled, false); assert.equal('machineToken' in row, false);
    }
    assert.ok(!JSON.stringify(manager.list()).includes(token));
  });
  await test('duplicate QQ, duplicate port, reserved primary, URL injection and invalid fields are rejected', () => {
    for (const input of [
      { id: 'bot-c', expectedQQ: '222', port: 3202 }, { id: 'bot-c', expectedQQ: '111', port: 3202 }, { id: 'bot-c', expectedQQ: '444', port: a.port }, { id: 'primary', expectedQQ: '444', port: 3202 },
    ]) assert.throws(() => manager.add({ name: 'third', machineToken: token, ...input }));
    assert.throws(() => manager.add({ id: 'bot-c', name: 'third', expectedQQ: '444', port: 3202, machineToken: token, url: 'http://evil.invalid' }));
  });
  await test('unknown and mismatched identities cannot be verified, enabled or proxied', async () => {
    await assert.rejects(manager.proxy('bot-a', { path: '/api/status' }), reject(409));
    a.state.qq = null; await assert.rejects(manager.verify('bot-a'), reject(502));
    a.state.qq = '999'; await assert.rejects(manager.update('bot-a', { enabled: true }), reject(502));
    a.state.qq = '222'; a.state.id = 'bot-b'; await assert.rejects(manager.verify('bot-a'), reject(502));
    a.state.id = 'bot-a';
  });
  await test('enable requires peers sync and all enabled workers acknowledge the full bot QQ set', async () => {
    a.state.denyPeers = true; await assert.rejects(manager.update('bot-a', { enabled: true }), reject(502));
    assert.equal(manager.list().find(row => row.id === 'bot-a').enabled, false);
    a.state.denyPeers = false; await manager.verify('bot-a'); await manager.update('bot-a', { enabled: true });
    await manager.update('bot-b', { enabled: true });
    assert.deepEqual(a.state.peers.sort(), ['111', '222', '333']); assert.deepEqual(b.state.peers.sort(), ['111', '222', '333']);
    a.state.denyPeers = true; await assert.rejects(manager.verify('bot-b'), reject(502)); a.state.denyPeers = false;
  });
  await test('two workers route the same conversation key to different fixed authenticated endpoints', async () => {
    const first = await manager.proxy('bot-a', { path: '/api/conversation-roles?key=group%3A456' });
    const second = await manager.proxy('bot-b', { path: '/api/conversation-roles?key=group%3A456' });
    assert.equal(first.data.botId, 'bot-a'); assert.equal(second.data.botId, 'bot-b');
    assert.ok(a.state.requests.every(req => req.token === tokenFor('bot-a') && !req.cookie && !req.agent));
    assert.ok(b.state.requests.every(req => req.token === tokenFor('bot-b') && !req.cookie && !req.agent));
  });
  await test('internal tenant funding authenticates only enabled verified matching worker credentials', async () => {
    assert.equal(manager.authenticateWorker('bot-a', token), true);
    assert.equal(manager.authenticateWorker('bot-b', token), false);
    assert.throws(() => manager.add({ id: 'bot-c', name: 'third', expectedQQ: '444', port: 3202, machineToken: token }));
    await assert.rejects(manager.update('bot-b', { machineToken: token }), reject(409));
    assert.equal(manager.authenticateWorker('bot-a', token + 'wrong'), false);
    assert.equal(manager.authenticateWorker('primary', token), false);
    assert.equal(manager.authenticateWorker('unknown', token), false);
    await manager.update('bot-a', { enabled: false });
    assert.equal(manager.authenticateWorker('bot-a', token), false);
    await manager.update('bot-a', { enabled: true });
  });
  await test('conversation budgets and legacy group alias pass through only reviewed API roots', async () => {
    for (const path of ['/api/conversation-budgets', '/api/group-budgets']) {
      assert.equal((await manager.proxy('bot-a', { path })).status, 200);
      assert.equal((await manager.proxy('bot-a', { method: 'POST', path, body: { key: 'private:456', dailyLimit: 1 } })).status, 200);
    }
  });
  await test('proxy rejects SSRF, redirects, forged headers and nested manager/auth APIs', async () => {
    for (const path of ['http://169.254.169.254', '//evil/api/status', '/api/../auth', '/api/%2e%2e/auth', '/api/auth/login', '/api/bots', '/api/instance', '/api/status#evil', '/api/console/token', '/api/security/console-token', '/api/socialV2/prompt', '/api/new-unreviewed-endpoint']) await assert.rejects(manager.proxy('bot-a', { path }));
    await assert.rejects(manager.proxy('bot-a', { path: '/api/status', headers: { cookie: 'forged', 'x-agent-token': 'x' } }), reject(400));
    a.state.redirect = true; await assert.rejects(manager.proxy('bot-a', { path: '/api/status' }), reject(502)); a.state.redirect = false;
    assert.equal((await manager.proxy('bot-a', { method: 'POST', path: '/api/internal/member', body: { action: 'overview', principal: { role: 'user' } } })).status, 200);
  });
  await test('worker response credentials and token-bearing text never reach browser results', async () => {
    a.state.extra = { machineToken: token, nested: { accessToken: 'private', agentToken: 'private', tokens: 42 }, message: 'worker said ' + token + ' 【会话令牌】0123456789abcdef0123456789abcdef' };
    const result = await manager.proxy('bot-a', { path: '/api/status' });
    assert.equal('machineToken' in result.data, false); assert.deepEqual(result.data.nested, { tokens: 42 });
    assert.ok(!JSON.stringify(result.data).includes(token)); assert.ok(!result.data.message.includes('0123456789abcdef'));
    delete a.state.extra;
  });
  await test('identity is rechecked for each request and a broken worker does not disturb primary or its peer', async () => {
    a.state.online = false; await assert.rejects(manager.proxy('bot-a', { path: '/api/status' }), reject(502));
    assert.equal((await manager.proxy('bot-b', { path: '/api/status' })).data.botId, 'bot-b'); assert.equal(manager.list()[0].id, 'primary');
    a.state.online = true;
  });
  await test('disabled and deleted records remain in the known bot QQ filter and cannot be proxied', async () => {
    await manager.update('bot-b', { enabled: false }); manager.remove('bot-b');
    assert.ok(manager.knownBotQQs().includes('333')); assert.equal(manager.list().some(row => row.id === 'bot-b'), false);
    await assert.rejects(manager.proxy('bot-b', { path: '/api/status' }), reject(404));
  });
  await test('corrupt and future registry never falls back to empty or overwrites original data', async () => {
    const valid = raw;
    for (const bad of ['{broken', '{"version":99,"bots":{}}', '{"version":1,"bots":{},"unknown":true}']) {
      raw = bad; assert.throws(() => manager.list(), reject(503)); assert.throws(() => manager.add({ id: 'bot-z', name: 'z', expectedQQ: '444', port: 3202, machineToken: token }), reject(503)); assert.equal(raw, bad);
    }
    raw = valid;
  });
  console.log(JSON.stringify({ passed, liveQqMessages: 0, liveModelRequests: 0 }));
} finally { await a.close(); await b.close(); }
