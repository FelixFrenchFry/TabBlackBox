import { createRestorePort } from '../support/restore';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../../src/database';
import { Controller } from '../../src/controller';
import type { Session } from '../../src/model';

// capture after the settling delay instead of the product backup frequency
vi.mock('../../src/automatic', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/automatic')>();
  return { ...actual, DEFAULT_AUTOMATIC_SETTINGS: { ...actual.DEFAULT_AUTOMATIC_SETTINGS, enabled: true, intervalMinutes: 0 } };
});

const session: Session = { windows: [{ groups: [], tabs: [{ url: 'https://example.test', title: 'Example', pinned: false, group: null }] }] };
const port = createRestorePort();
afterEach(() => vi.useRealTimers());

describe('capture coordination', () =>
{
  it.each(['manual', 'automatic', 'overview'] as const)('retries failed startup recovery through %s', async retry =>
  {
    const repository = new Repository(crypto.randomUUID());
    const operation = { kind: 'running' as const, snapshotId: 'old', startedAt: 1, opened: 2, skipped: 0, failed: 0, groupErrors: 0, total: 4, errors: [] };
    await repository.setOperation(operation);
    const recover = vi.spyOn(repository, 'recoverOperation').mockRejectedValueOnce(new Error('Temporary database failure'));
    const scan = vi.fn(async () => session);
    const controller = new Controller(repository, scan, port);
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      await expect(controller.start()).rejects.toThrow('Temporary database failure');
      expect(controller.status).toEqual({ kind: 'error', message: 'Temporary database failure' });
      expect(scan).not.toHaveBeenCalled();
      expect((await repository.metadata()).operation).toEqual(operation);

      if (retry !== 'manual') await vi.advanceTimersByTimeAsync(60_000);
      if (retry === 'overview') await controller.overview();
      else await controller.capture(retry);

      expect(recover).toHaveBeenCalledTimes(2);
      expect((await repository.metadata()).operation).toMatchObject({ ...operation, kind: 'interrupted' });
      expect(await repository.list()).toHaveLength(retry === 'manual' ? 2 : 1);
      expect(controller.status.kind).toBe('current');
    } finally { controller.stopTimers(); await repository.close(); }
  });

  it('shares initialization between concurrent retries after a recovery failure', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    const recover = vi.spyOn(repository, 'recoverOperation').mockRejectedValueOnce(new Error('Temporary database failure'));
    const controller = new Controller(repository, async () => session, port);
    try {
      await expect(controller.start()).rejects.toThrow('Temporary database failure');
      const gate = Promise.withResolvers<void>();
      recover.mockImplementationOnce(() => gate.promise);
      const first = controller.start(true);
      const second = controller.start();
      const overview = controller.overview();
      expect(second).toBe(first);
      gate.resolve();
      await Promise.all([first, second, overview]);
      expect(recover).toHaveBeenCalledTimes(2);
      expect(await repository.list()).toHaveLength(1);
    } finally { controller.stopTimers(); await repository.close(); }
  });

  it('handles a failed timer retry and prevents restoration until recovery succeeds', async () =>
  {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const repository = new Repository(crypto.randomUUID());
    const recover = vi.spyOn(repository, 'recoverOperation').mockRejectedValue(new Error('Database unavailable'));
    const scan = vi.fn(async () => session);
    const createWindow = vi.fn(port.createWindow);
    const controller = new Controller(repository, scan, { ...port, createWindow });
    try {
      await expect(controller.restore('old')).rejects.toThrow('Database unavailable');
      controller.changed();
      await vi.advanceTimersByTimeAsync(2000);
      await controller.idle();
      expect(recover).toHaveBeenCalledTimes(1);
      expect(scan).not.toHaveBeenCalled();
      expect(createWindow).not.toHaveBeenCalled();
      expect(controller.status).toEqual({ kind: 'error', message: 'Database unavailable' });
      recover.mockRestore();
      await vi.advanceTimersByTimeAsync(58_000);
      await controller.capture('automatic');
      expect(controller.status.kind).toBe('current');
    } finally { controller.stopTimers(); await repository.close(); }
  });

  it('marks changes pending and captures after the settling delay', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    let current = session;
    const scan = vi.fn(async () => current);
    const controller = new Controller(repository, scan, port);
    try {
      await controller.start();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      current = { windows: [] };
      controller.changed();
      expect(controller.status.kind).toBe('pending');
      await vi.advanceTimersByTimeAsync(1999);
      expect(scan).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await controller.idle();
      expect(scan).toHaveBeenCalledTimes(2);
      expect(controller.status.kind).toBe('empty');
      expect(await repository.list()).toHaveLength(1);
    } finally { controller.stopTimers(); await repository.close(); }
  });

  it('discards a scan invalidated by an event rather than saving stale data', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    let onScan = () => {};
    const controller = new Controller(repository, async () => { onScan(); return session; }, port);
    try {
      await controller.start();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      onScan = () => controller.changed();
      await controller.capture('manual');
      expect(controller.status.kind).toBe('error');
      expect(await repository.list()).toHaveLength(1);
    } finally { controller.stopTimers(); await repository.close(); }
  });

  it('shows saving failures without deleting the last backup', async () =>
  {
    const repository = new Repository(crypto.randomUUID(), 1000);
    let current = session;
    const controller = new Controller(repository, async () => current, port);
    try {
      await controller.start();
      current = { windows: [{ groups: [], tabs: [{ url: 'https://large.test', title: 'x'.repeat(2000), pinned: false, group: null }] }] };
      vi.spyOn(repository, 'capture').mockRejectedValueOnce(new DOMException('Disk full', 'QuotaExceededError'));
      await controller.capture('manual');
      expect(controller.status.kind).toBe('error');
      expect(await repository.list()).toHaveLength(1);
    } finally { controller.stopTimers(); await repository.close(); }
  });

  it('recovers persisted running operations as interrupted on startup', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    await repository.setOperation({ kind: 'running', snapshotId: 'old', startedAt: 1, opened: 2, skipped: 0, failed: 0, groupErrors: 0, total: 4, errors: [] });
    const controller = new Controller(repository, async () => session, port);
    try {
      await controller.start();
      expect((await repository.metadata()).operation?.kind).toBe('interrupted');
    } finally { controller.stopTimers(); await repository.close(); }
  });

  it('attempts a scan within ten seconds even when changes keep arriving', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    const scan = vi.fn(async () => session);
    const controller = new Controller(repository, scan, port);
    try {
      await controller.start();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      for (let second = 0; second < 10; second++) {
        controller.changed();
        await vi.advanceTimersByTimeAsync(1000);
      }
      await controller.idle();
      expect(scan).toHaveBeenCalledTimes(2);
    } finally { controller.stopTimers(); await repository.close(); }
  });

  it('honors a queued manual capture ahead of restoration', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    const gate = Promise.withResolvers<Session>();
    const started = Promise.withResolvers<void>();
    const scan = vi.fn(async () => session);
    const controller = new Controller(repository, scan, port);
    try {
      await controller.start();
      const id = (await repository.metadata()).latestId;
      if (!id) throw new Error('Fixture backup missing');
      scan.mockImplementationOnce(() => { started.resolve(); return gate.promise; });
      const active = controller.capture('automatic');
      await started.promise;
      const manual = controller.capture('manual');
      const restore = controller.restore(id);
      gate.resolve(session);
      await Promise.all([active, manual, restore]);
      await controller.idle();
      expect((await repository.metadata()).operation?.kind).toBe('completed');
    } finally { gate.resolve(session); controller.stopTimers(); await repository.close(); }
  });

  it('rejects a second restore and pauses capture while the first is running', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    const pending = Promise.withResolvers<{ windowId: number; tabId: number }>();
    const started = Promise.withResolvers<void>();
    const scan = vi.fn(async () => session);
    const controller = new Controller(repository, scan, { ...port, createWindow: async () => { started.resolve(); return pending.promise; } });
    try {
      await controller.start();
      const id = (await repository.metadata()).latestId;
      if (!id) throw new Error('Fixture backup missing');
      await controller.restore(id);
      await started.promise;
      await expect(controller.restore(id)).rejects.toThrow('already in progress');
      controller.changed();
      await expect(controller.capture('manual')).rejects.toThrow('Restoration in progress');
      await controller.capture('automatic');
      expect(scan).toHaveBeenCalledTimes(1);
      pending.resolve({ windowId: 1, tabId: 2 });
      await controller.idle();
      expect(scan).toHaveBeenCalledTimes(2);
      expect((await repository.metadata()).operation?.kind).toBe('completed');
    } finally { pending.resolve({ windowId: 1, tabId: 2 }); await controller.idle(); controller.stopTimers(); await repository.close(); }
  });

  it('retries a failed scan after settling without waiting for the next alarm', async () =>
  {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const repository = new Repository(crypto.randomUUID());
    const scan = vi.fn(async () => session).mockRejectedValueOnce(new Error('Window disappeared'));
    const controller = new Controller(repository, scan, port);
    try {
      await controller.start();
      await vi.advanceTimersByTimeAsync(2000);
      await controller.idle();
      expect(scan).toHaveBeenCalledTimes(2);
      expect(controller.status.kind).toBe('current');
    } finally { controller.stopTimers(); await repository.close(); }
  });

  it('does not retry a full database on every tab event, but permits a manual retry', async () =>
  {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const repository = new Repository(crypto.randomUUID(), 1);
    const scan = vi.fn(async () => session);
    const controller = new Controller(repository, scan, port);
    try {
      await controller.start();
      controller.changed();
      await vi.advanceTimersByTimeAsync(5000);
      await controller.idle();
      expect(scan).toHaveBeenCalledTimes(1);
      await controller.capture('manual');
      expect(scan).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      await controller.capture('automatic');
      expect(scan).toHaveBeenCalledTimes(3);
    } finally { controller.stopTimers(); await repository.close(); }
  });
});

