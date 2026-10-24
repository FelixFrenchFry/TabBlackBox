import { test, expect, launchAutomaticBackups } from '../fixtures/extension';
import type { Request } from '../../../src/protocol';
import { send } from '../fixtures/session';

test('backup calendar filters both lists, preserves sorting, and retries a failed date load', async ({ testServer: baseUrl }) =>
{
  const app = await launchAutomaticBackups();
  try {
    const { today, yesterday } = await app.page.evaluate(() => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      const today = date.getTime();
      date.setDate(date.getDate() - 1);
      return { today, yesterday: date.getTime() };
    });
    await send(app.page, { kind: 'automatic-settings', update: { kind: 'frequency', value: 0 } });
    const calendarTab = await app.page.evaluate(async url => (await chrome.tabs.create({ url })).id, `${baseUrl}/calendar`);
    // capture the loaded title so a later capture does not add a second automatic backup
    await expect.poll(() => app.page.evaluate(async id => {
      const tab = await chrome.tabs.get(id!);
      return tab.status === 'complete' ? tab.title : null;
    }, calendarTab)).toBe('Research /calendar');
    await send(app.page, { kind: 'refresh' });
    await send(app.page, { kind: 'import', archive: { format: 'tabblackbox', version: 1, sessions: Array.from({ length: 15 }, (_, index) => ({
      capturedAt: index === 14 ? yesterday : today + index, name: index === 14 ? 'Yesterday' : `Calendar ${String(index + 1).padStart(2, '0')}`, source: 'manual',
      windows: [{ groups: [], tabs: [{ url: 'https://example.test', title: 'Saved tab', pinned: false, group: null }] }],
    })) } });
    await app.page.reload();
    const calendar = app.page.getByRole('region', { name: 'Backup calendar', exact: true });
    const savedPanel = app.page.getByRole('region', { name: 'Manual backups', exact: true });
    const automaticPanel = app.page.getByRole('region', { name: 'Automatic backups', exact: true });
    const todayCell = calendar.locator(`[data-start="${today}"]`);
    const yesterdayCell = calendar.locator(`[data-start="${yesterday}"]`);
    await expect(todayCell).toHaveAttribute('aria-label', /14 manual$/);
    await expect(todayCell).toHaveAttribute('data-level', '3');
    await expect(yesterdayCell).toHaveAttribute('data-level', '1');
    await expect(todayCell).toHaveCSS('width', '28px');
    await expect(todayCell).toHaveAttribute('aria-current', 'date');
    await expect(todayCell).toHaveCSS('text-decoration-line', 'none', { timeout: 1000 });
    const tooltip = calendar.locator('#calendar-day-tooltip');
    await expect(calendar.locator('.calendar-detail')).toHaveCount(0, { timeout: 1000 });
    await expect(todayCell).not.toHaveAttribute('title');
    await todayCell.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator(':scope > div')).toHaveText([(await todayCell.getAttribute('aria-label'))!.split(' · ')[0]!, '1 automatic · 14 manual']);
    await tooltip.hover();
    await expect(tooltip).toBeVisible();
    await yesterdayCell.hover();
    await expect(tooltip.locator(':scope > div')).toHaveText([(await yesterdayCell.getAttribute('aria-label'))!.split(' · ')[0]!, '0 automatic · 1 manual']);
    await calendar.locator('.calendar-day[data-level="0"]:enabled').first().hover();
    await expect(tooltip).toContainText('No stored backups');
    await calendar.locator('summary').hover();
    await expect(tooltip).toBeHidden();
    await todayCell.focus();
    await expect(tooltip).toBeVisible();
    await app.page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await expect(todayCell).toBeFocused();
    await app.page.keyboard.press('ArrowLeft');
    await expect(tooltip.locator(':scope > div')).toHaveText([(await yesterdayCell.getAttribute('aria-label'))!.split(' · ')[0]!, '0 automatic · 1 manual']);
    await calendar.getByRole('button', { name: 'Prev', exact: true }).focus();
    await expect(tooltip).toBeHidden();
    await expect(calendar.locator('.calendar-weekday')).toHaveCount(28);
    await expect(calendar.locator('.calendar-month-group')).toHaveCount(4);
    const legend = calendar.locator('.calendar-legend');
    const period = await calendar.locator('.calendar-period').boundingBox();
    const legendBounds = await legend.boundingBox();
    expect(legendBounds!.x).toBeGreaterThanOrEqual(period!.x + period!.width);
    expect(Math.abs(legendBounds!.y + legendBounds!.height / 2 - period!.y - period!.height / 2)).toBeLessThan(1);
    expect(await calendar.locator('.calendar-month-group').evaluateAll(months => months.every(month => {
      const days = [...month.querySelectorAll<HTMLButtonElement>('.calendar-day')];
      const first = new Date(Number(days[0]?.dataset.start));
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return days.length === new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate() && days.every((day, index) => {
        const date = new Date(Number(day.dataset.start));
        return date.getMonth() === first.getMonth() && day.textContent === String(index + 1) &&
          day.style.gridColumnStart === String((date.getDay() + 6) % 7 + 1) &&
          day.style.gridRowStart === String(Math.floor(((first.getDay() + 6) % 7 + index) / 7) + 3) &&
          day.disabled === (date.getTime() > today.getTime());
      });
    }))).toBe(true);
    await expect(calendar.locator('.calendar-swatch:visible')).toHaveCount(4);
    await expect(calendar.locator('.calendar-swatch[data-level="3"]')).toHaveAttribute('title', /2–\d+ backups/);
    await expect(calendar.locator('.calendar-swatch[data-level="2"]')).toHaveAttribute('title', 'Unused for this period');
    await expect(calendar.locator('.calendar-swatch[data-level="2"]')).toHaveAttribute('aria-label', 'Unused for this period');
    const help = calendar.getByRole('button', { name: 'About the backup calendar' });
    await help.click();
    await expect(calendar.locator('#calendar-help')).toHaveText('Browse backups by capture date. Darker colors indicate more backups, with details available when you hover over a day. Select a day to apply a filter to the backup lists.');
    await app.page.keyboard.press('Escape');
    const heading = calendar.locator('summary');
    const chevron = heading.locator(':scope > svg');
    await expect(chevron).toBeVisible({ timeout: 1000 });
    await expect(heading).toHaveCSS('list-style-type', 'none');
    await expect(chevron).toHaveCSS('width', '16px');
    await expect(chevron).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    await heading.click();
    await expect(todayCell).toBeHidden();
    const sessionChevron = savedPanel.locator('.backup-summary > svg').first();
    await expect(chevron).toHaveCSS('transform', await sessionChevron.evaluate(element => getComputedStyle(element).transform));
    await expect(chevron).toHaveCSS('color', await sessionChevron.evaluate(element => getComputedStyle(element).color));
    await heading.press('Enter');
    await expect(todayCell).toBeVisible();
    await expect(chevron).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    const savedHeight = await savedPanel.evaluate(element => element.getBoundingClientRect().height);
    const automaticHeight = await automaticPanel.evaluate(element => element.getBoundingClientRect().height);
    await app.page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let hold = true;
      document.addEventListener('hold-date-history', () => { hold = true; });
      document.addEventListener('release-date-history', () => { hold = false; });
      Object.defineProperty(chrome.runtime, 'sendMessage', { configurable: true, value: async (message: Request) => {
        if (message.kind === 'history' && hold) await new Promise<void>(resolve => document.addEventListener('release-date-history', () => resolve(), { once: true }));
        return original(message);
      } });
    });
    await todayCell.click();
    await expect(tooltip).toBeHidden();
    expect(await savedPanel.evaluate(element => element.getBoundingClientRect().height)).toBe(savedHeight);
    expect(await automaticPanel.evaluate(element => element.getBoundingClientRect().height)).toBe(automaticHeight);
    await expect(savedPanel.locator('.history-rows')).toHaveJSProperty('inert', true);
    await expect(automaticPanel.locator('.history-rows')).toHaveJSProperty('inert', true);
    await savedPanel.getByRole('button', { name: 'Restore', exact: true }).first().focus();
    await expect(savedPanel.getByRole('button', { name: 'Restore', exact: true }).first()).not.toBeFocused();
    await expect(savedPanel.getByText('Loading backups…', { exact: true })).toBeVisible();
    // superseded date requests must not replace the final selected day's rows
    await yesterdayCell.click();
    await todayCell.click();
    expect(await savedPanel.evaluate(element => element.getBoundingClientRect().height)).toBe(savedHeight);
    await app.page.evaluate(() => document.dispatchEvent(new Event('release-date-history')));
    await expect(savedPanel.locator('.history-rows')).toHaveJSProperty('inert', false);
    await expect(savedPanel.locator('.backup-title')).toHaveCount(5);
    await savedPanel.getByRole('button', { name: 'Show more', exact: true }).click();
    await expect(savedPanel.locator('.backup-title')).toHaveCount(10);
    await savedPanel.getByRole('button', { name: 'Show more', exact: true }).click();
    await expect(savedPanel.locator('.backup-title')).toHaveCount(14);
    await expect(automaticPanel.locator('.backup-row').first()).toBeVisible();
    await savedPanel.getByRole('button', { name: /^Date,/ }).click();
    await expect(savedPanel.locator('.backup-title').first()).toHaveText('Calendar 01');
    await app.page.getByRole('searchbox', { name: 'Search manual backups' }).fill('Calendar 01');
    await expect(savedPanel.locator('.backup-title')).toHaveText(['Calendar 01']);
    await app.page.getByRole('searchbox', { name: 'Search manual backups' }).fill('');
    await yesterdayCell.click();
    await expect(savedPanel.locator('.backup-title')).toHaveText(['Yesterday']);
    await expect(automaticPanel.getByText('No matching backups on this date')).toBeVisible();
    await app.page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let fail = true;
      Object.defineProperty(chrome.runtime, 'sendMessage', { configurable: true, value: async (message: Request) => {
        if (message.kind === 'history' && message.collection === 'saved' && message.range && fail) {
          fail = false;
          return { ok: false, error: 'Temporary date failure' };
        }
        return original(message);
      } });
    });
    await todayCell.click();
    const retry = savedPanel.getByRole('button', { name: 'Retry loading backups' });
    await expect(retry).toBeVisible();
    await expect(savedPanel.locator('.history-rows')).toHaveJSProperty('inert', true);
    await savedPanel.getByRole('button', { name: 'Restore', exact: true }).first().focus();
    await expect(savedPanel.getByRole('button', { name: 'Restore', exact: true }).first()).not.toBeFocused();
    await retry.click();
    await expect(savedPanel.locator('.history-rows')).toHaveJSProperty('inert', false);
    await expect(savedPanel.locator('.backup-title').first()).toHaveText('Calendar 01');
    await expect(savedPanel.locator('.backup-title')).toHaveCount(5);
    await app.page.setViewportSize({ width: 380, height: 900 });
    await expect(calendar.locator('.calendar-month-group')).toHaveCount(1);
    await expect(legend).toBeVisible();
    const narrowLegend = await legend.boundingBox();
    expect(narrowLegend!.x + narrowLegend!.width).toBeLessThanOrEqual(380);
    await expect(todayCell).toHaveAttribute('aria-pressed', 'true');
    await todayCell.hover();
    await expect(tooltip).toBeVisible();
    const bounds = await tooltip.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(16);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(364);
    expect(bounds!.y).toBeGreaterThanOrEqual(16);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(884);
    await app.page.setViewportSize({ width: 760, height: 900 });
    await expect(tooltip).toBeHidden();
    await expect(calendar.locator('.calendar-month-group')).toHaveCount(2);
    await app.page.setViewportSize({ width: 1280, height: 900 });
    await expect(calendar.locator('.calendar-month-group')).toHaveCount(4);
    await calendar.getByRole('button', { name: 'Prev', exact: true }).click();
    await expect(todayCell).toBeHidden();
    await expect(calendar.locator('.calendar-swatch:visible')).toHaveCount(4);
    if (new Date(today).getDate() > 1) {
      await expect(calendar.locator('.calendar-swatch[title="Unused for this period"]')).toHaveCount(3);
      await expect(calendar.locator('.calendar-day:not([data-level="0"])')).toHaveCount(0);
    }
    await calendar.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(todayCell).toHaveAttribute('aria-pressed', 'true');
    await app.page.evaluate(today => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      Object.defineProperty(chrome.runtime, 'sendMessage', { configurable: true, value: async (message: Request) => {
        if (message.kind === 'calendar' && message.range.end <= today) return { ok: false, error: 'Temporary calendar failure' };
        return original(message);
      } });
    }, today);
    await calendar.getByRole('button', { name: 'Prev', exact: true }).click();
    await expect(calendar.getByRole('button', { name: 'Retry calendar' })).toBeVisible();
    await calendar.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(todayCell).toBeVisible();
    await expect(calendar.getByRole('button', { name: 'Retry calendar' })).toBeHidden();
    await todayCell.focus();
    await app.page.keyboard.press('ArrowLeft');
    await expect(yesterdayCell).toBeFocused();
    await expect(tooltip).toBeVisible();
    await calendar.locator('summary').click();
    await expect(tooltip).toBeHidden();
    await expect(calendar.getByRole('button', { name: 'Clear date filter' })).toBeVisible();
    const filteredHeight = await savedPanel.evaluate(element => element.getBoundingClientRect().height);
    await app.page.evaluate(() => document.dispatchEvent(new Event('hold-date-history')));
    await calendar.getByRole('button', { name: 'Clear date filter' }).click();
    expect(await savedPanel.evaluate(element => element.getBoundingClientRect().height)).toBe(filteredHeight);
    await expect(savedPanel.locator('.history-rows')).toHaveJSProperty('inert', true);
    await app.page.evaluate(() => document.dispatchEvent(new Event('release-date-history')));
    await expect(savedPanel.locator('.history-rows')).toHaveJSProperty('inert', false);
    await expect(savedPanel.locator('.backup-title').first()).toHaveText('Yesterday');
    await expect(savedPanel.getByRole('button', { name: /^Date,/ })).toHaveAttribute('aria-label', 'Date, oldest first. Sort newest first');
  } finally { await app.context.close(); }
});
