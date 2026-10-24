import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import { readFile } from 'node:fs/promises';
import { importArchive } from '../fixtures/archive';

test('keeps, saves, searches, exports and imports sessions in separate history panels', async ({ extensionContext }, testInfo) => {
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  await page.evaluate(async () => {
    await chrome.tabs.create({ url: 'about:blank' });
    for (const message of [{ kind: 'automatic-settings', update: { kind: 'enabled', value: false } }]) {
      const reply = await chrome.runtime.sendMessage(message);
      if (!reply.ok) throw new Error(reply.error);
    }
  });
  await page.reload();
  const saved = page.getByRole('region', { name: 'Manual backups', exact: true });
  const automatic = page.getByRole('region', { name: 'Automatic backups', exact: true });
  await expect(automatic.locator('.backup-row').first()).toBeVisible();
  const captureDate = await automatic.locator('time').first().getAttribute('datetime');
  const keep = automatic.getByRole('button', { name: 'Keep session', exact: true }).first();
  await expect(keep).toHaveText('');
  await expect(keep).toHaveAttribute('data-tooltip', 'Keep as a manual backup');
  await keep.click();
  const dialog = page.getByRole('dialog', { name: 'Keep this session', exact: true });
  await expect(dialog.locator('form > p.muted')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'About keeping this session', exact: true }).hover();
  await expect(dialog.getByRole('tooltip')).toHaveText('Turn this automatic backup into a manual backup, so it remains saved until you delete it. Give it a name, or leave it blank to use ‘Unnamed session’.');
  await expect(dialog.getByRole('tooltip')).toBeVisible();
  // move away so the help popover no longer covers the dialog actions
  await page.mouse.move(0, 0);
  await expect(dialog.getByRole('tooltip')).toBeHidden();
  await dialog.getByLabel('Name', { exact: true }).fill('Research');
  await dialog.getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(saved.locator('.backup-title')).toHaveText('Research');
  await expect(saved.locator('.backup-number')).toHaveText('#1');
  await expect(saved.locator('time')).toHaveAttribute('datetime', captureDate!);
  await expect(page.getByRole('button', { name: 'Save current session', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back up now', exact: true }).click();
  await expect(page.getByText('Saved to Manual backups', { exact: true })).toHaveCount(0);
  await expect(saved.locator('.backup-row')).toHaveCount(2);
  await expect(saved.locator('.backup-number')).toHaveText(['#2', '#1']);
  await saved.getByRole('searchbox').fill('research');
  await expect(saved.locator('.backup-row')).toHaveCount(1);
  await saved.getByRole('searchbox').fill('');
  await expect(saved.locator('.backup-row')).toHaveCount(2);
  await expect(page.locator('.backup-summary > .badge')).toHaveCount(0);
  const research = saved.locator('.backup-row').filter({ hasText: 'Research' });
  await research.locator('summary').click();
  await expect(research.locator('.snapshot-preview')).toBeVisible();
  const pending = page.waitForEvent('download');
  await saved.getByRole('button', { name: 'Export all', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await pending;
  const path = testInfo.outputPath('sessions.json');
  await download.saveAs(path);
  const exported = JSON.parse(await readFile(path, 'utf8'));
  expect(exported.sessions).toHaveLength(2);
  await expect(research.getByRole('button', { name: 'Export session', exact: true })).toHaveAttribute('data-tooltip', 'Export session to a file');
  const remove = research.getByRole('button', { name: 'Delete session', exact: true });
  await expect(remove).toHaveAttribute('data-tooltip', 'Delete this manual backup');
  await remove.click();
  // name the panel beside the number because both panels number their own backups
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Delete manual backup?', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').locator('.session-card-name .muted')).toHaveText(/^Manual backup #\d+$/);
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(saved.locator('.backup-row')).toHaveCount(1);
  await page.locator('input[type="file"]').setInputFiles(path);
  await expect(saved.locator('.backup-row')).toHaveCount(3);
  await page.reload();
  await expect(saved.locator('.backup-row')).toHaveCount(3);
  expect((await saved.locator('.backup-number').allTextContents()).sort()).toEqual(['#2', '#3', '#4']);
  await page.screenshot({ path: testInfo.outputPath('saved-sessions.png'), fullPage: true });
  await page.setViewportSize({ width: 400, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('keeping an automatic backup leaves the manual backup search in place', async ({ extensionContext }) => {
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  const tab = { url: 'https://example.test/', title: 'Example', pinned: false, group: null };
  await importArchive(page, { format: 'tabblackbox', version: 1, sessions: ['Alpha', 'Beta'].map((name, index) => ({ capturedAt: index + 1, name, source: 'manual' as const, windows: [{ groups: [], tabs: [tab] }] })) });
  const saved = page.getByRole('region', { name: 'Manual backups', exact: true });
  const automatic = page.getByRole('region', { name: 'Automatic backups', exact: true });
  const search = saved.getByRole('searchbox', { name: 'Search manual backups', exact: true });
  await search.fill('alpha');
  await expect(saved.locator('.backup-title')).toHaveText(['Alpha']);
  await automatic.getByRole('button', { name: 'Keep session', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Keep this session', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('Gamma');
  await dialog.getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // the kept session joins the panel while the search still shows only its matches
  await expect(saved.locator('.list-header .badge')).toHaveText('3');
  await expect(search).toHaveValue('alpha');
  await expect(saved.locator('.backup-title')).toHaveText(['Alpha']);
  await search.fill('');
  await expect(saved.locator('.backup-title')).toHaveText(['Gamma', 'Beta', 'Alpha']);
});
