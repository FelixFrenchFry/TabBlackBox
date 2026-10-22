import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Metadata, StoredSnapshot } from '../../../src/model';

test('session names persist and refresh across pages without losing loaded or expanded rows', async ({ extensionContext }, testInfo) =>
{
  const context = await extensionContext({ viewport: { width: 1200, height: 900 } });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('tabblackbox.date-format', 'exact'));
  const url = `chrome-extension://${new URL(worker.url()).host}/backups.html`;
  await page.goto(url);
  await enableAutomaticBackups(page);
  await page.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ kind: 'automatic-settings', update: { kind: 'enabled', value: false } });
    if (!reply.ok) throw new Error(reply.error);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('tabblackbox');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = database.transaction(['snapshots', 'tabs', 'summaries', 'metadata'], 'readwrite');
    tx.objectStore('snapshots').clear();
    tx.objectStore('summaries').clear();
    const now = Date.now();
    tx.objectStore('tabs').clear();
    const tab = { id: 1, url: 'about:blank', title: 'Saved page', pinned: false, group: null };
    tx.objectStore('tabs').put(tab);
    let bytes = new TextEncoder().encode(JSON.stringify(tab)).byteLength;
    for (let number = 1; number <= 60; number++) {
      const snapshot: StoredSnapshot = { id: `fixture-${number}`, number, name: null, capturedAt: now + number, source: 'manual', windows: [{ groups: [], tabs: [1] }], tabIds: [1] };
      const size = new TextEncoder().encode(JSON.stringify({ ...snapshot, tabIds: undefined })).byteLength;
      bytes += size;
      tx.objectStore('snapshots').put(snapshot);
      tx.objectStore('summaries').put({ id: snapshot.id, number, name: null, capturedAt: snapshot.capturedAt, source: snapshot.source, windowCount: 1, tabCount: 1, supportedCount: 1, bytes: size });
    }
    const request = tx.objectStore('metadata').get('state');
    request.onsuccess = () => {
      const metadata: Metadata = request.result;
      Object.assign(metadata, { latestId: 'fixture-60', lastSessionNumbers: { automatic: 60, manual: 0 }, historyRevision: 0, lastSavedAt: now + 60, count: 60, bytes, automaticBytes: bytes, savedBytes: 0, lastTabId: 1 });
      tx.objectStore('metadata').put(metadata, 'state');
    };
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    database.close();
  });
  await page.reload();
  await expect(page.locator('.backup-row')).toHaveCount(5);
  for (let count = 10; count <= 60; count += 5) {
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(page.locator('.backup-row')).toHaveCount(count);
  }
  const other = await context.newPage();
  await other.goto(url);
  for (let count = 10; count <= 60; count += 5) {
    await other.getByRole('button', { name: 'Show more' }).click();
    await expect(other.locator('.backup-row')).toHaveCount(count);
  }
  const row = page.locator('.backup-row').filter({ has: page.getByRole('button', { name: 'Rename session #1', exact: true }) });
  const otherRow = other.locator('.backup-row').filter({ has: other.getByRole('button', { name: 'Rename session #1', exact: true }) });
  const date = await row.locator('time').getAttribute('datetime');
  await expect(row.locator('.backup-number')).toHaveText('#1');
  await expect(row.locator('.backup-title')).toHaveText('Unnamed session');
  const dateColumn = await row.locator('time').evaluate(element => element.getBoundingClientRect().x);
  await row.getByRole('button', { name: 'Rename session #1', exact: true }).click();
  await expect(row.locator('details')).not.toHaveAttribute('open', '');
  await expect(row.locator('.backup-name .session-rename')).toHaveCSS('border-top-width', '0px');
  await expect(row.locator('.session-rename svg')).toHaveCSS('width', '14px');
  await page.getByLabel('Name', { exact: true }).fill('Before <tab> cleanup');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row.locator('strong')).toHaveText('Before <tab> cleanup');
  await expect(otherRow.locator('strong')).toHaveText('Before <tab> cleanup');
  await expect(row.locator('.backup-title')).toHaveText('Before <tab> cleanup');
  await expect(row.locator('.backup-number')).toHaveText('#1');
  await expect(row.locator('.backup-date')).toHaveAttribute('datetime', date!);
  expect(await row.locator('.backup-date').evaluate(element => element.getBoundingClientRect().x)).toBe(dateColumn);
  expect(await row.locator('.backup-date').evaluate(element => getComputedStyle(element).fontWeight)).toBe('600');
  await expect(page.locator('.backup-row')).toHaveCount(60);
  await row.locator('summary').click();
  await expect(row.locator('.snapshot-preview')).toBeVisible();
  await row.locator('.snapshot-preview').evaluate(element => { element.setAttribute('data-preserved', 'true'); });
  await otherRow.getByRole('button', { name: 'Rename session #1', exact: true }).click();
  await other.getByLabel('Name', { exact: true }).fill('');
  await other.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.locator('strong').first()).toHaveText('Unnamed session');
  await expect(row.locator('details')).toHaveAttribute('open', '');
  await expect(row.locator('.snapshot-preview')).toHaveAttribute('data-preserved', 'true');
  await expect(row.locator('.backup-date')).toHaveAttribute('datetime', date!);
  await expect(page.locator('.backup-row')).toHaveCount(60);
  await page.evaluate(() => {
    localStorage.setItem('tabblackbox.date-format', 'combination');
    window.dispatchEvent(new Event('dateformatchange'));
  });
  await expect(row.locator('.backup-date')).toContainText('(');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: testInfo.outputPath('session-labels.png'), fullPage: false });
  await page.setViewportSize({ width: 400, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await row.scrollIntoViewIfNeeded();
  const [numberBox, nameBox, timeBox, actionBox] = await Promise.all([
    row.locator('.backup-number').boundingBox(), row.locator('.backup-label').boundingBox(),
    row.locator('.backup-date').boundingBox(), row.locator('.backup-actions').boundingBox(),
  ]);
  if (!numberBox || !nameBox || !timeBox || !actionBox) throw new Error('Missing session layout');
  expect(nameBox.y).toBeGreaterThanOrEqual(numberBox.y + numberBox.height);
  expect(timeBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
  expect(actionBox.y).toBeGreaterThanOrEqual(timeBox.y + timeBox.height);
  await page.screenshot({ path: testInfo.outputPath('session-labels-narrow.png'), fullPage: false });
  await page.reload();
  await expect(page.locator('.backup-row strong').first()).toHaveText('Unnamed session');
  await expect(page.locator('.backup-number').first()).toHaveText('#60');
});
