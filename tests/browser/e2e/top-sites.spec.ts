import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Request } from '../../../src/protocol';

test('lists top websites of the latest backup and of all backups', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext({ viewport: { width: 1200, height: 900 } });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html#statistics`);
  await enableAutomaticBackups(page);
  await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'automatic-settings', update: { kind: 'enabled', value: false } }));
  // the second backup replaces the first page of the site with another one
  const tab = await context.newPage();
  for (const path of ['first', 'second']) {
    await tab.goto(`http://127.0.0.1:9/${path}`).catch(() => undefined);
    await page.bringToFront();
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'backup' }));
  }
  await page.reload();
  const sites = page.locator('.top-sites');
  const site = sites.locator('.top-sites-row', { hasText: '127.0.0.1' });
  await expect(sites.getByRole('button', { name: 'Open now' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sites).toContainText(/tabs? on \d+ websites?/);
  await expect(site.locator('.top-sites-count')).toHaveText(/^1 · \d+%$/);
  await sites.getByRole('button', { name: 'All backups' }).click();
  await expect(sites).toContainText(/pages? on \d+ websites?/);
  await expect(site.locator('.top-sites-count')).toHaveText(/^2 · \d+%$/);
  await expect(sites.locator('.top-sites-other')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('top-sites.png') });
  await page.reload();
  await expect(sites.getByRole('button', { name: 'All backups' })).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 400, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await sites.screenshot({ path: testInfo.outputPath('top-sites-narrow.png') });
});

test('lists more websites in steps and returns to the initial list', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext({ viewport: { width: 1200, height: 900 } });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  // answer website requests with 25 websites so the list can grow twice
  await page.addInitScript(() =>
  {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    const sites = Array.from({ length: 25 }, (_, index) => ({ site: `site${index + 1}.test`, url: `https://site${index + 1}.test/`, count: 30 - index }));
    Object.defineProperty(chrome.runtime, 'sendMessage', { configurable: true, value: async (message: Request) =>
    {
      if (message.kind !== 'top-sites') return original(message);
      return { ok: true, data: { kind: 'top-sites', sites: sites.slice(0, Math.min(message.limit, (globalThis as { topSitesCap?: number }).topSitesCap ?? message.limit)), siteCount: sites.length, total: sites.reduce((total, item) => total + item.count, 0) } };
    } });
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html#statistics`);
  await enableAutomaticBackups(page);
  const sites = page.locator('.top-sites');
  const rows = sites.locator('.top-sites-row');
  const other = sites.locator('.top-sites-other');
  const more = other.locator('.top-sites-more');
  const fewer = other.getByRole('button', { name: 'Show fewer' });
  await expect(rows).toHaveCount(10);
  await expect(more).toHaveText('15 other websites');
  await expect(fewer).toHaveCount(0);
  const panelBox = await sites.boundingBox();
  const footerBox = await other.boundingBox();
  if (!panelBox || !footerBox) throw new Error('Missing top websites panel or footer');
  expect(footerBox.x).toBeCloseTo(panelBox.x + 1, 1);
  expect(footerBox.width).toBeCloseTo(panelBox.width - 2, 1);
  await expect(other).toHaveCSS('border-top-width', '1px');
  await more.click();
  await expect(rows).toHaveCount(20);
  await expect(more).toHaveText('5 other websites');
  await expect(more).toBeFocused();
  // numbering continues across the added websites
  await expect(rows.nth(10).locator('.top-sites-rank')).toHaveText('11');
  // the footer lists the remaining websites beside the control that returns to the initial list
  await expect(fewer).toBeVisible();
  await expect.poll(async () => (await more.boundingBox())?.y === (await fewer.boundingBox())?.y).toBe(true);
  await rows.nth(2).hover();
  await sites.screenshot({ path: testInfo.outputPath('top-sites-expanded.png') });
  await page.setViewportSize({ width: 400, height: 900 });
  await expect(more).toBeVisible();
  await expect(fewer).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await sites.screenshot({ path: testInfo.outputPath('top-sites-footer-narrow.png') });
  await page.setViewportSize({ width: 1200, height: 900 });
  await more.press('Enter');
  await expect(rows).toHaveCount(25);
  await expect(more).toHaveCount(0);
  await expect(fewer).toBeFocused();
  await fewer.click();
  await expect(rows).toHaveCount(10);
  await expect(fewer).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await expect(rows).toHaveCount(20);
  // switching what is counted starts again with the initial list
  await sites.getByRole('button', { name: 'All backups' }).click();
  await expect(rows).toHaveCount(10);
  // replies with only the initial websites keep the list collapsed
  await page.evaluate(() => { (globalThis as { topSitesCap?: number }).topSitesCap = 10; });
  await more.click();
  await expect(more).toHaveText('15 other websites');
  await expect(fewer).toHaveCount(0);
});
