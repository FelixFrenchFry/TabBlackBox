import { test, expect, launchAutomaticBackups } from '../fixtures/extension';
import { send, settledBackup } from '../fixtures/session';

test('restores 200 tabs across four windows with lightweight restore enabled', async ({ testServer: baseUrl }) =>
{
  const app = await launchAutomaticBackups();
  try {
    await send(app.page, { kind: 'restore-settings', settings: { unloadBackgroundTabs: true, unloadThreshold: 100 } });
    const ids = await app.page.evaluate(async url =>
    {
      const ids: number[] = [];
      for (let window = 0; window < 4; window++) {
        const created = await chrome.windows.create({ url: Array.from({ length: 50 }, (_, tab) => `${url}/large/${window}/${tab}`), focused: false });
        if (created?.id === undefined) throw new Error('Window not created');
        ids.push(created.id);
      }
      return ids;
    }, baseUrl);
    const backup = await settledBackup(app.page, 200);
    await app.page.evaluate(async windows => { for (const id of windows) await chrome.windows.remove(id); }, ids);
    await send(app.page, { kind: 'restore', id: backup.id });
    await expect.poll(async () =>
    {
      const result = await send(app.page, { kind: 'overview' });
      return result.kind === 'overview' ? result.overview.metadata.operation?.kind : null;
    }, { timeout: 90_000 }).toBe('completed');
    // enabled lightweight restoration opens background tabs above the threshold as placeholders
    const actual = await app.page.evaluate(async url =>
    {
      const placeholder = chrome.runtime.getURL('/restore.html#');
      const target = (tab: chrome.tabs.Tab) =>
      {
        const address = tab.pendingUrl || tab.url || '';
        return address.startsWith(placeholder) ? new URLSearchParams(address.slice(placeholder.length)).get('url') ?? '' : address;
      };
      const tabs = (await chrome.tabs.query({})).filter(tab => target(tab).startsWith(`${url}/large/`));
      const placeholders = tabs.filter(tab => (tab.pendingUrl || tab.url || '').startsWith(placeholder));
      return { count: tabs.length, windows: new Set(tabs.map(tab => tab.windowId)).size, placeholders: placeholders.length, first: placeholders[0]?.id };
    }, baseUrl);
    expect(actual).toMatchObject({ count: 200, windows: 4, placeholders: 196 });
    // showing a placeholder opens its saved page in the same tab
    await app.page.evaluate(async id => { await chrome.tabs.update(id!, { active: true }); }, actual.first);
    await expect.poll(async () => app.page.evaluate(async id => (await chrome.tabs.get(id!)).url, actual.first)).toMatch(new RegExp(`^${baseUrl}/large/`));
    // captures record placeholders as their saved pages
    const after = await settledBackup(app.page, 200);
    expect(after.windows.flatMap(window => window.tabs).every(tab => tab.url?.startsWith(`${baseUrl}/large/`))).toBe(true);
  } finally { await app.context.close(); }
});
