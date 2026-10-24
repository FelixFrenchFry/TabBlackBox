import { test, expect, type ExtensionContext } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Page } from '@playwright/test';
import type { Operation, Snapshot } from '../../../src/model';
import type { Reply, Request } from '../../../src/protocol';

const running: Operation = { kind: 'running', snapshotId: 'saved', name: 'Research', startedAt: 10, opened: 0, failed: 0, skipped: 0, groupErrors: 0, total: 3, errors: [] };

async function launch(extensionContext: ExtensionContext)
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.extension, 'isAllowedFileSchemeAccess', { value: async () => document.documentElement.dataset.fileAccess === 'true' });
    const snapshot: Snapshot = { id: 'saved', name: 'Research', number: 1, capturedAt: 1, source: 'manual', windows: Array.from({ length: 3 }, () => ({ groups: [], tabs: [
      { title: 'First', url: 'https://first.example', pinned: false, group: null },
      { title: 'Mail', url: 'https://mail.example/inbox', pinned: false, group: null },
      { title: 'Last', url: 'https://last.example', pinned: false, group: null },
    ] })) };
    const interval = window.setInterval.bind(window);
    Object.defineProperty(window, 'setInterval', { value: (callback: () => void, delay: number) => {
      if (delay === 1500) { document.addEventListener('test-poll', callback); return 0; }
      return interval(callback, delay);
    } });
    Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> => {
      if (message.kind === 'history') return { ok: true, data: { kind: 'history', more: false, count: message.collection === 'saved' ? 1 : 0, bytes: 100, items: message.collection === 'saved' ? [{ ...snapshot, windowCount: 3, tabCount: 9, supportedCount: 9, bytes: 100 }] : [] } };
      if (message.kind === 'snapshot') return { ok: true, data: { kind: 'snapshot', snapshot } };
      if (message.kind === 'restore-window' || message.kind === 'restore') {
        if (sessionStorage.getItem('test-delay')) await new Promise<void>(resolve => document.addEventListener('test-admit', () => resolve(), { once: true }));
        if (sessionStorage.getItem('test-reject')) return { ok: false, error: 'Restore could not start' };
        document.documentElement.dataset.restored = JSON.stringify(message);
        if (sessionStorage.getItem('test-persist-failure')) {
          sessionStorage.setItem('test-status-error', 'Restoration interrupted: Disk unavailable');
          return { ok: true, data: { kind: 'accepted' } };
        }
        const operation: Operation = { kind: 'running', snapshotId: 'saved', name: 'Research', startedAt: 10, opened: 0, failed: 0, skipped: 0, groupErrors: 0, total: 3, errors: [] };
        sessionStorage.setItem('test-operation', JSON.stringify(sessionStorage.getItem('test-fast-success') ? { ...operation, kind: 'completed', finishedAt: 11, opened: 3 } : operation));
        return { ok: true, data: { kind: 'accepted' } };
      }
      if (message.kind === 'dismiss-restore') {
        if (sessionStorage.getItem('test-delay-dismiss')) await new Promise<void>(resolve => document.addEventListener('test-dismiss', () => resolve(), { once: true }));
        const operation: Operation = JSON.parse(sessionStorage.getItem('test-operation')!);
        sessionStorage.setItem('test-operation', JSON.stringify({ ...operation, dismissed: true }));
        return { ok: true, data: { kind: 'accepted' } };
      }
      const reply: Reply = await original(message);
      if (reply.ok && reply.data.kind === 'overview') {
        const operation: Operation | null = JSON.parse(sessionStorage.getItem('test-operation') ?? 'null');
        reply.data.overview.metadata.operation = operation;
        reply.data.overview.status = { kind: operation?.kind === 'running' ? 'restoring' : 'current' };
        const error = sessionStorage.getItem('test-status-error');
        if (error) reply.data.overview.status = { kind: 'error', message: error };
      }
      return reply;
    } });
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  await page.locator('.saved-backups .backup-row summary').first().click();
  return { context, page };
}

async function poll(page: Page, operation: Operation): Promise<void>
{
  await page.evaluate(value => {
    sessionStorage.setItem('test-operation', JSON.stringify(value));
    document.dispatchEvent(new Event('test-poll'));
  }, operation);
}

