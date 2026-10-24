import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';

// British English dates such as "24 Oct 2026" instead of the German "24. Okt. 2026"
const englishDate = /\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec) 20\d{2}\b/;
const englishMonth = /^(January|February|March|April|May|June|July|August|September|October|November|December) 20\d{2}$/;

test('date format updates both views and persists after reload', async ({ extensionContext }) =>
{
  const context = await extensionContext({ locale: 'de-DE' });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const page = await context.newPage();
  await page.goto(origin + '/backups.html#settings');
  await enableAutomaticBackups(page);
  // show the latest backup time first instead of the next scheduled backup
  await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'automatic-settings', update: { kind: 'frequency', value: 0 } }));
  const dropdown = page.getByLabel('Date format', { exact: true });
  await expect(dropdown).toHaveValue('relative');
  const popup = await context.newPage();
  await popup.goto(origin + '/popup.html');
  await expect(popup.locator('time:visible').first()).toBeVisible();
  await dropdown.selectOption('relative');
  const time = popup.locator('time:visible').first();
  await expect.poll(async () => time.textContent()).toMatch(/ago|now/);
  await time.focus();
  await expect(popup.getByRole('tooltip')).toHaveText(englishDate);
  await expect(time).toHaveAttribute('aria-describedby', 'timestamp-tooltip');
  await expect(time).not.toHaveAttribute('title');
  await page.reload();
  await expect(dropdown).toHaveValue('relative');
  await dropdown.selectOption('combination');
  await expect(time).toHaveText(/20[0-9]{2}.*[(].*(ago|now)[)]/);
  await page.reload();
  await expect(dropdown).toHaveValue('combination');
  await popup.reload();
  await expect(popup.locator('time:visible').first()).toHaveText(/20[0-9]{2}.*[(].*(ago|now)[)]/);
  await dropdown.selectOption('exact');
  await expect(time).toHaveText(englishDate);
  await popup.reload();
  await expect(popup.locator('time:visible').first()).toHaveText(englishDate);
  // the backup calendar names months and weekdays in English for a German browser
  const backups = await context.newPage();
  await backups.goto(origin + '/backups.html');
  await expect(backups.locator('.calendar-month').first()).toHaveText(englishMonth);
  expect(await backups.locator('.calendar-month-group').first().locator('.calendar-weekday').allTextContents()).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
});
