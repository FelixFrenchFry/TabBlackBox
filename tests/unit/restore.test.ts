import { describe, expect, it, vi } from 'vitest';
import { restoreSession, type RestorePort } from '../../src/restore';
import type { Snapshot, Operation } from '../../src/model';

const snapshot: Snapshot = {
  id: 'saved', number: 1, name: null, capturedAt: 1, source: 'manual', windows: [
    { groups: [{ name: 'Research', color: 'blue', collapsed: true }], tabs: [
      { url: 'https://same.test', title: '', pinned: true, group: null },
      { url: 'https://same.test', title: '', pinned: false, group: 0 },
      { url: 'https://second.test', title: '', pinned: false, group: 0 },
      { url: 'chrome://settings', title: '', pinned: false, group: null },
    ] },
    { groups: [], tabs: [{ url: 'about:blank', title: '', pinned: false, group: null }] },
  ],
};
function fakePort(): RestorePort
{
  let id = 0;
  return {
    fileAccess: vi.fn(async () => false),
    createWindow: vi.fn(async () => ({ windowId: ++id, tabId: ++id })),
    createTab: vi.fn(async () => ++id),
    pinTab: vi.fn(async () => undefined),
    groupTabs: vi.fn(async () => undefined),
    createPlaceholderTab: vi.fn(async () => ++id),
  };
}

