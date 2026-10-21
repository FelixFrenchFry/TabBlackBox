import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Page } from '@playwright/test';
import { open, readFile, stat } from 'node:fs/promises';
import type { Archive } from '../../../src/archive';

async function storage(page: Page): Promise<{ saved: number; staged: number; tabs: number; manual: number }>
{
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('tabblackbox');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(['imports', 'summaries', 'tabs', 'metadata']);
      const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [summaries, staged, tabs, metadata] = await Promise.all([
        read(tx.objectStore('summaries').getAll()), read(tx.objectStore('imports').count()),
        read(tx.objectStore('tabs').count()), read(tx.objectStore('metadata').get('state')),
      ]);
      return { saved: summaries.filter(item => item.savedAt !== undefined).length, staged, tabs, manual: metadata.lastSessionNumbers.manual };
    } finally { db.close(); }
  });
}

test('round-trips an archive above 64 MiB and safely cancels or abandons another import', async ({ extensionContext }, testInfo) => {
  test.setTimeout(180_000);

  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const url = `chrome-extension://${new URL(worker.url()).host}/backups.html`;
  let page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await enableAutomaticBackups(page);
  await page.evaluate(async () => chrome.runtime.sendMessage({ kind: 'automatic-settings', update: { kind: 'enabled', value: false } }));
  const tab = { url: 'https://example.test/research', title: 'x'.repeat(512), pinned: true, group: 0 };
  const session = { name: 'Large archive', capturedAt: 1000, source: 'automatic' as const, tags: ['research'], windows: [{ groups: [{ name: 'Work 🧪', color: 'blue' as const, collapsed: true }], tabs: Array.from({ length: 500 }, () => tab) }] };
  const path = testInfo.outputPath('large-archive.json');
  const file = await open(path, 'w');
  try {
    await file.write('{"format":"tabblackbox","version":1,"sessions":[');
    for (let index = 0; index < 300; index++) await file.write(`${index ? ',' : ''}${JSON.stringify({ ...session, capturedAt: 1000 + index })}`);
    await file.write(']}');
  } finally { await file.close(); }
  expect((await stat(path)).size).toBeGreaterThan(64 * 1024 * 1024);
  await page.locator('input[type="file"]').setInputFiles(path);
  await expect(page.getByText('300 sessions imported', { exact: true })).toBeVisible({ timeout: 90_000 });
  const imported = await storage(page);
  expect(imported).toMatchObject({ saved: 300, staged: 0, manual: 300 });
  // duplicate expanded tabs retain a single shared record across all imported sessions
  expect(imported.tabs).toBeLessThan(10);
  await page.getByRole('button', { name: 'Export all', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await pending;
  const exportedPath = testInfo.outputPath('exported-archive.json');
  await download.saveAs(exportedPath);
  expect((await stat(exportedPath)).size).toBeGreaterThan(64 * 1024 * 1024);
  const exported: Archive = JSON.parse(await readFile(exportedPath, 'utf8'));
  expect(exported.sessions).toHaveLength(300);
  for (const [index, item] of exported.sessions.sort((a, b) => a.capturedAt - b.capturedAt).entries()) expect(item).toEqual({ ...session, capturedAt: 1000 + index });
  await page.locator('input[type="file"]').setInputFiles(path);
  await expect.poll(async () => (await storage(page)).staged).toBeGreaterThan(0);
  await page.getByRole('dialog', { name: 'Import sessions', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await storage(page)).toEqual(imported);
  await page.locator('input[type="file"]').setInputFiles(path);
  await expect.poll(async () => (await storage(page)).staged).toBeGreaterThan(0);
  await page.close();
  page = await context.newPage();
  await page.goto(url);
  await enableAutomaticBackups(page);
  await expect.poll(async () => (await storage(page)).staged).toBe(0);
  expect(await storage(page)).toEqual(imported);
  expect(errors).toEqual([]);
});
