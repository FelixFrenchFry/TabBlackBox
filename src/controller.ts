import type { Repository } from './database';
import { errorMessage, type Overview, type Session, type Source, type Status } from './model';
import { restoreSession, type RestorePort } from './restore';
import { restorableUrl, summarize } from './session';

export class Controller {
  status: Status = { kind: 'initializing' };
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstChange: number | undefined;
  private queue: Promise<void> = Promise.resolve();
  private restoring = false;
  private ready: Promise<void> | undefined;
  private retryAfter = 0;

  constructor(readonly repository: Repository, private readonly scan: () => Promise<Session>, private readonly port: RestorePort) {}

  start(): Promise<void> {
    this.ready ??= this.enqueue(async () => {
      try {
        await this.repository.recoverOperation();
        await this.performCapture('automatic');
      } catch (error) { this.status = { kind: 'error', message: errorMessage(error) }; }
    });
    return this.ready;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  idle(): Promise<void> { return this.queue; }

  stopTimers(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.firstChange = undefined;
  }

  changed(): void {
    this.generation++;
    if (this.restoring || Date.now() < this.retryAfter) return;
    if (this.status.kind !== 'error') this.status = { kind: 'pending' };
    this.firstChange ??= Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.stopTimers();
      void this.capture('automatic');
    }, Math.max(0, Math.min(2000, this.firstChange + 10_000 - Date.now())));
  }

  async capture(source: Source): Promise<void> {
    await this.start();
    if (this.restoring || (source === 'automatic' && Date.now() < this.retryAfter)) return;
    this.stopTimers();
    await this.enqueue(async () => { if (!this.restoring) await this.performCapture(source); });
  }

  private async performCapture(source: Source): Promise<void> {
    const generation = this.generation;
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
      this.status = this.restoring ? { kind: 'restoring' } : generation === this.generation
        ? { kind: result.kind === 'empty' ? 'empty' : 'current' } : { kind: 'pending' };
    } catch (error) {
      this.status = { kind: 'error', message: errorMessage(error) };
      this.retryAfter = Date.now() + 60_000;
      this.stopTimers();
    }
  }

  async overview(): Promise<Overview> {
    await this.start();
    const metadata = await this.repository.metadata();
    const newest = metadata.latestId ? await this.repository.get(metadata.latestId) : null;
    return { status: this.status, metadata, latest: newest ? summarize(newest) : null };
  }

  async restore(id: string): Promise<void> {
    await this.start();
    if (this.restoring) throw new Error('A restoration is already in progress.');
    this.restoring = true;
    this.stopTimers();
    try {
      // Wait for prior capture writes, then reserve the source before creating tabs.
      const snapshot = await this.enqueue(async () => {
        const snapshot = await this.repository.get(id);
        if (!snapshot.windows.some(window => window.tabs.some(tab => restorableUrl(tab.url)))) throw new Error('This backup has no supported tabs to restore.');
        this.status = { kind: 'restoring' };
        return snapshot;
      });
      void this.enqueue(async () => {
        try {
          await restoreSession(snapshot, this.port, operation => this.repository.setOperation(operation));
        } catch (error) {
          try {
            await this.repository.recoverOperation();
          } catch { /* Keep the running record for recovery on the next worker start. */ }
          this.status = { kind: 'error', message: `Restoration interrupted: ${errorMessage(error)}` };
        } finally {
          this.restoring = false;
        }
        if (this.status.kind !== 'error') await this.performCapture('automatic');
      });
    } catch (error) {
      this.restoring = false;
      throw error;
    }
  }
}
