import { applyAutomaticUpdate, DEFAULT_AUTOMATIC_SETTINGS } from './automatic';
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { AutomaticUpdate, BackupDay, CaptureResult, Collection, HistoryCursor, HistoryRange, HistorySort, Metadata, Operation, Session, Snapshot, Source, StorageSettings, StorageSettingsResult, StoredSnapshot, StoredTab, Summary, TabCountPoint, TabMatch } from './model';
import { compareHistory } from './history';
import { dayRange } from './calendar';
import { thinTabCounts } from './chart';
import type { Archive } from './archive';
import { canonicalSession, canonicalTab, decodeSnapshot, encodeSnapshot, snapshotTabIds, summarize } from './session';
import { DEFAULT_STORAGE_SETTINGS, MB, newestAutomaticId, retentionPlan, retentionRemovals, storageTotals, storedBytes } from './storage';

interface BackupDatabase extends DBSchema {
  snapshots: { key: string; value: StoredSnapshot; indexes: { tabIds: number } };
  tabs: { key: number; value: StoredTab; indexes: { url: string } };
  summaries: { key: string; value: Summary; indexes: { capturedAt: number } };
  metadata: { key: string; value: Metadata };
}

const TAB_SEARCH_RECORD_LIMIT = 500;

const initialMetadata = (): Metadata => ({ automatic: { ...DEFAULT_AUTOMATIC_SETTINGS }, settings: { ...DEFAULT_STORAGE_SETTINGS }, latestId: null, lastSavedAt: null, lastCheckedAt: null, bytes: 0, automaticBytes: 0, savedBytes: 0, count: 0, operation: null, lastTabId: 0, lastSessionNumbers: { automatic: 0, manual: 0 }, historyRevision: 0 });

type WriteTransaction = IDBPTransaction<BackupDatabase, ('snapshots' | 'tabs' | 'summaries' | 'metadata')[], 'readwrite'>;
type StorageState = { snapshots: StoredSnapshot[]; tabs: Map<number, StoredTab>; tabIds: Map<string, number> };

async function readStorage(tx: WriteTransaction): Promise<StorageState>
{
  const snapshots = await tx.objectStore('snapshots').getAll();
  const tabs = await tx.objectStore('tabs').getAll();
  return { snapshots, tabs: new Map(tabs.map(tab => [tab.id, tab])), tabIds: new Map(tabs.map(tab => [canonicalTab(tab), tab.id])) };
}

async function readTabs(snapshots: readonly StoredSnapshot[], read: (id: number) => Promise<StoredTab | undefined>): Promise<Map<number, StoredTab>>
{
  const ids = new Set(snapshots.flatMap(snapshot => snapshot.windows.flatMap(window => window.tabs)));
  const tabs = new Map<number, StoredTab>();
  await Promise.all([...ids].map(async id => {
    const tab = await read(id);
    if (!tab) throw new Error('This backup has missing tab data.');
    tabs.set(id, tab);
  }));
  return tabs;
}

function internSnapshot(snapshot: Snapshot, state: StorageState, metadata: Metadata): StoredSnapshot
{
  // allocate in memory so confirmation and failed transactions consume no IDs
  for (const window of snapshot.windows) for (const tab of window.tabs) {
    const key = canonicalTab(tab);
    if (state.tabIds.has(key)) continue;
    const id = metadata.lastTabId + 1;
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid tab number.');
    metadata.lastTabId = id;
    state.tabIds.set(key, id);
    state.tabs.set(id, { id, url: tab.url, title: tab.title, pinned: tab.pinned, group: tab.group });
  }
  const stored = encodeSnapshot(snapshot, state.tabIds);
  state.snapshots.push(stored);
  return stored;
}

function updateStorage(metadata: Metadata, state: StorageState): void
{
  Object.assign(metadata, storageTotals(state.snapshots, state.tabs));
  metadata.count = state.snapshots.length;
}

async function writeTabs(tx: WriteTransaction, state: StorageState, previousLastTabId: number): Promise<void>
{
  // collect only records absent from every retained session, including saved sessions
  const referenced = new Set(state.snapshots.flatMap(snapshot => snapshot.windows.flatMap(window => window.tabs)));
  for (const [id, tab] of state.tabs) {
    if (!referenced.has(id)) {
      if (id <= previousLastTabId) await tx.objectStore('tabs').delete(id);
    } else if (id > previousLastTabId) await tx.objectStore('tabs').add(tab);
  }
}

