import type { ChangeCounts, Session, SessionChanges, StoredChanges, StoredSnapshot, StoredTab } from './model';

type Occurrence = { url: string; window: number; index: number };

function occurrences(windows: readonly (readonly (string | null)[])[]): Occurrence[]
{
  // tabs without an address cannot be matched between backups
  return windows.flatMap((urls, window) => urls.flatMap((url, index) => url === null ? [] : [{ url, window, index }]));
}

function countUrls(items: readonly Occurrence[]): Map<string, number>
{
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.url, (counts.get(item.url) ?? 0) + 1);
  return counts;
}

function surplus(items: readonly Occurrence[], other: ReadonlyMap<string, number>): Set<Occurrence>
{
  // mark the last extra occurrences of each URL so duplicate tabs count individually
  const remaining = new Map([...countUrls(items)].map(([url, count]) => [url, count - (other.get(url) ?? 0)]));
  const result = new Set<Occurrence>();
  for (const item of [...items].reverse()) {
    const extra = remaining.get(item.url) ?? 0;
    if (extra <= 0) continue;
    result.add(item);
    remaining.set(item.url, extra - 1);
  }
  return result;
}

export function compareSessions(current: Session, previous: StoredSnapshot, tabs: ReadonlyMap<number, StoredTab>): StoredChanges
{
  const now = occurrences(current.windows.map(window => window.tabs.map(tab => tab.url)));
  const before = occurrences(previous.windows.map(window => window.tabs.map(id => {
    const tab = tabs.get(id);
    if (!tab) throw new Error('This backup has missing tab data.');
    return tab.url;
  })));
  const opened = surplus(now, countUrls(before));
  const closed = surplus(before, countUrls(now));
  const changes: StoredChanges = { previousId: previous.id, opened: current.windows.map(() => []), closed: current.windows.map(() => []), closedWindows: [] };
  for (const item of now) if (opened.has(item)) changes.opened[item.window]?.push(item.index);
  // reference closed tabs by the shared records that the previous session keeps stored
  const record = (item: Occurrence) => {
    const id = previous.windows[item.window]?.tabs[item.index];
    if (id === undefined) throw new Error('This backup has missing tab data.');
    return id;
  };
  // locate each URL by its first position in every current window
  const positions = current.windows.map(window => {
    const first = new Map<string, number>();
    window.tabs.forEach((tab, index) => { if (tab.url !== null && !first.has(tab.url)) first.set(tab.url, index); });
    return first;
  });
  for (const windowIndex of previous.windows.keys()) {
    const items = before.filter(item => item.window === windowIndex);
    // follow a previous window into the current window that kept most of its open pages
    const urls = new Set(items.filter(item => !closed.has(item)).map(item => item.url));
    let match = -1;
    let shared = 0;
    for (const [index, first] of positions.entries()) {
      const count = [...urls].filter(url => first.has(url)).length;
      if (count > shared) { match = index; shared = count; }
    }
    const removed = items.filter(item => closed.has(item));
    if (!removed.length) continue;
    const target = positions[match];
    if (!target) {
      changes.closedWindows.push(removed.map(record));
      continue;
    }
    const byIndex = new Map(items.map(item => [item.index, item]));
    for (const item of removed) {
      // show a closed tab after the nearest earlier tab of its window that is still open there
      let after = -1;
      for (let index = item.index - 1; index >= 0 && after < 0; index--) {
        const kept = byIndex.get(index);
        if (kept && !closed.has(kept)) after = target.get(kept.url) ?? -1;
      }
      changes.closed[match]?.push({ tab: record(item), after });
    }
  }
  return changes;
}

export function changedTabIds(changes: StoredChanges | undefined): number[]
{
  // list the shared tab records that the closed tabs of a comparison refer to
  return changes ? [...changes.closed.flatMap(window => window.map(item => item.tab)), ...changes.closedWindows.flat()] : [];
}

export function changeCounts(changes: SessionChanges | StoredChanges): ChangeCounts
{
  const total = (windows: readonly (readonly unknown[])[]) => windows.reduce((count, window) => count + window.length, 0);
  return { previousId: changes.previousId, opened: total(changes.opened), closed: total(changes.closed) + total(changes.closedWindows) };
}
