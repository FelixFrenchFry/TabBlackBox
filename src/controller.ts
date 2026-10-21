import { DEFAULT_AUTOMATIC_SETTINGS } from './automatic';
import { StorageLimitExceededError } from './storage';
import type { Repository } from './database';
import { errorMessage, type AutomaticSettings, type AutomaticUpdate, type CaptureResult, type Overview, type Session, type Snapshot, type Source, type Status, type StorageSettings, type StorageSettingsResult } from './model';
import { restoreSession, type RestorePort } from './restore';
import { FILE_ACCESS_MESSAGE, fileUrl, restorableUrl, selectWindows } from './session';

export class BackupBusyError extends Error {
  constructor() { super('Restoration in progress. Try backing up again when it finishes.'); }
}

type RestorationState =
  | { kind: 'idle' }
  | { kind: 'waiting'; automaticPending: boolean }
  | { kind: 'running' };

export type CaptureSchedule = { readonly id: string; readonly when: number };

export class Controller {
  private currentStatus: Status = { kind: 'initializing' };
  private generation = 0;
  private automatic: AutomaticSettings = { ...DEFAULT_AUTOMATIC_SETTINGS };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scheduledCapture: CaptureSchedule | undefined;
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
    private readonly scheduleWake: (schedule: CaptureSchedule | null) => void = () => {},
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
    this.scheduledCapture = undefined;
    this.scheduleWake(null);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.firstChange = undefined;
  }

  changed(): void
  {
    this.generation++;
    if (this.restoration.kind === 'running' || Date.now() < this.retryAfter || (this.initializationFailure && Date.now() < this.initializationFailure.retryAt)) return;
    if (!this.automatic.enabled) { if (this.status.kind !== 'error') this.status = { kind: 'disabled' }; return; }
    if (this.automatic.pausedUntil !== null && this.automatic.pausedUntil > Date.now()) {
      if (this.status.kind !== 'error') this.status = { kind: 'paused' };
      this.scheduleCapture(this.automatic.pausedUntil - Date.now());
      return;
    }
    if (this.status.kind !== 'error') this.status = { kind: 'pending' };
    this.firstChange ??= Date.now();
    this.scheduleCapture(Math.max(0, Math.min(2000, this.firstChange + 10_000 - Date.now())));
  }

  private scheduleCapture(delay: number): void
  {
    const schedule: CaptureSchedule = { id: crypto.randomUUID(), when: Date.now() + delay };
    this.scheduledCapture = schedule;
    this.scheduleWake(schedule);
    clearTimeout(this.timer);
    this.timer = setTimeout(() =>
    {
      void this.captureScheduled(schedule.id).catch(() => { /* startup errors surface in status and retry on the next event or alarm */ });
    }, delay);
  }

  async captureScheduled(id: string): Promise<void>
  {
    // consume the schedule before yielding so timer and alarm callbacks share one claim
    if (this.scheduledCapture?.id !== id) return;
    this.stopTimers();
    await this.capture('automatic');
  }

  async capture(source: Source, name?: string | null): Promise<CaptureResult | undefined>
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
    return this.enqueue(() => this.performCapture(source, name));
  }

  private captureFailed(error: unknown, phase: 'scan' | 'write'): void
  {
    this.status = { kind: 'error', message: errorMessage(error) };
    // retry scans after changes settle and back off failed database writes
    if (phase === 'scan') this.changed();
    else {
      this.retryAfter = Date.now() + 60_000;
      this.stopTimers();
    }
  }

  private async performCapture(source: Source, name?: string | null): Promise<CaptureResult | undefined>
  {
    if (source === 'automatic') {
      try { if (!await this.automaticReady()) return; }
      catch (error) { this.captureFailed(error, 'write'); return; }
    }
    let generation: number;
    let session: Session;
    // keep manual retries inside the admitted request and ahead of queued restoration
    for (let attempt = 1; ; attempt++) {
      generation = this.generation;
      try {
        session = await this.scan();
      } catch (error) {
        this.captureFailed(error, 'scan');
        return;
      }
      if (generation === this.generation) break;
      if (source === 'automatic') { this.changed(); return; }
      if (attempt === 3) {
        this.captureFailed(new Error('Tabs kept changing during the backup. No backup was saved. Try Back up now again.'), 'scan');
        return;
      }
    }
    try {
      const result = await this.repository.capture(session, source, Date.now(), name);
      if (source === 'manual' && this.automatic.enabled && this.automatic.pausedUntil !== null && this.automatic.pausedUntil > Date.now()) this.scheduleCapture(this.automatic.pausedUntil - Date.now());
      this.retryAfter = 0;
      this.status = generation === this.generation
        ? { kind: result.kind === 'empty' ? 'empty' : 'current' } : { kind: 'pending' };
      return result;
    } catch (error) {
      this.captureFailed(error, 'write');
    }
  }

  private async automaticReady(): Promise<boolean>
  {
    const metadata = await this.repository.metadata();
    this.automatic = metadata.automatic;
    if (!this.automatic.enabled) {
      this.stopTimers();
      if (this.status.kind !== 'error') this.status = { kind: 'disabled' };
      return false;
    }
    const now = Date.now();
    if (this.automatic.pausedUntil !== null && this.automatic.pausedUntil > now) {
      if (this.status.kind !== 'error') this.status = { kind: 'paused' };
      this.scheduleCapture(this.automatic.pausedUntil - now);
      return false;
    }
    const due = (metadata.lastSavedAt ?? 0) + this.automatic.intervalMinutes * 60_000;
    if (metadata.lastSavedAt !== null && due > now) {
      if (this.status.kind !== 'error' && this.status.kind !== 'current') this.status = { kind: 'pending' };
      this.scheduleCapture(due - now);
      return false;
    }
    return true;
  }

  async setAutomaticSettings(update: AutomaticUpdate): Promise<void>
  {
    await this.start(true);
    await this.enqueue(async () => {
      await this.repository.setAutomaticSettings(update, Date.now());
      this.automatic = (await this.repository.metadata()).automatic;
      this.stopTimers();
      if (this.restoration.kind === 'idle') {
        if (await this.automaticReady()) this.changed();
      }
    });
  }

  async overview(): Promise<Overview>
  {
    try { await this.start(); }
    catch { /* saved backups remain readable when recovery needs a write */ }
    const metadata = await this.repository.metadata();
    const latest = metadata.latestId ? await this.repository.summary(metadata.latestId) : null;
    // report the newest automatic backup so pages can hide its protected deletion
    const { items: [newest], bytes, count } = await this.repository.history(null, 1, 'automatic');
    return { status: this.status, metadata, latest, automaticStorage: { bytes, count, newestId: newest?.id ?? null }, oldestCapturedAt: await this.repository.oldestCapturedAt() };
  }

  async setStorageSettings(settings: StorageSettings, confirmedRemovalCount: number): Promise<StorageSettingsResult>
  {
    if (this.restoration.kind !== 'idle') throw new Error('Wait for restoration to finish before changing storage limits.');
    return this.enqueue(async () => {
      // successful settings cleanup starts no capture and keeps the capture status and schedule
      let result: StorageSettingsResult;
      try {
        // mark a running record from a stopped worker as interrupted, queued actions never overlap a restoration
        await this.repository.recoverOperation();
        result = await this.repository.setStorageSettings(settings, confirmedRemovalCount, Date.now());
      } catch (error) {
        // rejecting proposed limits leaves the active backup policy and status intact
        if (error instanceof StorageLimitExceededError) {
          throw new Error('The proposed space limit cannot fit the newest automatic backup. Increase the space limit. Your settings have not changed.');
        }
        // failed database writes report an error and back off automatic captures like failed backups
        this.captureFailed(error, 'write');
        throw error;
      }
      // a successful write lifts the write backoff so the next reconcile alarm or browser event retries capture
      if (result.kind === 'saved') this.retryAfter = 0;
      return result;
    });
  }

  async deleteSession(id: string): Promise<void>
  {
    await this.start(true);
    if (this.restoration.kind !== 'idle') throw new Error('Wait for restoration to finish before deleting backups.');
    await this.enqueue(async () => {
      if (!await this.repository.deleteSession(id)) return;
      // recheck coverage after deleting the latest backup while honoring automatic settings
      this.stopTimers();
      if (this.status.kind !== 'error') this.status = { kind: 'pending' };
      await this.performCapture('automatic');
    });
  }

  async restore(id: string, windowIndex?: number): Promise<void>
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
        let fileAccess = false;
        let lightweightAbove: number | null = null;
        try {
          snapshot = await this.repository.get(id);
          // apply the restore settings in effect when this restoration starts
          const { restore } = await this.repository.metadata();
          if (restore.unloadBackgroundTabs) lightweightAbove = restore.unloadThreshold;
          const windows = selectWindows(snapshot, windowIndex);
          const hasFiles = windows.some(window => window.tabs.some(tab => fileUrl(tab.url)));
          // check permission before opening browser windows for local files
          if (hasFiles) fileAccess = await this.port.fileAccess();
          if (!windows.some(window => window.tabs.some(tab => restorableUrl(tab.url, fileAccess)))) throw new Error(hasFiles ? FILE_ACCESS_MESSAGE : 'This backup has no supported tabs to restore.');
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
          await restoreSession(snapshot, this.port, operation => this.repository.setOperation(operation), fileAccess, windowIndex, lightweightAbove);
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
