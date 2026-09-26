export type GroupColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
export type SavedTab = { url: string | null; title: string; pinned: boolean; group: number | null };
export type SavedGroup = { name: string; color: GroupColor; collapsed: boolean };
export type SavedWindow = { tabs: SavedTab[]; groups: SavedGroup[] };
export type Session = { windows: SavedWindow[] };
export type Source = 'automatic' | 'manual';
export type Snapshot = Session & { id: string; number: number; name: string | null; capturedAt: number; source: Source; savedAt?: number };
export type Collection = 'saved' | 'automatic';
export type Summary = Pick<Snapshot, 'id' | 'number' | 'name' | 'capturedAt' | 'source' | 'savedAt'> & {
  windowCount: number; tabCount: number; supportedCount: number; bytes: number;
};
export type HistorySort = 'date-desc' | 'date-asc' | 'number-desc' | 'number-asc';
export type HistoryCursor = Pick<Summary, 'capturedAt' | 'number' | 'id'>;
export type RestoreProgress = {
  snapshotId: string; startedAt: number; opened: number; skipped: number; failed: number;
  groupErrors: number; total: number; errors: string[];
};
export type Operation = RestoreProgress & (
  | { kind: 'running' }
  | { kind: 'completed' | 'interrupted'; finishedAt: number }
);
export type AutomaticSettings = { enabled: boolean; intervalMinutes: 0 | 1 | 5 | 15 | 60 | 1440; pausedUntil: number | null };
export type AutomaticUpdate =
  | { kind: 'enabled'; value: boolean }
  | { kind: 'frequency'; value: AutomaticSettings['intervalMinutes'] }
  | { kind: 'pause'; minutes: 15 | 60 | 1440 }
  | { kind: 'resume' };
export type Metadata = {
  automatic: AutomaticSettings;
  settings: StorageSettings;
  latestId: string | null; lastSavedAt: number | null; lastCheckedAt: number | null;
  bytes: number; count: number; operation: Operation | null;
  lastSessionNumbers: Record<Source, number>; historyRevision: number;
};
export type StorageSettings = { retentionDays: number | null; maxBackups: number | null; maxStorageMB: number };
export type StorageSettingsResult = { kind: 'saved' } | { kind: 'confirmation'; removeCount: number };
export type CaptureResult = { kind: 'saved'; id: string } | { kind: 'unchanged' | 'empty' };
export type Status = { kind: 'initializing' | 'pending' | 'current' | 'empty' | 'restoring' | 'disabled' | 'paused' } | { kind: 'error'; message: string };
export type Overview = { status: Status; metadata: Metadata; latest: Summary | null; automaticStorage: { bytes: number; count: number } };

export function errorMessage(error: unknown): string
{
  if (error instanceof Error && (error.name === 'QuotaExceededError' || error.message.includes('storage full'))) return 'Backup failed: storage full. New changes are not being backed up.';
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}
