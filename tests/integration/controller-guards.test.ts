import { createRestorePort } from '../support/restore';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Controller, type CaptureSchedule } from '../../src/controller';
import { Repository } from '../../src/database';
import type { Session } from '../../src/model';
import type { RestorePort } from '../../src/restore';

// capture after the settling delay instead of the product backup frequency
vi.mock('../../src/automatic', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/automatic')>();
  return { ...actual, DEFAULT_AUTOMATIC_SETTINGS: { ...actual.DEFAULT_AUTOMATIC_SETTINGS, enabled: true, intervalMinutes: 0 } };
});

const tab = (url: string) => ({ url, title: url, pinned: false, group: null });
const session = (...windows: string[][]): Session => ({ windows: windows.map(urls => ({ groups: [], tabs: urls.map(tab) })) });
const busy = 'Restoration in progress. Try backing up again when it finishes.';

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
afterEach(() => { vi.useRealTimers(); });

// run a scenario against a fresh database and stop its timers afterwards
async function scenario(run: (context: {
  controller: Controller; repository: Repository; scan: ReturnType<typeof vi.fn<() => Promise<Session>>>;
  wake: ReturnType<typeof vi.fn<(schedule: CaptureSchedule | null) => void>>; show: (...windows: string[][]) => void;
}) => Promise<void>, port: RestorePort = createRestorePort())
{
  const repository = new Repository(crypto.randomUUID());
  let current = session(['https://example.test/a']);
  const scan = vi.fn(async () => current);
  const wake = vi.fn<(schedule: CaptureSchedule | null) => void>();
  const controller = new Controller(repository, scan, port, () => {}, wake);
  try {
    await run({ controller, repository, scan, wake, show: (...windows) => { current = session(...windows); } });
  } finally {
    controller.stopTimers();
    await controller.idle();
    await repository.close();
  }
}

// hold the first restored window open until the test releases it
function heldPort()
{
  let release = () => {};
  const opened = new Promise<void>(resolve => { release = resolve; });
  const createWindow = vi.fn(async () => { await opened; return { windowId: 1, tabId: 1 }; });
  return { port: { ...createRestorePort(), createWindow }, release: () => release() };
}

async function saved(result: Promise<{ kind: string; id?: string } | undefined>): Promise<string>
{
  const value = await result;
  if (value?.kind !== 'saved' || !value.id) throw new Error('Backup not saved');
  return value.id;
}

it('reports initializing until the first start', () => scenario(async ({ controller }) =>
{
  expect(controller.status).toEqual({ kind: 'initializing' });
}));

it('ignores tab changes and rejects storage edits while a restoration is running', async () =>
{
  const held = heldPort();
  await scenario(async ({ controller, wake }) =>
  {
    await controller.start();
    const id = (await controller.overview()).metadata.latestId;
    if (!id) throw new Error('Backup missing');
    await controller.restore(id);
    expect(controller.status).toEqual({ kind: 'restoring' });
    wake.mockClear();
    controller.changed();
    expect(controller.status).toEqual({ kind: 'restoring' });
    expect(wake).not.toHaveBeenCalled();
    await expect(controller.capture('manual')).rejects.toThrow(busy);
    await expect(controller.setStorageSettings({ retentionDays: null, maxBackups: null, maxStorageMB: 400 }, 0)).rejects.toThrow('Wait for restoration to finish before changing storage limits.');
    held.release();
    await controller.idle();
    expect(controller.status.kind).toBe('current');
  }, held.port);
});

