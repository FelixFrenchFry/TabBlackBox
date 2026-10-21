import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Reply } from '../../../src/protocol';

test('searches tabs across backups and filters both panels by the selected page', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext({ viewport: { width: 1200, height: 900 } });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  const closed = await context.newPage();
  await closed.goto('http://127.0.0.1:9/closed-research-page').catch(() => undefined);
  await page.bringToFront();
  await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'backup' }));
  await closed.close();
  await page.reload();
  const search = page.getByRole('searchbox', { name: 'Search tabs in all backups' });
  await search.fill('closed-research');
  const result = page.locator('.tab-search-result');
  await expect(result).toHaveCount(1);
  await expect(result.locator('.tab-url')).toHaveText('127.0.0.1:9/closed-research-page');
  await expect(result.locator('.tab-url .search-match')).toHaveText('closed-research');
  await expect(result.locator('.tab-search-seen > div').first()).toHaveText(/^Last seen .+ in manual #1$/);
  await expect(result.locator('.tab-search-seen > div').last()).toHaveText('0 automatic · 1 manual');
  await expect(result.getByRole('link', { name: 'Open in new tab' })).toHaveAttribute('href', 'http://127.0.0.1:9/closed-research-page');
  await expect(result.getByRole('button', { name: 'Open' })).toHaveCount(0);
  await search.fill('no such page anywhere');
  await expect(page.locator('.tab-search-results')).toContainText('No tabs match your search');
  await search.fill('closed-research');
  await result.getByRole('button', { name: 'Show backups' }).click();
  await expect(page.locator('.tab-filter')).toContainText('Showing backups that contain');
  await expect(page.locator('.saved-backups .backup-row')).toHaveCount(1);
  await expect(page.locator('.automatic-backups')).toContainText('No backups contain this tab');
  await page.screenshot({ path: testInfo.outputPath('tab-search.png'), fullPage: true });
  await page.setViewportSize({ width: 400, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.tab-filter').getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.tab-filter')).toBeHidden();
  await expect(page.locator('.automatic-backups')).not.toContainText('No backups contain this tab');
  await page.evaluate(() => Promise.all(Array.from({ length: 12 }, (_, index) => chrome.tabs.create({ url: `http://127.0.0.1:9/paged-result/${index}`, active: false }))));
  // retry manual backups until the settled tabs are stored
  await expect.poll(() => page.evaluate(async () => {
    await chrome.runtime.sendMessage({ kind: 'backup' });
    const reply: Reply = await chrome.runtime.sendMessage({ kind: 'tab-search', query: 'paged-result', limit: 20 });
    return reply.ok && reply.data.kind === 'tab-search' ? reply.data.items.length : 0;
  })).toBe(12);
  await search.fill('paged-result');
  const footer = page.locator('.tab-search-footer');
  await expect(result).toHaveCount(5);
  await expect(footer).toContainText('Showing the 5 most recently seen tabs. Add more words to narrow your search.');
  await page.locator('.tab-search').screenshot({ path: testInfo.outputPath('tab-search-more.png') });
  await footer.getByRole('button', { name: 'Show 10 more' }).click();
  await expect(result).toHaveCount(12);
  await expect(footer).toHaveCount(0);
});
