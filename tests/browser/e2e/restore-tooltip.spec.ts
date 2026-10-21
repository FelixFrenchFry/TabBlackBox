import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';

test('a supported Restore button remains usable with a tooltip after refresh', async ({ extensionContext }) =>
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  await page.evaluate(async () => { await chrome.tabs.create({ url: 'about:blank' }); });
  await page.getByRole('button', { name: 'Back up now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  const restore = page.locator('.backup-row').first().getByRole('button', { name: 'Restore', exact: true });
  await expect(restore).toBeEnabled();
  await restore.evaluate(button => { button.setAttribute('title', 'Restore this saved session'); });
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({ kind: 'refresh' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(restore).toHaveAttribute('title', 'Restore this saved session');
  await expect(restore).toBeEnabled();
});
