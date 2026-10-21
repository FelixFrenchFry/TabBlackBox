import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import { importArchive } from '../fixtures/archive';

test('history starts with 5 sessions and adds 10 per click until exhausted', async ({ extensionContext }) =>
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  for (const other of context.pages()) if (other !== page) await other.close();
  await importArchive(page, { format: 'tabblackbox', version: 1, sessions: Array.from({ length: 80 }, (_, index) => ({
    capturedAt: index + 1, name: null, source: 'manual',
    windows: [{ groups: [], tabs: Array.from({ length: index + 1 }, () => ({ url: 'about:blank', title: 'Saved page', pinned: false, group: null })) }],
  })) });
  await page.reload();
  const panel = page.getByRole('region', { name: 'Manual backups', exact: true });
  await expect(panel.locator('.backup-row')).toHaveCount(5);
  const more = panel.getByRole('button', { name: 'Load more', exact: true });
  for (const count of [15, 25, 35, 45, 55, 65, 75, 80]) {
    await more.click();
    await expect(panel.locator('.backup-row')).toHaveCount(count);
  }
  await expect(more).toBeHidden();
  expect(await panel.locator('.backup-counts > .muted').allTextContents()).toEqual([...Array.from({ length: 79 }, (_, index) => `1 window · ${80 - index} tabs`), '1 window · 1 tab']);
});
