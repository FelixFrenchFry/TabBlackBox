import { test, expect, type ExtensionContext } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Reply, Request } from '../../../src/protocol';

async function launch(extensionContext: ExtensionContext)
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const page = await context.newPage();
  await page.goto(`${origin}/backups.html`);
  await enableAutomaticBackups(page);
  return { context, worker, origin, page };
}

test('refresh keeps an expanded older session and pagination remains ordered', async ({ extensionContext }) =>
{
  const app = await launch(extensionContext);
  try {
    await app.page.addInitScript(() =>
    {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> =>
      {
        const newest = document.documentElement.dataset.newHistory === 'true' ? 51 : 50;
        if (message.kind === 'history') {
          if (message.collection === 'saved') return { ok: true, data: { kind: 'history', items: [], count: 0, bytes: 0 } };
          const first = message.before ? message.before.capturedAt - 1 : newest;
          const items = Array.from({ length: Math.min(message.before ? 10 : 5, first) }, (_, index) => ({ id: `saved-${first - index}`, number: first - index, name: null, capturedAt: first - index, source: 'automatic' as const, windowCount: 1, tabCount: first - index, supportedCount: 1, bytes: 100 }));
          return { ok: true, data: { kind: 'history', items, count: newest, bytes: newest * 100 } };
        }
        if (message.kind === 'snapshot') return { ok: true, data: { kind: 'snapshot', snapshot: { id: message.id, number: 1, name: null, capturedAt: 1, source: 'automatic', windows: [{ groups: [], tabs: [{ url: 'about:blank', title: 'Saved page', pinned: false, group: null }] }] } } };
        const reply: Reply = await original(message);
        if (reply.ok && reply.data.kind === 'overview') reply.data.overview.metadata.latestId = `saved-${newest}`;
        return reply;
      } });
    });
    await app.page.reload();
    await expect(app.page.locator('.backup-row')).toHaveCount(5);
    await app.page.getByRole('button', { name: 'Load more' }).click();
    await expect(app.page.locator('.backup-row')).toHaveCount(15);
    const older = app.page.locator('.backup-row').last();
    await older.evaluate(element => element.setAttribute('data-older-session', 'true'));
    await older.locator('summary').click();
    const retained = app.page.locator('[data-older-session]');
    await expect(retained.locator('.tab-title')).toHaveText('Saved page');
    await app.page.evaluate(() => { document.documentElement.dataset.newHistory = 'true'; });
    await expect(app.page.locator('.backup-row').first()).toContainText('51 tabs');
    await expect(retained.locator('details')).toHaveAttribute('open', '');
    await expect(retained.locator('.tab-title')).toHaveText('Saved page');
    await expect(app.page.locator('.backup-row')).toHaveCount(25);
    for (const count of [35, 45, 51]) {
      await app.page.getByRole('button', { name: 'Load more' }).click();
      await expect(app.page.locator('.backup-row')).toHaveCount(count);
    }
    await expect(app.page.getByRole('button', { name: 'Load more' })).toBeHidden();
    const counts = await app.page.locator('.backup-counts > .muted').allTextContents();
    expect(counts).toEqual([...Array.from({ length: 50 }, (_, index) => `1 window · ${51 - index} tabs`), '1 window · 1 tab']);
    await retained.locator('summary').click();
    await expect(retained.locator('details')).not.toHaveAttribute('open', '');
    await app.page.evaluate(() => { document.documentElement.dataset.newHistory = 'false'; });
    await expect(app.page.locator('.backup-row').first()).toContainText('50 tabs');
    await expect(app.page.locator('.backup-row details[open]')).toHaveCount(0);
  } finally { await app.context.close(); }
});

