import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Reply, Request } from '../../../src/protocol';

test('window buttons confirm only their own tabs and share the restore busy state', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext({ viewport: { width: 1200, height: 900 } });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.extension, 'isAllowedFileSchemeAccess', { value: async () => false });
    Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> => {
      if (message.kind === 'history' && message.collection === 'saved') return { ok: true, data: { kind: 'history', more: false, items: [], count: 0, bytes: 0 } };
      if (message.kind === 'history') return { ok: true, data: { kind: 'history', more: false, count: 1, bytes: 100, items: [{ id: 'saved', number: 1, name: null, capturedAt: 1, source: 'manual', windowCount: 2, tabCount: 3, supportedCount: 3, bytes: 100 }] } };
      if (message.kind === 'snapshot') return { ok: true, data: { kind: 'snapshot', snapshot: { id: 'saved', number: 1, name: null, capturedAt: 1, source: 'manual', windows: [
        { groups: [], tabs: [{ url: 'file:///C:/paper.pdf', title: 'Local paper', pinned: false, group: null }] },
        { groups: [], tabs: [{ url: 'https://selected.test', title: 'Selected page', pinned: false, group: null }, { url: 'about:blank', title: 'Blank tab', pinned: false, group: null }] },
      ] } } };
      if (message.kind === 'restore-window') {
        document.documentElement.dataset.restored = JSON.stringify(message);
        return { ok: true, data: { kind: 'accepted' } };
      }
      const reply: Reply = await original(message);
      if (reply.ok && reply.data.kind === 'overview' && document.documentElement.dataset.restored) reply.data.overview.status = { kind: 'restoring' };
      return reply;
    } });
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  await page.locator('.backup-row summary').click();
  const first = page.locator('.window-heading').nth(0).getByRole('button', { name: 'Restore this window 1', exact: true });
  const second = page.locator('.window-heading').nth(1).getByRole('button', { name: 'Restore this window 2', exact: true });
  await expect(second).toBeVisible();
  const sessionButton = page.locator('.backup-actions').getByRole('button', { name: 'Restore', exact: true });
  const [windowBox, countBox] = await Promise.all([second.boundingBox(), page.locator('.window-heading').nth(1).locator('.muted').boundingBox()]);
  if (!windowBox || !countBox) throw new Error('Missing window heading');
  const spacing = windowBox.x - countBox.x - countBox.width;
  expect(spacing).toBeGreaterThanOrEqual(0);
  expect(spacing).toBeLessThan(8);
  expect(Math.abs(windowBox.y + windowBox.height / 2 - countBox.y - countBox.height / 2)).toBeLessThan(2);
  await first.click();
  await expect(page.getByRole('dialog')).toContainText('Restore window 1?');
  await expect(page.getByRole('dialog')).toContainText('Allow access to file URLs');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await second.click();
  await expect(page.getByRole('dialog')).toContainText('2 tabs will open in 1 new window');
  await expect(page.getByRole('dialog')).not.toContainText('Allow access to file URLs');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.restored)).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('window-buttons.png'), fullPage: true });
  await page.setViewportSize({ width: 400, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await second.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('Restoring session');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(document.documentElement.dataset.restored!))).toEqual({ kind: 'restore-window', id: 'saved', windowIndex: 1 });
  await expect(first).toBeDisabled();
  await expect(second).toBeDisabled();
  await expect(sessionButton).toBeDisabled();
});
