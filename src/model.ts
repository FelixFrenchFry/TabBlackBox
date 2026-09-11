export type GroupColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
export type SavedTab = { url: string | null; title: string; pinned: boolean; group: number | null };
export type SavedGroup = { name: string; color: GroupColor; collapsed: boolean };
export type SavedWindow = { tabs: SavedTab[]; groups: SavedGroup[] };
export type Session = { windows: SavedWindow[] };
export type Source = 'automatic' | 'manual';
export type Snapshot = Session & { id: string; schemaVersion: 1; capturedAt: number; source: Source };
export type Summary = Pick<Snapshot, 'id' | 'capturedAt' | 'source'> & {
  windowCount: number; tabCount: number; supportedCount: number; bytes: number;
};
export type HistoryCursor = Pick<Summary, 'capturedAt' | 'id'>;
export type RestoreProgress = {
  snapshotId: string; startedAt: number; opened: number; skipped: number; failed: number;
  groupErrors: number; total: number; errors: string[];
};
export type Operation = RestoreProgress & (
  | { kind: 'running' }
  | { kind: 'completed' | 'interrupted'; finishedAt: number }
);
export type Metadata = {
  latestId: string | null; lastSavedAt: number | null; lastCheckedAt: number | null;
  bytes: number; count: number; operation: Operation | null;
};
export type CaptureResult = { kind: 'saved'; id: string } | { kind: 'unchanged' | 'empty' };
export type Status = { kind: 'initializing' | 'pending' | 'current' | 'empty' | 'restoring' } | { kind: 'error'; message: string };
export type Overview = { status: Status; metadata: Metadata; latest: Summary | null };

export function errorMessage(error: unknown): string {
  if (error instanceof Error && (error.name === 'QuotaExceededError' || error.message.includes('storage full'))) return 'Backup failed: storage full. New changes are not being backed up.';
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}
