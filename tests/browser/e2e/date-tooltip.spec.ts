import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import { importArchive } from '../fixtures/archive';

test('backup date tooltips stay beside the timestamp on desktop and narrow layouts', async ({ extensionContext }) => {
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('tabblackbox.date-format', 'relative'));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  await importArchive(page, { format: 'tabblackbox', version: 1, sessions: [{ name: 'Tooltip position', source: 'manual', capturedAt: Date.now() - 5 * 86400000, windows: [{ groups: [], tabs: [{ url: 'https://example.test', title: 'Example', pinned: false, group: null }] }] }] });
  await page.reload();
  const time = page.locator('.saved-backups .backup-date').first();
  const tooltip = page.locator('#timestamp-tooltip');
  for (const width of [1280, 430]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(time).toHaveText('5 days ago');
    await time.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await page.mouse.move(0, 0);
    await time.hover();
    await expect(tooltip, `tooltip visible at ${width}px`).toBeVisible();
    const anchor = await time.boundingBox();
    if (!anchor) throw new Error('Missing timestamp');
    const popup = await tooltip.boundingBox();
    if (!popup) throw new Error('Missing timestamp tooltip');
    const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
    const expectedLeft = Math.max(16, Math.min(anchor.x, viewportWidth - popup.width - 16));
    expect(Math.abs(popup.x - expectedLeft)).toBeLessThan(2);
  }
});
