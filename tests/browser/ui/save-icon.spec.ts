import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Request } from '../../../src/protocol';

for (const view of ['backups', 'popup']) {
  test(`${view} preserves an icon click when polling finishes between mouse down and up`, async ({ extensionContext }) =>
  {
    const context = await extensionContext();
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.addInitScript(() =>
    {
      Object.defineProperty(window, 'setInterval', { value: (callback: () => void) => { document.addEventListener('test-poll', callback); return 0; } });
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let backups = 0;
      Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request) =>
      {
        if (message.kind === 'backup') document.documentElement.dataset.backupRequests = String(++backups);
        const result = await original(message);
        if (message.kind === 'overview') document.documentElement.dataset.pollResolved = 'true';
        return result;
      } });
    });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/${view}.html`);
    await enableAutomaticBackups(page);
    await expect(page.locator('.status-title').first()).toBeVisible();
    const button = page.getByRole('button', { name: 'Back up now', exact: true });
    await button.scrollIntoViewIfNeeded();
    const svg = await button.locator('svg').elementHandle();
    if (!svg) throw new Error('Save icon missing');
    const label = await button.evaluateHandle(element => element.lastChild);
    const point = await svg.evaluate(element =>
    {
      const r = element.getBoundingClientRect();
      for (let y = r.top + 1; y < r.bottom; y++) for (let x = r.left + 1; x < r.right; x++) {
        const target = document.elementFromPoint(x, y);
        if (target && target !== element && element.contains(target)) return { x, y };
      }
      throw new Error('Save icon stroke missing');
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.evaluate(() => document.dispatchEvent(new Event('test-poll')));
    await expect(page.locator('html')).toHaveAttribute('data-poll-resolved', 'true');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(await svg.evaluate(element => element.isConnected)).toBe(true);
    expect(await label.evaluate(node => node?.isConnected)).toBe(true);
    await page.mouse.up();
    await expect(page.locator('html')).toHaveAttribute('data-backup-requests', '1');
    await expect(page.getByRole('button', { name: 'Back up now', exact: true })).toBeEnabled();
    expect(await svg.evaluate(element => element.isConnected)).toBe(true);
    expect(await label.evaluate(node => node?.isConnected)).toBe(true);
  });
}
