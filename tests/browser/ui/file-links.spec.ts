import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Reply, Request } from '../../../src/protocol';

test('file-only history offers permission instructions and opens files through the tabs API', async ({ extensionContext }) =>
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    const url = 'file:///M:/Research/My%20paper.pdf#page=3';
    Object.defineProperty(chrome.extension, 'isAllowedFileSchemeAccess', { value: async () => document.documentElement.dataset.fileAccess === 'true' });
    Object.defineProperty(chrome.tabs, 'create', { value: async (properties: chrome.tabs.CreateProperties) => {
      document.documentElement.dataset.openedUrl = properties.url;
      return { id: 123 };
    } });
    Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> => {
      if (message.kind === 'history' && message.collection === 'saved') return { ok: true, data: { kind: 'history', items: [], count: 0, bytes: 0 } };
      if (message.kind === 'history') return { ok: true, data: { kind: 'history', count: 1, bytes: 100, items: [{ id: 'local', number: 1, name: null, capturedAt: 1, source: 'manual', windowCount: 1, tabCount: 1, supportedCount: 0, bytes: 100 }] } };
      if (message.kind === 'snapshot') return { ok: true, data: { kind: 'snapshot', snapshot: { id: 'local', number: 1, name: null, capturedAt: 1, source: 'manual', windows: [{ groups: [], tabs: [{ url, title: 'Local paper', pinned: false, group: null }] }] } } };
      return original(message);
    } });
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  const row = page.locator('.backup-row');
  // the tab title and the arrow both open the file
  const fileControls = row.locator('.file-open');
  const expectFileControls = async (enabled: boolean) => {
    await expect(fileControls).toHaveCount(2);
    for (const control of await fileControls.all()) await (enabled ? expect(control).toBeEnabled() : expect(control).toBeDisabled());
  };
  await row.locator('summary').click();
  await expect(row.getByText('File access required', { exact: true })).toBeVisible();
  await expectFileControls(false);
  await expect(row.getByText('Will be skipped', { exact: true })).toHaveCount(0);
  await row.getByRole('button', { name: 'Open extension settings' }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.openedUrl)).toContain('chrome://extensions/?id=');
  await row.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Allow access to file URLs');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { document.documentElement.dataset.fileAccess = 'true'; });
  await expectFileControls(true);
  await expect(row.getByText('File access required', { exact: true })).toBeHidden();
  await row.locator('.tab-open.file-open').click();
  expect(await page.evaluate(() => document.documentElement.dataset.openedUrl)).toBe('file:///M:/Research/My%20paper.pdf#page=3');
  await row.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('1 tab will open in 1 new window');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { document.documentElement.dataset.fileAccess = 'false'; });
  await expectFileControls(false);
  await expect(row.getByText('File access required', { exact: true })).toBeVisible();
});
