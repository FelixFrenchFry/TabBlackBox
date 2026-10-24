import { test, expect, launchAutomaticBackups } from '../fixtures/extension';
import type { StoredSnapshot } from '../../../src/model';
import { send, seed, settledBackup } from '../fixtures/session';

test('captures, previews, restarts and restores real windows, pins, groups and duplicate URLs', async ({ testServer: baseUrl }, testInfo) =>
{
  const profile = testInfo.outputPath('profile');
  let app = await launchAutomaticBackups(profile);
  const errors: string[] = [];
  app.page.on('pageerror', error => errors.push(error.message));
  try {
    // capture tab changes after the settling delay instead of the product backup frequency
    await send(app.page, { kind: 'automatic-settings', update: { kind: 'frequency', value: 0 } });
    const sourceWindows = await seed(app.page, baseUrl);
    const backup = await settledBackup(app.page, 5);
    expect(backup.windows).toHaveLength(2);
    expect(backup.windows.flatMap(window => window.tabs).filter(tab => tab.pinned)).toHaveLength(1);
    const stored = await app.page.evaluate(async id => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('tabblackbox');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<StoredSnapshot>((resolve, reject) => {
          const request = db.transaction('snapshots').objectStore('snapshots').get(id);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally { db.close(); }
    }, backup.id);
    const references = stored.windows.flatMap(window => window.tabs);
    expect(references.every(id => typeof id === 'number')).toBe(true);
    expect(new Set(references).size).toBeLessThan(references.length);
    await app.page.reload();
    const firstRow = app.page.locator('.backup-row').first();
    await firstRow.locator('summary').first().click();
    await expect(firstRow.getByText('Will be skipped')).toBeVisible();
    await expect(firstRow.locator('.group-label')).toHaveCount(2);
    await app.page.screenshot({ path: testInfo.outputPath('history-light.png'), fullPage: true });
    await app.page.emulateMedia({ colorScheme: 'dark' });
    await expect(app.page.locator('html')).toHaveAttribute('data-color-mode', 'dark');
    await app.page.screenshot({ path: testInfo.outputPath('history-dark.png'), fullPage: true });
    const popup = await app.context.newPage();
    await popup.goto(`chrome-extension://${app.extensionId}/popup.html`);
    await expect(popup.getByRole('button', { name: 'Back up now' })).toBeVisible();
    await expect(popup.getByText(/Current tabs backed up (automatically|manually)/)).toBeVisible();
    await popup.locator('body').screenshot({ path: testInfo.outputPath('popup.png') });
    await popup.close();
    await app.page.evaluate(async ids => { for (const id of ids) await chrome.windows.remove(id); }, sourceWindows);
    await app.context.close();
    app = await launchAutomaticBackups(profile);
    const persisted = await send(app.page, { kind: 'snapshot', id: backup.id });
    expect(persisted).toEqual({ kind: 'snapshot', snapshot: backup });
    const existing = await app.page.evaluate(async () => (await chrome.tabs.query({})).map(tab => ({ id: tab.id, url: tab.url })));
    // exercise confirmation after selecting the saved row
    await app.page.reload();
    const history = await send(app.page, { kind: 'history', before: null });
    if (history.kind !== 'history') throw new Error('History missing');
    const panel = app.page.getByRole('region', { name: backup.source === 'manual' ? 'Manual backups' : 'Automatic backups', exact: true });
    const index = history.items.filter(item => item.source === backup.source).findIndex(item => item.id === backup.id);
    const row = panel.locator('.backup-row').nth(index);
    await row.getByRole('button', { name: 'Restore', exact: true }).click();
    const dialog = app.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await app.page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await row.getByRole('button', { name: 'Restore', exact: true }).click();
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(async () =>
    {
      const value = await send(app.page, { kind: 'overview' });
      const operation = value.kind === 'overview' ? value.overview.metadata.operation : null;
      return operation ? `${operation.kind} ${operation.snapshotId}` : null;
    }).toBe(`completed ${backup.id}`);
    const restored = await app.page.evaluate(async ids =>
    {
      const windows = await chrome.windows.getAll({ populate: true });
      const groups = await chrome.tabGroups.query({});
      // restored tabs report their address as pending until the first navigation commits
      const tabs = (await chrome.tabs.query({})).map(tab => ({ ...tab, url: tab.pendingUrl || tab.url }));
      return { windows: windows.filter(window => window.tabs?.some(tab => !ids.includes(tab.id))), groups, tabs };
    }, existing.map(tab => tab.id));
    for (const previous of existing) expect(restored.tabs.find(tab => tab.id === previous.id)?.url).toBe(previous.url);
    const actual = restored.tabs.filter(tab => !existing.some(previous => previous.id === tab.id));
    expect(actual).toHaveLength(4);
    expect(actual.filter(tab => tab.url === `${baseUrl}/two`)).toHaveLength(2);
    expect(actual.filter(tab => tab.pinned)).toHaveLength(1);
    expect(restored.groups.some(group => group.title === 'Research' && group.color === 'blue' && group.collapsed)).toBe(true);
    expect(restored.windows).toHaveLength(2);
    expect(actual.filter(tab => tab.windowId === actual[0]?.windowId).map(tab => tab.url)).toEqual([`${baseUrl}/one`, `${baseUrl}/two`, `${baseUrl}/two`]);
    expect(errors).toEqual([]);
  } finally { await app.context.close(); }
});
