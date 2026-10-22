import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifactDir = path.resolve('.local/conversation-sessions-ui'); fs.mkdirSync(artifactDir, { recursive: true });
const fixture = await startConsoleFixture();
const h = await bridgeHarness({ config: { allow: { groups: ['456', '789'], private: ['123', '456'] }, socialV2: { sticker: { enabled: false }, proactive: { enabled: false } } }, files: {
  'state/current-role.json': { role: '小鲸鱼', mode: 'active' },
  'roles/小鲸鱼.md': '# 小鲸鱼\nGLOBAL_FIXTURE', 'roles/温柔助手.md': '# 温柔助手\nGENTLE_FIXTURE',
} });
h.setMode('reserved2');
const server = h.startConsoleServer();
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const backend = 'http://127.0.0.1:' + server.address().port;
const api = async (route, body) => {
  const response = await fetch(backend + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
};
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [], errors = [], blocked = [];
let fault = null;
let oldRecord, firstSession, secondSession;
async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); console.log('PASS', name); } catch (error) { results.push({ name, ok: false, error: error.stack }); console.error('FAIL', name, error.stack); } }
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const bootstrap = await fetch(backend + '/api/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' }, body: JSON.stringify({ username: 'admin', password: 'Fixture_10' }) });
  assert.equal(bootstrap.status, 200);
  const adminCookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.url) { blocked.push(url.origin); return route.abort(); }
    if (fault && url.pathname === fault.path && route.request().method() === fault.method) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'fixture-only failure' }) });
    if (url.pathname.startsWith('/api/conversation-sessions') || ['/api/conversation-roles', '/api/group-roles', '/api/role', '/api/roles', '/api/roles/content', '/api/roles/rename', '/api/roles/delete', '/api/status'].includes(url.pathname)) {
      const response = await route.fetch({ url: backend + url.pathname + url.search, headers: { ...route.request().headers(), origin: backend, cookie: adminCookie } });
      return route.fulfill({ response });
    }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const row = id => page.locator('[data-session-record-id="' + id + '"]');
  const refresh = async () => {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/conversation-sessions' && r.request().method() === 'GET');
    await page.locator('#conversationSessionsRefresh').click(); assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.getElementById('conversationSessionsRefresh').disabled);
  };
  const action = async (locator, endpoint) => {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === 'POST');
    await locator.click(); assert.equal((await response).status(), 200);
    await page.waitForFunction(() => document.getElementById('conversationSessionsMsg').classList.contains('ok'));
  };
  const newConversation = async key => {
    await page.locator('#conversationSessionFilter').selectOption(key);
    await action(page.locator('#conversationSessionNew'), '/api/conversation-sessions/new');
  };
  await page.goto(fixture.url + '/#persona');
  await page.waitForSelector('[data-group-id="456"]');
  await page.waitForFunction(() => !document.getElementById('conversationSessionsRefresh').disabled);
  await test('empty archive is explained and viewing does not create model sessions', async () => {
    const result = await api('/api/conversation-sessions'); assert.equal(result.status, 200);
    assert.equal(result.data.sessions.length, 0);
    assert.match(await page.locator('#conversationSessionsList').innerText(), /还没有会话存档/);
    assert.equal(await page.locator('#conversationSessionNew').isDisabled(), true);
    assert.equal(h.calls.created.length, 0); assert.equal(h.calls.prompts.length, 0);
  });
  await test('new archive waits for the next normal wake and does not create a DSH session or send messages', async () => {
    await newConversation('group:456');
    const data = (await api('/api/conversation-sessions')).data;
    const active = data.sessions.find(record => record.id === data.active['group:456']);
    assert.ok(active); assert.ok(!active.sessionId); oldRecord = active.id;
    assert.match(await row(oldRecord).innerText(), /待下次唤醒创建/);
    assert.equal(h.calls.created.length, 0); assert.equal(h.calls.prompts.length, 0); assert.equal(h.calls.sent.length, 0);
  });
  await test('a persona switch keeps the old model conversation paused and a separate persona conversation', async () => {
    firstSession = await h.ensureSession('group:456');
    const st = h.getSocialV2State('group:456'); st.activeTopics.push({ text: 'kept topic' });
    h.appendSocialV2Message('group:456', 'fixture', 'kept message', 'kept message', false, false, '77');
    const before = JSON.stringify([st.recentMessages, st.unread, st.activeTopics]);
    const target = page.locator('[data-conversation-key="group:456"]');
    await target.locator('select').selectOption('温柔助手');
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/conversation-roles' && r.request().method() === 'POST');
    await target.getByRole('button').click(); assert.equal((await response).status(), 200);
    await page.waitForFunction(() => document.getElementById('groupRolesMsg').textContent.includes('已保存'));
    secondSession = await h.ensureSession('group:456'); assert.notEqual(firstSession, secondSession);
    await refresh();
    assert.equal(await row(oldRecord).getAttribute('data-status'), 'paused');
    assert.match(await row(oldRecord).innerText(), new RegExp(firstSession));
    assert.equal(JSON.stringify([st.recentMessages, st.unread, st.activeTopics]), before);
    assert.ok(h.calls.cancelled.includes(firstSession)); assert.equal(h.calls.archived.includes(firstSession), false);
  });
  await test('continue restores the same DSH ID and selected persona across a page reload', async () => {
    const creates = h.calls.created.length;
    await action(row(oldRecord).getByRole('button'), '/api/conversation-sessions/activate');
    assert.equal(h.state.sessions['group:456'], firstSession); assert.equal(h.calls.created.length, creates);
    await page.reload(); await page.waitForSelector('[data-session-record-id="' + oldRecord + '"]');
    assert.equal(await row(oldRecord).getAttribute('data-status'), 'active');
    assert.match(await page.locator('[data-conversation-key="group:456"]').innerText(), /小鲸鱼/);
  });
  await test('new conversation retains previous history for the same stable persona', async () => {
    const before = (await api('/api/conversation-sessions')).data;
    const creates = h.calls.created.length;
    await newConversation('group:456');
    const after = (await api('/api/conversation-sessions')).data;
    const previous = after.sessions.find(record => record.id === oldRecord);
    const fresh = after.sessions.find(record => record.id === after.active['group:456']);
    assert.equal(after.sessions.length, before.sessions.length + 1);
    assert.equal(previous.status, 'paused'); assert.notEqual(fresh.id, oldRecord);
    assert.equal(fresh.personaId, previous.personaId); assert.ok(!fresh.sessionId);
    assert.equal(h.calls.created.length, creates); assert.equal(h.calls.archived.includes(firstSession), false);
  });
  await test('filter separates a private conversation from a group with the same number', async () => {
    const before = (await api('/api/conversation-sessions')).data.active['group:456'];
    await newConversation('private:456');
    assert.equal(await page.locator('[data-session-record-id]').count(), 1);
    assert.match(await page.locator('#conversationSessionsList').innerText(), /私聊/);
    const after = (await api('/api/conversation-sessions')).data;
    assert.equal(after.active['group:456'], before); assert.ok(after.active['private:456']);
    await page.locator('#conversationSessionFilter').selectOption('');
    assert.equal(await page.locator('[data-session-record-id]').count(), after.sessions.length);
  });
  await test('desktop and touch controls remain usable without page overflow', async () => {
    await page.locator('#conversationSessionPanel').screenshot({ path: path.join(artifactDir, 'desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#conversationSessionFilter').selectOption('group:456');
    assert.equal(await page.locator('#conversationSessionNew').isEnabled(), true);
    assert.equal(await row(oldRecord).getByRole('button').isVisible(), true);
    const size = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth }));
    assert.ok(size.body <= size.width + 1, JSON.stringify(size));
    await page.locator('#conversationSessionPanel').screenshot({ path: path.join(artifactDir, 'mobile.png') });
    await page.locator('#themeToggle').click();
    await page.locator('#conversationSessionPanel').screenshot({ path: path.join(artifactDir, 'mobile-dark.png') });
  });
  await test('failed actions and failed reads show errors and never claim success or clear real archives', async () => {
    const before = (await api('/api/conversation-sessions')).data;
    fault = { path: '/api/conversation-sessions/new', method: 'POST' };
    await page.locator('#conversationSessionNew').click();
    await page.waitForFunction(() => document.getElementById('conversationSessionsMsg').textContent.includes('操作失败'));
    assert.equal((await api('/api/conversation-sessions')).data.sessions.length, before.sessions.length);
    fault = { path: '/api/conversation-sessions', method: 'GET' };
    await page.locator('#conversationSessionsRefresh').click();
    await page.waitForFunction(() => document.getElementById('conversationSessionsMsg').textContent.includes('无法加载'));
    assert.equal(await page.locator('[data-session-record-id]').count(), 0);
    assert.equal(await page.locator('#conversationSessionNew').isDisabled(), true);
    fault = null; await refresh();
    assert.equal((await api('/api/conversation-sessions')).data.sessions.length, before.sessions.length);
  });
  await test('UI interactions caused no real model calls, QQ traffic, external requests or JavaScript errors', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
    assert.equal(h.calls.prompts.length, 0); assert.equal(h.calls.sent.length, 0);
  });
} finally {
  await browser.close(); await fixture.close(); await new Promise(resolve => server.close(resolve)); await h.close();
  fs.writeFileSync(path.join(artifactDir, 'results.json'), JSON.stringify({ results, errors, blocked, scope: 'real isolated bridge APIs; fake DSH and QQ' }, null, 2));
}
if (results.some(result => !result.ok)) process.exitCode = 1;
