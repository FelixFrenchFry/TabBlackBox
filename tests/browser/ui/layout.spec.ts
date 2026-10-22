import { test, expect, launchAutomaticBackups } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Request, Reply } from '../../../src/protocol';

test('switching views keeps shared layout positions stable with native scrollbars', async () =>
{
  const app = await launchAutomaticBackups();
  try {
    // model a long history without hundreds of snapshots
    await app.page.locator('main').first().evaluate(element => { element.style.minHeight = '1600px'; });
    for (const width of [1280, 1000, 800, 640, 390]) {
      await app.page.setViewportSize({ width, height: 1200 });
      const positions = async () => app.page.evaluate(() =>
      {
        return ['.brand', '.local-label', '.nav-item', 'main:not([hidden])', 'main:not([hidden]) h1'].map(selector =>
        {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`Missing ${selector}`);
          const rect = element.getBoundingClientRect();
          return { selector, x: rect.x, y: rect.y };
        });
      });
      await app.page.getByRole('link', { name: 'Backups', exact: true }).click();
      await expect(app.page.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();
      const history = await positions();
      await app.page.getByRole('link', { name: 'Settings', exact: true }).click();
      await expect(app.page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      expect(await positions(), `Shared positions at ${width}px`).toEqual(history);
    }
  } finally { await app.context.close(); }
});

test('backup status expands saved time and keeps warnings visible across polls', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext({ viewport: { width: 1200, height: 900 } });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.addInitScript(() => {
    const savedAt = Date.now() - 60_000;
    const interval = window.setInterval.bind(window);
    Object.defineProperty(window, 'setInterval', { value: (callback: () => void, delay: number) => {
      if (delay !== 1500) return interval(callback, delay);
      document.addEventListener('status-poll', callback);
      return 0;
    } });
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> => {
      const reply: Reply = await original(message);
      if (reply.ok && reply.data.kind === 'overview') {
        reply.data.overview.status = document.documentElement.dataset.statusError ? { kind: 'error', message: 'Test backup error' } : { kind: 'pending' };
        reply.data.overview.metadata.automatic = { enabled: true, intervalMinutes: 15, pausedUntil: null };
        reply.data.overview.metadata.lastSavedAt = savedAt;
      }
      return reply;
    } });
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  const status = page.getByRole('region', { name: 'Backup status' });
  const summary = status.locator('summary');
  const times = status.locator('.status-times');
  await expect(summary).toContainText('Changes waiting for the next backup');
  await expect(status.locator('.scheduled-backup')).toBeVisible();
  await expect(times).toBeHidden();
  const search = page.locator('.tab-search');
  const statusBox = await status.boundingBox();
  const searchBox = await search.boundingBox();
  if (!statusBox || !searchBox) throw new Error('Missing status or search');
  expect(searchBox.width).toBe(statusBox.width);
  expect(statusBox.y).toBeGreaterThan(searchBox.y + searchBox.height);
  await summary.focus();
  await summary.press('Enter');
  await expect(times).toBeVisible();
  await expect(times).toContainText('Last saved');
  await expect(times.locator('time')).toHaveCount(1);
  const saved = await times.locator('time').first().elementHandle();
  if (!saved) throw new Error('Missing saved timestamp');
  await page.evaluate(() => {
    document.documentElement.dataset.statusError = 'true';
    document.dispatchEvent(new Event('status-poll'));
  });
  await expect(summary).toContainText('Backup needs attention');
  await expect(times).toBeVisible();
  expect(await saved.evaluate(element => element.isConnected)).toBe(true);
  await summary.press('Space');
  await expect(times).toBeHidden();
  await expect(status.getByText('Test backup error', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('backup-status.png') });
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(status.getByText('Test backup error', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