function nextSessionNumber(metadata: Metadata, source: Source): number
{
  const number = metadata.lastSessionNumbers[source] + 1;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid session number.');
  metadata.lastSessionNumbers[source] = number;
  return number;
}

export class Repository {
  private connection: Promise<IDBPDatabase<BackupDatabase>> | null = null;
  constructor(private readonly name = 'tabblackbox', private readonly budget?: number) {}

  private db(): Promise<IDBPDatabase<BackupDatabase>>
  {
    this.connection ??= openDB<BackupDatabase>(this.name, 4, {
      upgrade(db, oldVersion, _newVersion, transaction)
      {
        void (async () => {
          if (oldVersion < 3) {
            // replace disposable session data once while retaining existing preferences
            const previous = oldVersion === 0 ? undefined : await transaction.objectStore('metadata').get('state');
            for (const store of [...db.objectStoreNames]) db.deleteObjectStore(store);
            db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('tabIds', 'tabIds', { multiEntry: true });
            db.createObjectStore('tabs', { keyPath: 'id' }).createIndex('url', 'url');
            db.createObjectStore('summaries', { keyPath: 'id' }).createIndex('capturedAt', 'capturedAt');
            db.createObjectStore('metadata');
            const metadata = initialMetadata();
            if (previous) { metadata.automatic = previous.automatic; metadata.settings = previous.settings; }
            await transaction.objectStore('metadata').put(metadata, 'state');
            return;
          }
          // index existing sessions by tab record and tab records by URL without replacing them
          transaction.objectStore('tabs').createIndex('url', 'url');
          const snapshots = transaction.objectStore('snapshots');
          snapshots.createIndex('tabIds', 'tabIds', { multiEntry: true });
          for (let cursor = await snapshots.openCursor(); cursor; cursor = await cursor.continue()) {
            await cursor.update({ ...cursor.value, tabIds: snapshotTabIds(cursor.value.windows) });
          }
        })().catch(() => {
          try { transaction.abort(); } catch { /* failed requests may already have aborted the upgrade */ }
        });
      },
      blocking: () => { void this.close(); },
      terminated: () => { this.connection = null; },
    }).catch((error: unknown) => { this.connection = null; throw error; });
    return this.connection;
  }

  async close(): Promise<void>
  {
    const connection = this.connection;
    this.connection = null;
    if (connection) (await connection).close();
  }

  async metadata(): Promise<Metadata>
  {
    return (await (await this.db()).get('metadata', 'state')) ?? initialMetadata();
  }

  async get(id: string): Promise<Snapshot>
  {
    const tx = (await this.db()).transaction(['snapshots', 'tabs']);
    const snapshot = await tx.objectStore('snapshots').get(id);
    if (!snapshot) throw new Error('This backup is no longer available. Refresh history.');
    const tabs = await readTabs([snapshot], id => tx.objectStore('tabs').get(id));
    await tx.done;
    return decodeSnapshot(snapshot, tabs);
  }

  async summary(id: string): Promise<Summary>
  {
    const summary = await (await this.db()).get('summaries', id);
    if (!summary) throw new Error('This backup is no longer available. Refresh history.');
    return summary;
  }

  async list(before: HistoryCursor | null = null, limit = 50): Promise<Summary[]>
  {
    return (await this.history(before, limit)).items;
  }

