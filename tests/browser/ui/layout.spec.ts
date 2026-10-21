import { test, expect, launchAutomaticBackups } from '../fixtures/extension';

test('switching views keeps shared layout positions stable with native scrollbars', async () =>
{
  const app = await launchAutomaticBackups();
  try {
    // model a long history without hundreds of snapshots
    await app.page.locator('main').first().evaluate(element => { element.style.minHeight = '1600px'; });
    for (const width of [1280, 1000, 800, 640, 390]) {
      await app.page.setViewportSize({ width, height: 1200 });
      const positions = async () => app.page.evaluate(() =>
      {
        return ['.brand', '.local-label', '.nav-item', 'main:not([hidden])', 'main:not([hidden]) h1'].map(selector =>
        {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`Missing ${selector}`);
          const rect = element.getBoundingClientRect();
          return { selector, x: rect.x, y: rect.y };
        });
      });
      await app.page.getByRole('link', { name: 'Backups', exact: true }).click();
      await expect(app.page.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();
      const history = await positions();
      await app.page.getByRole('link', { name: 'Settings', exact: true }).click();
      await expect(app.page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      expect(await positions(), `Shared positions at ${width}px`).toEqual(history);
    }
  } finally { await app.context.close(); }
});
