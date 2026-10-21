import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Request } from '../../../src/protocol';

test('popup confirms saving in a disabled button without reserved feedback space', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext({ viewport: { width: 380, height: 450 } });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.addInitScript(() =>
  {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    let backups = 0;
    Object.defineProperty(window, 'setInterval', { value: (callback: () => void) => { document.addEventListener('test-poll', callback); return 0; } });
    Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request) =>
    {
      if (message.kind === 'backup') {
        document.documentElement.dataset.backups = String(++backups);
        await new Promise<void>(resolve => document.addEventListener('release-backup', () => resolve(), { once: true }));
      }
      const result = await original(message);
      if (message.kind === 'overview') document.documentElement.dataset.polled = 'true';
      return result;
    } });
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await enableAutomaticBackups(page);
  await page.evaluate(() => document.dispatchEvent(new Event('test-poll')));
  await expect(page.getByText('Current tabs backed up automatically')).toBeVisible();
  const save = page.locator('.backup-button');
  const before = await save.boundingBox();
  const footerBefore = await page.locator('.popup-footer').boundingBox();
  await expect(page.locator('.popup-feedback')).toBeHidden();
  await save.click();
  await expect(save).toHaveText('Backing up…');
  await expect(save).toBeDisabled();
  await expect(save.locator('.save-spinner')).toBeVisible();
  expect(await save.boundingBox()).toEqual(before);
  await expect(page.locator('html')).toHaveAttribute('data-backups', '1');
  await save.dispatchEvent('click');
  await page.evaluate(() => document.dispatchEvent(new Event('release-backup')));
  await expect(save).toHaveText('Saved');
  await expect(save).toBeDisabled();
  await save.dispatchEvent('click');
  await page.evaluate(() => document.dispatchEvent(new Event('test-poll')));
  await expect(page.locator('html')).toHaveAttribute('data-polled', 'true');
  await expect(save).toHaveText('Saved');
  await expect(save).toBeDisabled();
  expect(await save.boundingBox()).toEqual(before);
  expect(await page.locator('.popup-footer').boundingBox()).toEqual(footerBefore);
  await expect(page.locator('.popup-feedback')).toBeHidden();
  await expect(page.locator('.popup-footer > span')).toHaveText('Backups stay on this device. No accounts. No cloud.');
  await expect(page.locator('.popup-footer').getByRole('link', { name: 'Privacy', exact: true })).toBeVisible();
  await expect(page.locator('.popup-footer svg')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('popup-saved.png') });
  await expect(save).toHaveText('Back up now');
  await expect(save).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-backups', '1');
});
