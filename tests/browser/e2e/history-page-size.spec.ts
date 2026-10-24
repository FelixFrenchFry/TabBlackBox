import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import { importArchive } from '../fixtures/archive';

test('history expands in pages and collapses without changing its filters or sort', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  for (const other of context.pages()) if (other !== page) await other.close();
  await importArchive(page, { format: 'tabblackbox', version: 1, sessions: Array.from({ length: 80 }, (_, index) => ({
    capturedAt: index + 1, name: `Backup ${index + 1}`, source: 'manual',
    windows: [{ groups: [], tabs: Array.from({ length: index + 1 }, () => ({ url: 'about:blank', title: 'Saved page', pinned: false, group: null })) }],
  })) });
  await page.reload();
  const panel = page.getByRole('region', { name: 'Manual backups', exact: true });
  await expect(panel.locator('.backup-row')).toHaveCount(5);
  const more = panel.getByRole('button', { name: 'Show more', exact: true });
  const fewer = panel.getByRole('button', { name: 'Show less', exact: true });
  await expect(fewer).toBeHidden();
  for (let count = 10; count <= 80; count += 5) {
    await more.click();
    await expect(panel.locator('.backup-row')).toHaveCount(count);
  }
  // the last full page already ends the history without an empty extra page
  await expect(more).toBeHidden();
  await expect(fewer).toBeFocused();
  expect(await panel.locator('.backup-counts > .muted').allTextContents()).toEqual([...Array.from({ length: 79 }, (_, index) => `1 window · ${80 - index} tabs`), '1 window · 1 tab']);
  await fewer.click();
  await expect(panel.locator('.backup-row')).toHaveCount(5);
  await expect(more).toBeFocused();
  await expect(fewer).toBeHidden();
  await more.click();
  await expect(panel.locator('.backup-row')).toHaveCount(10);
  const footer = panel.locator('.history-pagination');
  const listBox = await panel.locator('.backup-list').boundingBox();
  const footerBox = await footer.boundingBox();
  if (!listBox || !footerBox) throw new Error('Missing backup list or pagination footer');
  expect(footerBox.x).toBeCloseTo(listBox.x + 1, 1);
  expect(footerBox.width).toBeCloseTo(listBox.width - 2, 1);
  await expect(footer).toHaveCSS('border-top-width', '1px');
  await footer.screenshot({ path: testInfo.outputPath('history-pagination.png') });
  await page.setViewportSize({ width: 400, height: 900 });
  await expect(more).toBeVisible();
  await expect(fewer).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await footer.screenshot({ path: testInfo.outputPath('history-pagination-narrow.png') });
  await page.setViewportSize({ width: 1200, height: 900 });
  const search = panel.getByRole('searchbox', { name: 'Search manual backups', exact: true });
  await search.fill('Backup 1');
  const names = panel.locator('.backup-title');
  await expect(names.first()).toHaveText('Backup 71');
  const filtered = await names.allTextContents();
  await more.click();
  await expect(names).toHaveCount(10);
  await fewer.click();
  await expect(names).toHaveText(filtered);
  await expect(search).toHaveValue('Backup 1');
  const date = panel.getByRole('button', { name: /^Date,/ });
  await date.click();
  await expect(names).toHaveText(['Backup 1', 'Backup 10', 'Backup 11', 'Backup 12', 'Backup 13']);
  await more.click();
  await expect(names).toHaveCount(10);
  await fewer.click();
  await expect(names).toHaveText(['Backup 1', 'Backup 10', 'Backup 11', 'Backup 12', 'Backup 13']);
  await expect(date).toHaveAttribute('aria-label', 'Date, oldest first. Sort newest first');
  await expect(search).toHaveValue('Backup 1');
});