test('keeps selected-window confirmation open through progress, Escape and failure details', async ({ extensionContext }, testInfo) =>
{
  const { page } = await launch(extensionContext);
  await page.getByRole('button', { name: 'Restore this window 3', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.evaluate(element => { element.setAttribute('data-test-dialog', 'original'); });
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Restoring session' })).toBeVisible({ timeout: 2000 });
  await expect(dialog).toHaveAttribute('data-test-dialog', 'original');
  expect(await page.evaluate(() => JSON.parse(document.documentElement.dataset.restored!))).toEqual({ kind: 'restore-window', id: 'saved', windowIndex: 2 });
  await poll(page, { ...running, opened: 1 });
  await expect(dialog).toContainText('1 tab opened');
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '1');
  await dialog.screenshot({ path: testInfo.outputPath('restore-progress.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'View restore progress', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Restoring session' })).toBeVisible();
  // the running restoration offers a visible hide action and reopens from the status card
  await expect(dialog.getByRole('button', { name: 'Hide', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'View restore progress', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Restoring session' })).toBeVisible();
  const failed: Operation = { ...running, kind: 'completed', finishedAt: Date.now(), opened: 2, failed: 1, errors: ['Test failure'], issues: [{ kind: 'tab', title: 'Mail', url: 'https://mail.example/inbox', message: 'Test failure' }] };
  await poll(page, failed);
  await expect(dialog.getByRole('heading', { name: 'Restoration finished with issues' })).toBeVisible();
  await expect(dialog).toContainText('2 tabs opened');
  await expect(dialog.getByRole('link', { name: 'Mail', exact: true })).toHaveAttribute('href', 'https://mail.example/inbox');
  await expect(dialog).toContainText('Test failure');
  await dialog.locator('summary').click();
  await poll(page, failed);
  await expect(dialog.locator('details')).not.toHaveAttribute('open');
  await expect(dialog.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Hide', exact: true })).toHaveCount(0);
  await dialog.locator('summary').click();
  await page.screenshot({ path: testInfo.outputPath('restore-dialog.png') });
  // closing a finished result dismisses it
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View restore issues', exact: true })).toHaveCount(0);
  // focus moves past the hidden status button to the backup action
  await expect(page.locator('.backup-button:visible')).toBeFocused();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('test-operation')!).dismissed)).toBe(true);
  // a stale overview without the stored dismissal keeps the closed result hidden
  await poll(page, failed);
  await expect(page.getByRole('button', { name: 'View restore issues', exact: true })).toHaveCount(0);
});

test('fast success closes the initiating dialog and rejected admission restores confirmation', async ({ extensionContext }) =>
{
  const { page } = await launch(extensionContext);
  await page.evaluate(() => sessionStorage.setItem('test-reject', 'true'));
  await page.getByRole('button', { name: 'Restore this window 3', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Restore could not start');
  await expect(dialog.getByRole('heading')).toHaveText('Restore window 3?');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await page.evaluate(() => { sessionStorage.removeItem('test-reject'); sessionStorage.setItem('test-fast-success', 'true'); });
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.toast-region')).toHaveText('Restoration finished · 3 tabs opened');
  await expect(page.getByRole('button', { name: 'View restore progress', exact: true })).toHaveCount(0);
});

test('Escape during admission reserves the restore and hidden completion stays available with file permission updates', async ({ extensionContext }) =>
{
  const { page } = await launch(extensionContext);
  await page.evaluate(() => sessionStorage.setItem('test-delay', 'true'));
  const restore = page.getByRole('button', { name: 'Restore this window 3', exact: true });
  await restore.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(dialog).toContainText('Preparing restoration…');
  await page.keyboard.press('Escape');
  await expect(restore).toBeDisabled({ timeout: 2000 });
  await page.evaluate(() => document.dispatchEvent(new Event('test-poll')));
  await expect(restore).toBeDisabled();
  await page.getByRole('button', { name: 'View restore progress', exact: true }).click();
  await expect(dialog).toContainText('Preparing restoration…');
  await page.evaluate(() => document.dispatchEvent(new Event('test-admit')));
  await expect(dialog).toContainText('0 tabs opened');
  await page.keyboard.press('Escape');
  const failed: Operation = { ...running, kind: 'completed', finishedAt: 11, opened: 2, failed: 1, errors: ['File refused'], issues: [{ kind: 'tab', title: 'Paper', url: 'file:///C:/paper.pdf', message: 'File refused' }] };
  await poll(page, failed);
  await expect(page.getByRole('button', { name: 'View restore issues', exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'View restore issues', exact: true }).click();
  const controls = dialog.locator('.file-open');
  await expect(controls).toHaveCount(2);
  for (const control of await controls.all()) await expect(control).toBeDisabled();
  await page.evaluate(() => { document.documentElement.dataset.fileAccess = 'true'; });
  await poll(page, failed);
  for (const control of await controls.all()) await expect(control).toBeEnabled();
  await page.setViewportSize({ width: 400, height: 700 });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('a delayed dismissal cannot close a newer restoration dialog', async ({ extensionContext }) =>
{
  const { page } = await launch(extensionContext);
  await poll(page, { ...running, kind: 'completed', startedAt: 5, finishedAt: 6, opened: 2, failed: 1, errors: ['Old failure'] });
  await page.evaluate(() => sessionStorage.setItem('test-delay-dismiss', 'true'));
  await page.getByRole('button', { name: 'View restore issues', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => sessionStorage.setItem('test-delay', 'true'));
  await page.getByRole('button', { name: 'Restore this window 3', exact: true }).click();
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(dialog).toContainText('Preparing restoration…');
  await page.evaluate(() => document.dispatchEvent(new Event('test-dismiss')));
  // the callback and any stale overview must leave the new pending restore intact
  await page.evaluate(() => document.dispatchEvent(new Event('test-poll')));
  await expect(dialog.getByRole('heading')).toHaveText('Restoring session');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new Event('test-admit')));
  await expect(dialog).toContainText('0 tabs opened');
});

test('an accepted restore that cannot save initial progress reports interruption instead of waiting forever', async ({ extensionContext }) =>
{
  const { page } = await launch(extensionContext);
  await page.evaluate(() => sessionStorage.setItem('test-persist-failure', 'true'));
  const restore = page.getByRole('button', { name: 'Restore this window 3', exact: true });
  await restore.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Restoration interrupted' })).toBeVisible({ timeout: 2000 });
  await expect(dialog.getByRole('alert')).toContainText('Disk unavailable');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(restore).toBeEnabled();
  await page.getByRole('button', { name: 'View restore issues', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Disk unavailable');
  // a failed recovery write can leave the stored operation marked as running
  await poll(page, { ...running, startedAt: 12, opened: 1 });
  await expect(dialog.getByRole('heading')).toHaveText('Restoration interrupted');
  await expect(dialog.getByRole('alert')).toContainText('Disk unavailable');
  await expect(dialog.getByRole('progressbar')).toHaveCount(0);
});
