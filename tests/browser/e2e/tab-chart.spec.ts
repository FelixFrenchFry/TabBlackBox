import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';

test('charts tab counts with backup details on hover and keyboard focus', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext({ viewport: { width: 1200, height: 900 } });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html#statistics`);
  await enableAutomaticBackups(page);
  await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'automatic-settings', update: { kind: 'enabled', value: false } }));
  for (const path of ['first', 'second']) {
    const tab = await context.newPage();
    await tab.goto(`http://127.0.0.1:9/${path}`).catch(() => undefined);
    await page.bringToFront();
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'backup' }));
  }
  await page.reload();
  const chart = page.locator('.tab-chart');
  await expect(chart.locator('.tab-chart-manual')).toHaveCount(2);
  await expect(chart.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
  const plot = chart.getByRole('group', { name: /Tab counts/ });
  await plot.focus();
  await page.keyboard.press('End');
  const tooltip = page.locator('.tab-chart-tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('Manual backup #2');
  await page.screenshot({ path: testInfo.outputPath('tab-chart.png') });
  await page.keyboard.press('ArrowLeft');
  await expect(tooltip).toContainText('Manual backup #1');
  await plot.click();
  await expect(page.locator('.calendar-filter')).toBeHidden();
  await chart.getByRole('button', { name: '24 hours' }).click();
  await expect(chart.getByRole('button', { name: '24 hours' })).toHaveAttribute('aria-pressed', 'true');
  await expect(chart).toContainText('Last 24 hours');
  await page.reload();
  await expect(chart.getByRole('button', { name: '24 hours' })).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 400, height: 900 });
  // wait for the chart to redraw at the narrower width
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await chart.screenshot({ path: testInfo.outputPath('tab-chart-narrow.png') });
});
