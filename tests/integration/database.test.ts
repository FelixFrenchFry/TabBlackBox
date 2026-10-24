import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { Repository } from '../../src/database';
import type { Session } from '../../src/model';

const session: Session = { windows: [{ groups: [], tabs: [{ url: 'https://example.test', title: 'Example', pinned: true, group: null }] }] };

describe('transactional backups', () =>
{
  it('paginates through equal timestamps despite new backups and a deleted anchor', async () =>
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    try {
      for (let i = 0; i < 12; i++) {
        await repository.capture({ windows: [{ groups: [], tabs: [{ url: `https://example.test/${i}`, title: '', pinned: false, group: null }] }] }, 'automatic', 1000);
      }
      const original = await repository.list(null, 100);
      const first = await repository.list(null, 5);
      const anchor = first.at(-1);
      if (!anchor) throw new Error('Fixture cursor missing');
      await repository.capture(session, 'automatic', 2000);
      await repository.keep(anchor.id, null, 2001);
      await repository.deleteSession(anchor.id);
      const rest = await repository.list(anchor, 100);
      expect(rest.map(item => item.id)).toEqual(original.slice(5).map(item => item.id));
      expect(new Set([...first, ...rest].map(item => item.id)).size).toBe(12);
    } finally { await repository.close(); }
  });
  it('persists across connection restart, deduplicates and never replaces a snapshot with empty state', async () =>
  {
    const name = crypto.randomUUID();
    const first = new Repository(name);
    const saved = await first.capture(session, 'automatic', 1000);
    expect(saved.kind).toBe('saved');
    await first.close();
    const reopened = new Repository(name);
    expect((await reopened.list()).length).toBe(1);
    expect((await reopened.capture(session, 'automatic', 2000)).kind).toBe('unchanged');
    expect((await reopened.capture({ windows: [] }, 'automatic', 3000)).kind).toBe('empty');
    expect((await reopened.list()).length).toBe(1);
    expect((await reopened.metadata()).lastCheckedAt).toBe(3000);
    await reopened.close();
  });

  it('keeps snapshots and successful metadata when a retained history cannot fit', async () =>
  {
    const repository = new Repository(crypto.randomUUID(), 1000);
    await repository.capture(session, 'manual', 1000);
    const before = await repository.metadata();
    const tooLarge: Session = { windows: [{ groups: [], tabs: [{ url: 'https://large.test', title: 'x'.repeat(2000), pinned: false, group: null }] }] };
    await expect(repository.capture(tooLarge, 'automatic', 2000)).rejects.toThrow('storage full');
    expect(await repository.metadata()).toEqual(before);
    expect(await repository.list()).toHaveLength(1);
    await repository.close();
  });

  it('keeps old history and more than 200 backups with the new defaults', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    for (let i = 0; i < 205; i++) {
      await repository.capture({ windows: [{ groups: [], tabs: [{ url: `https://example.test/${i}`, title: '', pinned: false, group: null }] }] }, 'automatic', i);
    }
    expect(await repository.list(null, 1000)).toHaveLength(205);
    await repository.capture(session, 'manual', 31 * 86_400_000);
    expect(await repository.list(null, 1000)).toHaveLength(206);
    await repository.close();
  });

  it('rolls back an aborted transaction without changing bodies or successful metadata', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    await repository.capture(session, 'manual', 1000);
    const metadata = await repository.metadata();
    const original = IDBObjectStore.prototype.add;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key)
    {
      const request = original.call(this, value, key);
      if (this.name === 'snapshots') this.transaction.abort();
      return request;
    });
    try {
      const changed = structuredClone(session);
      const first = changed.windows[0]?.tabs[0];
      if (!first) throw new Error('Fixture missing');
      first.title = 'Changed';
      await expect(repository.capture(changed, 'manual', 2000)).rejects.toThrow();
    } finally { spy.mockRestore(); }
    expect(await repository.metadata()).toEqual(metadata);
    expect(await repository.list()).toHaveLength(1);
    await repository.close();
  });

  it('reuses shared tab records while exporting saved sessions', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    try {
      for (let i = 0; i < 3; i++) await repository.capture(session, 'manual', 1000 + i);
      let reads = 0;
      const original = IDBObjectStore.prototype.get;
      const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key)
      {
        if (this.name === 'tabs') reads++;
        return original.call(this, key);
      });
      try {
        const exported: Session[] = [];
        expect(await repository.exportSaved(item => { exported.push({ windows: item.windows }); })).toBe(3);
        expect(exported).toEqual([session, session, session]);
        expect(reads).toBe(1);
      } finally { spy.mockRestore(); }
    } finally { await repository.close(); }
  });

  it('refuses to export when only automatic backups exist', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    try {
      await expect(repository.exportSaved(() => {})).rejects.toThrow('No manual backups are available to export.');
      await repository.capture(session, 'automatic', 1000);
      const exported = vi.fn();
      await expect(repository.exportSaved(exported)).rejects.toThrow('No manual backups are available to export.');
      expect(exported).not.toHaveBeenCalled();
    } finally { await repository.close(); }
  });

  it('checks missing tab records on each export', async () =>
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    try {
      await repository.capture(session, 'manual', 1000);
      await repository.exportSaved(() => {});
      const db = await openDB(name);
      try { await db.delete('tabs', (await repository.metadata()).lastTabId); }
      finally { db.close(); }
      await expect(repository.exportSaved(() => {})).rejects.toThrow('missing tab data');
    } finally { await repository.close(); }
  });

  it('refuses a newer database version without resetting existing backups', async () =>
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    await repository.capture(session, 'manual', 1000);
    await repository.close();
    const current = await openDB(name);
    const futureVersion = current.version + 1;
    current.close();
    const future = await openDB(name, futureVersion);
    future.close();
    await expect(repository.list()).rejects.toThrow();
    const stillPresent = await openDB(name, futureVersion);
    expect(await stillPresent.getAll('snapshots')).toHaveLength(1);
    stillPresent.close();
  });
});
