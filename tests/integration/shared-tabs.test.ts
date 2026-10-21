import { exportArchive } from '../support/archive';
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { Repository } from '../../src/database';
import { Controller } from '../../src/controller';
import type { Metadata, SavedTab, Snapshot, StoredSnapshot, StoredTab, Summary } from '../../src/model';
import { canonicalTab, decodeSnapshot, encodeSnapshot } from '../../src/session';
import { DEFAULT_STORAGE_SETTINGS, retentionPlan, retentionRemovals, storageTotals } from '../../src/storage';

const tab: SavedTab = { url: 'https://example.test', title: 'Research 🧪', pinned: false, group: null };
const session = (title = tab.title) => ({ windows: [{ groups: [], tabs: [{ ...tab, title }, { ...tab, title }] }] });
const size = (value: object) => new TextEncoder().encode(JSON.stringify({ ...value, tabIds: undefined })).byteLength;
const stores = (contexts: unknown[]) => contexts.filter((store): store is IDBObjectStore => store instanceof IDBObjectStore).map(store => store.name);
const snapshot = (id: string, capturedAt: number): Omit<Snapshot, 'changes'> => ({ ...session(), id, number: capturedAt, name: null, source: 'automatic', capturedAt });

async function rawStorage(name: string)
{
  const db = await openDB(name);
  try {
    const tx = db.transaction(['snapshots', 'tabs', 'summaries', 'metadata']);
    const snapshots: StoredSnapshot[] = await tx.objectStore('snapshots').getAll();
    const tabs: StoredTab[] = await tx.objectStore('tabs').getAll();
    const summaries: Summary[] = await tx.objectStore('summaries').getAll();
    const metadata: Metadata = await tx.objectStore('metadata').get('state');
    await tx.done;
    return { snapshots, tabs, summaries, metadata };
  } finally { db.close(); }
}

async function checkStorage(name: string)
{
  const state = await rawStorage(name);
  const expected = (records: StoredSnapshot[]) => {
    const ids = new Set(records.flatMap(snapshot => snapshot.windows.flatMap(window => window.tabs)));
    expect(state.tabs.filter(tab => ids.has(tab.id))).toHaveLength(ids.size);
    return records.reduce((sum, record) => sum + size(record), 0) + state.tabs.filter(tab => ids.has(tab.id)).reduce((sum, tab) => sum + size(tab), 0);
  };
  expect(state.metadata.bytes).toBe(expected(state.snapshots));
  expect(state.metadata.automaticBytes).toBe(expected(state.snapshots.filter(snapshot => snapshot.savedAt === undefined)));
  expect(state.metadata.savedBytes).toBe(expected(state.snapshots.filter(snapshot => snapshot.savedAt !== undefined)));
  expect(state.tabs).toHaveLength(new Set(state.snapshots.flatMap(snapshot => snapshot.windows.flatMap(window => window.tabs))).size);
  for (const snapshot of state.snapshots) {
    expect(state.summaries.find(summary => summary.id === snapshot.id)?.bytes).toBe(size(snapshot));
    expect(snapshot.tabIds).toEqual([...new Set(snapshot.windows.flatMap(window => window.tabs))]);
  }
  return state;
}

