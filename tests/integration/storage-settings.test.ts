import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { Repository } from '../../src/database';
import { parseRequest } from '../../src/protocol';

const session = (title: string) => ({ windows: [{ groups: [], tabs: [{ url: 'https://example.test', title, pinned: false, group: null }] }] });
const settings = { retentionDays: 30, maxBackups: 2, maxStorageMB: 250 };

it('expires older backups during unchanged captures while retaining the newest', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.setStorageSettings(settings, 0, 0);
    await repository.capture(session('first'), 'automatic', 1000);
    const newest = await repository.capture(session('second'), 'automatic', 2000);
    if (newest.kind !== 'saved') throw new Error('Fixture missing');
    await repository.capture(session('second'), 'automatic', 31 * 86_400_000);
    expect((await repository.list()).map(item => item.id)).toEqual([newest.id]);
  } finally { await repository.close(); }
});

it('requires confirmation before deleting backups and persists the new limits', async () =>
{
  const name = crypto.randomUUID();
  const repository = new Repository(name);
  try {
    for (let i = 0; i < 4; i++) await repository.capture(session(String(i)), 'automatic', Date.now() + i);
    expect(await repository.setStorageSettings(settings, 0, Date.now())).toEqual({ kind: 'confirmation', removeCount: 2 });
    expect(await repository.list()).toHaveLength(4);
    expect((await repository.metadata()).settings).toEqual({ retentionDays: null, maxBackups: null, maxStorageMB: 100 });
    expect(await repository.setStorageSettings(settings, 2, Date.now())).toEqual({ kind: 'saved' });
    expect(await repository.list()).toHaveLength(2);
    await repository.close();
    expect((await repository.metadata()).settings).toEqual(settings);
    await repository.capture(session('next'), 'automatic', Date.now() + 10);
    expect(await repository.list()).toHaveLength(2);
  } finally { await repository.close(); }
});

it('uses decimal MB and removes oldest backups to make room for the new one', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.setStorageSettings({ ...settings, maxBackups: 100, maxStorageMB: 1 }, 0, Date.now());
    await repository.capture(session('a'.repeat(510_000)), 'automatic', Date.now());
    await repository.capture(session('b'.repeat(510_000)), 'automatic', Date.now() + 1);
    expect(await repository.list()).toHaveLength(1);
    expect((await repository.metadata()).bytes).toBeLessThanOrEqual(1_000_000);
    const before = await repository.metadata();
    await expect(repository.capture(session('c'.repeat(1_000_000)), 'automatic', Date.now() + 2)).rejects.toThrow('storage full');
    expect(await repository.metadata()).toEqual(before);
  } finally { await repository.close(); }
});

it('keeps the newly saved candidate when timestamps tie and only one backup is allowed', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.setStorageSettings({ ...settings, maxBackups: 1 }, 0, Date.now());
    for (let i = 0; i < 5; i++) {
      const result = await repository.capture(session(String(i)), 'automatic', 1000);
      if (result.kind !== 'saved') throw new Error('Fixture missing');
      expect((await repository.list()).map(item => item.id)).toEqual([result.id]);
    }
  } finally { await repository.close(); }
});

it('rejects invalid storage settings at the message boundary', () =>
{
  for (const maxStorageMB of [0, -1, 0.5, Infinity, '250']) {
    expect(() => parseRequest({ kind: 'storage-settings', settings: { ...settings, maxStorageMB }, confirmedRemovalCount: 0 })).toThrow();
  }
  expect(parseRequest({ kind: 'storage-settings', settings, confirmedRemovalCount: 0 })).toEqual({ kind: 'storage-settings', settings, confirmedRemovalCount: 0 });
});

