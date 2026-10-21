import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Request, Reply } from '../../../src/protocol';

test('settings share a temporary toast and each manual backup confirms saving in its button', async ({ extensionContext }) =>
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> => {
      if (document.documentElement.dataset.failSave && (message.kind === 'storage-settings' || message.kind === 'automatic-settings')) return { ok: false, error: 'Save failed for testing' };
      return original(message);
    } });
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html#settings`);
  await enableAutomaticBackups(page);
  const toast = page.locator('.toast-region');
  await expect(toast).toBeEmpty();
  await expect(page.locator('.settings-save-status')).toHaveCount(0);
  await page.evaluate(() => {
    const region = document.querySelector('.toast-region');
    if (!region) throw new Error('Missing toast region');
    new MutationObserver(records => {
      const added = records.reduce((count, record) => count + record.addedNodes.length, 0);
      document.documentElement.dataset.toasts = String(Number(document.documentElement.dataset.toasts ?? 0) + added);
    }).observe(region, { childList: true });
  });
  const firstPanel = page.locator('.settings-card').first();
  const before = await firstPanel.evaluate(element => ({ top: element.getBoundingClientRect().top + scrollY, height: element.getBoundingClientRect().height }));
  const enabled = page.getByRole('switch', { name: 'Automatic backups', exact: true });
  const actions = [
    () => page.getByLabel('Color theme').selectOption('dark'),
    () => page.getByLabel('Date format', { exact: true }).selectOption('exact'),
    () => page.getByLabel('Backup frequency', { exact: true }).selectOption('5'),
    () => enabled.uncheck(),
    () => enabled.check(),
    () => page.getByRole('button', { name: 'Pause', exact: true }).click(),
    () => page.getByRole('button', { name: 'Resume now' }).click(),
    () => page.getByLabel('Space limit', { exact: true }).fill('350'),
    () => page.getByRole('switch', { name: 'Enable backup limit' }).check(),
    () => page.getByRole('switch', { name: 'Enable time limit' }).check(),
  ];
  for (const [index, action] of actions.entries()) {
    await action();
    await expect(page.locator('html')).toHaveAttribute('data-toasts', String(index + 1));
    await expect(toast).toHaveText('Settings have been saved');
    await expect(toast.locator('.backup-toast')).toHaveCount(1);
  }
  expect(await firstPanel.evaluate(element => ({ top: element.getBoundingClientRect().top + scrollY, height: element.getBoundingClientRect().height }))).toEqual(before);
  await expect(toast).toBeEmpty();
  await page.evaluate(() => { document.documentElement.dataset.failSave = 'true'; });
  await page.getByLabel('Space limit', { exact: true }).fill('400');
  await expect(page.getByText('Save failed for testing')).toBeVisible();
  await expect(toast).toBeEmpty();
  await expect(page.locator('html')).toHaveAttribute('data-toasts', '10');
  await page.evaluate(() => { delete document.documentElement.dataset.failSave; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(toast).toHaveText('Settings have been saved');
  await enabled.uncheck();
  await expect(enabled).toBeEnabled();
  await page.getByRole('link', { name: 'Backups', exact: true }).click();
  const backup = page.locator('.backup-button:visible');
  await backup.click();
  await expect(backup).toHaveText('Saved');
  await expect(backup).toBeDisabled();
  await expect(backup).toBeEnabled();
  await backup.click();
  await expect(backup).toHaveText('Saved');
  await expect(backup).toBeDisabled();
  await expect(toast).toBeEmpty();
  const reply: Reply = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'history', collection: 'saved', before: null }));
  expect(reply.ok && reply.data.kind === 'history' && reply.data.count).toBe(2);
});