  async history(before: HistoryCursor | null = null, limit = 50, collection?: Collection, query = '', sort: HistorySort = 'date-desc', range?: HistoryRange, tabUrl?: string): Promise<{ items: Summary[]; count: number; bytes: number }>
  {
    const db = await this.db();
    const transaction = db.transaction(['summaries', 'metadata', 'snapshots', 'tabs']);
    const summaries = await transaction.objectStore('summaries').index('capturedAt').getAll();
    const metadata = (await transaction.objectStore('metadata').get('state')) ?? initialMetadata();
    let containing: Set<string> | undefined;
    if (tabUrl !== undefined) {
      // limit results to backups referencing any stored record of the page
      const ids = await transaction.objectStore('tabs').index('url').getAllKeys(tabUrl);
      const index = transaction.objectStore('snapshots').index('tabIds');
      containing = new Set((await Promise.all(ids.map(id => index.getAllKeys(id)))).flat());
    }
    const result: Summary[] = [];
    let count = 0;
    const bytes = collection === 'automatic' ? metadata.automaticBytes : collection === 'saved' ? metadata.savedBytes : metadata.bytes;
    const search = query.trim().toLocaleLowerCase();
    if (limit > 0) summaries.sort((a, b) => compareHistory(a, b, sort));
    for (const item of summaries) {
      const matches = collection === undefined || (item.savedAt !== undefined) === (collection === 'saved');
      if (matches) count++;
      // filter the full collection before paging in the selected order
      if (matches && result.length < limit && (!range || (item.capturedAt >= range.start && item.capturedAt < range.end)) && (item.name ?? 'Unnamed session').toLocaleLowerCase().includes(search) &&
          (!containing || containing.has(item.id)) && (!before || compareHistory(item, before, sort) > 0)) result.push(item);
    }
    await transaction.done;
    return { items: result, count, bytes };
  }

  async calendar(range: HistoryRange): Promise<BackupDay[]>
  {
    // aggregate only the displayed period without reading complete snapshots
    const summaries = await (await this.db()).getAllFromIndex('summaries', 'capturedAt', IDBKeyRange.bound(range.start, range.end, false, true));
    const days = new Map<number, BackupDay>();
    for (const item of summaries) {
      const start = dayRange(item.capturedAt).start;
      const day = days.get(start) ?? { start, saved: 0, automatic: 0 };
      if (item.savedAt === undefined) day.automatic++;
      else day.saved++;
      days.set(start, day);
    }
    return [...days.values()];
  }

  async tabCounts(range: HistoryRange): Promise<{ points: TabCountPoint[]; before: TabCountPoint | null }>
  {
    const transaction = (await this.db()).transaction('summaries');
    const index = transaction.store.index('capturedAt');
    // read only summaries so charting never loads complete snapshots
    const summaries = await index.getAll(IDBKeyRange.bound(range.start, range.end, false, true));
    // carry the newest earlier automatic count into the start of the period
    let before: Summary | undefined;
    for (let cursor = await index.openCursor(IDBKeyRange.upperBound(range.start, true), 'prev'); cursor; cursor = await cursor.continue()) {
      if (cursor.value.savedAt === undefined) { before = cursor.value; break; }
    }
    await transaction.done;
    const point = (item: Summary): TabCountPoint => ({ id: item.id, number: item.number, capturedAt: item.capturedAt, tabCount: item.tabCount, windowCount: item.windowCount, collection: item.savedAt === undefined ? 'automatic' : 'saved' });
    const points = summaries.map(point);
    // reduce each collection separately so manual backups remain visible beside dense automatic history
    return {
      points: [...thinTabCounts(points.filter(item => item.collection === 'automatic'), range), ...thinTabCounts(points.filter(item => item.collection === 'saved'), range)],
      before: before ? point(before) : null,
    };
  }

