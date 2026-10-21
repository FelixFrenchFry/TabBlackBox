import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Reply, Request } from '../../../src/protocol';

test('storage autosave settles edits, validates fields, commits on Enter and blur, and retries failures', async ({ extensionContext }) => {
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> => {
      if (message.kind === 'storage-settings') {
        const data = document.documentElement.dataset;
        data.saves = String(Number(data.saves ?? 0) + 1);
        data.savedSettings = JSON.stringify(message.settings);
        data.delay = String(performance.now() - Number(data.editTime));
        if (data.fail === 'true') { data.fail = 'false'; return { ok: false, error: 'Save failed for test' }; }
      }
      return original(message);
    } });
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html#settings`);
  await enableAutomaticBackups(page);
  const input = page.getByLabel('Space limit', { exact: true });
  const status = page.locator('.toast-region');
  await expect(input).toBeEnabled();
  await input.evaluate(node => {
    if (!(node instanceof HTMLInputElement)) throw new Error('Missing input');
    document.documentElement.dataset.editTime = String(performance.now());
    node.focus(); node.value = '300'; node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(status).toHaveText('Settings have been saved');
  expect(await page.evaluate(() => Number(document.documentElement.dataset.delay))).toBeGreaterThanOrEqual(240);
  await expect(input).toBeFocused();
  await input.fill('');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.setting-validation:visible')).toHaveCount(1);
  await input.evaluate(node => {
    if (!(node instanceof HTMLInputElement)) throw new Error('Missing input');
    node.value = '301'; node.dispatchEvent(new Event('input', { bubbles: true }));
    node.value = '300'; node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // wait past the 250 ms autosave delay to confirm that returning to the saved value does not save again
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.documentElement.dataset.saves)).toBe('1');
  await input.evaluate(node => {
    if (!(node instanceof HTMLInputElement)) throw new Error('Missing input');
    node.value = '350'; node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    if (document.documentElement.dataset.saves !== '2') throw new Error('Enter did not save immediately');
  });
  await expect(status).toHaveText('Settings have been saved');
  await expect(input).toBeEnabled();
  await input.evaluate(node => {
    if (!(node instanceof HTMLInputElement)) throw new Error('Missing input');
    document.documentElement.dataset.fail = 'true';
    node.value = '400'; node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    if (document.documentElement.dataset.saves !== '3') throw new Error('Blur did not save immediately');
  });
  await expect(page.getByText('Save failed for test')).toBeVisible();
  await expect(page.getByText('Save failed for test')).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(status).toHaveText('Settings have been saved');
  await page.reload();
  await expect(input).toHaveValue('400');
  const toggle = page.getByRole('switch', { name: 'Enable backup limit' });
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(toggle).not.toBeChecked();
  const label = page.locator('.limit-toggle').filter({ has: toggle }).locator('span');
  const box = await label.boundingBox();
  if (!box) throw new Error('Missing toggle label');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await input.fill('450');
  await page.mouse.down();
  // hold the pointer past the 250 ms autosave delay to confirm that the edit waits for the toggle click
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => document.documentElement.dataset.saves)).toBeUndefined();
  await page.mouse.up();
  await expect(toggle).toBeChecked();
  await expect(status).toHaveText('Settings have been saved');
  expect(await page.evaluate(() => document.documentElement.dataset.saves)).toBe('1');
  expect(await page.evaluate(() => JSON.parse(document.documentElement.dataset.savedSettings!))).toEqual({ maxStorageMB: 450, maxBackups: 5000, retentionDays: null });
  await input.fill('500');
  await page.mouse.down();
  await page.mouse.move(5, 5);
  await page.mouse.up();
  await expect(status).toHaveText('Settings have been saved');
  await expect(input).toHaveValue('500');
  await expect(toggle).toBeChecked();
  await page.reload();
  await expect(input).toHaveValue('500');
  await expect(toggle).toBeChecked();
});
