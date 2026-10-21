import { test, expect, launchAutomaticBackups } from '../fixtures/extension';
import { send } from '../fixtures/session';

for (const local of [false, true]) {
  test(local ? 'local sorting supersedes a pending cross-page sort using the displayed direction' : 'retries a failed cross-page history sort without discarding visible rows', async () =>
  {
    const app = await launchAutomaticBackups();
    try {
      await send(app.page, { kind: 'import', archive: { format: 'tabblackbox', version: 1, sessions: Array.from({ length: 35 }, (_, index) => ({
        capturedAt: index + 1, name: String(index + 1), source: 'manual',
        windows: [{ groups: [], tabs: [{ url: 'https://example.test', title: 'Saved tab', pinned: false, group: null }] }],
      })) } });
      const other = await app.context.newPage();
      await other.goto(`chrome-extension://${app.extensionId}/backups.html`);
      await app.page.reload();
      await expect(app.page.locator('.backup-title')).toHaveCount(5);
      await expect(other.locator('.backup-title')).toHaveCount(5);
      await app.page.evaluate(() => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        let fail = true;
        Object.defineProperty(chrome.runtime, 'sendMessage', { configurable: true, value: async (message: { kind?: string; collection?: string; sort?: string }) => {
          if (message.kind === 'history' && message.collection === 'saved' && message.sort === 'date-asc' && fail) {
            fail = false;
            await new Promise<void>(resolve => document.addEventListener('release-cross-page-sort', () => resolve(), { once: true }));
            return { ok: false, error: 'Temporary cross-page sort failure' };
          }
          return original(message);
        } });
      });
      const panel = app.page.getByRole('region', { name: 'Manual backups', exact: true });
      const height = await panel.evaluate(element => element.getBoundingClientRect().height);
      const originalNames = await panel.locator('.backup-title').allTextContents();
      const localDate = panel.getByRole('button', { name: /^Date,/ });
      const date = other.getByRole('region', { name: 'Manual backups', exact: true }).getByRole('button', { name: /^Date,/ });
      await date.click();
      await expect(other.locator('.backup-title')).toHaveText(Array.from({ length: 5 }, (_, index) => String(index + 1)));
      await expect(panel.getByRole('button', { name: 'Load more', exact: true })).toBeDisabled();
      expect(await panel.evaluate(element => element.getBoundingClientRect().height)).toBe(height);
      await expect(panel.locator('.backup-row').first()).toBeVisible();
      await expect(panel.locator('.backup-title')).toHaveText(originalNames);
      await expect(localDate).toHaveAttribute('aria-label', 'Date, newest first. Sort oldest first');
      if (local) {
        await localDate.click();
        await expect(panel.locator('.backup-title')).toHaveText(Array.from({ length: 5 }, (_, index) => String(index + 1)));
        await app.page.evaluate(() => document.dispatchEvent(new Event('release-cross-page-sort')));
        await expect(panel.getByRole('button', { name: 'Retry loading backups' })).toBeHidden();
        await expect(localDate).toHaveAttribute('aria-label', 'Date, oldest first. Sort newest first');
        return;
      }
      await app.page.evaluate(() => document.dispatchEvent(new Event('release-cross-page-sort')));
      await expect(panel.getByText('Temporary cross-page sort failure', { exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Retry loading backups' })).toBeVisible();
      await expect(panel.locator('.backup-row').first()).toBeVisible();
      await expect(localDate).toHaveAttribute('aria-label', 'Date, newest first. Sort oldest first');
      await panel.getByRole('button', { name: 'Retry loading backups' }).click();
      await expect(app.page.locator('.backup-title')).toHaveText(Array.from({ length: 5 }, (_, index) => String(index + 1)));
      await expect(localDate).toHaveAttribute('aria-label', 'Date, oldest first. Sort newest first');
      await expect(app.page.evaluate(() => localStorage.getItem('tabblackbox.history-sort.saved'))).resolves.toBe('date-asc');
    } finally { await app.context.close(); }
  });
}