it('confirms cleanup without rescanning or replacing the newest stored session', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  let current = session;
  const scan = vi.fn(async () => current);
  const controller = new Controller(repository, scan, port);
  try {
    await controller.start();
    await repository.capture({ windows: [{ groups: [], tabs: [{ url: 'https://example.test/B', title: 'B', pinned: false, group: null }] }] }, 'automatic', Date.now() + 1);
    const before = await repository.metadata();
    current = { windows: [{ groups: [], tabs: [{ url: 'https://example.test/B', title: 'B', pinned: false, group: null }] }] };
    const limits = { retentionDays: 30, maxBackups: 1, maxStorageMB: 250 };
    expect(await controller.setStorageSettings(limits, 0)).toEqual({ kind: 'confirmation', removeCount: 1 });
    expect(await repository.metadata()).toEqual(before);
    current = { windows: [{ groups: [], tabs: [{ url: 'https://example.test/C', title: 'C', pinned: false, group: null }] }] };
    const capture = vi.spyOn(repository, 'capture');
    expect(await controller.setStorageSettings(limits, 1)).toEqual({ kind: 'saved' });
    expect(capture).not.toHaveBeenCalled();
    const metadata = await repository.metadata();
    expect(metadata.latestId).toBe(before.latestId);
    expect((await repository.get(metadata.latestId ?? '')).windows[0]?.tabs[0]?.title).toBe('B');
    expect(scan).toHaveBeenCalledTimes(1);
    expect(controller.status.kind).toBe('current');
  } finally { controller.stopTimers(); await repository.close(); }
});

