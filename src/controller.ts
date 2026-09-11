import type { Repository } from './database';
import { errorMessage, type Overview, type Session, type Snapshot, type Source, type Status } from './model';
import { restoreSession, type RestorePort } from './restore';
import { restorableUrl, summarize } from './session';

export class BackupBusyError extends Error {
  constructor() { super('Restoration in progress. Try backing up again when it finishes.'); }
}

type RestorationState =
  | { kind: 'idle' }
  | { kind: 'waiting'; automaticPending: boolean }
  | { kind: 'running' };

export class Controller {
  private currentStatus: Status = { kind: 'initializing' };
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstChange: number | undefined;
  private queue: Promise<void> = Promise.resolve();
  private restoration: RestorationState = { kind: 'idle' };
  private ready: Promise<void> | undefined;
  private retryAfter = 0;
  private initializationFailure: { message: string; retryAt: number } | undefined;

  constructor(
    readonly repository: Repository,
    private readonly scan: () => Promise<Session>,
    private readonly port: RestorePort,
    private readonly onStatusChange: (status: Status) => void = () => {},
  ) {}

  get status(): Status { return this.currentStatus; }
  set status(value: Status)
  {
    const previous = this.currentStatus;
    if (previous.kind === value.kind && (previous.kind !== 'error' || (value.kind === 'error' && previous.message === value.message))) return;
    this.currentStatus = value;
    this.onStatusChange(value);
  }

  start(forceRetry = false): Promise<void>
  {
    if (!this.ready && !forceRetry && this.initializationFailure && Date.now() < this.initializationFailure.retryAt) {
      return Promise.reject(new Error(this.initializationFailure.message));
    }
    // recover interrupted work before the first automatic capture
    this.ready ??= this.enqueue(async () =>
    {
      try {
        await this.repository.recoverOperation();
        this.initializationFailure = undefined;
        await this.performCapture('automatic');
      } catch (error) {
        this.status = { kind: 'error', message: errorMessage(error) };
        this.initializationFailure = { message: errorMessage(error), retryAt: Date.now() + 60_000 };
        this.ready = undefined;
        throw error;
      }
    });
    return this.ready;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T>
  {
    const next = this.queue.then(action);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  idle(): Promise<void> { return this.queue; }

  stopTimers(): void
  {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.firstChange = undefined;
  }

  changed(): void
  {
    this.generation++;
    if (this.restoration.kind === 'running' || Date.now() < this.retryAfter || (this.initializationFailure && Date.now() < this.initializationFailure.retryAt)) return;
    if (this.status.kind !== 'error') this.status = { kind: 'pending' };
    this.firstChange ??= Date.now();
    this.scheduleCapture(Math.max(0, Math.min(2000, this.firstChange + 10_000 - Date.now())));
  }

  private scheduleCapture(delay: number): void
  {
    clearTimeout(this.timer);
    this.timer = setTimeout(() =>
    {
      this.stopTimers();
      void this.capture('automatic').catch(() => { /* startup errors surface in status and retry on the next event or alarm */ });
    }, delay);
  }

  async capture(source: Source): Promise<void>
  {
    await this.start(source === 'manual');
    if (this.restoration.kind !== 'idle') {
      if (source === 'manual') throw new BackupBusyError();
      if (this.restoration.kind === 'waiting') this.restoration.automaticPending = true;
      return;
    }
    if (source === 'automatic' && Date.now() < this.retryAfter) return;
    this.stopTimers();
    // fix capture admission before asynchronous work begins
    await this.enqueue(() => this.performCapture(source));
  }

  private async performCapture(source: Source): Promise<void>
  {
    const generation = this.generation;
    // discard scans that become stale while browser state changes
    let session: Session;
    try {
      session = await this.scan();
    } catch (error) {
      this.status = { kind: 'error', message: errorMessage(error) };
      this.changed();
      return;
    }
    try {
      if (generation !== this.generation) { this.changed(); return; }
      const result = await this.repository.capture(session, source, Date.now());
      this.retryAfter = 0;
      this.status = generation === this.generation
        ? { kind: result.kind === 'empty' ? 'empty' : 'current' } : { kind: 'pending' };
    } catch (error) {
      this.status = { kind: 'error', message: errorMessage(error) };
      this.retryAfter = Date.now() + 60_000;
      this.stopTimers();
    }
  }

  async overview(): Promise<Overview>
  {
    try { await this.start(); }
    catch { /* saved backups remain readable when recovery needs a write */ }
    const metadata = await this.repository.metadata();
    const newest = metadata.latestId ? await this.repository.get(metadata.latestId) : null;
    return { status: this.status, metadata, latest: newest ? summarize(newest) : null };
  }

  async restore(id: string): Promise<void>
  {
    await this.start(true);
    if (this.restoration.kind !== 'idle') throw new Error('A restoration is already in progress.');
    const reservation: RestorationState & { kind: 'waiting' } = { kind: 'waiting', automaticPending: false };
    this.restoration = reservation;
    return new Promise<void>((resolve, reject) =>
    {
      // queue validation and browser work after admitted captures
      void this.enqueue(async () =>
      {
        let snapshot: Snapshot;
        try {
          snapshot = await this.repository.get(id);
          if (!snapshot.windows.some(window => window.tabs.some(tab => restorableUrl(tab.url)))) throw new Error('This backup has no supported tabs to restore.');
        } catch (error) {
          this.restoration = { kind: 'idle' };
          // retain the debounce window for captures deferred during validation
          if (reservation.automaticPending) this.scheduleCapture(0);
          reject(error);
          return;
        }
        this.restoration = { kind: 'running' };
        this.stopTimers();
        this.status = { kind: 'restoring' };
        resolve();
        try {
          await restoreSession(snapshot, this.port, operation => this.repository.setOperation(operation));
        } catch (error) {
          try {
            await this.repository.recoverOperation();
          } catch { /* keep the running record for recovery on the next worker start */ }
          this.status = { kind: 'error', message: `Restoration interrupted: ${errorMessage(error)}` };
        } finally {
          this.restoration = { kind: 'idle' };
        }
        if (this.status.kind !== 'error') await this.performCapture('automatic');
      });
    });
  }
}
