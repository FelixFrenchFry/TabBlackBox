import type { Metadata, StorageSettings, StoredSnapshot, StoredTab, Summary } from './model';

export class StorageLimitExceededError extends Error {
  constructor() { super('Backup failed: storage full. The newest automatic backup exceeds the space limit. Increase the space limit.'); }
}

export const MB = 1_000_000;
export const DEFAULT_STORAGE_SETTINGS: Readonly<StorageSettings> = { retentionDays: null, maxBackups: null, maxStorageMB: 250 };

export function parseStorageSettings(value: unknown): StorageSettings
{
  if (typeof value !== 'object' || value === null) throw new Error('Invalid storage settings.');
  const integer = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
  if (!('retentionDays' in value) || (value.retentionDays !== null && !integer(value.retentionDays, 3650)) ||
      !('maxBackups' in value) || (value.maxBackups !== null && !integer(value.maxBackups, 100_000)) ||
      !('maxStorageMB' in value) || !integer(value.maxStorageMB, 100_000)) throw new Error('Enter valid whole-number storage limits.');
  return { retentionDays: value.retentionDays, maxBackups: value.maxBackups, maxStorageMB: value.maxStorageMB };
}

export function storedBytes(record: StoredSnapshot | StoredTab): number
{
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

export function storageTotals(snapshots: readonly StoredSnapshot[], tabs: ReadonlyMap<number, StoredTab>): Pick<Metadata, 'bytes' | 'automaticBytes' | 'savedBytes'>
{
  // encode each record once and charge shared tabs once per collection and once globally
  const totals = { bytes: 0, automaticBytes: 0, savedBytes: 0 };
  const collections = new Map<number, { automatic: boolean; saved: boolean }>();
  for (const snapshot of snapshots) {
    const saved = snapshot.savedAt !== undefined;
    const size = storedBytes(snapshot);
    totals.bytes += size;
    if (saved) totals.savedBytes += size;
    else totals.automaticBytes += size;
    for (const window of snapshot.windows) for (const id of window.tabs) {
      const membership = collections.get(id) ?? { automatic: false, saved: false };
      if (saved) membership.saved = true;
      else membership.automatic = true;
      collections.set(id, membership);
    }
  }
  for (const [id, membership] of collections) {
    const tab = tabs.get(id);
    if (!tab) throw new Error('This backup has missing tab data.');
    const size = storedBytes(tab);
    totals.bytes += size;
    if (membership.automatic) totals.automaticBytes += size;
    if (membership.saved) totals.savedBytes += size;
  }
  return totals;
}

type RetentionRecord = Pick<Summary, 'id' | 'capturedAt' | 'savedAt'>;

function automaticHistory<T extends RetentionRecord>(records: readonly T[], latestId: string | null): T[]
{
  return records.filter(item => item.savedAt === undefined).sort((a, b) => Number(b.id === latestId) - Number(a.id === latestId) || b.capturedAt - a.capturedAt || b.id.localeCompare(a.id));
}

export function retentionRemovals(records: readonly RetentionRecord[], latestId: string | null, settings: StorageSettings, now: number): string[]
{
  // saved sessions and the newest automatic backup are protected
  const cutoff = settings.retentionDays === null ? -Infinity : now - settings.retentionDays * 86_400_000;
  return automaticHistory(records, latestId).filter((item, index) => index > 0 &&
    ((settings.maxBackups !== null && index >= settings.maxBackups) || item.capturedAt < cutoff)).map(item => item.id);
}

export function retentionPlan(records: readonly StoredSnapshot[], tabs: ReadonlyMap<number, StoredTab>, latestId: string | null, settings: StorageSettings, now: number, budget = settings.maxStorageMB * MB): { removeIds: string[] }
{
  const removeIds = new Set(retentionRemovals(records, latestId, settings, now));
  const kept = automaticHistory(records, latestId).filter(item => !removeIds.has(item.id));
  const references = new Map<number, number>();
  const snapshotBytes = new Map<string, number>();
  const tabBytes = new Map<number, number>();
  let bytes = 0;
  for (const snapshot of kept) {
    const size = storedBytes(snapshot);
    snapshotBytes.set(snapshot.id, size);
    bytes += size;
    for (const id of new Set(snapshot.windows.flatMap(window => window.tabs))) {
      if (!references.has(id)) {
        const tab = tabs.get(id);
        if (!tab) throw new Error('This backup has missing tab data.');
        const size = storedBytes(tab);
        tabBytes.set(id, size);
        bytes += size;
      }
      references.set(id, (references.get(id) ?? 0) + 1);
    }
  }
  // decrement temporary references so each removal scans only its own tabs
  while (bytes > budget && kept.length > 1) {
    const oldest = kept.pop();
    if (!oldest) break;
    removeIds.add(oldest.id);
    bytes -= snapshotBytes.get(oldest.id) ?? 0;
    for (const id of new Set(oldest.windows.flatMap(window => window.tabs))) {
      const count = (references.get(id) ?? 0) - 1;
      references.set(id, count);
      if (count === 0) bytes -= tabBytes.get(id) ?? 0;
    }
  }
  if (bytes > budget) throw new StorageLimitExceededError();
  return { removeIds: records.filter(item => removeIds.has(item.id)).map(item => item.id) };
}
