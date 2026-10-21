import { exportArchive } from '../support/archive';
import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { Repository } from '../../src/database';
import { parseRequest, SESSION_NAME_LIMIT } from '../../src/protocol';

const session = (title: string) => ({ windows: [{ groups: [], tabs: [{ url: 'https://example.test', title, pinned: false, group: null }] }] });

it('numbers each collection independently across captures, keeping, imports and deletion', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    const automatic = await repository.capture(session('automatic first'), 'automatic', 1000);
    await repository.capture(session('automatic second'), 'automatic', 2000);
    const manual = await repository.capture(session('manual first'), 'manual', 3000);
    if (automatic.kind !== 'saved' || manual.kind !== 'saved') throw new Error('Fixture missing');
    expect((await repository.get(manual.id)).number).toBe(1);
    const kept = await repository.keep(automatic.id, 'Kept', 4000);
    expect(kept).toMatchObject({ number: 2, capturedAt: 1000, savedAt: 4000 });
    expect(await repository.keep(automatic.id, 'Kept', 5000)).toEqual(kept);
    const archive = await exportArchive(repository, automatic.id);
    await repository.importSaved(archive, 6000);
    expect((await repository.history(null, 10, 'saved')).items.map(item => item.number).sort()).toEqual([1, 2, 3]);
    await repository.deleteSession(manual.id);
    await repository.close();
    const nextManual = await repository.capture(session('manual second'), 'manual', 7000);
    const nextAutomatic = await repository.capture(session('automatic third'), 'automatic', 8000);
    if (nextManual.kind !== 'saved' || nextAutomatic.kind !== 'saved') throw new Error('Fixture missing');
    expect((await repository.get(nextManual.id)).number).toBe(4);
    expect((await repository.get(nextAutomatic.id)).number).toBe(3);
    const items = await repository.list();
    expect((await repository.metadata()).bytes).toBeGreaterThan(items.reduce((sum, item) => sum + item.bytes, 0));
  } finally { await repository.close(); }
});

it('does not consume manual numbers when a keep or import transaction fails', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    const automatic = await repository.capture(session('automatic'), 'automatic', 1000);
    await repository.capture(session('manual'), 'manual', 2000);
    if (automatic.kind !== 'saved') throw new Error('Fixture missing');
    const archive = await exportArchive(repository);
    const before = await repository.metadata();
    const original = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'metadata') throw new Error('Injected metadata failure');
      return original.apply(this, args);
    });
    try {
      await expect(repository.keep(automatic.id, 'Kept', 3000)).rejects.toThrow('Injected metadata failure');
      await expect(repository.importSaved(archive, 4000)).rejects.toThrow('Injected metadata failure');
    } finally { put.mockRestore(); }
    expect(await repository.metadata()).toEqual(before);
    expect((await repository.get(automatic.id)).savedAt).toBeUndefined();
    expect((await repository.keep(automatic.id, 'Kept', 5000)).number).toBe(2);
  } finally { await repository.close(); }
});

it('commits numbers only for new backups and retains the sequence through retention and restart', async () =>
{
  const name = crypto.randomUUID();
  const repository = new Repository(name, 1000);
  try {
    await repository.capture(session('first'), 'automatic', 1000);
    await repository.capture(session('first'), 'automatic', 2000);
    await expect(repository.capture(session('x'.repeat(2000)), 'automatic', 3000)).rejects.toThrow('storage full');
    expect((await repository.metadata()).lastSessionNumbers.automatic).toBe(1);
    await repository.capture(session('second'), 'automatic', 3500);
    const settings = { maxBackups: 1, retentionDays: null, maxStorageMB: 250 };
    expect(await repository.setStorageSettings(settings, 0, 4000)).toEqual({ kind: 'confirmation', removeCount: 1 });
    expect((await repository.metadata()).lastSessionNumbers.automatic).toBe(2);
    await repository.setStorageSettings(settings, 1, 4000);
    expect((await repository.list()).map(item => item.number)).toEqual([2]);
    await repository.close();
    await repository.capture(session('third'), 'automatic', 5000);
    expect((await repository.list()).map(item => item.number)).toEqual([3]);
  } finally { await repository.close(); }
});