it('persists disabled limits and keeps old backups until the active count limit requires cleanup', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    const unlimited = { retentionDays: null, maxBackups: null, maxStorageMB: 250 };
    expect(parseRequest({ kind: 'storage-settings', settings: unlimited, confirmedRemovalCount: 0 })).toMatchObject({ settings: unlimited });
    await repository.setStorageSettings(unlimited, 0, Date.now());
    await repository.capture(session('old'), 'automatic', 1000);
    await repository.capture(session('new'), 'automatic', Date.now());
    await repository.close();
    expect((await repository.metadata()).settings).toEqual(unlimited);
    expect(await repository.list()).toHaveLength(2);
    expect(await repository.setStorageSettings({ ...unlimited, maxBackups: 1 }, 0, Date.now())).toEqual({ kind: 'confirmation', removeCount: 1 });
    await repository.setStorageSettings({ ...unlimited, maxBackups: 1 }, 1, Date.now());
    expect(await repository.list()).toHaveLength(1);
  } finally { await repository.close(); }
});
it('confirms removal of existing backups without replacing the newest backup', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.capture(session('A'), 'automatic', Date.now());
    await repository.capture(session('B'), 'automatic', Date.now() + 1);
    const before = await repository.metadata();
    const history = await repository.list();
    const limits = { ...settings, maxBackups: 1 };
    expect(await repository.setStorageSettings(limits, 0, Date.now())).toEqual({ kind: 'confirmation', removeCount: 1 });
    expect(await repository.metadata()).toEqual(before);
    expect(await repository.list()).toEqual(history);
    expect(await repository.setStorageSettings(limits, 1, Date.now())).toEqual({ kind: 'saved' });
    const after = await repository.metadata();
    expect(after.settings).toEqual(limits);
    expect(after.count).toBe(1);
    expect(after.latestId).toBe(before.latestId);
    expect(after.lastSavedAt).toBe(before.lastSavedAt);
    expect(after.lastCheckedAt).toBe(before.lastCheckedAt);
    expect((await repository.get(after.latestId ?? '')).windows).toEqual(session('B').windows);
  } finally { await repository.close(); }
});

it('updates limits without creating backups or advancing capture timestamps', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.capture(session('A'), 'automatic', Date.now());
    const before = await repository.metadata();
    const limits = { ...settings, maxBackups: 1 };
    expect(await repository.setStorageSettings(limits, 0, Date.now() + 1000)).toEqual({ kind: 'saved' });
    expect(await repository.metadata()).toEqual({ ...before, settings: limits });
    expect(await repository.list()).toHaveLength(1);
  } finally { await repository.close(); }
});

it('reconfirms cleanup when another capture increases the required removal count', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.capture(session('a'.repeat(600_000)), 'automatic', Date.now());
    await repository.capture(session('b'.repeat(600_000)), 'automatic', Date.now() + 1);
    const limits = { ...settings, maxStorageMB: 1 };
    expect(await repository.setStorageSettings(limits, 0, Date.now())).toEqual({ kind: 'confirmation', removeCount: 1 });
    await repository.capture(session('c'.repeat(900_000)), 'automatic', Date.now() + 2);
    const before = await repository.metadata();
    expect(await repository.setStorageSettings(limits, 1, Date.now())).toEqual({ kind: 'confirmation', removeCount: 2 });
    expect(await repository.metadata()).toEqual(before);
    expect(await repository.list()).toHaveLength(3);
    expect(await repository.setStorageSettings(limits, 2, Date.now())).toEqual({ kind: 'saved' });
    expect(await repository.list()).toHaveLength(1);
    expect((await repository.metadata()).bytes).toBeLessThanOrEqual(1_000_000);
  } finally { await repository.close(); }
});

it('rolls back cleanup and settings when the metadata write fails', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.capture(session('A'), 'automatic', Date.now());
    await repository.capture(session('B'), 'automatic', Date.now() + 1);
    const before = await repository.metadata();
    const history = await repository.list();
    const original = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'metadata') throw new Error('Injected metadata failure');
      return original.apply(this, args);
    });
    try {
      await expect(repository.setStorageSettings({ ...settings, maxBackups: 1 }, 1, Date.now())).rejects.toThrow('Injected metadata failure');
    } finally { put.mockRestore(); }
    expect(await repository.metadata()).toEqual(before);
    expect(await repository.list()).toEqual(history);
    expect((await repository.get(before.latestId ?? '')).windows).toEqual(session('B').windows);
  } finally { await repository.close(); }
});
it('preserves a pre-absence session through multiple new captures with the new defaults', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    const old = await repository.capture(session('Important work'), 'automatic', 1000);
    if (old.kind !== 'saved') throw new Error('Missing fixture');
    await repository.capture(session('New tab'), 'automatic', 100 * 86_400_000);
    await repository.capture(session('Another page'), 'automatic', 100 * 86_400_000 + 1000);
    expect((await repository.get(old.id)).windows).toEqual(session('Important work').windows);
    expect(await repository.list()).toHaveLength(3);
  } finally { await repository.close(); }
});
