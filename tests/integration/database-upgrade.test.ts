import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { openDB } from 'idb';
import { DATABASE_VERSION, Repository, upgradeDatabase, type BackupDatabase } from '../../src/database';
import type { AutomaticSettings, Session, StoredSnapshot } from '../../src/model';
import { openReleasedDatabase, PRE_RELEASE_DATABASE_VERSION, releasedMetadata } from '../support/released';

const session = (url: string): Session => ({ windows: [{ groups: [{ name: 'Work', color: 'blue', collapsed: false }], tabs: [{ url, title: 'Example', pinned: true, group: 0 }] }] });

it.each([
  { enabled: false, pausedUntil: null, privacyAcceptedAt: 500 },
  { enabled: true, pausedUntil: null, privacyAcceptedAt: 500 },
  { enabled: true, pausedUntil: 9_000_000_000_000, privacyAcceptedAt: 500 },
  { enabled: false, pausedUntil: null, privacyAcceptedAt: null },
])('preserves released schema-9 data with enabled=$enabled, pausedUntil=$pausedUntil and privacyAcceptedAt=$privacyAcceptedAt', async ({ enabled, pausedUntil, privacyAcceptedAt }) =>
{
  const name = crypto.randomUUID();
  // fixed records from the released schema keep the upgrade check independent of current defaults
  const automatic: AutomaticSettings = { enabled, intervalMinutes: 5, pausedUntil };
  const saved: StoredSnapshot = { id: 'released', number: 1, name: 'Research', capturedAt: 1000, source: 'manual', savedAt: 2000, windows: [{ groups: [{ name: 'Work', color: 'blue', collapsed: false }], tabs: [1] }], tabIds: [1] };
  const metadata = releasedMetadata({ privacyAcceptedAt, automatic, latestId: saved.id, lastSavedAt: 2000, lastCheckedAt: 2000, bytes: 300, savedBytes: 300, count: 1, lastTabId: 1, lastSessionNumbers: { automatic: 0, manual: 1 }, historyRevision: 7 });
  const db = await openReleasedDatabase(name);
  const tx = db.transaction(['snapshots', 'tabs', 'summaries', 'metadata'], 'readwrite');
  await tx.objectStore('snapshots').put(saved);
  await tx.objectStore('tabs').put({ id: 1, url: 'https://example.test/released', title: 'Example', pinned: true, group: 0 });
  await tx.objectStore('summaries').put({ id: saved.id, number: 1, name: 'Research', capturedAt: 1000, source: 'manual', savedAt: 2000, windowCount: 1, tabCount: 1, supportedCount: 1, bytes: 300 });
  await tx.objectStore('metadata').put(metadata, 'state');
  await tx.done;
  db.close();
  const repository = new Repository(name);
  try {
    expect(await repository.metadata()).toEqual(metadata);
    expect((await repository.get(saved.id)).windows).toEqual(session('https://example.test/released').windows);
    await repository.setAutomaticSettings({ kind: 'frequency', value: 60 }, 3000);
    await repository.close();
    expect(await repository.metadata()).toEqual({ ...metadata, automatic: { ...automatic, intervalMinutes: 60 } });
    expect((await repository.list()).map(item => item.id)).toEqual([saved.id]);
  } finally { await repository.close(); }
});

it('keeps backups and settings when a later version opens a released database', async () =>
{
  const name = crypto.randomUUID();
  const released = new Repository(name);
  await released.setAutomaticSettings({ kind: 'enabled', value: false }, 500);
  await released.capture(session('https://example.test/automatic'), 'automatic', 1000);
  await released.capture(session('https://example.test/saved'), 'manual', 2000, 'Research');
  await released.setRestoreSettings({ unloadBackgroundTabs: false, unloadThreshold: 250 });
  const metadata = await released.metadata();
  const history = await released.list(null, 100);
  const snapshots = await Promise.all(history.map(item => released.get(item.id)));
  await released.close();

  // a later schema version runs the upgrade steps against the released stores
  const upgraded = await openDB<BackupDatabase>(name, DATABASE_VERSION + 1, { upgrade(db, oldVersion) { upgradeDatabase(db, oldVersion); } });
  upgraded.close();

  const reopened = new Repository(name);
  try {
    // the repository still opens at its own version, so read the stores directly
    const db = await openDB<BackupDatabase>(name);
    try {
      expect(db.version).toBe(DATABASE_VERSION + 1);
      expect(await db.get('metadata', 'state')).toEqual(metadata);
      expect(await db.count('snapshots')).toBe(2);
      expect(await db.count('summaries')).toBe(2);
      expect(await db.count('tabs')).toBe(2);
    } finally { db.close(); }
    await expect(reopened.list()).rejects.toThrow();
  } finally { await reopened.close(); }
  expect(snapshots.map(snapshot => snapshot.name)).toContain('Research');
});

it('starts a pre-release database empty at the released schema', async () =>
{
  const name = crypto.randomUUID();
  const old = await openDB(name, PRE_RELEASE_DATABASE_VERSION, { upgrade(db) { db.createObjectStore('snapshots').put({ stale: true }, 'old'); } });
  old.close();
  const repository = new Repository(name);
  try {
    expect(await repository.list()).toEqual([]);
    expect((await repository.metadata()).automatic.enabled).toBe(false);
    await repository.capture(session('https://example.test/new'), 'manual', 1000);
    expect(await repository.list()).toHaveLength(1);
  } finally { await repository.close(); }
});
