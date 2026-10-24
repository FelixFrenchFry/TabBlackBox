import { test, expect } from '../fixtures/extension';

test('empty automatic history describes whether automatic backups are on', async ({ extensionContext }) =>
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  const automatic = page.getByRole('region', { name: 'Automatic backups', exact: true });
  const setAutomatic = (value: boolean) => page.evaluate(enabled => chrome.runtime.sendMessage({ kind: 'automatic-settings', update: { kind: 'enabled', value: enabled } }), value);
  await expect(automatic.locator('.empty-state p')).toHaveText(/^Open some tabs and enable automatic backups in Settings/);
  // a manual backup of unchanged tabs leaves the automatic history empty after enabling
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByRole('region', { name: 'Manual backups', exact: true }).locator('.backup-row')).toHaveCount(1);
  await setAutomatic(true);
  await expect(automatic.locator('.empty-state p')).toHaveText('Automatic backups are on. The first one is saved after your tabs change.');
  await expect(automatic.locator('.backup-row')).toHaveCount(0);
  // a pause keeps automatic backups enabled but describes the paused state
  await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'automatic-settings', update: { kind: 'pause', minutes: 15 } }));
  await expect(automatic.locator('.empty-state p')).toHaveText('Automatic backups are paused. They resume when the pause timer ends.');
  await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'automatic-settings', update: { kind: 'resume' } }));
  await expect(automatic.locator('.empty-state p')).toHaveText('Automatic backups are on. The first one is saved after your tabs change.');
  await setAutomatic(false);
  await expect(automatic.locator('.empty-state p')).toHaveText(/^Open some tabs and enable automatic backups in Settings/);
});
