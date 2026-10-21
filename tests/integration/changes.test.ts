import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { changeCounts, compareSessions } from '../../src/changes';
import { Repository } from '../../src/database';
import type { Session, StoredTab } from '../../src/model';
import { exportArchive } from '../support/archive';

const tab = (url: string | null, title = url ?? '') => ({ url, title, pinned: false, group: null });
const session = (...windows: (string | null)[][]): Session => ({ windows: windows.map(urls => ({ groups: [], tabs: urls.map(url => tab(url)) })) });
const compare = (current: Session, previous: Session) =>
{
  // store one shared record per previous tab and resolve the closed tab references for readable expectations
  const tabs = new Map<number, StoredTab>();
  const windows = previous.windows.map(window => ({ groups: window.groups, tabs: window.tabs.map(item => {
    const id = tabs.size + 1;
    tabs.set(id, { ...item, id });
    return id;
  }) }));
  const changes = compareSessions(current, { id: 'previous', number: 1, name: null, capturedAt: 1, source: 'automatic', windows, tabIds: [...tabs.keys()] }, tabs);
  const closedTab = (id: number) => ({ url: tabs.get(id)?.url ?? null, title: tabs.get(id)?.title ?? '' });
  return { ...changes, closed: changes.closed.map(window => window.map(({ tab, after }) => ({ ...closedTab(tab), after }))), closedWindows: changes.closedWindows.map(window => window.map(closedTab)) };
};

describe('compareSessions', () =>
{
  it('marks opened tabs and places closed tabs after their previous neighbor', () =>
  {
    const changes = compare(session(['a', 'c', 'd']), session(['a', 'b', 'c']));
    expect(changes.opened).toEqual([[2]]);
    expect(changes.closed).toEqual([[{ url: 'b', title: 'b', after: 0 }]]);
    expect(changes.closedWindows).toEqual([]);
    expect(changeCounts(changes)).toEqual({ previousId: 'previous', opened: 1, closed: 1 });
  });

  it('places closed tabs at the top when no earlier tab remains', () =>
  {
    expect(compare(session(['c']), session(['a', 'b', 'c'])).closed).toEqual([[{ url: 'a', title: 'a', after: -1 }, { url: 'b', title: 'b', after: -1 }]]);
  });

  it('counts duplicate tabs individually and ignores tabs without an address', () =>
  {
    const changes = compare(session(['a', 'a', null]), session(['a', null, null]));
    expect(changes.opened).toEqual([[1]]);
    expect(changeCounts(changes)).toMatchObject({ opened: 1, closed: 0 });
  });

  it('ignores tabs moved within or between windows', () =>
  {
    expect(changeCounts(compare(session(['b', 'c', 'a']), session(['a', 'b', 'c'])))).toMatchObject({ opened: 0, closed: 0 });
    expect(changeCounts(compare(session(['a'], ['b', 'c']), session(['a', 'b'], ['c'])))).toMatchObject({ opened: 0, closed: 0 });
  });

  it('lists windows without remaining pages as closed windows', () =>
  {
    const changes = compare(session(['a']), session(['a'], ['x', 'y', null]));
    expect(changes.closed).toEqual([[]]);
    expect(changes.closedWindows).toEqual([[{ url: 'x', title: 'x' }, { url: 'y', title: 'y' }]]);
    expect(changeCounts(changes)).toMatchObject({ opened: 0, closed: 2 });
  });

  it('lists a closed window as closed even when one of its pages stays open elsewhere', () =>
  {
    const changes = compare(session(['a', 'b']), session(['a', 'b'], ['x', 'a']));
    expect(changes.closed).toEqual([[]]);
    expect(changes.closedWindows).toEqual([[{ url: 'x', title: 'x' }, { url: 'a', title: 'a' }]]);
  });

  it('follows a previous window into the current window that kept most of its pages', () =>
  {
    const changes = compare(session(['a'], ['b', 'c', 'e']), session(['a', 'b', 'c', 'd']));
    expect(changes.closed).toEqual([[], [{ url: 'd', title: 'd', after: 1 }]]);
    expect(changes.opened).toEqual([[], [2]]);
  });
});

