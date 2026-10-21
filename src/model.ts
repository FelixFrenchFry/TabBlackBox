export type GroupColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
export type SavedTab = { url: string | null; title: string; pinned: boolean; group: number | null };
export type SavedGroup = { name: string; color: GroupColor; collapsed: boolean };
export type SavedWindow = { tabs: SavedTab[]; groups: SavedGroup[] };
export type Session = { windows: SavedWindow[] };
export type Source = 'automatic' | 'manual';
export type SessionDetails = { tags: string[] };
// tabs compared by URL with the previous session in the same panel
export type ClosedTabChange = Pick<SavedTab, 'url' | 'title'> & { after: number };
export type SessionChanges = { previousId: string; opened: number[][]; closed: ClosedTabChange[][]; closedWindows: Omit<ClosedTabChange, 'after'>[][] };
// stored comparisons refer to the shared tab records of the previous session instead of copying closed tabs
export type StoredChanges = Omit<SessionChanges, 'closed' | 'closedWindows'> & { closed: { tab: number; after: number }[][]; closedWindows: number[][] };
export type ChangeCounts = { previousId: string; opened: number; closed: number };
export type Snapshot = Session & { id: string; number: number; name: string | null; capturedAt: number; source: Source; savedAt?: number; tags?: string[]; changes?: SessionChanges };
export type StoredTab = SavedTab & { id: number };
export type StoredWindow = Omit<SavedWindow, 'tabs'> & { tabs: number[] };
export type StoredSnapshot = Omit<Snapshot, 'windows' | 'changes'> & { windows: StoredWindow[]; tabIds: number[]; changes?: StoredChanges };
export type Collection = 'saved' | 'automatic';
export type Summary = Pick<Snapshot, 'id' | 'number' | 'name' | 'capturedAt' | 'source' | 'savedAt' | 'tags'> & {
  windowCount: number; tabCount: number; supportedCount: number; bytes: number; changeCounts?: ChangeCounts;
};
export type TabCountPoint = Pick<Summary, 'id' | 'number' | 'capturedAt' | 'tabCount' | 'windowCount'> & { collection: Collection };
// open counts every tab of the latest backup and all counts each page once across retained backups
export type TopSitesScope = 'open' | 'all';
export type SiteCount = { site: string; url: string | null; count: number };
export type TopSites = { sites: SiteCount[]; siteCount: number; total: number };
export type TabMatch = { url: string; title: string; lastSeen: number; lastSeenNumber: number; lastSeenCollection: Collection; automaticCount: number; savedCount: number };
export type SearchField = 'name' | 'tags';
export type TabSearchField = 'title' | 'url';
export type HistorySort = 'date-desc' | 'date-asc' | 'number-desc' | 'number-asc';
export type HistoryCursor = Pick<Summary, 'capturedAt' | 'number' | 'id'>;
export type HistoryRange = { start: number; end: number };
export type BackupDay = { start: number; saved: number; automatic: number };
export type RestoreIssue =
  | { kind: 'tab' | 'pin'; title: string; url: string | null; message: string }
  | { kind: 'group'; title: string; message: string };
export type RestoreProgress = {
  snapshotId: string; startedAt: number; opened: number; skipped: number; failed: number;
  groupErrors: number; total: number; errors: string[];
  // older results contain only error strings and have not been dismissed
  name?: string | null; issues?: RestoreIssue[]; dismissed?: boolean;
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
export type RestoreSettings = { unloadBackgroundTabs: boolean; unloadThreshold: number };
export type Metadata = {
  automatic: AutomaticSettings;
  settings: StorageSettings;
  restore: RestoreSettings;
  latestId: string | null; lastSavedAt: number | null; lastCheckedAt: number | null;
  bytes: number; automaticBytes: number; savedBytes: number; count: number; operation: Operation | null;
  lastTabId: number;
  lastSessionNumbers: Record<Source, number>; historyRevision: number;
};
export type StorageSettings = { retentionDays: number | null; maxBackups: number | null; maxStorageMB: number };
export type StorageSettingsResult = { kind: 'saved' } | { kind: 'confirmation'; removeCount: number };
export type CaptureResult = { kind: 'saved'; id: string } | { kind: 'unchanged' | 'empty' };
export type Status = { kind: 'initializing' | 'pending' | 'current' | 'empty' | 'restoring' | 'disabled' | 'paused' } | { kind: 'error'; message: string };
export type Overview = { status: Status; metadata: Metadata; latest: Summary | null; automaticStorage: { bytes: number; count: number; newestId: string | null }; oldestCapturedAt: number | null };

export function errorMessage(error: unknown): string
{
  if (error instanceof Error && (error.name === 'QuotaExceededError' || error.message.includes('storage full'))) return 'Backup failed: storage full. New changes are not being backed up.';
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}
