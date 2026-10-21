import { test, expect, launchAutomaticBackups } from '../fixtures/extension';
import type { Request } from '../../../src/protocol';

for (const view of ['backups', 'popup']) {
  for (const failPoll of [false, true]) {
    test(`${view} queues a manual backup behind a ${failPoll ? 'failed' : 'delayed'} poll`, async ({ testServer: baseUrl }) =>
    {
      const app = await launchAutomaticBackups();
      try {
        await app.page.evaluate(async url => { await chrome.tabs.create({ url }); }, `${baseUrl}/queued`);
        await app.page.addInitScript(fail =>
        {
          const original = chrome.runtime.sendMessage.bind(chrome.runtime);
          let blockPoll = true;
          let backupCount = 0;
          Object.defineProperty(chrome.runtime, 'sendMessage', { configurable: true, value: async (message: Request) =>
          {
            if (message.kind === 'overview' && blockPoll) {
              blockPoll = false;
              document.documentElement.dataset.pollWaiting = 'true';
              await new Promise<void>(resolve => document.addEventListener('release-poll', () => resolve(), { once: true }));
              if (fail) return { ok: false, error: 'Temporary poll failure' };
            }
            if (message.kind === 'backup') {
              document.documentElement.dataset.backupCount = String(++backupCount);
              await new Promise<void>(resolve => document.addEventListener('release-backup', () => resolve(), { once: true }));
            }
            return original(message);
          } });
        }, failPoll);
        await app.page.goto(`chrome-extension://${app.extensionId}/${view}.html`);
        await expect(app.page.locator('html')).toHaveAttribute('data-poll-waiting', 'true');
        await app.page.getByRole('button', { name: 'Back up now', exact: true }).click();
        const saving = app.page.getByRole('button', { name: 'Backing up…', exact: true });
        await expect(saving).toBeDisabled();
        await saving.dispatchEvent('click');
        await expect(app.page.locator('html')).not.toHaveAttribute('data-backup-count');
        await app.page.evaluate(() => document.dispatchEvent(new Event('release-poll')));
        await expect(app.page.locator('html')).toHaveAttribute('data-backup-count', '1');
        await expect(saving).toBeDisabled();
        await app.page.evaluate(() => document.dispatchEvent(new Event('release-backup')));
        await expect(app.page.getByRole('button', { name: 'Back up now', exact: true })).toBeEnabled();
        if (view === 'backups') await expect(app.page.locator('.saved-backups .backup-row')).toHaveCount(1);
        await expect(app.page.getByText('Temporary poll failure')).not.toBeVisible();
        await expect(app.page.locator('html')).toHaveAttribute('data-backup-count', '1');
      } finally { await app.context.close(); }
    });
  }
}