it('holds automatic captures for exactly one minute after a failed write', () => scenario(async ({ controller, repository, scan, wake, show }) =>
{
  await controller.start();
  vi.spyOn(repository, 'capture').mockRejectedValueOnce(new Error('Disk full'));
  show(['https://example.test/b']);
  await controller.capture('manual');
  expect(controller.status).toEqual({ kind: 'error', message: 'Disk full' });
  wake.mockClear();
  scan.mockClear();
  controller.changed();
  await controller.capture('automatic');
  expect(wake).not.toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }));
  expect(scan).not.toHaveBeenCalled();
  // the backoff still holds one millisecond before the minute ends
  await vi.advanceTimersByTimeAsync(59_999);
  controller.changed();
  expect(wake).not.toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }));
  await vi.advanceTimersByTimeAsync(1);
  controller.changed();
  expect(wake).toHaveBeenLastCalledWith({ id: expect.any(String), when: Date.now() + 2000 });
  await controller.capture('automatic');
  expect(scan).toHaveBeenCalledOnce();
  expect(controller.status.kind).toBe('current');
}));

it('keeps a write backoff when a storage change still needs confirmation', () => scenario(async ({ controller, repository, scan, show }) =>
{
  await controller.start();
  show(['https://example.test/b']);
  await saved(controller.capture('automatic'));
  vi.spyOn(repository, 'capture').mockRejectedValueOnce(new Error('Disk full'));
  show(['https://example.test/c']);
  await controller.capture('manual');
  expect(await controller.setStorageSettings({ retentionDays: null, maxBackups: 1, maxStorageMB: 400 }, 0)).toEqual({ kind: 'confirmation', removeCount: 1 });
  scan.mockClear();
  await controller.capture('automatic');
  expect(scan).not.toHaveBeenCalled();
  expect(await controller.setStorageSettings({ retentionDays: null, maxBackups: 1, maxStorageMB: 400 }, 1)).toEqual({ kind: 'saved' });
  await controller.capture('automatic');
  expect(scan).toHaveBeenCalledOnce();
}));

it('ignores tab changes for one minute after startup recovery fails', () => scenario(async ({ controller, repository, wake }) =>
{
  vi.spyOn(repository, 'recoverOperation').mockRejectedValueOnce(new Error('Database unavailable'));
  await expect(controller.start()).rejects.toThrow('Database unavailable');
  controller.changed();
  await vi.advanceTimersByTimeAsync(59_999);
  controller.changed();
  expect(wake).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  controller.changed();
  expect(wake).toHaveBeenCalledWith({ id: expect.any(String), when: Date.now() + 2000 });
}));

it.each([
  ['settings', (controller: Controller) => controller.setAutomaticSettings({ kind: 'frequency', value: 5 })],
  ['deletion', async (controller: Controller, repository: Repository) => controller.deleteSession(await saved(repository.capture(session(['https://example.test/old']), 'manual', Date.now())))],
])('retries failed startup immediately for %s', (_name, act) => scenario(async ({ controller, repository }) =>
{
  vi.spyOn(repository, 'recoverOperation').mockRejectedValueOnce(new Error('Database unavailable'));
  await expect(controller.start()).rejects.toThrow('Database unavailable');
  await act(controller, repository);
  expect(controller.status.kind).not.toBe('error');
}));

it('stays disabled on tab changes without scheduling and keeps an earlier error', () => scenario(async ({ controller, scan, wake }) =>
{
  await controller.start();
  await controller.setAutomaticSettings({ kind: 'enabled', value: false });
  await controller.capture('manual');
  expect(controller.status.kind).toBe('current');
  expect(wake).toHaveBeenLastCalledWith(null);
  wake.mockClear();
  controller.changed();
  expect(controller.status).toEqual({ kind: 'disabled' });
  expect(wake).not.toHaveBeenCalled();
  scan.mockRejectedValueOnce(new Error('Scan failed'));
  await controller.capture('manual');
  controller.changed();
  expect(controller.status).toEqual({ kind: 'error', message: 'Scan failed' });
}));