describe('shared tab records', () =>
{
  it('preserves duplicates, windows and window-local group definitions through encoding', () =>
  {
    const grouped = { ...tab, group: 0 };
    const tabs = new Map<number, StoredTab>([[1, { ...grouped, id: 1 }]]);
    const ids = new Map([[canonicalTab(grouped), 1]]);
    const original: Snapshot = { ...snapshot('a', 1), windows: [
      { tabs: [grouped, grouped], groups: [{ name: 'Research', color: 'blue', collapsed: false }] },
      { tabs: [grouped], groups: [{ name: 'Work', color: 'red', collapsed: true }] },
    ] };
    const stored = encodeSnapshot(original, ids);
    expect(stored.windows.map(window => window.tabs)).toEqual([[1, 1], [1]]);
    expect(stored.tabIds).toEqual([1]);
    const restored = decodeSnapshot(stored, tabs);
    expect(restored).toEqual(original);
    expect(restored.windows[0]?.tabs[0]).not.toBe(restored.windows[0]?.tabs[1]);
    expect(() => decodeSnapshot(stored, new Map())).toThrow('missing tab');
  });

  it('distinguishes complete tab variants without depending on property order', () =>
  {
    expect(canonicalTab({ group: null, pinned: false, title: tab.title, url: tab.url })).toBe(canonicalTab(tab));
    const variants = [tab, { ...tab, title: 'Other' }, { ...tab, pinned: true }, { ...tab, group: 0 }, { ...tab, url: null }, { ...tab, url: '' }];
    expect(new Set(variants.map(canonicalTab)).size).toBe(variants.length);
  });

  it('counts a shared record once per collection and once globally', () =>
  {
    const record: StoredTab = { ...tab, id: 1 };
    const tabs = new Map([[1, record]]);
    const automatic: StoredSnapshot = { ...snapshot('a', 1), windows: [{ groups: [], tabs: [1, 1] }], tabIds: [1] };
    const saved = { ...automatic, id: 'b', savedAt: 2 };
    expect(storageTotals([automatic, saved], tabs)).toEqual({
      bytes: size(automatic) + size(saved) + size(record),
      automaticBytes: size(automatic) + size(record),
      savedBytes: size(saved) + size(record),
    });
  });

  it('frees shared bytes only at the last automatic reference and protects the candidate', () =>
  {
    const record: StoredTab = { ...tab, id: 1 };
    const tabs = new Map([[1, record]]);
    const first: StoredSnapshot = { ...snapshot('z', 1), windows: [{ groups: [], tabs: [1, 1] }], tabIds: [1] };
    const second = { ...first, id: 'a' };
    const saved = { ...first, id: 'saved', savedAt: 2 };
    const records = [first, second, saved];
    const budget = size(second) + size(record);
    expect(retentionPlan(records, tabs, second.id, DEFAULT_STORAGE_SETTINGS, 2, budget)).toEqual({ removeIds: [first.id] });
    expect(retentionRemovals(records, 'saved', { ...DEFAULT_STORAGE_SETTINGS, maxBackups: 1 }, 2)).toEqual(['a']);
    expect(() => retentionPlan(records, tabs, second.id, DEFAULT_STORAGE_SETTINGS, 2, budget - 1)).toThrow('storage full');
  });

  it('stores numeric references and avoids full scans on unchanged captures and history reads', async () =>
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    try {
      const saved = await repository.capture(session(), 'automatic', 1);
      if (saved.kind !== 'saved') throw new Error('Fixture missing');
      const db = await openDB(name);
      try {
        expect(await db.getAll('tabs')).toHaveLength(1);
        expect((await db.get('snapshots', saved.id)).windows[0].tabs).toEqual([1, 1]);
      } finally { db.close(); }
      const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
      const get = vi.spyOn(IDBObjectStore.prototype, 'get');
      try {
        expect((await repository.capture(session(), 'automatic', 2)).kind).toBe('unchanged');
        expect(stores(getAll.mock.contexts)).not.toContain('tabs');
        expect(stores(getAll.mock.contexts)).not.toContain('snapshots');
        expect(stores(get.mock.contexts).filter(name => name === 'tabs')).toHaveLength(1);
        get.mockClear();
        await repository.history();
        expect(stores(get.mock.contexts)).not.toContain('tabs');
        expect(stores(get.mock.contexts)).not.toContain('snapshots');
      } finally { getAll.mockRestore(); get.mockRestore(); }
      expect((await repository.get(saved.id)).windows).toEqual(session().windows);
      expect((await repository.metadata()).lastCheckedAt).toBe(2);
    } finally { await repository.close(); }
  });

  it('maintains shared records and totals through keep, rename, import, pruning and deletion', async () =>
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    try {
      const first = await repository.capture(session(), 'automatic', 1);
      const manual = await repository.capture(session(), 'manual', 2);
      if (first.kind !== 'saved' || manual.kind !== 'saved') throw new Error('Fixture missing');
      let state = await checkStorage(name);
      expect(state.tabs).toHaveLength(1);
      expect(state.metadata.automaticBytes + state.metadata.savedBytes).toBeGreaterThan(state.metadata.bytes);
      await repository.rename(first.id, 'Research 🧪');
      await checkStorage(name);
      const archive = await exportArchive(repository, manual.id);
      await repository.importSaved(archive, 3);
      await checkStorage(name);
      await repository.keep(first.id, 'Kept', 4);
      state = await checkStorage(name);
      expect(state.metadata.automaticBytes).toBe(0);
      expect(state.metadata.lastTabId).toBe(1);
      await repository.capture(session('other'), 'automatic', 5);
      await repository.setStorageSettings({ ...DEFAULT_STORAGE_SETTINGS, maxBackups: 1 }, 1, 6);
      state = await checkStorage(name);
      expect(state.tabs).toHaveLength(2);
      for (const saved of (await repository.history(null, 100, 'saved')).items) await repository.deleteSession(saved.id);
      state = await checkStorage(name);
      expect(state.tabs).toHaveLength(1);
      await repository.capture(session('last'), 'automatic', 7);
      state = await checkStorage(name);
      expect(state.tabs.map(tab => tab.title)).toEqual(['last']);
      const lastId = state.metadata.lastTabId;
      await repository.capture(session(), 'automatic', 8);
      state = await checkStorage(name);
      expect(state.tabs[0]?.id).toBeGreaterThan(lastId);
      await repository.close();
      expect((await exportArchive(repository).catch(() => null))).toBeNull();
      await checkStorage(name);
    } finally { await repository.close(); }
  });

  it('applies expiration to existing backups when changing limits', async () =>
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    try {
      await repository.capture(session('old'), 'automatic', 1);
      await repository.capture(session('new'), 'automatic', 2);
      const before = await rawStorage(name);
      const settings = { ...DEFAULT_STORAGE_SETTINGS, retentionDays: 1 };
      expect(await repository.setStorageSettings(settings, 0, 2 * 86_400_000)).toEqual({ kind: 'confirmation', removeCount: 1 });
      expect(await rawStorage(name)).toEqual(before);
      await repository.setStorageSettings(settings, 1, 2 * 86_400_000);
      expect(await repository.list()).toHaveLength(1);
      await checkStorage(name);
    } finally { await repository.close(); }
  });

  it('does not bypass a lowered space budget for an unchanged latest snapshot', async () =>
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    try {
      await repository.capture(session('old'), 'automatic', 1);
      await repository.capture(session('new'), 'automatic', 2);
      const state = await checkStorage(name);
      await repository.close();
      const limited = new Repository(name, state.metadata.automaticBytes - 1);
      try {
        expect(await limited.setStorageSettings(DEFAULT_STORAGE_SETTINGS, 0, 3)).toEqual({ kind: 'confirmation', removeCount: 1 });
        expect(await rawStorage(name)).toEqual(state);
        await limited.setStorageSettings(DEFAULT_STORAGE_SETTINGS, 1, 3);
        expect(await limited.list()).toHaveLength(1);
        await checkStorage(name);
      } finally { await limited.close(); }
      const tooSmall = new Repository(name, 1);
      try {
        const before = await rawStorage(name);
        await expect(tooSmall.capture(session('new'), 'automatic', 4)).rejects.toThrow('storage full');
        expect(await rawStorage(name)).toEqual(before);
      } finally { await tooSmall.close(); }
    } finally { await repository.close(); }
  });

  it.each(['tabs', 'snapshots', 'metadata'])('rolls back all records and IDs after a failure at %s', async store =>
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    try {
      await repository.setStorageSettings({ ...DEFAULT_STORAGE_SETTINGS, maxBackups: 1 }, 0, 1);
      await repository.capture(session('old'), 'automatic', 1);
      const before = await rawStorage(name);
      const originalAdd = IDBObjectStore.prototype.add;
      const originalPut = IDBObjectStore.prototype.put;
      const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
        const request = originalAdd.call(this, value, key);
        if (this.name === store) this.transaction.abort();
        return request;
      });
      const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
        if (this.name === store) throw new Error('Injected persistence failure');
        return originalPut.call(this, value, key);
      });
      try { await expect(repository.capture(session('new'), 'automatic', 2)).rejects.toThrow(); }
      finally { add.mockRestore(); put.mockRestore(); }
      expect(await rawStorage(name)).toEqual(before);
    } finally { await repository.close(); }
  });

  it('shares records across concurrent writers and fails explicitly on missing references', async () =>
  {
    const name = crypto.randomUUID();
    const first = new Repository(name);
    const second = new Repository(name);
    try {
      await Promise.all([first.capture(session(), 'manual', 1), second.capture(session(), 'manual', 2)]);
      const state = await checkStorage(name);
      expect(state.tabs).toHaveLength(1);
      expect(state.metadata.lastTabId).toBe(1);
      const saved = state.snapshots[0];
      if (!saved) throw new Error('Fixture missing');
      const db = await openDB(name);
      try { await db.delete('tabs', 1); } finally { db.close(); }
      await expect(first.get(saved.id)).rejects.toThrow('missing tab');
      await expect(first.capture(session(), 'automatic', 3)).rejects.toThrow('missing tab');
    } finally { await first.close(); await second.close(); }
  });

  it('reads overview from stored summaries and metadata after initialization', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
    const controller = new Controller(repository, async () => session(), {
      fileAccess: async () => false, createWindow: async () => ({ windowId: 1, tabId: 1 }),
      createTab: async () => 1, pinTab: async () => {}, groupTabs: async () => {}, createPlaceholderTab: async () => 1,
    });
    try {
      await controller.start();
      const get = vi.spyOn(IDBObjectStore.prototype, 'get');
      const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
      try {
        const overview = await controller.overview();
        expect(overview.latest).not.toBeNull();
        expect(overview.automaticStorage.bytes).toBe(overview.metadata.automaticBytes);
        expect(stores([...get.mock.contexts, ...getAll.mock.contexts])).not.toContain('snapshots');
        expect(stores([...get.mock.contexts, ...getAll.mock.contexts])).not.toContain('tabs');
      } finally { get.mockRestore(); getAll.mockRestore(); }
    } finally { controller.stopTimers(); await repository.close(); }
  });

  it('rolls back an entire multi-session import including its new tab records', async () =>
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    try {
      await repository.capture(session('existing'), 'manual', 1);
      const before = await rawStorage(name);
      const original = IDBObjectStore.prototype.put;
      const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
        if (this.name === 'metadata') throw new Error('Injected import failure');
        return original.call(this, value, key);
      });
      try {
        await expect(repository.importSaved({ format: 'tabblackbox', version: 1, sessions: [
          { ...session('first'), name: 'First', capturedAt: 2, source: 'manual' },
          { ...session('second'), name: 'Second', capturedAt: 3, source: 'manual' },
        ] }, 4)).rejects.toThrow('Injected import failure');
      } finally { put.mockRestore(); }
      expect(await rawStorage(name)).toEqual(before);
    } finally { await repository.close(); }
  });

  it('captures group definition changes without changing existing tab records', async () =>
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    const current = { windows: [{ groups: [{ name: 'Research', color: 'blue' as const, collapsed: false }], tabs: [{ ...tab, group: 0 }] }] };
    try {
      const original = structuredClone(current);
      const first = await repository.capture(current, 'automatic', 1);
      const group = current.windows[0]?.groups[0];
      if (!group || first.kind !== 'saved') throw new Error('Fixture missing');
      group.name = 'Work';
      group.collapsed = true;
      expect((await repository.capture(current, 'automatic', 2)).kind).toBe('saved');
      expect((await checkStorage(name)).tabs).toHaveLength(1);
      expect((await repository.get(first.id)).windows).toEqual(original.windows);
    } finally { await repository.close(); }
  });

  it('round-trips 50 gradually changing 500-tab sessions with substantial shared storage savings', async () =>
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    const originals = new Map<string, Snapshot>();
    try {
      let previousId: string | null = null;
      for (let index = 0; index < 50; index++) {
        const current = { windows: [{ groups: [], tabs: Array.from({ length: 500 }, (_, tabIndex) => ({ ...tab, url: `https://example.test/research/${tabIndex}`, title: tabIndex === 0 ? `Changed ${index}` : `Research tab ${tabIndex}` })) }] };
        const result = await repository.capture(current, 'automatic', index + 1);
        if (result.kind !== 'saved') throw new Error('Fixture missing');
        // title changes keep the same pages so later captures record no opened or closed tabs
        const changes = previousId ? { changes: { previousId, opened: [[]], closed: [[]], closedWindows: [] } } : {};
        previousId = result.id;
        originals.set(result.id, { ...current, id: result.id, number: index + 1, name: null, source: 'automatic', capturedAt: index + 1, ...changes });
      }
      const state = await checkStorage(name);
      expect(state.tabs).toHaveLength(549);
      expect(state.metadata.bytes).toBeLessThan([...originals.values()].reduce((sum, snapshot) => sum + size(snapshot), 0) * 0.15);
      for (const [id, original] of originals) expect(await repository.get(id)).toEqual(original);
    } finally { await repository.close(); }
  });
});