it('applies storage settings without scanning changed browser tabs', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session);
  const controller = new Controller(repository, scan, port);
  try {
    await controller.start();
    const before = await repository.metadata();
    scan.mockRejectedValueOnce(new Error('Browser is unavailable'));
    controller.changed();
    const settings = { retentionDays: 30, maxBackups: 1, maxStorageMB: 250 };
    expect(await controller.setStorageSettings(settings, 0)).toEqual({ kind: 'saved' });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(await repository.metadata()).toEqual({ ...before, settings });
    expect(controller.status.kind).toBe('pending');
  } finally { controller.stopTimers(); await repository.close(); }
});

it('keeps browser changes during the atomic settings commit pending', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const controller = new Controller(repository, async () => session, port);
  try {
    await controller.start();
    const original = repository.setStorageSettings.bind(repository);
    vi.spyOn(repository, 'setStorageSettings').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      controller.changed();
      return result;
    });
    expect(await controller.setStorageSettings({ retentionDays: 30, maxBackups: 1, maxStorageMB: 250 }, 0)).toEqual({ kind: 'saved' });
    expect(controller.status.kind).toBe('pending');
  } finally { controller.stopTimers(); await repository.close(); }
});
it('rejects undersized proposed limits without changing backup status or the active policy', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const large = { windows: [{ groups: [], tabs: [{ url: 'https://example.test', title: 'x'.repeat(1_100_000), pinned: false, group: null }] }] };
  const statusChanged = vi.fn();
  const controller = new Controller(repository, async () => large, port, statusChanged);
  try {
    await controller.start();
    const before = await repository.metadata();
    statusChanged.mockClear();
    await expect(controller.setStorageSettings({ retentionDays: 30, maxBackups: 2000, maxStorageMB: 1 }, 0)).rejects.toThrow('proposed space limit');
    expect(controller.status.kind).toBe('current');
    expect(statusChanged).not.toHaveBeenCalled();
    expect(await repository.metadata()).toEqual(before);
    await controller.capture('automatic');
    expect(controller.status.kind).toBe('current');
  } finally { controller.stopTimers(); await repository.close(); }
});

