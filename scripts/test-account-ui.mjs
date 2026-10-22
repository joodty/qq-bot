import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve('.local/account-ui'); fs.mkdirSync(output, { recursive: true });
const fixture = await startConsoleFixture();
const pages = Object.fromEntries(['console', 'login', 'viewer', 'workspace'].map(name => ['public/' + name + '.html', fs.readFileSync('public/' + name + '.html', 'utf8')]));
const h = await bridgeHarness({ config: { allow: { groups: ['456', '789'], private: ['123'] } }, files: pages });
const server = h.startConsoleServer();
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const adminPassword = 'Admin_1234', userPassword = 'Viewer_123', changedPassword = 'Viewer_456';
const results = [], errors = [], external = [];
async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); console.log('PASS', name); } catch (error) { results.push({ name, ok: false, error: error.stack }); console.error('FAIL', name, error.stack); } }
async function context() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' });
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { external.push(url.origin); return route.abort(); }
    // Authentication and viewer permissions use the actual isolated bridge. Other
    // management panels get offline data, so no DSH/QQ services are contacted.
    if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/') && !url.pathname.startsWith('/api/member/') && !url.pathname.startsWith('/api/bots') && url.pathname !== '/api/viewer/overview') {
      const response = await route.fetch({ url: fixture.url + url.pathname + url.search, headers: { ...route.request().headers(), origin: fixture.url } });
      return route.fulfill({ response });
    }
    return route.continue();
  });
  return ctx;
}
const admin = await context(), normal = await context();
const page = await admin.newPage(), userPage = await normal.newPage();
for (const p of [page, userPage]) { p.setDefaultTimeout(12000); p.on('pageerror', error => errors.push(error.message)); }
async function login(p, username, password) {
  await p.goto(base + '/login'); await p.waitForSelector('#loginSubmit:not([disabled])');
  await p.locator('#username').fill(username); await p.locator('#password').fill(password); await p.locator('#loginSubmit').click();
}
try {
  await test('uninitialized public page offers no token activation or registration form', async () => {
    await page.goto(base + '/?token=fixture-console-token');
    await page.waitForSelector('#setupNotice:visible');
    assert.equal(new URL(page.url()).pathname, '/login'); assert.equal(new URL(page.url()).search, '');
    assert.equal(await page.locator('#bootstrapToken').count(), 0);
    assert.equal(await page.locator('#setupFields').count(), 0);
    assert.equal(await page.locator('#loginForm').isVisible(), false);
    assert.ok((await page.locator('#setupNotice').innerText()).includes('平台尚未初始化'));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, 'activation-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1400, height: 1000 });
  });
  await test('administrator initialized outside the browser signs in with persistent HttpOnly cookie', async () => {
    const initialized = await fetch(base + '/api/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' }, body: JSON.stringify({ username: 'admin', password: adminPassword }) });
    assert.equal(initialized.status, 200);
    await login(page, 'admin', adminPassword);
    await page.locator('#accountIdentity').filter({ hasText: 'admin' }).waitFor();
    const cookie = (await admin.cookies()).find(c => c.name === 'qq_console_session');
    assert.ok(cookie?.httpOnly); assert.equal(cookie.sameSite, 'Strict'); assert.ok(cookie.expires * 1000 > Date.now() + 28 * 86400000);
    assert.equal(await page.evaluate(() => localStorage.getItem('consoleToken')), null);
    assert.equal(await page.locator('#section-token').count(), 0);
  });
  await test('refreshing the clean root preserves administrator login without token prompts', async () => {
    await page.reload(); await page.locator('#accountIdentity').filter({ hasText: 'admin' }).waitFor();
    assert.equal(new URL(page.url()).search, ''); assert.ok(await page.locator('#accountLogout').isVisible());
  });
  await test('administrator creates a scoped ordinary account through the actual account API', async () => {
    await page.goto(base + '/#access');
    await page.locator('#accountCreateForm').locator('xpath=ancestor::details').evaluate(el => { el.open = true; });
    await page.locator('#accountNewUsername').fill('viewer'); await page.locator('#accountNewPassword').fill(userPassword); await page.locator('#accountNewScopes').fill('group:456');
    await page.locator('#accountCreate').click(); await page.waitForSelector('[data-account-username="viewer"]');
    assert.equal(await page.locator('#accountNewPassword').inputValue(), '');
    const users = await (await admin.request.get(base + '/api/auth/users')).json();
    assert.deepEqual(users.users.find(u => u.username === 'viewer').conversationKeys, ['group:456']);
    await page.locator('#section-accounts').screenshot({ path: path.join(output, 'accounts-desktop.png') });
  });
  await test('wrong credentials stay on the login screen with a clear error', async () => {
    await login(userPage, 'viewer', 'Wrong_fixture_password');
    await userPage.waitForSelector('#loginMessage.error');
    assert.equal(new URL(userPage.url()).pathname, '/login');
  });
  await test('ordinary login lands on its own workspace and scoped member editor remains available', async () => {
    await userPage.locator('#password').fill(userPassword); await userPage.locator('#loginSubmit').click();
    await userPage.locator('#workspaceIdentity').filter({ hasText: 'viewer' }).waitFor();
    assert.equal(new URL(userPage.url()).pathname, '/workspace');
    await userPage.reload(); await userPage.locator('#workspaceIdentity').filter({ hasText: 'viewer' }).waitFor();
    await userPage.getByRole('link', { name: '已授权会话人设' }).click();
    await userPage.locator('#viewerIdentity').filter({ hasText: 'viewer' }).waitFor();
    assert.equal(await userPage.locator('#mainNav').count(), 0);
  });
  await test('ordinary account cannot request administrator or cross-conversation APIs', async () => {
    for (const route of ['/api/auth/users', '/api/status', '/api/conversation-roles', '/api/conversation-sessions', '/api/tokens/daily?key=group:789']) assert.equal((await normal.request.get(base + route)).status(), 403, route);
    assert.equal((await normal.request.post(base + '/api/conversation-roles', { data: { key: 'group:456', role: null } })).status(), 403);
    const response = await normal.request.get(base + '/api/viewer/overview');
    assert.equal(response.status(), 200);
    const data = await response.json(); assert.deepEqual(data.conversations.map(row => row.key), ['group:456']);
    const encoded = JSON.stringify(data); assert.ok(!encoded.includes('group:789')); assert.ok(!encoded.includes('console-token')); assert.ok(!encoded.includes('sessionId'));
  });
  await test('scoped member mobile page stays within viewport and changing own password requires a new login', async () => {
    await userPage.locator('#viewerMessage').filter({ hasText: '已更新' }).waitFor();
    await userPage.setViewportSize({ width: 390, height: 844 });
    assert.ok(await userPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await userPage.screenshot({ path: path.join(output, 'viewer-mobile.png'), fullPage: true });
    await userPage.locator('#viewerPasswordForm').locator('xpath=ancestor::details').evaluate(el => { el.open = true; });
    await userPage.locator('#viewerCurrentPassword').fill(userPassword); await userPage.locator('#viewerNewPassword').fill(changedPassword); await userPage.locator('#viewerConfirmPassword').fill(changedPassword); await userPage.locator('#viewerPasswordSave').click();
    await userPage.waitForSelector('#loginForm'); assert.equal((await normal.request.get(base + '/api/viewer/overview')).status(), 401);
    await login(userPage, 'viewer', changedPassword); await userPage.waitForSelector('#workspaceIdentity');
    await userPage.goto(base + '/viewer'); await userPage.waitForSelector('#viewerIdentity');
  });
  await test('administrator can disable an ordinary account and revoke its active session', async () => {
    const row = page.locator('[data-account-username="viewer"]');
    await row.locator('input[type="checkbox"]').check(); await row.getByRole('button', { name: '保存账号 viewer' }).click();
    await row.getByRole('status').filter({ hasText: '已保存' }).waitFor();
    assert.equal((await normal.request.get(base + '/api/viewer/overview')).status(), 401);
    await userPage.reload(); await userPage.waitForSelector('#loginForm');
  });
  await test('admin controls fit mobile and explicit logout revokes clean-root access', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.locator('#section-accounts').screenshot({ path: path.join(output, 'accounts-mobile.png') });
    await page.locator('#accountLogout').click(); await page.waitForSelector('#loginForm');
    assert.equal((await admin.request.get(base + '/api/auth/users')).status(), 401);
    await page.goto(base + '/'); await page.waitForSelector('#loginForm');
  });
  await test('no browser errors, external requests, live QQ messages or paid model calls', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(h.calls.sent.length, 0); assert.equal(h.calls.prompts.length, 0);
  });
} finally {
  await browser.close(); await fixture.close(); await new Promise(resolve => server.close(resolve)); await h.close();
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, errors, external }, null, 2));
}
if (results.some(r => !r.ok)) process.exitCode = 1;
