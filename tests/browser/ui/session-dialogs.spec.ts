import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Reply, Request } from '../../../src/protocol';

for (const failure of [false, true]) test(`session dialogs share pending lookup and open state, lookup failure=${failure}`, async ({ extensionContext }) =>
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.extension, 'isAllowedFileSchemeAccess', { value: async () => false });
    Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> => {
      if (message.kind === 'history' && message.collection === 'saved') return { ok: true, data: { kind: 'history', items: [], count: 0, bytes: 0 } };
      if (message.kind === 'history') return { ok: true, data: { kind: 'history', count: 1, bytes: 100, items: [{ id: 'saved', number: 1, name: null, capturedAt: 1, source: 'manual', windowCount: 1, tabCount: 1, supportedCount: 1, bytes: 100 }] } };
      if (message.kind === 'snapshot') return new Promise(resolve => {
        document.documentElement.dataset.snapshotPending = 'true';
        window.addEventListener('finish-snapshot', event => {
          delete document.documentElement.dataset.snapshotPending;
          resolve((event as CustomEvent<boolean>).detail
            ? { ok: false, error: 'Snapshot lookup failed' }
            : { ok: true, data: { kind: 'snapshot', snapshot: { id: 'saved', number: 1, name: null, capturedAt: 1, source: 'manual', windows: [{ groups: [], tabs: [{ url: 'about:blank', title: 'Page', pinned: false, group: null }] }] } } });
        }, { once: true });
      });
      if (message.kind === 'rename') return { ok: false, error: 'Rename failed' };
      return original(message);
    } });
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  const restore = page.locator('.backup-actions').getByRole('button', { name: 'Restore', exact: true });
  const rename = page.getByRole('button', { name: 'Rename session #1', exact: true });
  await restore.click();
  await expect(page.locator('html')).toHaveAttribute('data-snapshot-pending', 'true');
  await expect(rename).toBeDisabled();
  await expect(restore).toBeDisabled();
  await rename.evaluate(button => (button as HTMLButtonElement).click());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(fail => window.dispatchEvent(new CustomEvent('finish-snapshot', { detail: fail })), failure);
  if (failure) {
    await expect(page.getByRole('alert')).toContainText('Snapshot lookup failed');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } else {
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toContainText('Restore this session?');
    await expect(rename).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  await expect(restore).toBeEnabled();
  await expect(rename).toBeEnabled();
  await rename.click();
  await expect(page.getByRole('dialog')).toContainText('Rename this session');
  await expect(restore).toBeDisabled();
  await expect(rename).toBeDisabled();
  await restore.evaluate(button => (button as HTMLButtonElement).click());
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByLabel('Name', { exact: true }).fill('Research');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Rename failed');
  await expect(restore).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(restore).toBeEnabled();
  await expect(rename).toBeEnabled();
});
