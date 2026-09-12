import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CaptureResult, HistoryCursor, Metadata, Operation, Session, Snapshot, Source, StorageSettings, StorageSettingsResult, Summary } from './model';
import { canonicalSession, summarize } from './session';
import { DEFAULT_STORAGE_SETTINGS, retentionPlan } from './storage';

interface BackupDatabase extends DBSchema {
  snapshots: { key: string; value: Snapshot };
  summaries: { key: string; value: Summary; indexes: { capturedAt: number } };
  metadata: { key: string; value: Metadata };
}

const initialMetadata = (): Metadata => ({ latestId: null, lastSavedAt: null, lastCheckedAt: null, bytes: 0, count: 0, operation: null });

export class Repository {
  private connection: Promise<IDBPDatabase<BackupDatabase>> | null = null;
  constructor(private readonly name = 'tabblackbox', private readonly budget?: number) {}

  private db(): Promise<IDBPDatabase<BackupDatabase>>
  {
    this.connection ??= openDB<BackupDatabase>(this.name, 1, {
      upgrade(db)
      {
        db.createObjectStore('snapshots', { keyPath: 'id' });
        db.createObjectStore('summaries', { keyPath: 'id' }).createIndex('capturedAt', 'capturedAt');
        db.createObjectStore('metadata');
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
    if (snapshot.schemaVersion !== 1) throw new Error('This backup needs a newer version of TabBlackBox.');
    return snapshot;
  }

  async list(before: HistoryCursor | null = null, limit = 50): Promise<Summary[]>
  {
    const db = await this.db();
    const transaction = db.transaction('summaries');
    const range = before ? IDBKeyRange.upperBound(before.capturedAt) : null;
    let cursor = await transaction.store.index('capturedAt').openCursor(range, 'prev');
    const result: Summary[] = [];
    while (cursor && result.length < limit) {
      // use the primary key to break timestamp ties after the anchor is pruned
      if (!before || cursor.key < before.capturedAt || cursor.primaryKey < before.id) result.push(cursor.value);
      cursor = await cursor.continue();
    }
    await transaction.done;
    return result;
  }

  async capture(session: Session, source: Source, now: number): Promise<CaptureResult>
  {
    return this.writeCapture(session, source, now);
  }

  async setStorageSettings(settings: StorageSettings, confirmedRemovalCount: number, session: Session, now: number): Promise<StorageSettingsResult>
  {
    const result = await this.writeCapture(session, 'automatic', now, { settings, confirmedRemovalCount });
    return result.kind === 'confirmation' ? result : { kind: 'saved' };
  }

  private writeCapture(session: Session, source: Source, now: number): Promise<CaptureResult>;
  private writeCapture(session: Session, source: Source, now: number, change: { settings: StorageSettings; confirmedRemovalCount: number }): Promise<CaptureResult | StorageSettingsResult>;
  private async writeCapture(session: Session, source: Source, now: number, change?: { settings: StorageSettings; confirmedRemovalCount: number }): Promise<CaptureResult | StorageSettingsResult>
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
        if (latest && canonicalSession(latest) === canonicalSession(session)) result = { kind: 'unchanged' };
        else {
          candidate = { ...session, id: crypto.randomUUID(), schemaVersion: 1, capturedAt: now, source };
          result = { kind: 'saved', id: candidate.id };
        }
      }
      // include the prospective backup in the deletion count before any writes
      const history = await tx.objectStore('summaries').getAll();
      if (candidate) history.push(summarize(candidate));
      const settings = change?.settings ?? metadata.settings ?? DEFAULT_STORAGE_SETTINGS;
      const plan = retentionPlan(history, candidate?.id ?? metadata.latestId, settings, now, this.budget);
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
        Object.assign(metadata, { latestId: candidate.id, lastSavedAt: now });
      }
      if (change) metadata.settings = change.settings;
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
