import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Request, Reply } from '../../../src/protocol';

for (const view of ['popup', 'backups']) test(`${view} shares backup button states without changing width`, async ({ extensionContext }) =>
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> => {
      if (message.kind !== 'backup') return original(message);
      document.documentElement.dataset.backupRequests = String(Number(document.documentElement.dataset.backupRequests ?? 0) + 1);
      if (document.documentElement.dataset.failBackup) return { ok: false, error: 'Backup failed for testing' };
      const reply: Reply = await original(message);
      document.documentElement.dataset.backupReady = 'true';
      await new Promise<void>(resolve => window.addEventListener('release-backup', () => resolve(), { once: true }));
      return reply;
    } });
  });
  const [name, hash] = view.split('#');
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/${name}.html${hash ? '#' + hash : ''}`);
  await enableAutomaticBackups(page);
  const save = page.locator('.backup-button:visible');
  await expect(save).toBeEnabled();
  await expect(page.locator('.status-title strong:visible')).toHaveText('Current tabs backed up automatically');
  if (view === 'backups') {
    await expect(page.locator('.saved-backups .archive-toolbar .backup-button')).toBeVisible();
    await expect(page.locator('.archive-toolbar .backup-button + button')).toHaveText('Export all');
  }
  const width = await save.evaluate(element => element.getBoundingClientRect().width);
  await save.click();
  await expect(save).toHaveText('Backing up…');
  await expect(save).toBeDisabled();
  await expect(save.locator('.save-spinner')).toBeVisible();
  expect(await save.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
  // wait for the background response before releasing the UI request
  await expect(page.locator('html')).toHaveAttribute('data-backup-requests', '1');
  await expect(page.locator('html')).toHaveAttribute('data-backup-ready', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('release-backup')));
  await expect(save).toHaveText('Saved');
  await expect(save).toBeDisabled();
  await expect(save).toHaveCSS('opacity', '0.55');
  expect(await save.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
  if (view === 'popup') await expect(page.locator('.backup-toast')).toHaveCount(0);
  await expect(page.locator('.status-title strong:visible')).toHaveText('Current tabs backed up manually');
  if (view === 'backups') {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.backup-button:visible')).toHaveCount(0);
    await expect(page.locator('.status-title strong:visible')).toHaveText('Current tabs backed up manually');
    await page.getByRole('link', { name: 'Backups', exact: true }).click();
  }
  await save.evaluate(element => (element as HTMLButtonElement).click());
  await expect(page.locator('html')).toHaveAttribute('data-backup-requests', '1');
  await expect(save).toHaveText('Back up now');
  await expect(save).toBeEnabled();
  expect(await save.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
  await page.evaluate(() => { document.documentElement.dataset.failBackup = 'true'; });
  await save.click();
  await expect(page.locator('[role="alert"]:visible').first()).toHaveText('Backup failed for testing');
  await expect(save).toHaveText('Back up now');
  await expect(save).toBeEnabled();
});
