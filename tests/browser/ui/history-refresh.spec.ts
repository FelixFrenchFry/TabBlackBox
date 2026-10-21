import { test, expect, launchAutomaticBackups } from '../fixtures/extension';
import type { Request } from '../../../src/protocol';
import { settledBackup } from '../fixtures/session';

test('history retries a failed refresh and displays the newly saved session', async ({ testServer: baseUrl }) =>
{
  const app = await launchAutomaticBackups();
  try {
    await app.page.evaluate(async url => { await chrome.tabs.create({ url }); }, `${baseUrl}/first`);
    await settledBackup(app.page, 1);
    await expect(app.page.locator('.backup-row').first()).toContainText('1 tab');
    await app.page.evaluate(() =>
    {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let fail = true;
      Object.defineProperty(chrome.runtime, 'sendMessage', { configurable: true, value: async (message: Request) =>
      {
        if (message.kind === 'history' && fail) { fail = false; return { ok: false, error: 'Temporary history failure' }; }
        return original(message);
      } });
    });
    await app.page.evaluate(async url => { await chrome.tabs.create({ url }); }, `${baseUrl}/second`);
    await settledBackup(app.page, 2);
    await expect(app.page.locator('main:visible').getByText('Temporary history failure')).toBeVisible();
    await expect(app.page.locator('.backup-row').first()).toContainText('2 tabs');
    await expect(app.page.locator('main:visible').getByText('Temporary history failure')).not.toBeVisible();
  } finally { await app.context.close(); }
});
