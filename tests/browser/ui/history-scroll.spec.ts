import { test, expect, type ExtensionContext } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import type { Reply, Request } from '../../../src/protocol';

async function launch(extensionContext: ExtensionContext)
{
  const context = await extensionContext();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
  await enableAutomaticBackups(page);
  return { context, page };
}

test('a failed page waits for the next scroll and then loads', async ({ extensionContext }) =>
{
  const app = await launch(extensionContext);
  try {
    await app.page.addInitScript(() =>
    {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> =>
      {
        if (message.kind === 'history') {
          if (message.collection === 'saved') return { ok: true, data: { kind: 'history', items: [], count: 0, bytes: 0, more: false } };
          if (message.before) {
            const attempt = Number(document.documentElement.dataset.olderRequests ?? '0') + 1;
            document.documentElement.dataset.olderRequests = String(attempt);
            // the first older page fails like a temporary database error
            if (attempt === 1) return { ok: false, error: 'Page load failed for testing' };
          }
          const first = message.before ? message.before.capturedAt - 1 : 100;
          const items = Array.from({ length: Math.min(50, first) }, (_, index) => ({ id: `backup-${first - index}`, number: first - index, name: null, capturedAt: first - index, source: 'automatic' as const, windowCount: 1, tabCount: first - index, supportedCount: 1, bytes: 100 }));
          return { ok: true, data: { kind: 'history', items, count: 100, bytes: 10_000, more: first > 50 } };
        }
        const reply: Reply = await original(message);
        // a fixed latest backup keeps polling from resetting the mocked history
        if (reply.ok && reply.data.kind === 'overview') reply.data.overview.metadata.latestId = 'backup-100';
        return reply;
      } });
    });
    await app.page.reload();
    const rows = app.page.locator('.automatic-backups .history-rows');
    await expect(app.page.locator('.backup-row')).toHaveCount(50);
    // a single scroll to the end fires one native scroll event
    await rows.evaluate(element => { element.scrollTo(0, element.scrollHeight); });
    await expect(app.page.getByText('Page load failed for testing')).toBeVisible();
    // a failure does not retry on its own
    await app.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
    await expect(app.page.locator('html')).toHaveAttribute('data-older-requests', '1');
    await expect(app.page.locator('.backup-row')).toHaveCount(50);
    // scrolling again at the end retries the page
    await rows.evaluate(element => { element.dispatchEvent(new Event('scroll')); });
    await expect(app.page.locator('.backup-row')).toHaveCount(100);
    await expect(app.page.locator('html')).toHaveAttribute('data-older-requests', '2');
    const counts = await app.page.locator('.backup-counts > .muted').allTextContents();
    expect(counts).toEqual(Array.from({ length: 100 }, (_, index) => `1 window · ${100 - index} ${index === 99 ? 'tab' : 'tabs'}`));
  } finally { await app.context.close(); }
});

test('an opened session keeps its header and actions pinned while its tabs scroll', async ({ extensionContext }, testInfo) =>
{
  const app = await launch(extensionContext);
  try {
    await app.page.addInitScript(() =>
    {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      Object.defineProperty(chrome.runtime, 'sendMessage', { value: async (message: Request): Promise<Reply> =>
      {
        if (message.kind === 'history') {
          if (message.collection === 'saved') return { ok: true, data: { kind: 'history', items: [], count: 0, bytes: 0, more: false } };
          const items = Array.from({ length: 10 }, (_, index) => ({ id: `backup-${10 - index}`, number: 10 - index, name: null, capturedAt: 10 - index, source: 'automatic' as const, windowCount: 1, tabCount: 60, supportedCount: 60, bytes: 100 }));
          return { ok: true, data: { kind: 'history', items, count: 10, bytes: 1000, more: false } };
        }
        if (message.kind === 'snapshot') {
          const tabs = Array.from({ length: 60 }, (_, index) => ({ url: `https://example.test/${index}`, title: `Saved page ${index + 1}`, pinned: false, group: null }));
          return { ok: true, data: { kind: 'snapshot', snapshot: { id: message.id, number: 10, name: null, capturedAt: 10, source: 'automatic', windows: [{ groups: [], tabs }] } } };
        }
        const reply: Reply = await original(message);
        if (reply.ok && reply.data.kind === 'overview') reply.data.overview.metadata.latestId = 'backup-10';
        return reply;
      } });
    });
    await app.page.reload();
    const rows = app.page.locator('.automatic-backups .history-rows');
    const opened = app.page.locator('.backup-row').first();
    await opened.locator('summary').click();
    await expect(opened.getByText('Saved page 60', { exact: true })).toBeAttached();
    // compare the pinned header and actions with the top of the scrolled list
    const offsets = () => opened.evaluate(row => {
      const list = row.closest('.history-rows');
      const summary = row.querySelector('.backup-summary');
      const actions = row.querySelector('.backup-actions');
      if (!list || !summary || !actions) throw new Error('Row structure missing');
      const top = list.getBoundingClientRect().top;
      const header = summary.getBoundingClientRect();
      const hit = document.elementFromPoint(header.left + 40, header.top + header.height / 2);
      return { summary: Math.round(header.top - top), actions: Math.round(actions.getBoundingClientRect().top - top), covered: !hit || !summary.contains(hit) };
    });
    await rows.evaluate(element => { element.scrollTop = 600; });
    await expect.poll(offsets).toEqual({ summary: 0, actions: 6, covered: false });
    await rows.screenshot({ path: testInfo.outputPath('pinned-session.png') });
    // the header leaves with its row once the list scrolls past the opened session
    await rows.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(async () => (await offsets()).summary).toBeLessThan(0);
  } finally { await app.context.close(); }
});
