import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import { importArchive } from '../fixtures/archive';

test('history scrolls inside its panel and loads further pages without changing its filters or sort', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  for (const other of context.pages()) if (other !== page) await other.close();
  await importArchive(page, { format: 'tabblackbox', version: 1, sessions: Array.from({ length: 100 }, (_, index) => ({
    capturedAt: index + 1, name: `Backup ${index + 1}`, source: 'manual',
    windows: [{ groups: [], tabs: Array.from({ length: index + 1 }, () => ({ url: 'about:blank', title: 'Saved page', pinned: false, group: null })) }],
  })) });
  await page.reload();
  const panel = page.getByRole('region', { name: 'Manual backups', exact: true });
  const rows = panel.locator('.history-rows');
  const scrollToEnd = () => rows.evaluate(element => { element.scrollTo(0, element.scrollHeight); element.dispatchEvent(new Event('scroll')); });
  await expect(panel.locator('.backup-row')).toHaveCount(50);
  await expect(panel.getByRole('button', { name: /^Show (more|less)$/ })).toHaveCount(0);
  // the list keeps its own height and scrolls inside the panel
  expect(await rows.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight <= Math.ceil(9.5 * 41))).toBe(true);
  // count the requests for further manual backup pages
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    document.documentElement.dataset.olderPages = '0';
    Object.defineProperty(chrome.runtime, 'sendMessage', { configurable: true, value: (message: { kind: string; before?: unknown; collection?: string }) => {
      if (message.kind === 'history' && message.before && message.collection === 'saved') document.documentElement.dataset.olderPages = String(Number(document.documentElement.dataset.olderPages) + 1);
      return original(message);
    } });
  });
  await scrollToEnd();
  await expect(panel.locator('.backup-row')).toHaveCount(100);
  // the last full page already ends the history without an empty extra page
  await scrollToEnd();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
  await expect(panel.locator('.backup-row')).toHaveCount(100);
  await expect(page.locator('html')).toHaveAttribute('data-older-pages', '1');
  expect(await panel.locator('.backup-counts > .muted').allTextContents()).toEqual([...Array.from({ length: 99 }, (_, index) => `1 window · ${100 - index} tabs`), '1 window · 1 tab']);
  await panel.screenshot({ path: testInfo.outputPath('history-scroll.png') });
  await page.setViewportSize({ width: 400, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: testInfo.outputPath('history-scroll-narrow.png') });
  await page.setViewportSize({ width: 1200, height: 900 });
  // a new search starts at the top of its results
  const search = panel.getByRole('searchbox', { name: 'Search manual backups', exact: true });
  await search.fill('Backup 1');
  const names = panel.locator('.backup-title');
  await expect(names.first()).toHaveText('Backup 100');
  await expect(names).toHaveCount(20);
  expect(await rows.evaluate(element => element.scrollTop)).toBe(0);
  const date = panel.getByRole('button', { name: /^Date,/ });
  await date.click();
  await expect(names.first()).toHaveText('Backup 1');
  await expect(names.nth(1)).toHaveText('Backup 10');
  await expect(names).toHaveCount(20);
  await expect(date).toHaveAttribute('aria-label', 'Date, oldest first. Sort newest first');
  await expect(search).toHaveValue('Backup 1');
});