test('a popup with stale status reports a manual backup blocked by another page restoring', async ({ extensionContext }) =>
{
  const app = await launch(extensionContext);
  try {
    const id = await app.page.evaluate(async () =>
    {
      // capture tab changes after the settling delay instead of the product backup frequency
      await chrome.runtime.sendMessage({ kind: 'automatic-settings', update: { kind: 'frequency', value: 0 } });
      await chrome.tabs.create({ url: 'about:blank' });
      const reply: Reply = await chrome.runtime.sendMessage({ kind: 'backup' });
      if (!reply.ok || reply.data.kind !== 'overview' || !reply.data.overview.metadata.latestId) throw new Error('Fixture missing');
      return reply.data.overview.metadata.latestId;
    });
    const popup = await app.context.newPage();
    await popup.addInitScript(() => { Object.defineProperty(window, 'setInterval', { value: () => 0 }); });
    await popup.goto(`${app.origin}/popup.html`);
    await expect(popup.getByText(/Current tabs backed up (automatically|manually)/)).toBeVisible();
    await app.worker.evaluate(() =>
    {
      const original = chrome.windows.create.bind(chrome.windows);
      const gate = new Promise<void>(resolve => Object.defineProperty(chrome.windows, 'releaseTestRestore', { value: resolve }));
      Object.defineProperty(chrome.windows, 'create', { value: async (data: chrome.windows.CreateData) => { await gate; return original(data); } });
    });
    await app.page.evaluate(async id =>
    {
      const reply: Reply = await chrome.runtime.sendMessage({ kind: 'restore', id });
      if (!reply.ok) throw new Error(reply.error);
    }, id);
    await popup.getByRole('button', { name: 'Back up now', exact: true }).click();
    await expect(popup.getByRole('alert')).toHaveText('Restoration in progress. Try backing up again when it finishes.');
    await app.worker.evaluate(() =>
    {
      const release = Reflect.get(chrome.windows, 'releaseTestRestore');
      if (typeof release !== 'function') throw new Error('Gate missing');
      release();
    });
  } finally { await app.context.close(); }
});

for (const failOldRequest of [false, true]) {
  test(`history discards an old pagination ${failOldRequest ? 'failure' : 'response'} after resetting`, async ({ extensionContext }) =>
  {
    const app = await launch(extensionContext);
    try {
      await app.page.addInitScript(fail =>
      {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        let delayOlder = true;
        Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> =>
        {
          if (message.kind === 'history') {
            if (message.collection === 'saved') return { ok: true, data: { kind: 'history', items: [], count: 0, bytes: 0 } };
            const newest = document.documentElement.dataset.newHistory === 'true' ? 101 : 100;
            const first = message.before ? message.before.capturedAt - 1 : newest;
            if (message.before && delayOlder) {
              delayOlder = false;
              document.documentElement.dataset.olderWaiting = 'true';
              await new Promise<void>(resolve => document.addEventListener('release-older', () => resolve(), { once: true }));
              if (fail) return { ok: false, error: 'Stale pagination failure' };
            }
            return { ok: true, data: { kind: 'history', count: newest, bytes: newest * 100, items: Array.from({ length: message.before ? 10 : 5 }, (_, index) => ({ id: `saved-${first - index}`, number: first - index, name: null, capturedAt: first - index, source: 'automatic', windowCount: 1, tabCount: first - index, supportedCount: 1, bytes: 100 })) } };
          }
          const reply: Reply = await original(message);
          if (reply.ok && reply.data.kind === 'overview') reply.data.overview.metadata.latestId = document.documentElement.dataset.newHistory === 'true' ? 'new' : 'old';
          return reply;
        } });
      }, failOldRequest);
      await app.page.reload();
      await expect(app.page.locator('.backup-row')).toHaveCount(5);
      await app.page.getByRole('button', { name: 'Load more' }).click();
      await expect(app.page.locator('html')).toHaveAttribute('data-older-waiting', 'true');
      await app.page.evaluate(() => { document.documentElement.dataset.newHistory = 'true'; });
      await expect(app.page.locator('.backup-row').first()).toContainText('101 tabs');
      await app.page.evaluate(async () =>
      {
        document.dispatchEvent(new Event('release-older'));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
      await expect(app.page.locator('.backup-row')).toHaveCount(5);
      await expect(app.page.getByText('Stale pagination failure')).toHaveCount(0);
      await app.page.getByRole('button', { name: 'Load more' }).click();
      await expect(app.page.locator('.backup-row')).toHaveCount(15);
      const counts = await app.page.locator('.backup-counts > .muted').allTextContents();
      expect(counts).toEqual(Array.from({ length: 15 }, (_, index) => `1 window · ${101 - index} tabs`));
    } finally { await app.context.close(); }
  });
}
