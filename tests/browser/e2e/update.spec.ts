import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, launchExtension } from '../fixtures/extension';
import { seed } from '../fixtures/session';
import type { Reply } from '../../../src/protocol';
import type { Snapshot, Summary } from '../../../src/model';

// old build from scripts/build-baseline.mjs
const baselineRef = 'abc8b4c';
const baseline = resolve('.baseline', baselineRef, 'chrome-mv3');
const current = resolve('.output/chrome-mv3');
const archive = readFileSync(resolve('tests/fixtures/released/archive-v1.json'));
const preferences = { 'tabblackbox.appearance': 'light', 'tabblackbox.date-format': 'exact', 'tabblackbox.history-sort.saved': 'number-asc', 'tabblackbox.calendar-open': 'false' };

// requests both builds understand
async function message(page: Page, request: object): Promise<Reply>
{
  return page.evaluate(async value => chrome.runtime.sendMessage(value), request);
}

async function data(page: Page, request: object)
{
  const reply = await message(page, request);
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

async function open(context: BrowserContext, reuseStartTab: boolean): Promise<{ page: Page; extensionId: string }>
{
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  // reuse the start tab to keep it out of the backups
  const page = (reuseStartTab ? context.pages()[0] : undefined) ?? await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/backups.html`);
  return { page, extensionId };
}

// all backups in both panels with their contents
async function backups(page: Page): Promise<{ summary: Summary; snapshot: Snapshot }[]>
{
  const result: { summary: Summary; snapshot: Snapshot }[] = [];
  for (const collection of ['automatic', 'saved'] as const) {
    let before: Summary | null = null;
    while (true) {
      const history = await data(page, { kind: 'history', before: before && { capturedAt: before.capturedAt, number: before.number, id: before.id }, collection });
      if (history.kind !== 'history') throw new Error('Unexpected history reply');
      for (const summary of history.items) {
        const snapshot = await data(page, { kind: 'snapshot', id: summary.id });
        if (snapshot.kind !== 'snapshot') throw new Error('Unexpected snapshot reply');
        result.push({ summary, snapshot: snapshot.snapshot });
      }
      before = history.items.at(-1) ?? null;
      if (!before) break;
    }
  }
  return result.sort((a, b) => a.summary.id.localeCompare(b.summary.id));
}

test('an update from the baseline build keeps backups, settings, preferences, and placeholder addresses', async ({ testServer: baseUrl }, testInfo) =>
{
  expect(existsSync(resolve(baseline, 'manifest.json')), 'run npm run test:baseline first').toBe(true);
  // same folder for both builds to keep the extension ID
  const extension = testInfo.outputPath('extension');
  const profile = testInfo.outputPath('profile');
  cpSync(baseline, extension, { recursive: true });

  let context = await launchExtension(profile, { viewport: { width: 1280, height: 900 } }, extension);
  let before: Awaited<ReturnType<typeof backups>>;
  let settings: object;
  let extensionId: string;
  let placeholder: string;
  try {
    const app = await open(context, true);
    extensionId = app.extensionId;
    // old builds wait for a privacy choice
    const choice = await message(app.page, { kind: 'privacy-choice', automatic: true });
    if (!choice.ok && choice.error !== 'Invalid request.') throw new Error(choice.error);
    await app.page.reload();
    await data(app.page, { kind: 'automatic-settings', update: { kind: 'enabled', value: true } });
    // back up every change while creating tabs
    await data(app.page, { kind: 'automatic-settings', update: { kind: 'frequency', value: 0 } });
    await data(app.page, { kind: 'storage-settings', settings: { retentionDays: 90, maxBackups: 300, maxStorageMB: 400 }, confirmedRemovalCount: 0 });
    await data(app.page, { kind: 'restore-settings', settings: { unloadBackgroundTabs: true, unloadThreshold: 30 } });

    await seed(app.page, baseUrl);
    await expect.poll(async () => {
      const overview = await data(app.page, { kind: 'refresh' });
      return overview.kind === 'overview' ? overview.overview.latest?.tabCount : 0;
    }).toBe(5);
    await data(app.page, { kind: 'automatic-settings', update: { kind: 'frequency', value: 15 } });
    const manual = await data(app.page, { kind: 'backup' });
    if (manual.kind !== 'overview' || !manual.overview.metadata.latestId) throw new Error('Manual backup failed');
    await data(app.page, { kind: 'rename', id: manual.overview.metadata.latestId, name: 'Before update', details: { tags: ['release'] } });
    await app.page.locator('input[type="file"]').setInputFiles({ name: 'released.json', mimeType: 'application/json', buffer: archive });
    await expect(app.page.getByText(/\d+ sessions? imported/)).toBeVisible();

    await app.page.evaluate(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, preferences);
    // placeholder tab in the old address format
    placeholder = `chrome-extension://${extensionId}/restore.html#${new URLSearchParams({ url: `${baseUrl}/placeholder`, title: 'Placeholder page' })}`;
    await app.page.evaluate(async address => { await chrome.tabs.create({ url: address, active: false }); }, placeholder);
    await expect.poll(() => app.page.evaluate(async address => (await chrome.tabs.query({})).some(tab => tab.url === address), placeholder)).toBe(true);

    before = await backups(app.page);
    expect(before.filter(item => item.summary.savedAt !== undefined).length).toBeGreaterThan(1);
    const overview = await data(app.page, { kind: 'overview' });
    if (overview.kind !== 'overview') throw new Error('Unexpected overview reply');
    const { automatic, settings: storage, restore } = overview.overview.metadata;
    settings = { automatic, storage, restore };
  } finally { await context.close(); }

  // swap in the new build and bump the version like a real update
  rmSync(extension, { recursive: true, force: true });
  cpSync(current, extension, { recursive: true });
  const manifestPath = resolve(extension, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };
  manifest.version = manifest.version.replace(/\d+$/, patch => String(Number(patch) + 1));
  writeFileSync(manifestPath, JSON.stringify(manifest));

  context = await launchExtension(profile, { viewport: { width: 1280, height: 900 } }, extension);
  try {
    // open the page in a new tab
    const app = await open(context, false);
    expect(app.extensionId).toBe(extensionId);
    expect(await app.page.evaluate(() => chrome.runtime.getManifest().version)).toBe(manifest.version);
    expect(await backups(app.page)).toEqual(before);
    const overview = await data(app.page, { kind: 'overview' });
    if (overview.kind !== 'overview') throw new Error('Unexpected overview reply');
    const { automatic, settings: storage, restore } = overview.overview.metadata;
    expect({ automatic, storage, restore }).toEqual(settings);

    // preferences still apply
    expect(await app.page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), Object.keys(preferences))).toEqual(preferences);
    await expect(app.page.locator('html')).toHaveAttribute('data-color-mode', 'light');

    // old placeholder address still loads its page
    // Playwright does not restore tabs after a restart
    const tabId = await app.page.evaluate(async address => (await chrome.tabs.create({ url: address, active: false })).id, placeholder);
    if (tabId === undefined) throw new Error('Placeholder tab missing');
    await app.page.evaluate(async id => { await chrome.tabs.update(id, { active: true }); }, tabId);
    await expect.poll(() => app.page.evaluate(async id => (await chrome.tabs.get(id)).url, tabId)).toBe(`${baseUrl}/placeholder`);

    // new build still works with the old data
    const manual = await data(app.page, { kind: 'backup' });
    expect(manual.kind === 'overview' && manual.captureResult?.kind).toBe('saved');
    const after = await backups(app.page);
    for (const item of before) expect(after.find(other => other.summary.id === item.summary.id)?.snapshot.windows).toEqual(item.snapshot.windows);
  } finally { await context.close(); }
});
