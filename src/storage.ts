import type { StorageSettings, Summary } from './model';

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

export function retentionPlan(records: Summary[], latestId: string | null, settings: StorageSettings, now: number, budget = settings.maxStorageMB * MB)
{
  // saved sessions never participate in automatic cleanup
  const saved = records.filter(item => item.savedAt !== undefined);
  const newest = records.filter(item => item.savedAt === undefined).sort((a, b) => Number(b.id === latestId) - Number(a.id === latestId) || b.capturedAt - a.capturedAt || b.id.localeCompare(a.id));
  const cutoff = settings.retentionDays === null ? -Infinity : now - settings.retentionDays * 86_400_000;
  const kept = newest.filter((item, index) => (settings.maxBackups === null || index < settings.maxBackups) && (index === 0 || item.capturedAt >= cutoff));
  let bytes = kept.reduce((sum, item) => sum + item.bytes, 0);
  while (bytes > budget && kept.length > 1) {
    const oldest = kept.pop();
    if (oldest) bytes -= oldest.bytes;
  }
  if (bytes > budget) throw new StorageLimitExceededError();
  const keepIds = new Set([...saved, ...kept].map(item => item.id));
  return { removeIds: records.filter(item => !keepIds.has(item.id)).map(item => item.id), bytes: bytes + saved.reduce((sum, item) => sum + item.bytes, 0), count: keepIds.size };
}