  async searchTabs(query: string, limit = 100): Promise<{ items: TabMatch[]; truncated: boolean; tooBroad: boolean }>
  {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(word => word.length > 0);
    if (!words.length) return { items: [], truncated: false, tooBroad: false };
    const transaction = (await this.db()).transaction(['tabs', 'snapshots', 'summaries']);
    // match shared tab records instead of every reference in every snapshot
    const tabs = (await transaction.objectStore('tabs').getAll()).filter((tab): tab is StoredTab & { url: string } => {
      const text = `${tab.title}\n${tab.url ?? ''}`.toLocaleLowerCase();
      return tab.url !== null && words.every(word => text.includes(word));
    });
    // skip backup lookups for queries that match too many records to summarize quickly
    if (tabs.length > TAB_SEARCH_RECORD_LIMIT) {
      await transaction.done;
      return { items: [], truncated: false, tooBroad: true };
    }
    const summaries = new Map(tabs.length ? (await transaction.objectStore('summaries').getAll()).map(item => [item.id, item]) : []);
    const index = transaction.objectStore('snapshots').index('tabIds');
    const references = await Promise.all(tabs.map(async tab => ({ tab, ids: await index.getAllKeys(tab.id) })));
    await transaction.done;
    // combine title, pin, and group variants of each page and report its newest title
    const pages = new Map<string, { match: TabMatch; saved: Map<string, boolean> }>();
    for (const { tab, ids } of references) {
      for (const id of ids) {
        const summary = summaries.get(id);
        if (!summary) throw new Error('This backup is no longer available. Refresh history.');
        const collection: Collection = summary.savedAt === undefined ? 'automatic' : 'saved';
        const page = pages.get(tab.url) ?? { match: { url: tab.url, title: tab.title, lastSeen: summary.capturedAt, lastSeenNumber: summary.number, lastSeenCollection: collection, automaticCount: 0, savedCount: 0 }, saved: new Map<string, boolean>() };
        page.saved.set(id, summary.savedAt !== undefined);
        if (summary.capturedAt > page.match.lastSeen) Object.assign(page.match, { title: tab.title, lastSeen: summary.capturedAt, lastSeenNumber: summary.number, lastSeenCollection: collection });
        pages.set(tab.url, page);
      }
    }
    const items = [...pages.values()].map(({ match, saved }) => {
      const savedCount = [...saved.values()].filter(Boolean).length;
      return { ...match, automaticCount: saved.size - savedCount, savedCount };
    }).sort((a, b) => b.lastSeen - a.lastSeen || a.url.localeCompare(b.url));
    return { items: items.slice(0, limit), truncated: items.length > limit, tooBroad: false };
  }

  async capture(session: Session, source: Source, now: number, name?: string | null): Promise<CaptureResult>
  {
    return this.writeCapture(session, source, now, undefined, name);
  }

  async setStorageSettings(settings: StorageSettings, confirmedRemovalCount: number, session: Session, now: number): Promise<StorageSettingsResult>
  {
    const result = await this.writeCapture(session, 'automatic', now, { settings, confirmedRemovalCount });
    return result.kind === 'confirmation' ? result : { kind: 'saved' };
  }

