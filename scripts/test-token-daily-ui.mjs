import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { startConsoleFixture } from './console-ui-fixture.mjs';
import { tokenDailyRecords } from './token-daily-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve('.local/token-daily-ui'); fs.mkdirSync(output, { recursive: true });
const fixture = await startConsoleFixture();
const records = tokenDailyRecords();
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const maliciousKey = 'internal:<img src=x onerror="window.__usageXss=true">';
records.push({ ...records[4], sid: 'fixture-escape', key: maliciousKey });
const h = await bridgeHarness({ files: { 'state/token-usage.jsonl': records.map(r => JSON.stringify(r)).join('\n') } });
const server = h.startConsoleServer();
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const backend = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [], errors = [], external = [];
let failure = null;
async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); console.log('PASS', name); } catch (error) { results.push({ name, ok: false, error: error.stack }); console.error('FAIL', name, error.stack); } }
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const bootstrap = await fetch(backend + '/api/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' }, body: JSON.stringify({ username: 'admin', password: 'Fixture_10' }) });
  assert.equal(bootstrap.status, 200);
  const adminCookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.url) { external.push(url.origin); return route.abort(); }
    if (url.pathname.startsWith('/api/tokens/')) {
      if (failure && url.pathname.endsWith(failure)) return route.fulfill({ status: 500, json: { ok: false, error: 'synthetic usage failure' } });
      const response = await route.fetch({ url: backend + url.pathname + url.search, headers: { ...route.request().headers(), origin: backend, cookie: adminCookie } });
      return route.fulfill({ response });
    }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await test('loads real bridge report, all conversation types, costs and missing-history warning', async () => {
    await page.goto(fixture.url + '/#usage');
    await page.waitForFunction(() => document.getElementById('usageDailyStatus').textContent.includes('已同步'));
    assert.equal(await page.locator('#usageDailyRows table tr').count(), 7);
    assert.match(await page.locator('#usageDailyRanking').innerText(), /群聊 123456789/);
    assert.match(await page.locator('#usageDailyRanking').innerText(), /私聊 100001/);
    assert.match(await page.locator('#usageDailyRanking').innerText(), /管理员 100002/);
    assert.match(await page.locator('#usageDailyCoverage').innerText(), /1\.3 万 token 缺少可定位日期/);
    assert.match(await page.locator('#usageDailyCoverage').innerText(), /1 次调用缺少模型报价/);
    assert.equal(await page.locator('#usageDailyCost').innerText(), '¥6.24');
  });
  await test('daily range filters by Beijing calendar date, with separate token-cost categories', async () => {
    await page.locator('#usageDailyFrom').fill(today); await page.locator('#usageDailyTo').fill(today);
    await page.locator('#usageDailyLoad').click();
    await page.waitForFunction(day => document.getElementById('usageDailyStatus').textContent.startsWith(day + ' 至 ' + day) && document.getElementById('usageDailyStatus').textContent.includes('已同步'), today);
    assert.equal(await page.locator('#usageDailyRows table tr').count(), 6);
    assert.equal(await page.locator('#usageDailyInputCost').innerText(), '¥2.10');
    assert.equal(await page.locator('#usageDailyCacheCost').innerText(), '¥0.01');
    assert.equal(await page.locator('#usageDailyOutputCost').innerText(), '¥2.13');
  });
  await test('selecting one group isolates report from private and owner calls', async () => {
    await page.locator('#usageDailyKey').selectOption('group:123456789');
    await page.waitForFunction(() => document.getElementById('usageDailyStatus').textContent.includes('已同步') && document.querySelectorAll('#usageDailyRows table tr').length === 2);
    assert.equal(await page.locator('#usageDailyCost').innerText(), '¥4.01');
    assert.doesNotMatch(await page.locator('#usageDailyRanking').innerText(), /私聊|管理员/);
    assert.ok((await page.locator('#usageDailyKey option').count()) >= 7);
  });
  await test('private and owner selection uses the same generic report', async () => {
    for (const [key, value] of [['private:100001', '¥0.14'], ['owner:100002', '¥0.08']]) {
      await page.locator('#usageDailyKey').selectOption(key);
      await page.waitForFunction(value => document.getElementById('usageDailyStatus').textContent.includes('已同步') && document.getElementById('usageDailyCost').textContent === value, value);
    }
  });
  await test('unrecorded dates show explicit empty report and zero dates, not a missing chart', async () => {
    await page.locator('#usageDailyFrom').fill('2020-01-01'); await page.locator('#usageDailyTo').fill('2020-01-02');
    await page.locator('#usageDailyLoad').click();
    await page.waitForFunction(() => document.getElementById('usageDailyCost').textContent === '¥0');
    assert.match(await page.locator('#usageDailyRows').innerText(), /没有保留的调用明细/);
    assert.equal(await page.locator('#usageDailyDays table tr').count(), 3);
  });
  await test('invalid range displays API validation error without painting success', async () => {
    await page.locator('#usageDailyFrom').fill('2026-01-01'); await page.locator('#usageDailyTo').fill('2026-06-01');
    await page.locator('#usageDailyLoad').click();
    await page.waitForFunction(() => document.getElementById('usageDailyStatus').classList.contains('err'));
    assert.match(await page.locator('#usageDailyStatus').innerText(), /90 天/);
  });
  await test('daily and summary API errors remain visible, recovery reloads data', async () => {
    failure = 'daily'; await page.locator('#usageDailyLoad').click();
    await page.waitForFunction(() => document.getElementById('usageDailyStatus').textContent.includes('synthetic usage failure'));
    failure = 'summary'; await page.locator('#usageRefresh').click();
    await page.waitForFunction(() => document.getElementById('usageMsg').textContent.includes('synthetic usage failure'));
    failure = null;
    await page.locator('#usageDailyFrom').fill(today); await page.locator('#usageDailyTo').fill(today);
    await page.locator('#usageDailyKey').selectOption('');
    await page.waitForFunction(() => document.getElementById('usageDailyStatus').textContent.includes('已同步'));
    await page.locator('#usageRefresh').click();
    await page.waitForFunction(() => document.getElementById('usageMsg').textContent.includes('已同步'));
  });
  await test('conversation labels are escaped and cannot inject HTML', async () => {
    assert.equal(await page.locator('#usageDailyRows img').count(), 0);
    assert.equal(await page.locator('#usageDailyRanking img').count(), 0);
    assert.equal(await page.evaluate(() => window.__usageXss), undefined);
    assert.match(await page.locator('#usageDailyRows').innerText(), /<img src=x/);
    await page.locator('#section-usage').screenshot({ path: path.join(output, 'desktop.png') });
  });
  await test('mobile and dark layouts expose date and conversation controls without viewport overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#usageDailyFrom').isVisible(), true);
    assert.equal(await page.locator('#usageDailyKey').isVisible(), true);
    let sizes = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(sizes.width <= sizes.viewport + 1, JSON.stringify(sizes));
    await page.locator('#section-usage').screenshot({ path: path.join(output, 'mobile.png') });
    await page.locator('#themeToggle').click();
    await page.locator('#section-usage').screenshot({ path: path.join(output, 'mobile-dark.png') });
  });
  await test('no JS errors, external requests, QQ messages or paid model calls', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(h.calls.sent.length, 0); assert.equal(h.calls.prompts.length, 0);
  });
} finally {
  await browser.close(); await fixture.close(); await new Promise(resolve => server.close(resolve)); await h.close();
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, errors, external }, null, 2));
}
if (results.some(r => !r.ok)) process.exitCode = 1;