it('allocates distinct numbers across concurrent repository writers', async () =>
{
  const name = crypto.randomUUID();
  const first = new Repository(name);
  const second = new Repository(name);
  try {
    await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? first : second).capture(session(String(index)), index % 3 ? 'automatic' : 'manual', 1000)));
    expect((await first.history(null, 10, 'automatic')).items.map(item => item.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await first.history(null, 10, 'saved')).items.map(item => item.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  } finally { await first.close(); await second.close(); }
});

it('renames without changing capture identity, deduplication or retention', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    const saved = await repository.capture(session('first'), 'automatic', 1000);
    if (saved.kind !== 'saved') throw new Error('Fixture missing');
    const before = await repository.get(saved.id);
    const named = await repository.rename(saved.id, 'Research 🧪');
    expect(named).toMatchObject({ number: 1, name: 'Research 🧪', capturedAt: 1000 });
    expect(await repository.get(saved.id)).toEqual({ ...before, name: 'Research 🧪' });
    expect((await repository.metadata()).bytes).toBe((await repository.metadata()).automaticBytes);
    expect((await repository.metadata()).bytes).toBeGreaterThan(named.bytes);
    expect((await repository.metadata()).historyRevision).toBe(1);
    await repository.rename(saved.id, 'Research 🧪');
    expect((await repository.metadata()).historyRevision).toBe(1);
    expect((await repository.capture(session('first'), 'automatic', 2000)).kind).toBe('unchanged');
    expect((await repository.metadata()).lastSessionNumbers.automatic).toBe(1);
    await repository.rename(saved.id, null);
    expect(await repository.get(saved.id)).toEqual(before);
    await repository.rename(saved.id, 'Named backups still expire');
    await repository.setStorageSettings({ maxBackups: 1, retentionDays: null, maxStorageMB: 250 }, 1, 3000);
    await repository.capture(session('second'), 'automatic', 3000);
    await expect(repository.get(saved.id)).rejects.toThrow('no longer available');
    await expect(repository.rename(saved.id, 'Removed')).rejects.toThrow('no longer available');
  } finally { await repository.close(); }
});

it('rolls back failed renames and rejects oversized names without deleting backups', async () =>
{
  const name = crypto.randomUUID();
  const repository = new Repository(name);
  const saved = await repository.capture(session('first'), 'automatic', 1000);
  if (saved.kind !== 'saved') throw new Error('Fixture missing');
  const metadata = await repository.metadata();
  await repository.close();
  const limited = new Repository(name, metadata.bytes + 10);
  try {
    await expect(limited.rename(saved.id, 'x'.repeat(100))).rejects.toThrow('not enough backup storage');
    expect(await limited.metadata()).toEqual(metadata);
    expect((await limited.get(saved.id)).name).toBeNull();
    const original = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key);
      if (this.name === 'summaries') this.transaction.abort();
      return request;
    });
    try { await expect(limited.rename(saved.id, 'short')).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(await limited.metadata()).toEqual(metadata);
    expect((await limited.get(saved.id)).name).toBeNull();
    expect((await limited.list())[0]?.name).toBeNull();
  } finally { await limited.close(); }
});

it('validates and normalizes names at the message boundary', () =>
{
  expect(parseRequest({ kind: 'rename', id: 'saved', name: '  Research  ' })).toEqual({ kind: 'rename', id: 'saved', name: 'Research' });
  expect(parseRequest({ kind: 'rename', id: 'saved', name: '  ' })).toEqual({ kind: 'rename', id: 'saved', name: null });
  for (const name of [undefined, 5, {}, 'x'.repeat(SESSION_NAME_LIMIT + 1)]) expect(() => parseRequest({ kind: 'rename', id: 'saved', name })).toThrow();
});