  private writeCapture(session: Session, source: Source, now: number, change: undefined, name?: string | null): Promise<CaptureResult>;
  private writeCapture(session: Session, source: Source, now: number, change: { settings: StorageSettings; confirmedRemovalCount: number }): Promise<CaptureResult | StorageSettingsResult>;
  private async writeCapture(session: Session, source: Source, now: number, change?: { settings: StorageSettings; confirmedRemovalCount: number }, name?: string | null): Promise<CaptureResult | StorageSettingsResult>
  {
    const db = await this.db();
    // plan the candidate and commit snapshots, retention, and settings in one transaction
    const tx = db.transaction(['snapshots', 'tabs', 'summaries', 'metadata'], 'readwrite');
    try {
      const metadata = (await tx.objectStore('metadata').get('state')) ?? initialMetadata();
      if (metadata.operation?.kind === 'running') throw new Error('Restoration is in progress.');
      const previousLastTabId = metadata.lastTabId;
      const settings = change?.settings ?? metadata.settings;
      const history = await tx.objectStore('summaries').getAll();
      let result: CaptureResult = { kind: 'empty' };
      let candidate: Snapshot | undefined;
      if (session.windows.length) {
        // compare only the latest snapshot before loading the complete shared pool
        const latest = source === 'automatic' && metadata.latestId ? await tx.objectStore('snapshots').get(metadata.latestId) : undefined;
        const latestTabs = latest ? await readTabs([latest], id => tx.objectStore('tabs').get(id)) : undefined;
        if (latest && latestTabs && canonicalSession(decodeSnapshot(latest, latestTabs)) === canonicalSession(session)) result = { kind: 'unchanged' };
        else {
          const number = nextSessionNumber(metadata, source);
          candidate = { ...session, id: crypto.randomUUID(), number, name: name ?? null, capturedAt: now, source, ...(source === 'manual' ? { savedAt: now } : {}) };
          result = { kind: 'saved', id: candidate.id };
        }
      }
      // unchanged and empty scans still honor expiration and proposed storage limits
      if (source === 'automatic' && !candidate && !retentionRemovals(history, metadata.latestId, settings, now).length &&
          metadata.automaticBytes <= (this.budget ?? settings.maxStorageMB * MB)) {
        metadata.settings = settings;
        metadata.lastCheckedAt = now;
        await tx.objectStore('metadata').put(metadata, 'state');
        await tx.done;
        return result;
      }
      const state = await readStorage(tx);
      const stored = candidate ? internSnapshot(candidate, state, metadata) : undefined;
      // manual saves do not consume the automatic budget or prune its history
      const plan = source === 'manual'
        ? { removeIds: [] }
        : retentionPlan(state.snapshots, state.tabs, candidate?.id ?? metadata.latestId, settings, now, this.budget);
      if (change && plan.removeIds.length > change.confirmedRemovalCount) {
        await tx.done;
        return { kind: 'confirmation', removeCount: plan.removeIds.length };
      }
      for (const id of plan.removeIds) {
        await tx.objectStore('snapshots').delete(id);
        await tx.objectStore('summaries').delete(id);
      }
      const removed = new Set(plan.removeIds);
      state.snapshots = state.snapshots.filter(snapshot => !removed.has(snapshot.id));
      await writeTabs(tx, state, previousLastTabId);
      if (candidate && stored) {
        await tx.objectStore('snapshots').add(stored);
        await tx.objectStore('summaries').add(summarize(candidate, storedBytes(stored)));
        // commit the number with the snapshot so failed or unchanged captures do not consume it
        Object.assign(metadata, { latestId: candidate.id, lastSavedAt: now });
      }
      metadata.settings = settings;
      updateStorage(metadata, state);
      metadata.lastCheckedAt = now;
      await tx.objectStore('metadata').put(metadata, 'state');
      await tx.done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* abort may already have happened on the failed request */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async rename(id: string, name: string | null): Promise<Summary>
  {
    return this.updateSession(id, name);
  }

  async keep(id: string, name: string | null, now: number): Promise<Summary>
  {
    return this.updateSession(id, name, now);
  }

  private async updateSession(id: string, name: string | null, savedAt?: number): Promise<Summary>
  {
    // update labels and byte accounting together without capturing or applying retention
    const tx = (await this.db()).transaction(['snapshots', 'tabs', 'summaries', 'metadata'], 'readwrite');
    try {
      const state = await readStorage(tx);
      const snapshot = state.snapshots.find(snapshot => snapshot.id === id);
      if (!snapshot) throw new Error('This backup is no longer available. Refresh history.');
      const metadata = (await tx.objectStore('metadata').get('state')) ?? initialMetadata();
      const previous = summarize(decodeSnapshot(snapshot, state.tabs), storedBytes(snapshot));
      snapshot.name = name;
      // assign a manual number only when the session first enters the saved collection
      if (savedAt !== undefined && snapshot.savedAt === undefined) {
        snapshot.number = nextSessionNumber(metadata, 'manual');
        snapshot.savedAt = savedAt;
      }
      const summary = summarize(decodeSnapshot(snapshot, state.tabs), storedBytes(snapshot));
      updateStorage(metadata, state);
      if (snapshot.savedAt === undefined && summary.bytes > previous.bytes) {
        if (metadata.automaticBytes > (this.budget ?? metadata.settings.maxStorageMB * MB)) throw new Error('There is not enough backup storage for this session. Shorten the name or increase the storage limit.');
      }
      if (previous.name !== name || previous.savedAt !== snapshot.savedAt) {
        await tx.objectStore('snapshots').put(snapshot);
        await tx.objectStore('summaries').put(summary);
        metadata.historyRevision++;
        await tx.objectStore('metadata').put(metadata, 'state');
      }
      await tx.done;
      return summary;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be aborted */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async deleteSession(id: string): Promise<boolean>
  {
    // delete one saved session or automatic backup and repair the capture pointer atomically
    const tx = (await this.db()).transaction(['snapshots', 'tabs', 'summaries', 'metadata'], 'readwrite');
    try {
      const snapshot = await tx.objectStore('snapshots').get(id);
      if (!snapshot) throw new Error('This backup is no longer available. Refresh history.');
      const metadata = (await tx.objectStore('metadata').get('state')) ?? initialMetadata();
      if (metadata.operation?.kind === 'running') throw new Error('Wait for restoration to finish before deleting backups.');
      const deletedLatest = metadata.latestId === id;
      const state = await readStorage(tx);
      // keep the newest automatic backup as the recovery boundary like retention does
      if (snapshot.savedAt === undefined && newestAutomaticId(state.snapshots, metadata.latestId) === id) throw new Error('The newest automatic backup cannot be deleted.');
      state.snapshots = state.snapshots.filter(snapshot => snapshot.id !== id);
      await tx.objectStore('snapshots').delete(id);
      await tx.objectStore('summaries').delete(id);
      await writeTabs(tx, state, metadata.lastTabId);
      updateStorage(metadata, state);
      metadata.historyRevision++;
      if (deletedLatest) {
        // imported capture dates must not become the automatic scheduling boundary
        let newest = await tx.objectStore('summaries').index('capturedAt').openCursor(null, 'prev');
        while (newest?.value.savedAt !== undefined) newest = await newest.continue();
        metadata.latestId = newest?.value.id ?? null;
        metadata.lastSavedAt = newest?.value.capturedAt ?? null;
      }
      await tx.objectStore('metadata').put(metadata, 'state');
      await tx.done;
      return deletedLatest;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be aborted */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async exportSaved(id?: string): Promise<Archive>
  {
    const tx = (await this.db()).transaction(['snapshots', 'tabs']);
    const snapshots = id === undefined ? await tx.objectStore('snapshots').getAll() : [await tx.objectStore('snapshots').get(id)];
    // export any single session by ID but only saved sessions in a complete export
    const saved = snapshots.filter((snapshot): snapshot is StoredSnapshot => snapshot !== undefined && (id !== undefined || snapshot.savedAt !== undefined));
    const tabs = await readTabs(saved, id => tx.objectStore('tabs').get(id));
    const sessions = saved.map(snapshot => decodeSnapshot(snapshot, tabs))
      .map(({ windows, name, capturedAt, source }) => ({ windows, name, capturedAt, source }));
    await tx.done;
    if (!sessions.length) throw new Error('No saved sessions are available to export.');
    return { format: 'tabblackbox', version: 1, sessions };
  }

  async importSaved(archive: Archive, now: number): Promise<void>
  {
    // import the entire archive without pruning recovery history or replacing its latest pointer
    const tx = (await this.db()).transaction(['snapshots', 'tabs', 'summaries', 'metadata'], 'readwrite');
    try {
      const metadata = (await tx.objectStore('metadata').get('state')) ?? initialMetadata();
      const previousLastTabId = metadata.lastTabId;
      const state = await readStorage(tx);
      for (const session of archive.sessions) {
        const number = nextSessionNumber(metadata, 'manual');
        const snapshot: Snapshot = { ...session, id: crypto.randomUUID(), number, savedAt: now };
        const stored = internSnapshot(snapshot, state, metadata);
        await tx.objectStore('snapshots').add(stored);
        await tx.objectStore('summaries').add(summarize(snapshot, storedBytes(stored)));
      }
      await writeTabs(tx, state, previousLastTabId);
      updateStorage(metadata, state);
      metadata.historyRevision++;
      await tx.objectStore('metadata').put(metadata, 'state');
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be aborted */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async setAutomaticSettings(update: AutomaticUpdate, now: number): Promise<void>
  {
    // merge one preference within the metadata transaction so other pages cannot overwrite it
    const tx = (await this.db()).transaction('metadata', 'readwrite');
    try {
      const metadata = (await tx.store.get('state')) ?? initialMetadata();
      metadata.automatic = applyAutomaticUpdate(metadata.automatic, update, now);
      await tx.store.put(metadata, 'state');
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be aborted */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async setOperation(operation: Operation): Promise<void>
  {
    const tx = (await this.db()).transaction('metadata', 'readwrite');
    const metadata = (await tx.store.get('state')) ?? initialMetadata();
    metadata.operation = operation;
    await tx.store.put(metadata, 'state');
    await tx.done;
  }

  async recoverOperation(now = Date.now()): Promise<void>
  {
    const operation = (await this.metadata()).operation;
    if (operation?.kind === 'running') await this.setOperation({ ...operation, kind: 'interrupted', finishedAt: now });
  }
}
