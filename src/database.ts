import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CaptureResult, Metadata, Operation, Session, Snapshot, Source, Summary } from './model';
import { BYTE_BUDGET, canonicalSession, retainedIds, summarize } from './session';

interface BackupDatabase extends DBSchema {
  snapshots: { key: string; value: Snapshot };
  summaries: { key: string; value: Summary; indexes: { capturedAt: number } };
  metadata: { key: string; value: Metadata };
}

const initialMetadata = (): Metadata => ({ latestId: null, lastSavedAt: null, lastCheckedAt: null, bytes: 0, count: 0, operation: null });

export class Repository {
  private connection: Promise<IDBPDatabase<BackupDatabase>> | null = null;
  constructor(private readonly name = 'tabblackbox', private readonly budget = BYTE_BUDGET) {}

  private db(): Promise<IDBPDatabase<BackupDatabase>> {
    this.connection ??= openDB<BackupDatabase>(this.name, 1, {
      upgrade(db) {
        db.createObjectStore('snapshots', { keyPath: 'id' });
        db.createObjectStore('summaries', { keyPath: 'id' }).createIndex('capturedAt', 'capturedAt');
        db.createObjectStore('metadata');
      },
      blocking: () => { void this.close(); },
      terminated: () => { this.connection = null; },
    }).catch((error: unknown) => { this.connection = null; throw error; });
    return this.connection;
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection) (await connection).close();
  }

  async metadata(): Promise<Metadata> {
    return (await (await this.db()).get('metadata', 'state')) ?? initialMetadata();
  }

  async get(id: string): Promise<Snapshot> {
    const snapshot = await (await this.db()).get('snapshots', id);
    if (!snapshot) throw new Error('This backup is no longer available. Refresh history.');
    if (snapshot.schemaVersion !== 1) throw new Error('This backup needs a newer version of TabBlackBox.');
    return snapshot;
  }

  async list(offset = 0, limit = 50): Promise<Summary[]> {
    const db = await this.db();
    const transaction = db.transaction('summaries');
    let cursor = await transaction.store.index('capturedAt').openCursor(null, 'prev');
    if (cursor && offset) cursor = await cursor.advance(offset);
    const result: Summary[] = [];
    while (cursor && result.length < limit) {
      result.push(cursor.value);
      cursor = await cursor.continue();
    }
    await transaction.done;
    return result;
  }

  async capture(session: Session, source: Source, now: number): Promise<CaptureResult> {
    const db = await this.db();
    const tx = db.transaction(['snapshots', 'summaries', 'metadata'], 'readwrite');
    try {
      const metadata = (await tx.objectStore('metadata').get('state')) ?? initialMetadata();
      if (metadata.operation?.kind === 'running') throw new Error('Restoration is in progress.');
      const latest = metadata.latestId ? await tx.objectStore('snapshots').get(metadata.latestId) : undefined;
      let result: CaptureResult = { kind: 'empty' };
      if (session.windows.length) {
        if (latest && canonicalSession(latest) === canonicalSession(session)) result = { kind: 'unchanged' };
        else {
          const snapshot: Snapshot = { ...session, id: crypto.randomUUID(), schemaVersion: 1, capturedAt: now, source };
          const summary = summarize(snapshot);
          const history = [...await tx.objectStore('summaries').getAll(), summary];
          const keep = retainedIds(history, now);
          const kept = history.filter(item => keep.has(item.id));
          const bytes = kept.reduce((total, item) => total + item.bytes, 0);
          if (bytes > this.budget) throw new Error('Backup failed: storage full');
          for (const item of history) {
            if (!keep.has(item.id)) {
              await tx.objectStore('snapshots').delete(item.id);
              await tx.objectStore('summaries').delete(item.id);
            }
          }
          await tx.objectStore('snapshots').add(snapshot);
          await tx.objectStore('summaries').add(summary);
          Object.assign(metadata, { latestId: snapshot.id, lastSavedAt: now, bytes, count: kept.length });
          result = { kind: 'saved', id: snapshot.id };
        }
      }
      metadata.lastCheckedAt = now;
      await tx.objectStore('metadata').put(metadata, 'state');
      await tx.done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* The failed request may already have aborted it. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async setOperation(operation: Operation): Promise<void> {
    const tx = (await this.db()).transaction('metadata', 'readwrite');
    const metadata = (await tx.store.get('state')) ?? initialMetadata();
    metadata.operation = operation;
    await tx.store.put(metadata, 'state');
    await tx.done;
  }

  async recoverOperation(now = Date.now()): Promise<void> {
    const operation = (await this.metadata()).operation;
    if (operation?.kind === 'running') await this.setOperation({ ...operation, kind: 'interrupted', finishedAt: now });
  }
}
