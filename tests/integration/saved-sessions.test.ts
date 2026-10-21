import { exportArchive } from '../support/archive';
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { Repository } from '../../src/database';
import { parseArchive } from '../../src/archive';

const session = (title: string) => ({ windows: [{ groups: [], tabs: [{ url: 'https://example.test', title, pinned: false, group: null }] }] });

it('keeps curated sessions and manual captures through age and count cleanup', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    const old = await repository.capture(session('research'), 'automatic', 1000);
    if (old.kind !== 'saved') throw new Error('Fixture missing');
    await repository.keep(old.id, 'Research', 2000);
    const manual = await repository.capture(session('manual'), 'manual', 3000);
    if (manual.kind !== 'saved') throw new Error('Fixture missing');
    await repository.capture(session('current'), 'automatic', 4000);
    await repository.setStorageSettings({ retentionDays: 1, maxBackups: 1, maxStorageMB: 250 }, 1, 3 * 86_400_000);
    expect(await repository.get(old.id)).toMatchObject({ source: 'automatic', capturedAt: 1000, savedAt: 2000, name: 'Research' });
    expect((await repository.history(null, 10, 'saved')).items.map(item => item.id)).toEqual([manual.id, old.id]);
    expect((await repository.history(null, 10, 'automatic')).items).toHaveLength(1);
    expect(await repository.list()).toHaveLength(3);
  } finally { await repository.close(); }
});

it('saves an unchanged current session and preserves it after reopening', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.capture(session('research'), 'automatic', 1000);
    const result = await repository.capture(session('research'), 'manual', 2000);
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') throw new Error('Fixture missing');
    await repository.close();
    expect(await repository.get(result.id)).toMatchObject({ name: null, savedAt: 2000 });
    expect((await repository.capture(session('research'), 'manual', 2500)).kind).toBe('saved');
    expect((await repository.capture(session('research'), 'automatic', 3000)).kind).toBe('unchanged');
  } finally { await repository.close(); }
});

it('excludes manual backups from the automatic space budget and preserves total accounting', async () => {
  const repository = new Repository(crypto.randomUUID(), 1200);
  try {
    const manual = await repository.capture(session('a'.repeat(2000)), 'manual', 1000);
    if (manual.kind !== 'saved') throw new Error('Fixture missing');
    await repository.rename(manual.id, 'Keep');
    await repository.capture(session('b'.repeat(600)), 'automatic', 2000);
    await repository.capture(session('c'.repeat(600)), 'automatic', 3000);
    const items = await repository.list();
    expect(items).toHaveLength(2);
    expect((await repository.history(null, 10, 'automatic')).bytes).toBeLessThanOrEqual(1200);
    expect((await repository.metadata()).bytes).toBeGreaterThan(items.reduce((sum, item) => sum + item.bytes, 0));
    expect((await repository.get(manual.id)).name).toBe('Keep');
    const metadata = await repository.metadata();
    await expect(repository.capture(session('d'.repeat(2000)), 'automatic', 4000)).rejects.toThrow('storage full');
    expect(await repository.metadata()).toEqual(metadata);
  } finally { await repository.close(); }
});

it('filters before pagination and searches saved names beyond the first page', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.capture(session('old'), 'manual', 1000, 'Research');
    for (let index = 0; index < 12; index++) await repository.capture(session(String(index)), 'automatic', 2000 + index);
    await repository.capture(session('new'), 'manual', 4000, 'Holiday');
    const first = await repository.history(null, 1, 'saved');
    expect(first.count).toBe(2);
    expect(first.items[0]?.name).toBe('Holiday');
    const anchor = first.items[0];
    if (!anchor) throw new Error('Fixture missing');
    expect((await repository.history(anchor, 1, 'saved')).items[0]?.name).toBe('Research');
    expect((await repository.history(null, 1, 'saved', 'research')).items[0]?.name).toBe('Research');
  } finally { await repository.close(); }
});

it('deletes an archive explicitly and repairs latest metadata without reusing numbers', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    const first = await repository.capture(session('old'), 'automatic', 1000);
    const saved = await repository.capture(session('new'), 'manual', 2000, null);
    if (first.kind !== 'saved' || saved.kind !== 'saved') throw new Error('Fixture missing');
    const archive = await exportArchive(repository);
    const imported = archive.sessions[0];
    if (!imported) throw new Error('Fixture missing');
    imported.capturedAt = 9_999_999;
    await repository.importSaved(archive, 3000);
    await repository.deleteSession(saved.id);
    expect((await repository.metadata()).latestId).toBe(first.id);
    expect((await repository.metadata()).lastSessionNumbers).toEqual({ automatic: 1, manual: 2 });
    expect((await exportArchive(repository, first.id)).sessions).toMatchObject([{ source: 'automatic', capturedAt: 1000 }]);
    await expect(repository.deleteSession(first.id)).rejects.toThrow('newest automatic backup cannot be deleted');
    expect(await repository.metadata()).toMatchObject({ latestId: first.id, lastSavedAt: 1000 });
    const newer = await repository.capture(session('newer'), 'automatic', 4000);
    if (newer.kind !== 'saved') throw new Error('Fixture missing');
    expect(await repository.deleteSession(first.id)).toBe(false);
    expect(await repository.metadata()).toMatchObject({ latestId: newer.id, lastSavedAt: 4000 });
    expect((await repository.list()).map(item => item.id)).not.toContain(first.id);
    // a later manual backup moves the pointer but the newest automatic backup stays protected
    await repository.capture(session('manual later'), 'manual', 5000, null);
    await expect(repository.deleteSession(newer.id)).rejects.toThrow('newest automatic backup cannot be deleted');
  } finally { await repository.close(); }
});

it('exports and imports saved sessions atomically without replacing the current recovery point', async () => {
  const repository = new Repository(crypto.randomUUID());
  const target = new Repository(crypto.randomUUID());
  const limited = new Repository(crypto.randomUUID(), 300);
  try {
    await repository.capture(session('research'), 'manual', 1000, 'Research');
    await repository.capture(session('second'), 'manual', 2000, 'Second');
    const archive = await exportArchive(repository);
    const current = await target.capture(session('current'), 'automatic', 2000);
    expect(parseArchive(archive)).toEqual(archive);
    await target.importSaved(archive, 3000);
    expect((await target.history(null, 10, 'saved')).items.find(item => item.name === 'Research')).toMatchObject({ capturedAt: 1000, name: 'Research' });
    expect((await target.metadata()).latestId).toBe(current.kind === 'saved' ? current.id : null);
    await limited.importSaved(archive, 3000);
    expect(await limited.list()).toHaveLength(2);
    expect((await limited.history(null, 10, 'automatic')).bytes).toBe(0);
    const invalid = structuredClone(archive);
    const tab = invalid.sessions[0]?.windows[0]?.tabs[0];
    if (!tab) throw new Error('Fixture missing');
    tab.group = 99;
    expect(() => parseArchive(invalid)).toThrow();
  } finally { await repository.close(); await target.close(); await limited.close(); }
});