it('does not clear an earlier capture error when storage settings are saved', async () =>
{
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session);
  const statusChanged = vi.fn();
  const controller = new Controller(repository, scan, port, statusChanged);
  try {
    await controller.start();
    scan.mockRejectedValueOnce(new Error('Browser scan failed'));
    await controller.capture('manual');
    const before = await repository.metadata();
    const settings = { retentionDays: 30, maxBackups: 2000, maxStorageMB: 250 };
    expect(await controller.setStorageSettings(settings, 0)).toEqual({ kind: 'saved' });
    expect(controller.status).toEqual({ kind: 'error', message: 'Browser scan failed' });
    expect(statusChanged).toHaveBeenLastCalledWith(controller.status);
    expect(await repository.metadata()).toEqual({ ...before, settings });
    await vi.advanceTimersByTimeAsync(2000);
    await controller.idle();
    expect(scan).toHaveBeenCalledTimes(3);
    expect(controller.status.kind).toBe('current');
  } finally { controller.stopTimers(); await repository.close(); }
});

it('reports settings write failures and backs off automatic retries while allowing a manual retry', async () =>
{
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session);
  const statusChanged = vi.fn();
  const controller = new Controller(repository, scan, port, statusChanged);
  try {
    await controller.start();
    const before = await repository.metadata();
    controller.changed();
    vi.spyOn(repository, 'setStorageSettings').mockRejectedValueOnce(new DOMException('Disk quota exceeded', 'QuotaExceededError'));
    await expect(controller.setStorageSettings({ retentionDays: 30, maxBackups: 2000, maxStorageMB: 250 }, 0)).rejects.toThrow('Disk quota exceeded');
    expect(controller.status).toEqual({ kind: 'error', message: 'Backup failed: storage full. New changes are not being backed up.' });
    expect(statusChanged).toHaveBeenLastCalledWith(controller.status);
    expect(await repository.metadata()).toEqual(before);
    controller.changed();
    await vi.advanceTimersByTimeAsync(5000);
    await controller.idle();
    await controller.capture('automatic');
    expect(scan).toHaveBeenCalledTimes(1);
    await controller.capture('manual');
    expect(scan).toHaveBeenCalledTimes(2);
    expect(controller.status.kind).toBe('current');
  } finally { controller.stopTimers(); await repository.close(); }
});
