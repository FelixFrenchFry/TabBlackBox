import type { GroupColor, SavedTab, SavedWindow, Session, Snapshot, StoredSnapshot, StoredTab, StoredWindow, Summary } from './model';
import { placeholderTarget } from './placeholder';
import { changeCounts } from './changes';

export type CaptureTab = { index: number; url?: string; pendingUrl?: string; title?: string; pinned: boolean; groupId: number };
export type CaptureWindow = { id?: number; type?: string; incognito: boolean; tabs?: CaptureTab[] };
export type CaptureGroup = { id: number; windowId: number; title?: string; color: GroupColor; collapsed: boolean };

// a scan that saw windows or tab groups change midway and can be repeated
export class BrowserChangedError extends Error {}

export function normalizeSession(windows: CaptureWindow[], groups: CaptureGroup[], ownOrigin: string): Session
{
  const saved: SavedWindow[] = [];
  for (const window of windows) {
    if (window.incognito || window.type !== 'normal') continue;
    if (!window.tabs) throw new BrowserChangedError('Browser changed during capture. Retrying.');
    const result: SavedWindow = { tabs: [], groups: [] };
    const groupIds = new Map<number, number>();
    for (const tab of [...window.tabs].sort((a, b) => a.index - b.index)) {
      let url = tab.pendingUrl || tab.url || null;
      let title = tab.title ?? '';
      // record placeholder tabs as their saved page and skip other own pages
      const target = placeholderTarget(url, ownOrigin);
      if (target) ({ url, title } = target);
      else if (url?.startsWith(ownOrigin)) continue;
      let group: number | null = null;
      if (tab.groupId !== -1) {
        const metadata = groups.find(item => item.id === tab.groupId && item.windowId === window.id);
        if (!metadata) throw new BrowserChangedError('Tab groups changed during capture. Retrying.');
        group = groupIds.get(tab.groupId) ?? result.groups.length;
        if (!groupIds.has(tab.groupId)) {
          groupIds.set(tab.groupId, group);
          result.groups.push({ name: metadata.title ?? '', color: metadata.color, collapsed: metadata.collapsed });
        }
      }
      result.tabs.push({ url, title, pinned: tab.pinned, group });
    }
    if (result.tabs.length) saved.push(result);
  }
  return { windows: saved };
}

export function canonicalSession(session: Session): string
{
  return JSON.stringify(session.windows.map(window => JSON.stringify([
    window.tabs.map(canonicalTab),
    window.groups.map(group => [group.name, group.color, group.collapsed]),
  ])).sort());
}

export function canonicalTab(tab: SavedTab): string
{
  return JSON.stringify([tab.url, tab.title, tab.pinned, tab.group]);
}

export function encodeSnapshot(snapshot: Snapshot, tabIds: ReadonlyMap<string, number>): StoredSnapshot
{
  // comparisons are computed from stored sessions after encoding
  const { changes: _, ...session } = snapshot;
  const windows = session.windows.map(window => ({ ...window, tabs: window.tabs.map(tab => {
    const id = tabIds.get(canonicalTab(tab));
    if (id === undefined) throw new Error('Tab record has not been allocated.');
    return id;
  }) }));
  return { ...session, windows, tabIds: snapshotTabIds(windows) };
}

export function snapshotTabIds(windows: readonly StoredWindow[]): number[]
{
  // list each referenced tab record once for the multi-entry tab index
  return [...new Set(windows.flatMap(window => window.tabs))];
}

export function decodeSnapshot(snapshot: StoredSnapshot, tabs: ReadonlyMap<number, StoredTab>): Snapshot
{
  const { tabIds, changes, ...stored } = snapshot;
  const record = (id: number) => {
    const tab = tabs.get(id);
    if (!tab) throw new Error('This backup has missing tab data.');
    return tab;
  };
  // preserve each occurrence and resolve group indices within its saved window
  const windows = snapshot.windows.map(window => ({ ...window, tabs: window.tabs.map(id => {
    const tab = record(id);
    return { url: tab.url, title: tab.title, pinned: tab.pinned, group: tab.group };
  }) }));
  if (!changes) return { ...stored, windows };
  // resolve closed tabs from the shared records of the previous session
  const closedTab = (id: number) => {
    const tab = record(id);
    return { url: tab.url, title: tab.title };
  };
  return { ...stored, windows, changes: {
    previousId: changes.previousId, opened: changes.opened,
    closed: changes.closed.map(window => window.map(({ tab, after }) => ({ ...closedTab(tab), after }))),
    closedWindows: changes.closedWindows.map(window => window.map(closedTab)),
  } };
}

export function selectWindows(snapshot: Snapshot, windowIndex?: number): SavedWindow[]
{
  if (windowIndex === undefined) return snapshot.windows;
  const window = snapshot.windows[windowIndex];
  if (!Number.isSafeInteger(windowIndex) || windowIndex < 0 || !window) throw new Error('This saved window is no longer available. Refresh history.');
  return [window];
}

export function fileUrl(url: string | null): boolean
{
  if (!url) return false;
  try { return new URL(url).protocol === 'file:'; }
  catch { return false; }
}

export const FILE_ACCESS_MESSAGE = 'To open local files, enable “Allow access to file URLs” in the details for this extension.';

export function restorableUrl(url: string | null, fileAccess = false): url is string
{
  if (url === 'about:blank') return true;
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || (fileAccess && parsed.protocol === 'file:');
  } catch { return false; }
}

export const DAY_MS = 86_400_000;

export function summarize(snapshot: Snapshot, bytes: number): Summary
{
  const tabs = snapshot.windows.flatMap(window => window.tabs);
  return {
    id: snapshot.id, number: snapshot.number, name: snapshot.name, capturedAt: snapshot.capturedAt, source: snapshot.source,
    ...(snapshot.savedAt === undefined ? {} : { savedAt: snapshot.savedAt }),
    ...(snapshot.tags === undefined ? {} : { tags: snapshot.tags }),
    windowCount: snapshot.windows.length, tabCount: tabs.length,
    supportedCount: tabs.filter(tab => restorableUrl(tab.url, true)).length,
    bytes,
    ...(snapshot.changes === undefined ? {} : { changeCounts: changeCounts(snapshot.changes) }),
  };
}
