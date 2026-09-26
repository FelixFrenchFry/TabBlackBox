import { applyAutomaticUpdate, DEFAULT_AUTOMATIC_SETTINGS } from './automatic';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AutomaticUpdate, CaptureResult, Collection, HistoryCursor, HistorySort, Metadata, Operation, Session, Snapshot, Source, StorageSettings, StorageSettingsResult, Summary } from './model';
import { compareHistory } from './history';
import type { Archive } from './archive';
import { canonicalSession, summarize } from './session';
import { DEFAULT_STORAGE_SETTINGS, MB, retentionPlan } from './storage';

interface BackupDatabase extends DBSchema {
  snapshots: { key: string; value: Snapshot };
  summaries: { key: string; value: Summary; indexes: { capturedAt: number } };
  metadata: { key: string; value: Metadata };
}

const initialMetadata = (): Metadata => ({ automatic: { ...DEFAULT_AUTOMATIC_SETTINGS }, settings: { ...DEFAULT_STORAGE_SETTINGS }, latestId: null, lastSavedAt: null, lastCheckedAt: null, bytes: 0, count: 0, operation: null, lastSessionNumbers: { automatic: 0, manual: 0 }, historyRevision: 0 });

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
    this.connection ??= openDB<BackupDatabase>(this.name, 2, {
      upgrade(db, oldVersion, _newVersion, transaction)
      {
        if (oldVersion === 0) {
          db.createObjectStore('snapshots', { keyPath: 'id' });
          db.createObjectStore('summaries', { keyPath: 'id' }).createIndex('capturedAt', 'capturedAt');
          db.createObjectStore('metadata');
        } else {
          // split existing numbering by collection and update byte accounting atomically
          void (async () => {
            const metadata = (await transaction.objectStore('metadata').get('state')) ?? initialMetadata();
            metadata.lastSessionNumbers = { automatic: 0, manual: 0 };
            if ('lastSessionNumber' in metadata) delete metadata.lastSessionNumber;
            const snapshots = await transaction.objectStore('snapshots').getAll();
            snapshots.sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id));
            metadata.bytes = 0;
            for (const snapshot of snapshots) {
              snapshot.number = nextSessionNumber(metadata, snapshot.savedAt === undefined ? 'automatic' : 'manual');
              const summary = summarize(snapshot);
              metadata.bytes += summary.bytes;
              await transaction.objectStore('snapshots').put(snapshot);
              await transaction.objectStore('summaries').put(summary);
            }
            metadata.count = snapshots.length;
            metadata.historyRevision++;
            await transaction.objectStore('metadata').put(metadata, 'state');
          })().catch(() => {
            try { transaction.abort(); } catch { /* failed requests may already have aborted the upgrade */ }
          });
        }
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
    const snapshot = await (await this.db()).get('snapshots', id);
    if (!snapshot) throw new Error('This backup is no longer available. Refresh history.');
    return snapshot;
  }

  async list(before: HistoryCursor | null = null, limit = 50): Promise<Summary[]>
  {
    return (await this.history(before, limit)).items;
  }

  async history(before: HistoryCursor | null = null, limit = 50, collection?: Collection, query = '', sort: HistorySort = 'date-desc'): Promise<{ items: Summary[]; count: number; bytes: number }>
  {
    const db = await this.db();
    const transaction = db.transaction('summaries');
    const summaries = await transaction.store.index('capturedAt').getAll();
    const result: Summary[] = [];
    let count = 0;
    let bytes = 0;
    const search = query.trim().toLocaleLowerCase();
    if (limit > 0) summaries.sort((a, b) => compareHistory(a, b, sort));
    for (const item of summaries) {
      const matches = collection === undefined || (item.savedAt !== undefined) === (collection === 'saved');
      if (matches) { count++; bytes += item.bytes; }
      // filter the full collection before paging in the selected order
      if (matches && result.length < limit && (item.name ?? 'Unnamed session').toLocaleLowerCase().includes(search) &&
          (!before || compareHistory(item, before, sort) > 0)) result.push(item);
    }
    await transaction.done;
    return { items: result, count, bytes };
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
    const tx = db.transaction(['snapshots', 'summaries', 'metadata'], 'readwrite');
    try {
      const metadata = (await tx.objectStore('metadata').get('state')) ?? initialMetadata();
      if (metadata.operation?.kind === 'running') throw new Error('Restoration is in progress.');
      const latest = metadata.latestId ? await tx.objectStore('snapshots').get(metadata.latestId) : undefined;
      let result: CaptureResult = { kind: 'empty' };
      let candidate: Snapshot | undefined;
      if (session.windows.length) {
        if (source === 'automatic' && latest && canonicalSession(latest) === canonicalSession(session)) result = { kind: 'unchanged' };
        else {
          const number = nextSessionNumber(metadata, source);
          candidate = { ...session, id: crypto.randomUUID(), number, name: name ?? null, capturedAt: now, source, ...(source === 'manual' ? { savedAt: now } : {}) };
          result = { kind: 'saved', id: candidate.id };
        }
      }
      // include the prospective backup in the deletion count before any writes
      const history = await tx.objectStore('summaries').getAll();
      if (candidate) history.push(summarize(candidate));
      const settings = change?.settings ?? metadata.settings;
      // manual saves do not consume the automatic budget or prune its history
      const plan = source === 'manual'
        ? { removeIds: [], bytes: history.reduce((sum, item) => sum + item.bytes, 0), count: history.length }
        : retentionPlan(history, candidate?.id ?? metadata.latestId, settings, now, this.budget);
      if (change && plan.removeIds.length > change.confirmedRemovalCount) {
        await tx.done;
        return { kind: 'confirmation', removeCount: plan.removeIds.length };
      }
      for (const id of plan.removeIds) {
        await tx.objectStore('snapshots').delete(id);
        await tx.objectStore('summaries').delete(id);
      }
      if (candidate) {
        await tx.objectStore('snapshots').add(candidate);
        await tx.objectStore('summaries').add(summarize(candidate));
        // commit the number with the snapshot so failed or unchanged captures do not consume it
        Object.assign(metadata, { latestId: candidate.id, lastSavedAt: now });
      }
      metadata.settings = settings;
      Object.assign(metadata, { bytes: plan.bytes, count: plan.count });
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
    const tx = (await this.db()).transaction(['snapshots', 'summaries', 'metadata'], 'readwrite');
    try {
      const snapshot = await tx.objectStore('snapshots').get(id);
      if (!snapshot) throw new Error('This backup is no longer available. Refresh history.');
      const metadata = (await tx.objectStore('metadata').get('state')) ?? initialMetadata();
      const previous = summarize(snapshot);
      snapshot.name = name;
      // assign a manual number only when the session first enters the saved collection
      if (savedAt !== undefined && snapshot.savedAt === undefined) {
        snapshot.number = nextSessionNumber(metadata, 'manual');
        snapshot.savedAt = savedAt;
      }
      const summary = summarize(snapshot);
      const bytes = metadata.bytes + summary.bytes - previous.bytes;
      if (snapshot.savedAt === undefined && bytes > metadata.bytes) {
        const history = await tx.objectStore('summaries').getAll();
        const automaticBytes = history.filter(item => item.savedAt === undefined).reduce((sum, item) => sum + item.bytes, 0) + summary.bytes - previous.bytes;
        if (automaticBytes > (this.budget ?? metadata.settings.maxStorageMB * MB)) throw new Error('There is not enough backup storage for this session. Shorten the name or increase the storage limit.');
      }
      if (previous.name !== name || previous.savedAt !== snapshot.savedAt) {
        await tx.objectStore('snapshots').put(snapshot);
        await tx.objectStore('summaries').put(summary);
        metadata.bytes = bytes;
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

  async deleteSaved(id: string): Promise<boolean>
  {
    // delete only explicitly saved sessions and repair the capture pointer atomically
    const tx = (await this.db()).transaction(['snapshots', 'summaries', 'metadata'], 'readwrite');
    try {
      const snapshot = await tx.objectStore('snapshots').get(id);
      if (!snapshot || snapshot.savedAt === undefined) throw new Error('This saved session is no longer available. Refresh history.');
      const metadata = (await tx.objectStore('metadata').get('state')) ?? initialMetadata();
      if (metadata.operation?.kind === 'running') throw new Error('Wait for restoration to finish before deleting saved sessions.');
      const deletedLatest = metadata.latestId === id;
      const summary = await tx.objectStore('summaries').get(id);
      await tx.objectStore('snapshots').delete(id);
      await tx.objectStore('summaries').delete(id);
      metadata.bytes -= summary?.bytes ?? summarize(snapshot).bytes;
      metadata.count--;
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
    const tx = (await this.db()).transaction('snapshots');
    const snapshots = id === undefined ? await tx.store.getAll() : [await tx.store.get(id)];
    const sessions = snapshots.filter((snapshot): snapshot is Snapshot => snapshot !== undefined && snapshot.savedAt !== undefined)
      .map(({ windows, name, capturedAt, source }) => ({ windows, name, capturedAt, source }));
    await tx.done;
    if (!sessions.length) throw new Error('No saved sessions are available to export.');
    return { format: 'tabblackbox', version: 1, sessions };
  }

  async importSaved(archive: Archive, now: number): Promise<void>
  {
    // import the entire archive without pruning recovery history or replacing its latest pointer
    const tx = (await this.db()).transaction(['snapshots', 'summaries', 'metadata'], 'readwrite');
    try {
      const metadata = (await tx.objectStore('metadata').get('state')) ?? initialMetadata();
      for (const session of archive.sessions) {
        const number = nextSessionNumber(metadata, 'manual');
        const snapshot: Snapshot = { ...session, id: crypto.randomUUID(), number, savedAt: now };
        const summary = summarize(snapshot);
        metadata.bytes += summary.bytes;
        await tx.objectStore('snapshots').add(snapshot);
        await tx.objectStore('summaries').add(summary);
        metadata.count++;
      }
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
