import { test, expect, launchAutomaticBackups } from '../fixtures/extension';
import type { Request } from '../../../src/protocol';

test('calendar navigation pages by the fitted month count after resizing and stops at the current month', async () =>
{
  const app = await launchAutomaticBackups();
  try {
    const calendar = app.page.getByRole('region', { name: 'Backup calendar', exact: true });
    const previous = calendar.locator('.calendar-previous');
    const next = calendar.locator('.calendar-next');
    const groups = calendar.locator('.calendar-month-group');
    const months = () => groups.evaluateAll(elements => elements.map(element => {
      const day = element.querySelector<HTMLButtonElement>('.calendar-day');
      if (!day) throw new Error('Calendar month missing');
      const date = new Date(Number(day.dataset.start));
      return date.getFullYear() * 12 + date.getMonth();
    }));
    await expect(groups).toHaveCount(4);
    const initial = await months();
    const current = initial[3];
    if (current === undefined) throw new Error('Calendar month missing');
    await previous.click();
    await expect.poll(months).toEqual(initial.map(month => month - 4));
    await previous.click();
    await expect.poll(months).toEqual(initial.map(month => month - 8));
    await next.click();
    await expect.poll(months).toEqual(initial.map(month => month - 4));
    await next.click();
    await expect.poll(months).toEqual(initial);
    await expect(next).toBeDisabled();
    await app.page.setViewportSize({ width: 380, height: 900 });
    await expect.poll(months).toEqual([current]);
    await previous.click();
    await expect.poll(months).toEqual([current - 1]);
    await app.page.setViewportSize({ width: 760, height: 900 });
    await expect.poll(months).toEqual([current - 2, current - 1]);
    await previous.click();
    await expect.poll(months).toEqual([current - 4, current - 3]);
    await app.page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(months).toEqual(initial.map(month => month - 3));
    await next.click();
    await expect.poll(months).toEqual(initial);
    await expect(next).toBeDisabled();
  } finally { await app.context.close(); }
});

test('calendar navigation preserves the displayed period until the latest request succeeds', async () =>
{
  const app = await launchAutomaticBackups();
  try {
    const calendar = app.page.getByRole('region', { name: 'Backup calendar', exact: true });
    const grid = calendar.locator('.calendar-grid');
    const period = calendar.locator('.calendar-period > span').first();
    const firstMonth = calendar.locator('.calendar-month').first();
    const loading = calendar.locator('.calendar-loading');
    const previous = calendar.getByRole('button', { name: 'Prev', exact: true });
    const next = calendar.getByRole('button', { name: 'Next', exact: true });
    await expect(grid).toHaveAttribute('aria-busy', 'false');
    const originalPeriod = await period.textContent();
    const originalMonth = await firstMonth.textContent();
    const originalHeight = await calendar.evaluate(element => element.getBoundingClientRect().height);
    const originalTop = await app.page.locator('.history-panel').first().evaluate(element => element.getBoundingClientRect().top);
    await app.page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let count = 0;
      let fail = false;
      document.addEventListener('fail-calendar', () => { fail = true; });
      Object.defineProperty(chrome.runtime, 'sendMessage', { configurable: true, value: async (message: Request) => {
        if (message.kind !== 'calendar') return original(message);
        const index = ++count;
        const failure = fail;
        fail = false;
        const released = new Promise<void>(resolve => document.addEventListener(`release-calendar-${index}`, () => resolve(), { once: true }));
        document.documentElement.dataset.calendarRequests = String(index);
        const reply = await original(message);
        await released;
        return failure ? { ok: false, error: 'Temporary calendar failure' } : reply;
      } });
    });
    await previous.click();
    await expect(grid).toHaveAttribute('aria-busy', 'true');
    await expect(firstMonth).toBeVisible({ timeout: 1000 });
    await expect(period).toHaveText(originalPeriod!);
    await expect(firstMonth).toHaveText(originalMonth!);
    await expect(loading).toBeVisible();
    expect(await calendar.evaluate(element => element.getBoundingClientRect().height)).toBe(originalHeight);
    expect(await app.page.locator('.history-panel').first().evaluate(element => element.getBoundingClientRect().top)).toBe(originalTop);
    await app.page.evaluate(() => document.dispatchEvent(new Event('release-calendar-1')));
    await expect(grid).toHaveAttribute('aria-busy', 'false');
    await expect(period).not.toHaveText(originalPeriod!);
    await expect(firstMonth).not.toHaveText(originalMonth!);
    await expect(loading).toBeHidden();
    const earlierPeriod = await period.textContent();
    const earlierMonth = await firstMonth.textContent();

    await app.page.evaluate(() => document.dispatchEvent(new Event('fail-calendar')));
    await previous.click();
    await app.page.evaluate(() => document.dispatchEvent(new Event('release-calendar-2')));
    const retry = calendar.getByRole('button', { name: 'Retry calendar', exact: true });
    await expect(retry).toBeVisible();
    await expect(firstMonth).toBeVisible();
    await expect(firstMonth).toHaveText(earlierMonth!);
    await expect(period).toHaveText(earlierPeriod!);
    await expect(loading).toBeHidden();
    await retry.click();
    await app.page.evaluate(() => document.dispatchEvent(new Event('release-calendar-3')));
    await expect(grid).toHaveAttribute('aria-busy', 'false');
    await expect(retry).toBeHidden();
    await expect(firstMonth).not.toHaveText(earlierMonth!);

    // finish the newer navigation before the older response arrives
    await previous.click();
    await next.click();
    await expect(app.page.locator('html')).toHaveAttribute('data-calendar-requests', '5');
    await app.page.evaluate(() => document.dispatchEvent(new Event('release-calendar-5')));
    await expect(grid).toHaveAttribute('aria-busy', 'false');
    const latestPeriod = await period.textContent();
    const latestMonth = await firstMonth.textContent();
    await app.page.evaluate(() => document.dispatchEvent(new Event('release-calendar-4')));
    // allow an obsolete delayed loading indicator to fire if it was not cancelled
    await app.page.waitForTimeout(350);
    await expect(period).toHaveText(latestPeriod!);
    await expect(firstMonth).toHaveText(latestMonth!);
    await expect(loading).toBeHidden();
    await expect(grid).toHaveAttribute('aria-busy', 'false');
  } finally { await app.context.close(); }
});
