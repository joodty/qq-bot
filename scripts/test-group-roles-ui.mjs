import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifactDir = path.resolve('.local/group-roles-ui'); fs.mkdirSync(artifactDir, { recursive: true });
const fixture = await startConsoleFixture();
const h = await bridgeHarness({ config: { allow: { groups: ['456', '789', '321', '654'], private: ['123', '456'] }, socialV2: { sticker: { enabled: false }, proactive: { enabled: false } } }, files: {
  'state/current-role.json': { role: '小鲸鱼', mode: 'active' },
  'roles/小鲸鱼.md': '# 小鲸鱼\nGLOBAL_FIXTURE', 'roles/温柔助手.md': '# 温柔助手\nGENTLE_FIXTURE', 'roles/技术伙伴.md': '# 技术伙伴\nTECH_FIXTURE',
} });
h.setMode('reserved2'); const server = h.startConsoleServer();
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const backend = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [], errors = [], blocked = [];
async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); console.log('PASS', name); } catch (e) { results.push({ name, ok: false, error: e.stack }); console.error('FAIL', name, e.stack); } }
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const bootstrap = await fetch(backend + '/api/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' }, body: JSON.stringify({ username: 'admin', password: 'Fixture_10' }) });
  assert.equal(bootstrap.status, 200);
  const adminCookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.url) { blocked.push(url.origin); return route.abort(); }
    if (['/api/conversation-roles', '/api/group-roles', '/api/role', '/api/roles', '/api/roles/content', '/api/roles/rename', '/api/roles/delete', '/api/status'].includes(url.pathname)) {
      const response = await route.fetch({ url: backend + url.pathname + url.search, headers: { ...route.request().headers(), origin: backend, cookie: adminCookie } });
      return route.fulfill({ response });
    }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const row = id => page.locator('[data-group-id="' + id + '"]');
  const save = async id => {
    const done = page.waitForResponse(r => new URL(r.url()).pathname === '/api/conversation-roles' && r.request().method() === 'POST');
    await row(id).getByRole('button', { name: '保存群 ' + id + ' 的人设' }).click();
    assert.equal((await done).status(), 200);
    await page.waitForFunction(() => document.getElementById('groupRolesMsg').textContent.includes('已保存'));
  };
  await page.goto(fixture.url + '/#persona');
  await page.waitForSelector('[data-group-id="456"]');
  await test('four real backend groups default to the global persona', async () => {
    assert.equal(await page.locator('[data-group-id]').count(), 4);
    assert.equal(await page.locator('[data-conversation-key="private:123"]').count(), 1);
    for (const id of ['456', '789', '321', '654']) assert.equal(await row(id).locator('select').inputValue(), '');
    assert.match(await row('789').innerText(), /沿用全局.*小鲸鱼/);
  });
  await test('saving a group persists through the actual bridge API and reload, leaving other groups global', async () => {
    await row('456').locator('select').selectOption('温柔助手'); await save('456');
    const stored = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/conversation-roles.json'), 'utf8'));
    assert.deepEqual(stored.roles, { 'group:456': '温柔助手' });
    assert.equal(await row('789').locator('select').inputValue(), '');
    await page.reload(); await page.waitForSelector('[data-group-id="456"]');
    assert.equal(await row('456').locator('select').inputValue(), '温柔助手');
  });
  await test('changing global selection refreshes inherited labels and keeps the group override', async () => {
    await page.locator('#roleInput').locator('xpath=ancestor::details').evaluate(e => { e.open = true; });
    await page.locator('#roleInput').fill('技术伙伴'); await page.locator('#roleSet').click();
    await page.waitForFunction(() => document.querySelector('[data-group-id="789"] .group-role-current').textContent.includes('技术伙伴'));
    assert.equal(await row('456').locator('select').inputValue(), '温柔助手');
    assert.match(await row('456').locator('.group-role-current').innerText(), /温柔助手/);
  });
  await test('returning to global removes only this group override', async () => {
    await row('456').locator('select').selectOption(''); await save('456');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/conversation-roles.json'), 'utf8')).roles, {});
    assert.match(await row('456').locator('.group-role-current').innerText(), /沿用全局.*技术伙伴/);
  });
  await test('ordinary and administrator private controls save independently of a group with the same number', async () => {
    for (const [key, role] of [['private:456', '温柔助手'], ['private:123', '技术伙伴']]) {
      const target = page.locator('[data-conversation-key="' + key + '"]');
      await target.locator('select').selectOption(role);
      const saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/conversation-roles' && r.request().method() === 'POST');
      await target.getByRole('button').click(); assert.equal((await saved).status(), 200);
      await page.waitForFunction(key => document.getElementById('groupRolesMsg').textContent.includes(key.split(':')[1] + ' 已保存'), key);
    }
    await page.reload(); await page.waitForSelector('[data-group-id="456"]');
    assert.equal(await row('456').locator('select').inputValue(), '');
    assert.equal(await page.locator('[data-conversation-key="private:456"] select').inputValue(), '温柔助手');
    assert.equal(await page.locator('[data-conversation-key="private:123"] select').inputValue(), '技术伙伴');
    assert.match(await page.locator('[data-conversation-key="private:123"]').innerText(), /管理员私聊/);
  });
  await test('desktop and touch viewport layouts have usable controls without horizontal overflow', async () => {
    await page.locator('#groupRolePanel').screenshot({ path: path.join(artifactDir, 'desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await row('456').locator('select').isVisible());
    const sizes = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(sizes.body <= sizes.viewport + 1, JSON.stringify(sizes));
    await row('321').locator('select').selectOption('温柔助手'); await save('321');
    await page.locator('#groupRolePanel').screenshot({ path: path.join(artifactDir, 'mobile.png') });
    await page.locator('#themeToggle').click();
    await page.locator('#groupRolePanel').screenshot({ path: path.join(artifactDir, 'mobile-dark.png') });
  });
  await test('save errors are visible and do not falsely change the active persona', async () => {
    fs.writeFileSync(path.join(h.temp, 'state/conversation-roles.json'), '{"version":99,"roles":{}}');
    await row('321').locator('select').selectOption('技术伙伴');
    await row('321').getByRole('button').click();
    await page.waitForFunction(() => document.getElementById('groupRolesMsg').textContent.includes('保存失败'));
    assert.match(await row('321').locator('.group-role-current').innerText(), /温柔助手/);
    assert.equal(await row('321').getByRole('button').isEnabled(), true);
    await page.locator('#groupRolesRefresh').click();
    await page.waitForFunction(() => document.getElementById('groupRolesMsg').textContent.includes('无法加载'));
    assert.equal(await page.locator('.group-role-row').count(), 0);
  });
  await test('no JavaScript errors, external requests, live QQ traffic or model calls', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.equal(h.calls.sent.length, 0); assert.equal(h.calls.prompts.length, 0);
  });
} finally {
  await browser.close(); await fixture.close(); await new Promise(resolve => server.close(resolve)); await h.close();
  fs.writeFileSync(path.join(artifactDir, 'results.json'), JSON.stringify({ results, errors, blocked }, null, 2));
}
if (results.some(r => !r.ok)) process.exitCode = 1;