it('keeps a deletion error visible while automatic backups are disabled', () => scenario(async ({ controller, scan, show }) =>
{
  await controller.start();
  await controller.setAutomaticSettings({ kind: 'enabled', value: false });
  show(['https://example.test/b']);
  const latest = await saved(controller.capture('manual'));
  scan.mockRejectedValueOnce(new Error('Scan failed'));
  await controller.capture('manual');
  // deleting the latest backup rechecks coverage without hiding the error
  await controller.deleteSession(latest);
  expect(controller.status).toEqual({ kind: 'error', message: 'Scan failed' });
}));

it('schedules paused changes for the pause end and resumes normal settling at that moment', () => scenario(async ({ controller, repository, scan, wake }) =>
{
  await controller.start();
  await controller.setAutomaticSettings({ kind: 'pause', minutes: 15 });
  expect(controller.status).toEqual({ kind: 'paused' });
  const until = (await repository.metadata()).automatic.pausedUntil;
  if (until === null) throw new Error('Pause missing');
  // a manual backup during the pause keeps the capture at the pause end
  await controller.capture('manual');
  expect(controller.status.kind).toBe('current');
  expect(wake).toHaveBeenLastCalledWith({ id: expect.any(String), when: until });
  controller.changed();
  expect(controller.status).toEqual({ kind: 'paused' });
  expect(wake).toHaveBeenLastCalledWith({ id: expect.any(String), when: until });
  scan.mockRejectedValueOnce(new Error('Scan failed'));
  await controller.capture('manual');
  controller.changed();
  expect(controller.status).toEqual({ kind: 'error', message: 'Scan failed' });
  await controller.capture('manual');
  controller.stopTimers();
  vi.setSystemTime(until);
  controller.changed();
  expect(controller.status).toEqual({ kind: 'pending' });
  expect(wake).toHaveBeenLastCalledWith({ id: expect.any(String), when: until + 2000 });
}));

it('keeps an error visible when pausing automatic backups', () => scenario(async ({ controller, scan }) =>
{
  await controller.start();
  scan.mockRejectedValueOnce(new Error('Scan failed'));
  await controller.setAutomaticSettings({ kind: 'enabled', value: false });
  await controller.capture('manual');
  await controller.setAutomaticSettings({ kind: 'enabled', value: true });
  await controller.setAutomaticSettings({ kind: 'pause', minutes: 60 });
  expect(controller.status).toEqual({ kind: 'error', message: 'Scan failed' });
}));

it('cancels a pending automatic capture when a manual backup saves first', () => scenario(async ({ controller, scan, wake, show }) =>
{
  await controller.start();
  show(['https://example.test/b']);
  controller.changed();
  await controller.capture('manual');
  expect(wake).toHaveBeenLastCalledWith(null);
  scan.mockClear();
  await vi.advanceTimersByTimeAsync(10_000);
  await controller.idle();
  expect(scan).not.toHaveBeenCalled();
}));

it('backs off when reading the automatic settings fails', () => scenario(async ({ controller, repository, scan, wake }) =>
{
  await controller.start();
  vi.spyOn(repository, 'metadata').mockRejectedValueOnce(new Error('Database unavailable'));
  scan.mockClear();
  await controller.capture('automatic');
  expect(controller.status).toEqual({ kind: 'error', message: 'Database unavailable' });
  expect(scan).not.toHaveBeenCalled();
  wake.mockClear();
  controller.changed();
  expect(wake).not.toHaveBeenCalled();
}));

it('reschedules an automatic capture whose tabs changed during the scan instead of retrying', () => scenario(async ({ controller, repository, scan, wake }) =>
{
  await controller.start();
  scan.mockClear();
  scan.mockImplementationOnce(async () => { controller.changed(); return session(['https://example.test/stale']); });
  wake.mockClear();
  await controller.capture('automatic');
  expect(scan).toHaveBeenCalledOnce();
  expect(await repository.list()).toHaveLength(1);
  expect(controller.status).toEqual({ kind: 'pending' });
  expect(wake).toHaveBeenLastCalledWith({ id: expect.any(String), when: expect.any(Number) });
}));

