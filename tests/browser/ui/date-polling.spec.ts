import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Request, Reply } from '../../../src/protocol';

for (const view of ['popup', 'backups']) {
  test(view + ' preserves status timestamps and lets only the date clock advance relative text', async ({ extensionContext }) => {
    const context = await extensionContext();
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('tabblackbox.date-format', 'relative');
      let now = Date.now();
      const savedAt = now - 20_000;
      Date.now = () => now;
      document.addEventListener('advance-date', () => { now += 1500; });
      Object.defineProperty(window, 'setInterval', { value: (callback: () => void, delay: number) => {
        document.addEventListener(delay === 1000 ? 'date-tick' : 'poll-tick', callback);
        return 0;
      } });
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let polls = 0;
      Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> => {
        const result: Reply = await original(message);
        if (result.ok && result.data.kind === 'overview') {
          result.data.overview.status = { kind: 'pending' };
          result.data.overview.metadata.automatic = { enabled: true, intervalMinutes: 1440, pausedUntil: null };
          result.data.overview.metadata.lastSavedAt = savedAt;
        }
        if (message.kind === 'overview') document.documentElement.dataset.polls = String(++polls);
        return result;
      } });
    });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/${view}.html`);
    await enableAutomaticBackups(page);
    if (view === 'backups') await page.locator('.status-summary').click();
    const time = page.locator('.status-card:visible .status-times time').first();
    await expect(page.locator('.status-card:visible .status-times time')).toHaveCount(1);
    await expect(time).toHaveText('20 seconds ago');
    await expect(page.locator('.status-card:visible .status-title')).toContainText('Changes waiting for the next backup');
    await expect(page.locator('.status-card:visible .scheduled-backup time')).toHaveText('in 23 hours');
    const exact = await time.evaluate(element => new Date(element.getAttribute('datetime') ?? '').toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const tooltip = page.locator('#timestamp-tooltip');
    await time.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(exact);
    await expect(tooltip).toHaveClass(/panel-help-popover/);
    await expect(time).not.toHaveAttribute('title');
    await expect(time).toHaveAttribute('aria-describedby', 'timestamp-tooltip');
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await page.mouse.move(0, 0);
    await time.hover();
    await expect(tooltip).toBeVisible();
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.dispatchEvent(new Event('date-tick')));
    await expect(tooltip).toBeHidden();
    await time.focus();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(exact);
    await page.keyboard.press('Escape');
    await time.evaluate(element => element.blur());
    const node = await time.elementHandle();
    if (!node) throw new Error('Missing timestamp');
    await page.evaluate(() => {
      document.dispatchEvent(new Event('advance-date'));
      document.dispatchEvent(new Event('poll-tick'));
    });
    await expect(page.locator('html')).toHaveAttribute('data-polls', '1');
    await expect(time).toHaveText('20 seconds ago');
    await expect(page.locator('.status-card:visible .status-title')).toContainText('Changes waiting for the next backup');
    await expect(page.locator('.status-card:visible .scheduled-backup time')).toHaveText('in 23 hours');
    expect(await node.evaluate(element => element.isConnected)).toBe(true);
    await page.evaluate(() => document.dispatchEvent(new Event('date-tick')));
    await expect(time).toHaveText('21 seconds ago');
    await time.evaluate(element => {
      document.documentElement.dataset.timeMutations = '0';
      new MutationObserver(records => {
        document.documentElement.dataset.timeMutations = String(Number(document.documentElement.dataset.timeMutations) + records.length);
      }).observe(element, { childList: true, characterData: true, subtree: true, attributes: true });
    });
    await page.evaluate(() => document.dispatchEvent(new Event('date-tick')));
    await expect(page.locator('html')).toHaveAttribute('data-time-mutations', '0');
    await page.evaluate(() => {
      localStorage.setItem('tabblackbox.date-format', 'exact');
      window.dispatchEvent(new Event('dateformatchange'));
    });
    const next = page.locator('.status-card:visible .scheduled-backup time');
    await expect(next).toHaveText(/20[0-9]{2}/);
    await page.evaluate(() => {
      localStorage.setItem('tabblackbox.date-format', 'combination');
      window.dispatchEvent(new Event('dateformatchange'));
    });
    await expect(next).toHaveText(/20[0-9]{2}.*[(]in 23 hours[)]/);
    await next.focus();
    await expect(tooltip).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem('tabblackbox.date-format', 'exact');
      window.dispatchEvent(new Event('dateformatchange'));
    });
    await expect(tooltip).toBeHidden();
    await expect(next).not.toHaveAttribute('tabindex');
  });
}