describe('stored changes', () =>
{
  const counts = async (repository: Repository, id: string) => (await repository.get(id)).changes && changeCounts((await repository.get(id)).changes!);

  it('compares each session with the previous session in its current panel', async () =>
  {
    const repository = new Repository(`changes-${crypto.randomUUID()}`);
    try {
      const capture = async (urls: string[], source: 'automatic' | 'manual', now: number) => {
        const result = await repository.capture(session(urls), source, now);
        if (result.kind !== 'saved') throw new Error('Capture was not saved.');
        return result.id;
      };
      const first = await capture(['https://a.test', 'https://b.test'], 'automatic', 1000);
      const manual = await capture(['https://a.test', 'https://c.test'], 'manual', 2000);
      const second = await capture(['https://a.test'], 'automatic', 3000);
      // manual backups never compare with automatic ones
      expect(await counts(repository, first)).toBeUndefined();
      expect(await counts(repository, manual)).toBeUndefined();
      expect(await counts(repository, second)).toEqual({ previousId: first, opened: 0, closed: 1 });
      expect((await repository.history(null, 10, 'automatic')).items[0]?.changeCounts).toEqual({ previousId: first, opened: 0, closed: 1 });

      // keeping moves the session into the saved panel and updates both panels
      await repository.keep(first, null, 4000);
      expect(await counts(repository, second)).toBeUndefined();
      expect(await counts(repository, first)).toBeUndefined();
      expect(await counts(repository, manual)).toEqual({ previousId: first, opened: 1, closed: 1 });
      expect((await repository.history(null, 10, 'saved')).items.find(item => item.id === manual)?.changeCounts).toEqual({ previousId: first, opened: 1, closed: 1 });

      // imports take their place by capture time
      await repository.importSaved({ format: 'tabblackbox', version: 1, sessions: [{ name: null, source: 'manual', capturedAt: 1500, windows: session(['https://a.test', 'https://c.test', 'https://d.test']).windows }] }, 5000);
      const imported = (await repository.history(null, 10, 'saved')).items.find(item => item.capturedAt === 1500);
      expect(imported?.changeCounts).toEqual({ previousId: first, opened: 2, closed: 1 });
      expect(await counts(repository, manual)).toEqual({ previousId: imported?.id, opened: 0, closed: 1 });

      // deleting links the next session to the deleted session's predecessor
      await repository.deleteSession(imported?.id ?? '');
      expect(await counts(repository, manual)).toEqual({ previousId: first, opened: 1, closed: 1 });
      expect((await repository.get(manual)).changes?.closed).toEqual([[{ url: 'https://b.test', title: 'https://b.test', after: 0 }]]);
      // exported archives carry only the session itself
      expect((await exportArchive(repository, manual)).sessions[0]).not.toHaveProperty('changes');
    } finally { await repository.close(); }
  });

  it('plans storage limits with the comparisons that remain after pruning', async () =>
  {
    // two unrelated sessions that each fit the limit alone but not together
    const repository = new Repository(`changes-${crypto.randomUUID()}`, 1_000_000);
    const large = (prefix: string): Session => ({ windows: [{ groups: [], tabs: Array.from({ length: 300 }, (_, index) => tab(`https://${prefix}.test/${index}`, `${prefix} ${index} ${'x'.repeat(1900)}`)) }] });
    try {
      const first = await repository.capture(large('first'), 'automatic', 1000);
      const second = await repository.capture(large('second'), 'automatic', 2000);
      if (first.kind !== 'saved' || second.kind !== 'saved') throw new Error('Capture was not saved.');
      const items = (await repository.history(null, 10, 'automatic')).items;
      expect(items.map(item => item.id)).toEqual([second.id]);
      expect((await repository.get(second.id)).changes).toBeUndefined();
      expect((await repository.metadata()).automaticBytes).toBeLessThanOrEqual(1_000_000);
    } finally { await repository.close(); }
  });

  it('stores closed tabs as references to the shared records of the previous session', async () =>
  {
    // deleting the middle backup compares the last one with a much larger older session
    const repository = new Repository(`changes-${crypto.randomUUID()}`);
    const large = (prefix: string): Session => ({ windows: [{ groups: [], tabs: Array.from({ length: 300 }, (_, index) => tab(`https://${prefix}.test/${index}`, `${prefix} ${index} ${'x'.repeat(1900)}`)) }] });
    try {
      const capture = async (value: Session, now: number) => {
        const result = await repository.capture(value, 'automatic', now);
        if (result.kind !== 'saved') throw new Error('Capture was not saved.');
        return result.id;
      };
      await capture(large('first'), 1000);
      const middle = await capture(session(['https://small.test']), 2000);
      const last = await capture(session(['https://small.test', 'https://other.test']), 3000);
      const before = (await repository.metadata()).automaticBytes;
      await repository.deleteSession(middle);
      expect((await repository.metadata()).automaticBytes).toBeLessThan(before);
      const snapshot = await repository.get(last);
      // the first session shares no pages with the last one and appears as a closed window
      expect(snapshot.changes?.closedWindows[0]).toHaveLength(300);
      expect(snapshot.changes?.closedWindows[0]?.[0]).toEqual({ url: 'https://first.test/0', title: `first 0 ${'x'.repeat(1900)}` });
    } finally { await repository.close(); }
  });

  it('drops the comparison of the oldest retained automatic backup', async () =>
  {
    const repository = new Repository(`changes-${crypto.randomUUID()}`);
    try {
      await repository.setStorageSettings({ retentionDays: null, maxBackups: 2, maxStorageMB: 100 }, 0, 1000);
      await repository.capture(session(['https://a.test']), 'automatic', 1000);
      await repository.capture(session(['https://b.test']), 'automatic', 2000);
      await repository.capture(session(['https://c.test']), 'automatic', 3000);
      const items = (await repository.history(null, 10, 'automatic')).items;
      expect(items.map(item => item.changeCounts?.opened)).toEqual([1, undefined]);
      expect(await counts(repository, items[1]?.id ?? '')).toBeUndefined();
    } finally { await repository.close(); }
  });
});
