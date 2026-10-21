import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';

test('shows how far backups reach back', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext({ viewport: { width: 1280, height: 900 } });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html#statistics`);
  await enableAutomaticBackups(page);
  const history = page.locator('.statistic', { hasText: 'Backup history' });
  const tab = await context.newPage();
  await tab.goto('http://127.0.0.1:9/first').catch(() => undefined);
  await page.bringToFront();
  await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'backup' }));
  await expect(history.locator('.statistic-value')).toHaveText('Less than 1 hour');
  await expect(history.locator('.statistic-detail')).toHaveText(/^Since .+ · oldest kept backup$/);
  await expect(history.locator('.statistic-trend')).toBeHidden();
  // the five summary cards share one row on wide pages
  const tops = await page.locator('.statistics-summary .statistic').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().top));
  expect(new Set(tops).size).toBe(1);
  await page.locator('.statistics-summary').screenshot({ path: testInfo.outputPath('statistics-summary.png') });
});
