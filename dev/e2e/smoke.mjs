// Smoke test: home/search/sort, repo view, details + copy, delete flow.
// Fails (exit 1) on any assertion or page JS error.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://app:8080';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };
const names = () => page.locator('.repo-card .name').allTextContents();

await page.goto(BASE + '/');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.repo-card');
check((await names()).includes('tools/busybox'), 'home lists repositories');
await page.screenshot({ path: 'out/home.png' });

await page.fill('#search', 'busybox:1.');
check((await page.locator('.repo-card .chip').allTextContents()).join() === '1.0,1.1', 'repo:tag search');
await page.fill('#search', '');

await page.selectOption('#repo-sort', 'tags-desc');
check((await names())[0] === 'tools/busybox', 'sort by tag count');

await page.goto(BASE + '/#/r/tools%2Fbusybox');
await page.waitForSelector('tbody td.tag');
check(await page.locator('tbody tr').count() >= 4, 'repo view shows tags');
await page.screenshot({ path: 'out/repo.png' });

await page.click('a[data-details="1.0"]');
await page.waitForSelector('.kv');
check(await page.locator('[data-copy-pre]').count() >= 2, 'details has raw JSON copy buttons');
await page.screenshot({ path: 'out/details.png' });
await page.click('[data-close]');

await page.check('input[data-tag="1.0"]');
await page.click('#btn-delete');
await page.waitForSelector('#confirm-delete');
check(await page.locator('.collateral').count() === 2, 'delete plan shows collateral tags');
await page.click('[data-close]');
await page.click('#sel-none');

if (await page.locator('input[data-tag="old"]').count()) {
  await page.check('input[data-tag="old"]');
  await page.click('#btn-delete');
  await page.click('#confirm-delete');
  await page.waitForSelector('.toast.ok');
  await page.waitForSelector('tbody td.tag');
  check(await page.locator('a[data-details="old"]').count() === 0, 'delete removes the tag');
}

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
await browser.close();
process.exit(failed ? 1 : 0);
