import { test, expect, launchAutomaticBackups } from '../fixtures/extension';

test('calendar colors keep the same readable day text across every intensity in both themes', async () =>
{
  const app = await launchAutomaticBackups();
  try {
    const cell = app.page.locator('.calendar-day:not(:disabled)').first();
    await expect(cell).toBeVisible();
    expect(await app.page.locator('.calendar-day').evaluateAll(days => [...new Set(days.map(day => getComputedStyle(day).fontWeight))])).toEqual(['600']);
    for (const mode of ['light', 'dark']) {
      await app.page.evaluate(mode => { document.documentElement.dataset.colorMode = mode; }, mode);
      const colors = await cell.evaluate(element => {
        const previous = element.getAttribute('data-level') ?? '0';
        const colors = Array.from({ length: 4 }, (_, level) => {
          element.setAttribute('data-level', String(level));
          const style = getComputedStyle(element);
          return { foreground: style.color, background: style.backgroundColor };
        });
        element.setAttribute('data-level', previous);
        return colors;
      });
      expect(new Set(colors.map(color => color.foreground)).size).toBe(1);
      expect(new Set(colors.map(color => color.background)).size).toBe(4);
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)?.map(Number) ?? [];
        expect(channels).toHaveLength(3);
        return channels.reduce((total, value, index) => {
          const channel = value / 255;
          return total + (index === 0 ? 0.2126 : index === 1 ? 0.7152 : 0.0722) * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
        }, 0);
      };
      for (const color of colors) {
        const foreground = luminance(color.foreground);
        const background = luminance(color.background);
        expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  } finally { await app.context.close(); }
});
