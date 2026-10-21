import { openDB, type IDBPDatabase } from 'idb';
import type { BackupDatabase } from '../../src/database';
import type { Metadata } from '../../src/model';

// the first released schema, kept fixed so tests start from data written by the released version
export const RELEASED_DATABASE_VERSION = 9;
// the last pre-release schema, which upgrades start empty
export const PRE_RELEASE_DATABASE_VERSION = RELEASED_DATABASE_VERSION - 1;

export type ReleasedMetadata = Metadata & { privacyAcceptedAt: number | null };

// opens a database with the stores and indexes of the released schema
export function openReleasedDatabase(name: string): Promise<IDBPDatabase<BackupDatabase>>
{
  return openDB<BackupDatabase>(name, RELEASED_DATABASE_VERSION, {
    upgrade(db) {
      db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('tabIds', 'tabIds', { multiEntry: true });
      db.createObjectStore('tabs', { keyPath: 'id' }).createIndex('url', 'url');
      db.createObjectStore('summaries', { keyPath: 'id' }).createIndex('capturedAt', 'capturedAt');
      db.createObjectStore('metadata');
      db.createObjectStore('imports');
    },
  });
}

// metadata of a released installation without backups, including the removed privacy field
export function releasedMetadata(overrides: Partial<ReleasedMetadata> = {}): ReleasedMetadata
{
  return {
    privacyAcceptedAt: 500,
    automatic: { enabled: false, intervalMinutes: 5, pausedUntil: null },
    settings: { retentionDays: 14, maxBackups: 500, maxStorageMB: 750 },
    restore: { unloadBackgroundTabs: true, unloadThreshold: 250 },
    latestId: null, lastSavedAt: null, lastCheckedAt: null,
    bytes: 0, automaticBytes: 0, savedBytes: 0, count: 0, operation: null,
    lastTabId: 0, lastSessionNumbers: { automatic: 0, manual: 0 }, historyRevision: 0,
    ...overrides,
  };
}