describe('restoration', () =>
{
  it('persists the session name and tab, pin and group issue details without changing earlier progress', async () =>
  {
    const port = fakePort();
    vi.mocked(port.pinTab).mockRejectedValueOnce(new Error('Pin refused'));
    vi.mocked(port.createTab).mockRejectedValueOnce(new Error('Tab refused'));
    vi.mocked(port.groupTabs).mockRejectedValueOnce(new Error('Group refused'));
    const progress: Operation[] = [];
    const result = await restoreSession({ ...snapshot, name: 'Research' }, port, async value => { progress.push(value); });
    expect(result).toMatchObject({ name: 'Research', issues: [
      { kind: 'pin', title: '', url: 'https://same.test', message: 'Could not pin the tab: Pin refused' },
      { kind: 'tab', title: '', url: 'https://same.test', message: 'Tab refused' },
      { kind: 'group', title: 'Research', message: 'Group refused' },
    ] });
    expect(progress[0]).toMatchObject({ name: 'Research', issues: [] });
  });

  it('identifies each affected tab when a destination window cannot be created and bounds details', async () =>
  {
    const port = fakePort();
    vi.mocked(port.createWindow).mockRejectedValue(new Error('Window refused'));
    const tabs = Array.from({ length: 25 }, (_, index) => ({ url: `https://example.test/${index}`, title: `Page ${index}`, pinned: false, group: null }));
    const result = await restoreSession({ ...snapshot, windows: [{ tabs, groups: [] }] }, port, async () => undefined);
    expect(result).toMatchObject({ failed: 25, issues: expect.arrayContaining([
      { kind: 'tab', title: 'Page 0', url: 'https://example.test/0', message: 'Window refused' },
    ]) });
    expect(result.issues).toHaveLength(20);
  });

  it('restores only the selected window with its pins, groups and skipped counts', async () =>
  {
    const port = fakePort();
    const saved = structuredClone(snapshot);
    saved.windows.reverse();
    const result = await restoreSession(saved, port, async () => undefined, false, 1);
    expect(port.createWindow).toHaveBeenCalledExactlyOnceWith('https://same.test');
    expect(port.createTab).toHaveBeenCalledTimes(2);
    expect(port.pinTab).toHaveBeenCalledWith(2);
    expect(port.groupTabs).toHaveBeenCalledWith(1, [3, 4], snapshot.windows[0]?.groups[0]);
    expect(result).toMatchObject({ total: 4, opened: 3, skipped: 1, failed: 0 });
    expect(saved.windows).toHaveLength(2);
  });

  it('keeps the original window number in restore errors', async () =>
  {
    const port = fakePort();
    vi.mocked(port.createWindow).mockRejectedValueOnce(new Error('Window refused'));
    const result = await restoreSession(snapshot, port, async () => undefined, false, 1);
    expect(result).toMatchObject({ total: 1, opened: 0, failed: 1, errors: ['Window 2: Window refused'] });
  });

  it.each([-1, 2, 0.5])('rejects unavailable window index %s before recording or opening anything', async index =>
  {
    const port = fakePort();
    const persist = vi.fn(async () => undefined);
    await expect(restoreSession(snapshot, port, persist, false, index)).rejects.toThrow('saved window');
    expect(persist).not.toHaveBeenCalled();
    expect(port.createWindow).not.toHaveBeenCalled();
  });

  it('restores local files with permission while retaining pin and group metadata', async () =>
  {
    const port = fakePort();
    const local = structuredClone(snapshot);
    local.windows[0]!.tabs[0]!.url = 'file:///C:/Research/My%20paper.pdf#page=3';
    local.windows[0]!.tabs[1]!.url = 'file:///M:/Research/paper.pdf';
    const result = await restoreSession(local, port, async () => undefined, true);
    expect(port.createWindow).toHaveBeenCalledWith('file:///C:/Research/My%20paper.pdf#page=3');
    expect(port.createTab).toHaveBeenCalledWith(1, 'file:///M:/Research/paper.pdf', false);
    expect(port.pinTab).toHaveBeenCalledWith(2);
    expect(port.groupTabs).toHaveBeenCalledWith(1, [3, 4], snapshot.windows[0]?.groups[0]);
    expect(result).toMatchObject({ opened: 4, skipped: 1, failed: 0 });
  });

  it('skips blocked local files and still opens the first web tab in the window', async () =>
  {
    const port = fakePort();
    const local = structuredClone(snapshot);
    local.windows[0]!.tabs[0]!.url = 'file:///C:/Research/paper.pdf';
    const result = await restoreSession(local, port, async () => undefined, false);
    expect(port.createWindow).not.toHaveBeenCalledWith('file:///C:/Research/paper.pdf');
    expect(result).toMatchObject({ opened: 3, skipped: 2, failed: 0 });
  });

  it('restores duplicates, pins and groups in separate windows and reports skipped URLs', async () =>
  {
    const port = fakePort();
    const progress: Operation[] = [];
    const result = await restoreSession(snapshot, port, async value => { progress.push(structuredClone(value)); });
    expect(port.createWindow).toHaveBeenCalledTimes(2);
    expect(port.createTab).toHaveBeenCalledTimes(2);
    expect(port.pinTab).toHaveBeenCalledTimes(1);
    expect(port.groupTabs).toHaveBeenCalledWith(1, [3, 4], snapshot.windows[0]?.groups[0]);
    expect(result).toMatchObject({ kind: 'completed', opened: 4, skipped: 1, failed: 0 });
    expect(progress[0]).toMatchObject({ kind: 'running', opened: 0 });
  });

  it('continues after a failed tab and a failed group', async () =>
  {
    const port = fakePort();
    vi.mocked(port.createTab).mockRejectedValueOnce(new Error('Tab refused'));
    vi.mocked(port.groupTabs).mockRejectedValue(new Error('Group refused'));
    const result = await restoreSession(snapshot, port, async () => undefined);
    expect(result).toMatchObject({ opened: 3, skipped: 1, failed: 1, groupErrors: 1 });
    expect(port.createWindow).toHaveBeenCalledTimes(2);
  });

  it('counts all supported tabs in a failed window and continues to later windows', async () =>
  {
    const port = fakePort();
    vi.mocked(port.createWindow).mockRejectedValueOnce(new Error('Window refused'));
    const result = await restoreSession(snapshot, port, async () => undefined);
    expect(result).toMatchObject({ opened: 1, failed: 3, skipped: 1 });
  });

  it('opens background web tabs above the threshold as placeholders and groups them', async () =>
  {
    const port = fakePort();
    const result = await restoreSession(snapshot, port, async () => undefined, false, undefined, 3);
    expect(port.createPlaceholderTab).toHaveBeenCalledTimes(2);
    expect(port.createPlaceholderTab).toHaveBeenCalledWith(1, 'https://same.test', '', false);
    expect(port.createPlaceholderTab).toHaveBeenCalledWith(1, 'https://second.test', '', false);
    expect(port.createTab).not.toHaveBeenCalled();
    expect(port.groupTabs).toHaveBeenCalledWith(1, [3, 4], snapshot.windows[0]?.groups[0]);
    expect(result).toMatchObject({ opened: 4, skipped: 1, failed: 0, groupErrors: 0, errors: [] });
  });

  it.each([4, null])('opens every tab normally when the threshold is %s', async threshold =>
  {
    const port = fakePort();
    await restoreSession(snapshot, port, async () => undefined, false, undefined, threshold);
    expect(port.createPlaceholderTab).not.toHaveBeenCalled();
  });

  it('opens local files and blank pages normally during lightweight restoration', async () =>
  {
    const port = fakePort();
    const mixed: Snapshot = { ...snapshot, windows: [{ groups: [], tabs: [
      { url: 'https://first.test', title: 'First', pinned: false, group: null },
      { url: 'file:///C:/Research/paper.pdf', title: 'Paper', pinned: false, group: null },
      { url: 'about:blank', title: '', pinned: false, group: null },
      { url: 'http://second.test/page', title: 'Second', pinned: true, group: null },
    ] }] };
    const result = await restoreSession(mixed, port, async () => undefined, true, undefined, 1);
    expect(vi.mocked(port.createTab).mock.calls.map(call => call[1])).toEqual(['file:///C:/Research/paper.pdf', 'about:blank']);
    expect(port.createPlaceholderTab).toHaveBeenCalledExactlyOnceWith(1, 'http://second.test/page', 'Second', true);
    expect(result).toMatchObject({ opened: 4, failed: 0 });
  });

  it('records a failed placeholder tab and continues', async () =>
  {
    const port = fakePort();
    vi.mocked(port.createPlaceholderTab).mockRejectedValueOnce(new Error('Tab refused'));
    const result = await restoreSession(snapshot, port, async () => undefined, false, undefined, 1);
    expect(result).toMatchObject({ kind: 'completed', opened: 3, failed: 1, errors: ['Window 1, https://same.test: Tab refused'] });
  });

  it('stops before touching the browser if initial progress cannot be saved', async () =>
  {
    const port = fakePort();
    await expect(restoreSession(snapshot, port, async () => { throw new Error('Disk unavailable'); })).rejects.toThrow('Disk unavailable');
    expect(port.createWindow).not.toHaveBeenCalled();
  });

  it('stops instead of replaying a browser mutation if its progress write fails', async () =>
  {
    const port = fakePort();
    let writes = 0;
    await expect(restoreSession(snapshot, port, async () => { if (++writes === 2) throw new Error('Disk unavailable'); })).rejects.toThrow();
    expect(port.createWindow).toHaveBeenCalledTimes(1);
    expect(port.createTab).not.toHaveBeenCalled();
  });
});
