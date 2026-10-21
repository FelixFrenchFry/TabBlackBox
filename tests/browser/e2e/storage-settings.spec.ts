import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Reply } from '../../../src/protocol';

for (const mode of ['manual-only', 'disabled', 'paused'] as const) test(`storage limit edits respect ${mode} backups`, async ({ extensionContext }) =>
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html#settings`);
  if (mode !== 'manual-only') {
    await enableAutomaticBackups(page);
    const reply: Reply = await page.evaluate(async paused => chrome.runtime.sendMessage({
      kind: 'automatic-settings', update: paused ? { kind: 'pause', minutes: 15 } : { kind: 'enabled', value: false },
    }), mode === 'paused');
    if (!reply.ok) throw new Error(reply.error);
  }
  const fixture = await context.newPage();
  await fixture.goto('about:blank');
  await fixture.evaluate(() => { document.title = 'Private unsaved page'; });
  const overview = () => page.evaluate(async () => {
    const reply: Reply = await chrome.runtime.sendMessage({ kind: 'overview' });
    if (!reply.ok) throw new Error(reply.error);
    if (reply.data.kind !== 'overview') throw new Error('Missing overview');
    return reply.data.overview;
  });
  const before = await overview();
  await page.getByLabel('Space limit', { exact: true }).fill('101');
  await expect(page.locator('.toast-region')).toHaveText('Settings have been saved');
  const after = await overview();
  expect(after.metadata).toEqual({ ...before.metadata, settings: { ...before.metadata.settings, maxStorageMB: 101 } });
  expect(after.status.kind).toBe(mode === 'paused' ? 'paused' : 'disabled');
  await page.reload();
  await expect(page.getByLabel('Space limit', { exact: true })).toHaveValue('101');
  expect((await overview()).metadata).toEqual(after.metadata);
});

test('storage rows persist limits, confirm cleanup, and show decimal MB with percentage', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext({ viewport: { width: 1100, height: 1000 } });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html#settings`);
  await enableAutomaticBackups(page);
  for (const other of context.pages()) if (other !== page) await other.close();
  await page.evaluate(async () =>
  {
    await chrome.runtime.sendMessage({ kind: 'backup' });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('tabblackbox');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction(['snapshots', 'tabs', 'summaries', 'metadata'], 'readwrite');
    tx.objectStore('snapshots').clear();
    tx.objectStore('summaries').clear();
    tx.objectStore('tabs').clear();
    const now = Date.now();
    const tabs = [
      { id: 1, url: 'about:blank', title: 'Old backup', pinned: false, group: null },
      { id: 2, url: 'about:blank', title: 'x'.repeat(510_000), pinned: false, group: null },
    ];
    let bytes = 0;
    for (const tab of tabs) {
      tx.objectStore('tabs').put(tab);
      bytes += new TextEncoder().encode(JSON.stringify(tab)).byteLength;
    }
    for (let index = 1; index <= 3; index++) {
      const snapshot = { id: `saved-${index}`, number: index, name: null, capturedAt: now + index, source: 'automatic', windows: [{ groups: [], tabs: [index === 3 ? 2 : 1] }], tabIds: [index === 3 ? 2 : 1] };
      const size = new TextEncoder().encode(JSON.stringify({ ...snapshot, tabIds: undefined })).byteLength;
      tx.objectStore('snapshots').put(snapshot);
      tx.objectStore('summaries').put({ id: snapshot.id, number: snapshot.number, name: null, capturedAt: snapshot.capturedAt, source: 'automatic', windowCount: 1, tabCount: 1, supportedCount: 1, bytes: size });
      bytes += size;
    }
    tx.objectStore('metadata').put({ privacyAcceptedAt: now, restore: { unloadBackgroundTabs: true, unloadThreshold: 100 }, automatic: { enabled: true, intervalMinutes: 0, pausedUntil: null }, settings: { retentionDays: 30, maxBackups: 2000, maxStorageMB: 250 }, latestId: 'saved-3', lastSessionNumbers: { automatic: 3, manual: 0 }, historyRevision: 0, lastSavedAt: now, lastCheckedAt: now, bytes, automaticBytes: bytes, savedBytes: 0, lastTabId: 2, count: 3, operation: null }, 'state');
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    db.close();
  });
  await page.reload();
  await expect(page.getByLabel('Time limit', { exact: true })).toHaveValue('30');
  await expect(page.getByLabel('Count limit', { exact: true })).toHaveValue('2000');
  await expect(page.getByLabel('Space limit', { exact: true })).toHaveValue('250');
  const status = page.locator('.toast-region');
  const form = page.locator('.storage-settings-form');
  await expect(page.locator('.storage-save')).toHaveCount(0);
  await page.getByLabel('Count limit', { exact: true }).evaluate(input => {
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing input');
    input.value = '3000'; input.dispatchEvent(new Event('input', { bubbles: true }));
    input.value = '2000'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(status).toBeEmpty();
  await page.getByLabel('Count limit', { exact: true }).fill('1');
  await expect(page.getByRole('dialog')).toContainText('delete 2 older backups');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Count limit', { exact: true })).toHaveValue('2000');
  await expect(page.locator('.settings-storage')).toContainText('3 automatic backups');
  await page.getByLabel('Space limit', { exact: true }).fill('1');
  await expect(status).toHaveText('Settings have been saved');
  await expect(form).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByLabel('Space limit', { exact: true })).toBeFocused();
  await page.getByLabel('Count limit', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Apply limits', exact: true }).click();
  await expect(status).toHaveText('Settings have been saved');
  await expect(status).toBeEmpty();
  await expect(page.locator('.settings-storage')).toHaveText('1 automatic backup · 0.51 MB of 1 MB used');
  await expect(page.locator('.storage-percentage')).toHaveText('51%');
  await expect(page.getByRole('progressbar')).toHaveAttribute('max', '1000000');
  await page.reload();
  await expect(page.getByLabel('Count limit', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Space limit', { exact: true })).toHaveValue('1');
  await page.getByRole('switch', { name: 'Enable time limit' }).uncheck();
  await page.getByRole('switch', { name: 'Enable backup limit' }).uncheck();
  await expect(form).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Enable time limit' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Enable backup limit' })).not.toBeChecked();
  await expect(page.getByLabel('Time limit', { exact: true })).toBeDisabled();
  await expect(page.locator('.storage-setting-row.is-inactive')).toHaveCount(2);
  await expect(page.getByLabel('Count limit', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Space limit', { exact: true })).toBeEnabled();
  await page.getByLabel('Color theme').selectOption('dark');
  await page.screenshot({ path: testInfo.outputPath('storage-settings-dark.png') });
  await page.setViewportSize({ width: 400, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('storage-settings-narrow.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
