import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Operation } from '../../../src/model';
import type { Reply, Request } from '../../../src/protocol';

test('successful restorations use expiring toasts while issues and interruptions stay visible', async ({ extensionContext }) =>
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    const old: Operation = { kind: 'completed', snapshotId: 'old', startedAt: 1, finishedAt: 2, opened: 304, skipped: 0, failed: 0, groupErrors: 0, total: 304, errors: [] };
    sessionStorage.setItem('test-operation', sessionStorage.getItem('test-operation') ?? JSON.stringify(old));
    Object.defineProperty(window, 'setInterval', { value: (callback: () => void, delay: number) => {
      if (delay === 1500) document.addEventListener('test-poll', callback);
      return 0;
    } });
    Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> => {
      const reply: Reply = await original(message);
      if (reply.ok && reply.data.kind === 'overview') {
        const operation: Operation = JSON.parse(sessionStorage.getItem('test-operation')!);
        reply.data.overview.metadata.operation = operation;
        reply.data.overview.status = { kind: operation.kind === 'running' ? 'restoring' : 'current' };
      }
      return reply;
    } });
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  const toast = page.locator('.toast-region');
  await expect(page.locator('.backup-button:visible')).toBeEnabled();
  await expect(toast).toBeEmpty();
  await expect(page.getByRole('region', { name: 'Restoration result' })).toHaveCount(0);
  const listTop = () => page.locator('.saved-backups .backup-list').evaluate(element => element.getBoundingClientRect().top + scrollY);
  const before = await listTop();
  async function poll(operation?: Operation): Promise<void> {
    await page.evaluate(value => {
      if (value) sessionStorage.setItem('test-operation', JSON.stringify(value));
      document.dispatchEvent(new Event('test-poll'));
    }, operation);
  }
  const running: Operation = { kind: 'running', snapshotId: 'new', startedAt: 3, opened: 0, skipped: 0, failed: 0, groupErrors: 0, total: 304, errors: [] };
  await poll(running);
  await expect(page.locator('.backup-button:visible')).toBeDisabled();
  await expect(toast).toBeEmpty();
  await poll({ ...running, kind: 'completed', finishedAt: 4, opened: 304 });
  await expect(toast).toHaveText('Restoration finished · 304 tabs opened');
  await expect(toast.locator('.is-success')).toHaveCount(1);
  expect(await listTop()).toBe(before);
  await page.clock.runFor(4000);
  await poll();
  await expect(toast).toHaveText('Restoration finished · 304 tabs opened');
  await page.clock.runFor(999);
  await expect(toast).not.toBeEmpty();
  await page.clock.runFor(1);
  await expect(toast).toBeEmpty();
  await poll();
  await expect(toast).toBeEmpty();
  // a later restoration may complete without an intermediate running response
  await poll({ ...running, kind: 'completed', startedAt: 5, finishedAt: 6, opened: 300, skipped: 2, failed: 2, groupErrors: 1, errors: ['Group failed'] });
  await page.getByRole('button', { name: 'View restore issues', exact: true }).click();
  const result = page.getByRole('region', { name: 'Restoration result' });
  await expect(result.getByRole('heading')).toHaveText('Restoration finished with issues');
  await expect(result).toContainText('300 tabs opened');
  await expect(result).toContainText('2 skipped');
  await expect(result).toContainText('2 failed');
  await expect(result).toContainText('1 group error');
  await expect(result).toContainText('Group failed');
  await expect(toast).toBeEmpty();
  await result.locator('summary').click();
  await poll();
  await expect(result.locator('details')).not.toHaveAttribute('open');
  await page.reload();
  await expect(page.locator('.backup-button:visible')).toBeEnabled();
  await expect(toast).toBeEmpty();
  await expect(result).toHaveCount(0);
  await page.getByRole('button', { name: 'View restore issues', exact: true }).click();
  await expect(result).toBeVisible();
  await poll({ ...running, kind: 'interrupted', startedAt: 7, finishedAt: 8, opened: 1 });
  await expect(result.getByRole('heading')).toHaveText('Restoration interrupted');
  await expect(result).toContainText('1 tab opened');
  await expect(result).toContainText('Restoring again can create duplicates');
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Color theme').selectOption('dark');
  await expect(toast).toHaveText('Settings have been saved');
  await page.clock.runFor(4999);
  await expect(toast).toHaveText('Settings have been saved');
  await page.clock.runFor(1);
  await expect(toast).toBeEmpty();
});

test('stored tab details survive reopening and closing the result persists its dismissal', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  await expect(page.locator('.backup-button:visible')).toBeEnabled();
  const operation: Operation = {
    kind: 'completed', snapshotId: 'saved', name: 'Research', startedAt: Date.now() - 300_000, finishedAt: Date.now() - 299_000,
    opened: 40, failed: 3, skipped: 0, groupErrors: 0, total: 43, errors: ['Tab refused'], issues: [
      { kind: 'tab', title: 'Research notes', url: 'https://notes.example/research', message: 'Could not create the tab' },
      { kind: 'tab', title: 'Project board', url: 'https://projects.example/board', message: 'The destination window was closed' },
      { kind: 'tab', title: 'API reference', url: 'https://docs.example/reference', message: 'The destination window was closed' },
    ],
  };
  await page.evaluate(async value => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('tabblackbox');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('metadata', 'readwrite');
        const store = transaction.objectStore('metadata');
        const read = store.get('state');
        read.onsuccess = () => store.put({ ...read.result, operation: value }, 'state');
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, operation);
  await page.reload();
  await page.getByRole('button', { name: 'View restore issues', exact: true }).click();
  const result = page.getByRole('region', { name: 'Restoration result' });
  await expect(result).toBeVisible();
  await expect(result).toContainText('Research ·');
  await expect(result.locator('time')).toHaveAttribute('datetime', new Date(operation.finishedAt).toISOString());
  await expect(result.getByRole('link', { name: 'Project board', exact: true })).toHaveAttribute('href', 'https://projects.example/board');
  await expect(result.locator('.tab-url').nth(1)).toHaveText('projects.example/board');
  await expect(result.locator('.tab-favicon')).toHaveCount(3);
  await expect(result.locator('.restore-result-item')).toHaveCount(3);
  await expect(result.locator('summary')).toHaveText('3 failed tabs');
  await expect(result.getByRole('button')).toHaveCount(0);
  await result.screenshot({ path: testInfo.outputPath('restore-result.png') });
  const reopened = await context.newPage();
  await reopened.goto(page.url());
  await reopened.getByRole('button', { name: 'View restore issues', exact: true }).click();
  const reopenedResult = reopened.getByRole('region', { name: 'Restoration result' });
  await expect(reopenedResult).toBeVisible();
  // a failed dismissal leaves the result available for another attempt
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    let fail = true;
    Object.defineProperty(chrome.runtime, 'sendMessage', { value: (message: Request) => {
      if (message.kind === 'dismiss-restore' && fail) {
        fail = false;
        return Promise.resolve({ ok: false, error: 'Dismissal could not be saved' });
      }
      return original(message);
    } });
  });
  const close = page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true });
  await close.click();
  await expect(result).toHaveCount(0);
  await page.getByRole('button', { name: 'View restore issues', exact: true }).click();
  await expect(result).toBeVisible();
  await close.click();
  await expect(result).toHaveCount(0);
  await expect(reopenedResult).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.backup-button:visible')).toBeEnabled();
  await expect(result).toHaveCount(0);
  const reply: Reply = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'overview' }));
  expect(reply.ok && reply.data.kind === 'overview' && reply.data.overview.metadata.operation).toEqual({ ...operation, dismissed: true });
});