it('settles and retries automatically after manual retries keep seeing changes', () => scenario(async ({ controller, scan, wake, show }) =>
{
  await controller.start();
  scan.mockImplementation(async () => { controller.changed(); return session(['https://example.test/stale']); });
  await controller.capture('manual');
  expect(controller.status).toEqual({ kind: 'error', message: 'Tabs kept changing during the backup. No backup was saved. Try Back up now again.' });
  expect(wake).toHaveBeenLastCalledWith({ id: expect.any(String), when: expect.any(Number) });
  scan.mockImplementation(async () => session(['https://example.test/b']));
  show(['https://example.test/b']);
  await vi.advanceTimersByTimeAsync(10_000);
  await controller.idle();
  expect(controller.status.kind).toBe('current');
}));

it('reports changes during the database write as still pending', () => scenario(async ({ controller, repository, show }) =>
{
  await controller.start();
  const write = repository.capture.bind(repository);
  vi.spyOn(repository, 'capture').mockImplementationOnce(async (...arguments_) => { controller.changed(); return write(...arguments_); });
  show(['https://example.test/b']);
  await saved(controller.capture('manual'));
  expect(controller.status).toEqual({ kind: 'pending' });
}));

it('keeps a current or error status and marks a restart pending until the frequency is due', () => scenario(async ({ controller, repository, scan }) =>
{
  await controller.start();
  expect(controller.status.kind).toBe('current');
  await controller.setAutomaticSettings({ kind: 'frequency', value: 15 });
  expect(controller.status.kind).toBe('current');
  scan.mockRejectedValueOnce(new Error('Scan failed'));
  await controller.capture('manual');
  await controller.setAutomaticSettings({ kind: 'frequency', value: 60 });
  expect(controller.status).toEqual({ kind: 'error', message: 'Scan failed' });
  const restarted = new Controller(repository, scan, createRestorePort());
  try {
    await restarted.start();
    expect(restarted.status).toEqual({ kind: 'pending' });
  } finally { restarted.stopTimers(); }
}));

it('reports only automatic backups in the automatic storage summary', () => scenario(async ({ controller, show }) =>
{
  await controller.start();
  const automatic = (await controller.overview()).metadata.latestId;
  show(['https://example.test/b']);
  const manual = await saved(controller.capture('manual'));
  const { automaticStorage, metadata } = await controller.overview();
  expect(metadata.latestId).toBe(manual);
  expect(automaticStorage).toMatchObject({ count: 1, newestId: automatic });
}));

it('checks file access when any window has a local file and restores supported tabs among unsupported ones', async () =>
{
  const port = { ...createRestorePort(), fileAccess: vi.fn(async () => true), createWindow: vi.fn(async (_url: string) => ({ windowId: 1, tabId: 1 })), createTab: vi.fn(async () => 2) };
  await scenario(async ({ repository, controller }) =>
  {
    await controller.start();
    const mixed = await saved(repository.capture(session(['chrome://settings', 'https://example.test/a'], ['file:///C:/notes.txt', 'https://example.test/b'], ['chrome://newtab']), 'manual', Date.now()));
    await controller.restore(mixed);
    await controller.idle();
    expect(port.fileAccess).toHaveBeenCalled();
    expect(port.createWindow.mock.calls.map(([url]) => url)).toEqual(['https://example.test/a', 'file:///C:/notes.txt']);
    port.createWindow.mockClear();
    const partly = await saved(repository.capture(session(['chrome://settings', 'https://example.test/c']), 'manual', Date.now()));
    await controller.restore(partly);
    await controller.idle();
    expect(port.createWindow).toHaveBeenCalledExactlyOnceWith('https://example.test/c');
    const unsupported = await saved(repository.capture(session(['chrome://settings']), 'manual', Date.now()));
    await expect(controller.restore(unsupported)).rejects.toThrow('This backup has no supported tabs to restore.');
  }, port);
});
