import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { createBrowser, startBackground } from '../support/browser';
import { restoreBrowser, scanBrowser } from '../../src/browser';
import type { Data, Reply } from '../../src/protocol';

vi.mock('../../src/browser', () => ({
  scanBrowser: vi.fn(),
  restoreBrowser: {
    fileAccess: vi.fn(async () => false),
    createWindow: vi.fn(async () => ({ windowId: 1, tabId: 1 })),
    createTab: vi.fn(async () => 2),
    pinTab: vi.fn(async () => undefined),
    groupTabs: vi.fn(async () => undefined),
    createPlaceholderTab: vi.fn(async () => 2),
  },
}));

const session = { windows: [{ groups: [], tabs: [{ title: 'Example docs', url: 'https://example.test/docs', pinned: false, group: null }] }] };
beforeEach(() => { vi.mocked(scanBrowser).mockReset().mockResolvedValue(session); });

// unwrap a successful reply so each assertion names the expected data kind
async function data(reply: Promise<Reply>): Promise<Data>
{
  const result = await reply;
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

it('answers only the popup and backups pages of this extension', async () =>
{
  const { browser } = await startBackground();
  const listener = browser.runtime.onMessage.listeners[0];
  if (!listener) throw new Error('Message listener missing');
  const send = (sender: chrome.runtime.MessageSender) => new Promise<{ handled: unknown; reply?: Reply }>(resolve => {
    let handled: unknown;
    const respond = (reply: Reply) => resolve({ handled, reply });
    handled = listener({ kind: 'overview' }, sender, respond);
    // ignored messages never respond, so report them once the listener returns
    if (handled === false) resolve({ handled });
  });
  for (const url of ['chrome-extension://test/popup.html', 'chrome-extension://test/backups.html', 'chrome-extension://test/backups.html#settings']) {
    const { handled, reply } = await send({ id: 'test', url });
    expect(handled).toBe(true);
    expect(reply).toMatchObject({ ok: true, data: { kind: 'overview' } });
  }
  for (const sender of [
    { id: 'other', url: 'chrome-extension://test/backups.html' },
    { id: 'test', url: 'chrome-extension://test/restore.html#url=https%3A%2F%2Fexample.test' },
    { id: 'test', url: 'chrome-extension://test/backups.html?settings' },
    { id: 'test', url: 'https://example.test/backups.html' },
    { id: 'test' },
    { url: 'chrome-extension://test/backups.html' },
  ]) {
    expect(await send(sender)).toEqual({ handled: false });
  }
});

it('routes every supported request to its reply', async () =>
{
  const { request } = await startBackground();
  const backup = await data(request({ kind: 'backup' }));
  if (backup.kind !== 'overview' || backup.captureResult?.kind !== 'saved') throw new Error('Manual backup missing');
  const id = backup.captureResult.id;
  const now = Date.now();
  const range = { start: now - 86_400_000, end: now + 1 };

  expect(await data(request({ kind: 'overview' }))).toMatchObject({ kind: 'overview', overview: { latest: { id } } });
  expect(await data(request({ kind: 'storage-settings', settings: { retentionDays: 90, maxBackups: 300, maxStorageMB: 400 }, confirmedRemovalCount: 0 }))).toEqual({ kind: 'storage-settings', result: { kind: 'saved' } });
  expect(await data(request({ kind: 'restore-settings', settings: { unloadBackgroundTabs: true, unloadThreshold: 30 } }))).toMatchObject({ kind: 'overview', overview: { metadata: { restore: { unloadBackgroundTabs: true, unloadThreshold: 30 } } } });
  const calendar = await data(request({ kind: 'calendar', range }));
  expect(calendar.kind === 'calendar' && calendar.days.reduce((total, day) => total + day.saved, 0)).toBe(1);
  const counts = await data(request({ kind: 'tab-counts', range }));
  expect(counts.kind === 'tab-counts' && counts.points.map(point => point.tabCount)).toEqual([1]);
  expect(await data(request({ kind: 'top-sites', scope: 'all', limit: 10 }))).toMatchObject({ kind: 'top-sites', total: 1, sites: [{ count: 1 }] });
  expect(await data(request({ kind: 'history', before: null }))).toMatchObject({ kind: 'history', count: 1, items: [{ id }] });
  expect(await data(request({ kind: 'tab-search', query: 'docs', limit: 10 }))).toMatchObject({ kind: 'tab-search', items: [{ url: 'https://example.test/docs' }] });
  expect(await data(request({ kind: 'snapshot', id }))).toMatchObject({ kind: 'snapshot', snapshot: { id, windows: session.windows } });
  expect(await data(request({ kind: 'rename', id, name: 'Research' }))).toMatchObject({ kind: 'renamed', summary: { id, name: 'Research' } });
  expect(await data(request({ kind: 'keep', id, name: 'Kept' }))).toMatchObject({ kind: 'renamed', summary: { name: 'Kept' } });
  // renaming an automatic backup keeps it automatic while keeping it marks it saved
  expect(await data(request({ kind: 'automatic-settings', update: { kind: 'enabled', value: true } }))).toMatchObject({ kind: 'overview' });
  await data(request({ kind: 'automatic-settings', update: { kind: 'frequency', value: 0 } }));
  vi.mocked(scanBrowser).mockResolvedValue({ windows: [{ groups: [], tabs: [{ title: 'Other', url: 'https://example.test/other', pinned: false, group: null }] }] });
  const refresh = await data(request({ kind: 'refresh' }));
  if (refresh.kind !== 'overview' || refresh.captureResult?.kind !== 'saved') throw new Error('Automatic backup missing');
  const automatic = refresh.captureResult.id;
  const renamed = await data(request({ kind: 'rename', id: automatic, name: 'Renamed' }));
  expect(renamed.kind === 'renamed' && renamed.summary.savedAt).toBeFalsy();
  const kept = await data(request({ kind: 'keep', id: automatic, name: 'Kept' }));
  expect(kept.kind === 'renamed' && kept.summary.savedAt).toBeTruthy();
  await data(request({ kind: 'automatic-settings', update: { kind: 'enabled', value: false } }));
  vi.mocked(scanBrowser).mockResolvedValue(session);

  expect(await data(request({ kind: 'restore', id }))).toEqual({ kind: 'accepted' });
  await vi.waitFor(async () => expect(await data(request({ kind: 'overview' }))).toMatchObject({ overview: { metadata: { operation: { kind: 'completed' } } } }));
  expect(restoreBrowser.createWindow).toHaveBeenLastCalledWith('https://example.test/docs');
  const finished = await data(request({ kind: 'overview' }));
  if (finished.kind !== 'overview' || finished.overview.metadata.operation?.kind !== 'completed') throw new Error('Restore result missing');
  expect(await data(request({ kind: 'dismiss-restore', id, startedAt: finished.overview.metadata.operation.startedAt }))).toEqual({ kind: 'accepted' });
  expect(await data(request({ kind: 'overview' }))).toMatchObject({ overview: { metadata: { operation: { dismissed: true } } } });

  vi.mocked(restoreBrowser.createWindow).mockClear();
  expect(await data(request({ kind: 'restore-window', id, windowIndex: 0 }))).toEqual({ kind: 'accepted' });
  await vi.waitFor(() => expect(restoreBrowser.createWindow).toHaveBeenCalledOnce());
  await vi.waitFor(async () => expect(await data(request({ kind: 'overview' }))).toMatchObject({ overview: { status: { kind: 'disabled' } } }));

  expect(await data(request({ kind: 'delete-session', id }))).toEqual({ kind: 'accepted' });
  expect(await request({ kind: 'snapshot', id })).toMatchObject({ ok: false });
});

it('rejects manual backups during a restoration while refreshes still report the overview', async () =>
{
  const { request } = await startBackground();
  const backup = await data(request({ kind: 'backup' }));
  if (backup.kind !== 'overview' || backup.captureResult?.kind !== 'saved') throw new Error('Manual backup missing');
  let open: (value: { windowId: number; tabId: number }) => void = () => {};
  vi.mocked(restoreBrowser.createWindow).mockImplementationOnce(() => new Promise(resolve => { open = resolve; }));
  await data(request({ kind: 'restore', id: backup.captureResult.id }));
  await vi.waitFor(() => expect(restoreBrowser.createWindow).toHaveBeenCalled());
  vi.mocked(scanBrowser).mockClear();
  expect(await request({ kind: 'backup' })).toEqual({ ok: false, error: 'Restoration in progress. Try backing up again when it finishes.' });
  expect(await data(request({ kind: 'refresh' }))).toMatchObject({ kind: 'overview', overview: { status: { kind: 'restoring' } } });
  expect(scanBrowser).not.toHaveBeenCalled();
  open({ windowId: 1, tabId: 1 });
  await vi.waitFor(async () => expect(await data(request({ kind: 'backup' }))).toMatchObject({ captureResult: { kind: 'saved' } }));
});

it('shows a red badge only while the backup status is an error', async () =>
{
  const { browser, request } = await startBackground();
  vi.mocked(scanBrowser).mockRejectedValueOnce(new Error('Scan failed'));
  expect(await data(request({ kind: 'backup' }))).toMatchObject({ overview: { status: { kind: 'error', message: 'Scan failed' } } });
  expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '!' });
  expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#cf222e' });
  const colored = browser.action.setBadgeBackgroundColor.mock.calls.length;
  expect(await data(request({ kind: 'backup' }))).toMatchObject({ overview: { status: { kind: 'current' } } });
  expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledTimes(colored);
});

it('creates the reconcile alarm only when it is missing', async () =>
{
  const present = createBrowser();
  await startBackground(present);
  await vi.waitFor(() => expect(present.action.setBadgeText).toHaveBeenCalled());
  expect(present.alarms.create).not.toHaveBeenCalledWith('reconcile-session', expect.anything());
  const missing = createBrowser();
  missing.alarms.get.mockResolvedValue(undefined);
  await startBackground(missing);
  await vi.waitFor(() => expect(missing.alarms.create).toHaveBeenCalledWith('reconcile-session', { periodInMinutes: 1 }));
});

it('reports a failed startup in the status and badge', async () =>
{
  const browser = createBrowser();
  browser.alarms.get.mockRejectedValue(new Error('Alarms unavailable'));
  const { request } = await startBackground(browser);
  await vi.waitFor(() => expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '!' }));
  expect(await data(request({ kind: 'overview' }))).toMatchObject({ overview: { status: { kind: 'error', message: 'Alarms unavailable' } } });
});
