import { createRestorePort } from '../support/restore';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { Controller, type CaptureSchedule } from '../../src/controller';
import { Repository } from '../../src/database';

// capture after the settling delay instead of the product backup frequency
vi.mock('../../src/automatic', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/automatic')>();
  return { ...actual, DEFAULT_AUTOMATIC_SETTINGS: { ...actual.DEFAULT_AUTOMATIC_SETTINGS, enabled: true, intervalMinutes: 0 } };
});

const session = (title: string) => ({ windows: [{ groups: [], tabs: [{ title, url: 'https://example.test', pinned: false, group: null }] }] });
const port = createRestorePort();
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['timer', 'alarm'] as const)('claims a deadline once when the %s fires first', async first => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('A'));
  const wake = vi.fn<(schedule: CaptureSchedule | null) => void>();
  const controller = new Controller(repository, scan, port, () => {}, wake);
  try {
    await controller.start();
    const writes = vi.spyOn(repository, 'capture');
    scan.mockClear();
    scan.mockImplementation(async () => session('B'));
    controller.changed();
    const scheduled = wake.mock.lastCall?.[0];
    if (!scheduled) throw new Error('Missing schedule');
    if (first === 'timer') vi.advanceTimersByTime(2000);
    const alarm = controller.captureScheduled(scheduled.id);
    await Promise.all([alarm, controller.captureScheduled(scheduled.id)]);
    await vi.advanceTimersByTimeAsync(2000);
    await controller.idle();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledTimes(1);
    scan.mockImplementation(async () => session('C'));
    await controller.captureScheduled(scheduled.id);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(await repository.list()).toHaveLength(2);
  } finally { controller.stopTimers(); await repository.close(); }
});

it('ignores replaced and cancelled deadlines without cancelling their replacement', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('A'));
  const wake = vi.fn<(schedule: CaptureSchedule | null) => void>();
  const controller = new Controller(repository, scan, port, () => {}, wake);
  try {
    await controller.start();
    scan.mockClear();
    controller.changed();
    const old = wake.mock.lastCall?.[0];
    controller.changed();
    const replacement = wake.mock.lastCall?.[0];
    if (!old || !replacement) throw new Error('Missing schedule');
    expect(old.when).toBe(replacement.when);
    expect(old.id).not.toBe(replacement.id);
    await controller.captureScheduled(old.id);
    expect(scan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await controller.idle();
    expect(scan).toHaveBeenCalledTimes(1);
    controller.changed();
    const cancelled = wake.mock.lastCall?.[0];
    if (!cancelled) throw new Error('Missing schedule');
    controller.stopTimers();
    await controller.captureScheduled(cancelled.id);
    expect(scan).toHaveBeenCalledTimes(1);
  } finally { controller.stopTimers(); await repository.close(); }
});

it('rebuilds a suspended frequency deadline on restart without accepting its old alarm', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('A'));
  const wake = vi.fn<(schedule: CaptureSchedule | null) => void>();
  let controller = new Controller(repository, scan, port, () => {}, wake);
  try {
    await controller.start();
    await controller.setAutomaticSettings({ kind: 'frequency', value: 1 });
    const old = wake.mock.lastCall?.[0];
    if (!old) throw new Error('Missing schedule');
    scan.mockImplementation(async () => session('B'));
    controller.stopTimers();
    controller = new Controller(repository, scan, port, () => {}, wake);
    await controller.start();
    const rebuilt = wake.mock.lastCall?.[0];
    if (!rebuilt) throw new Error('Missing schedule');
    expect(rebuilt.id).not.toBe(old.id);
    expect(rebuilt.when).toBe(old.when);
    scan.mockClear();
    await controller.captureScheduled(old.id);
    expect(scan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await controller.idle();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(await repository.list()).toHaveLength(2);
  } finally { controller.stopTimers(); await repository.close(); }
});

it.each([
  { wake: 'a scheduled deadline', changeBeforeDeadline: null },
  { wake: 'a pending tab change', changeBeforeDeadline: 60_000 },
  { wake: 'a tab change inside the settling window', changeBeforeDeadline: 1000 },
])('keeps the frequency deadline after a manual backup with $wake', async ({ changeBeforeDeadline }) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('A'));
  const controller = new Controller(repository, scan, port);
  try {
    await controller.start();
    await controller.setAutomaticSettings({ kind: 'frequency', value: 60 });
    const { lastSavedAt } = await repository.metadata();
    const remaining = changeBeforeDeadline ?? 60_000;
    // a manual backup just before the deadline does not postpone the next automatic backup
    await vi.advanceTimersByTimeAsync(60 * 60_000 - remaining);
    scan.mockImplementation(async () => session('B'));
    if (changeBeforeDeadline !== null) controller.changed();
    await controller.capture('manual');
    expect((await repository.metadata()).lastSavedAt).toBe(lastSavedAt);
    // advance to the original deadline without a periodic reconcile alarm
    await vi.advanceTimersByTimeAsync(remaining);
    await controller.idle();
    const { items: [newest], count } = await repository.history(null, 10, 'automatic');
    if (!newest) throw new Error('Missing automatic backup');
    expect(count).toBe(2);
    expect(newest.capturedAt).toBe(Date.now());
    expect(await repository.get(newest.id)).toMatchObject({ source: 'automatic', windows: [{ tabs: [{ title: 'B' }] }] });
  } finally { controller.stopTimers(); await repository.close(); }
});

it('backs off an automatic deadline queued during a failed manual write', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('A'));
  const controller = new Controller(repository, scan, port);
  const writing = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  try {
    await controller.start();
    await controller.setAutomaticSettings({ kind: 'frequency', value: 1 });
    scan.mockClear();
    scan.mockImplementation(async () => session('B'));
    vi.spyOn(repository, 'capture').mockImplementationOnce(async () => {
      writing.resolve();
      await finishWrite.promise;
      throw new Error('Disk full');
    });
    const manual = controller.capture('manual');
    await writing.promise;
    const manualQueue = controller.idle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.idle()).not.toBe(manualQueue);
    finishWrite.resolve();
    await manual;
    await controller.idle();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(controller.status).toEqual({ kind: 'error', message: 'Disk full' });
    expect(await repository.list()).toHaveLength(1);
  } finally {
    finishWrite.resolve();
    controller.stopTimers();
    await controller.idle();
    await repository.close();
  }
});
