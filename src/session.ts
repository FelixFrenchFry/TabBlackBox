import type { GroupColor, SavedWindow, Session, Snapshot, Summary } from './model';

export type CaptureTab = { index: number; url?: string; pendingUrl?: string; title?: string; pinned: boolean; groupId: number };
export type CaptureWindow = { id?: number; type?: string; incognito: boolean; tabs?: CaptureTab[] };
export type CaptureGroup = { id: number; windowId: number; title?: string; color: GroupColor; collapsed: boolean };

export function normalizeSession(windows: CaptureWindow[], groups: CaptureGroup[], ownOrigin: string): Session
{
  const saved: SavedWindow[] = [];
  for (const window of windows) {
    if (window.incognito || window.type !== 'normal') continue;
    if (!window.tabs) throw new Error('Browser changed during capture. Retrying.');
    const result: SavedWindow = { tabs: [], groups: [] };
    const groupIds = new Map<number, number>();
    for (const tab of [...window.tabs].sort((a, b) => a.index - b.index)) {
      const url = tab.pendingUrl || tab.url || null;
      if (url?.startsWith(ownOrigin)) continue;
      let group: number | null = null;
      if (tab.groupId !== -1) {
        const metadata = groups.find(item => item.id === tab.groupId && item.windowId === window.id);
        if (!metadata) throw new Error('Tab groups changed during capture. Retrying.');
        group = groupIds.get(tab.groupId) ?? result.groups.length;
        if (!groupIds.has(tab.groupId)) {
          groupIds.set(tab.groupId, group);
          result.groups.push({ name: metadata.title ?? '', color: metadata.color, collapsed: metadata.collapsed });
        }
      }
      result.tabs.push({ url, title: tab.title ?? '', pinned: tab.pinned, group });
    }
    if (result.tabs.length) saved.push(result);
  }
  return { windows: saved };
}

export function canonicalSession(session: Session): string
{
  return JSON.stringify(session.windows.map(window => JSON.stringify(window)).sort());
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

export function summarize(snapshot: Snapshot): Summary
{
  const tabs = snapshot.windows.flatMap(window => window.tabs);
  return {
    id: snapshot.id, number: snapshot.number, name: snapshot.name, capturedAt: snapshot.capturedAt, source: snapshot.source,
    windowCount: snapshot.windows.length, tabCount: tabs.length,
    supportedCount: tabs.filter(tab => restorableUrl(tab.url, true)).length,
    bytes: new TextEncoder().encode(JSON.stringify(snapshot)).byteLength,
  };
}
