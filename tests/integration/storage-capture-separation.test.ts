import { createRestorePort } from '../support/restore';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { Controller } from '../../src/controller';
import { Repository } from '../../src/database';
import { StorageLimitExceededError } from '../../src/storage';

const session = (title: string) => ({ windows: [{ groups: [], tabs: [{ url: 'https://example.test', title, pinned: false, group: null }] }] });
const port = createRestorePort();
afterEach(() => vi.useRealTimers());

it.each(['fresh', 'failed-startup'] as const)('storage edits do not initiate or retry capture on a %s controller', async mode =>
{
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('Private unsaved page'));
  const controller = new Controller(repository, scan, port);
  try {
    await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
    if (mode === 'failed-startup') {
      vi.spyOn(repository, 'recoverOperation').mockRejectedValueOnce(new Error('Recovery failed'));
      await expect(controller.start()).rejects.toThrow('Recovery failed');
    }
    const before = await repository.metadata();
    const status = controller.status;
    const settings = { ...before.settings, maxStorageMB: 101 };
    expect(await controller.setStorageSettings(settings, 0)).toEqual({ kind: 'saved' });
    expect(scan).not.toHaveBeenCalled();
    expect(await repository.metadata()).toEqual({ ...before, settings });
    expect(controller.status).toEqual(status);
  } finally { controller.stopTimers(); await repository.close(); }
});

it.each(['manual-only', 'disabled', 'paused', 'interval'] as const)('changes storage settings without capturing or changing %s backup state', async mode =>
{
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('Original'));
  const controller = new Controller(repository, scan, port);
  try {
    await repository.setAutomaticSettings({ kind: 'enabled', value: mode !== 'manual-only' }, Date.now());
    await controller.start();
    if (mode === 'disabled') await controller.setAutomaticSettings({ kind: 'enabled', value: false });
    if (mode === 'paused') await controller.setAutomaticSettings({ kind: 'pause', minutes: 15 });
    if (mode === 'interval') {
      scan.mockImplementation(async () => session('Pending'));
      await controller.capture('automatic');
    }
    const before = await repository.metadata();
    const history = await repository.list();
    const status = controller.status;
    const settings = { ...before.settings, maxStorageMB: 101 };
    scan.mockClear();
    scan.mockImplementation(async () => session('Private unsaved page'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(await controller.setStorageSettings(settings, 0)).toEqual({ kind: 'saved' });
    expect(scan).not.toHaveBeenCalled();
    expect(await repository.metadata()).toEqual({ ...before, settings });
    expect(await repository.list()).toEqual(history);
    expect(controller.status).toEqual(status);

    if (mode === 'paused' || mode === 'interval') {
      // storage edits leave the existing capture deadline available without another browser event
      await vi.advanceTimersByTimeAsync(15 * 60_000 - 1001);
      await controller.idle();
      expect(scan).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await controller.idle();
      expect(scan).toHaveBeenCalledTimes(1);
      expect(await repository.list()).toHaveLength(history.length + 1);
    } else {
      await controller.capture('manual');
      expect(scan).toHaveBeenCalledTimes(1);
      expect((await repository.history(null, 10, 'saved')).items).toHaveLength(1);
    }
  } finally { controller.stopTimers(); await repository.close(); }
});

it('confirms cleanup of existing backups while automatic backups are disabled without advancing capture metadata', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('Unsaved current page'));
  const controller = new Controller(repository, scan, port);
  try {
    const oldest = await repository.capture(session('Old'), 'automatic', 1000);
    const latest = await repository.capture(session('Newest'), 'automatic', 2000);
    if (oldest.kind !== 'saved' || latest.kind !== 'saved') throw new Error('Missing fixture');
    await repository.capture(session('Manual'), 'manual', 3000);
    await repository.setAutomaticSettings({ kind: 'enabled', value: false }, Date.now());
    await controller.start();
    const before = await repository.metadata();
    const history = await repository.list();
    const settings = { ...before.settings, maxBackups: 1 };

    expect(await controller.setStorageSettings(settings, 0)).toEqual({ kind: 'confirmation', removeCount: 1 });
    expect(await repository.metadata()).toEqual(before);
    expect(await repository.list()).toEqual(history);
    expect(await controller.setStorageSettings(settings, 1)).toEqual({ kind: 'saved' });
    expect(scan).not.toHaveBeenCalled();
    expect((await repository.list()).map(item => item.id)).toEqual(history.filter(item => item.id !== oldest.id).map(item => item.id));
    expect((await repository.history(null, 10, 'automatic')).items).toMatchObject([{ id: latest.id }]);
    expect(await repository.metadata()).toMatchObject({
      settings, latestId: before.latestId, lastSavedAt: before.lastSavedAt, lastCheckedAt: before.lastCheckedAt,
      lastTabId: before.lastTabId, lastSessionNumbers: before.lastSessionNumbers, historyRevision: before.historyRevision + 1,
    });
    expect(controller.status.kind).toBe('disabled');
  } finally { controller.stopTimers(); await repository.close(); }
});

it('lifts the write backoff after a raised limit is saved without capturing', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('Current'));
  const controller = new Controller(repository, scan, port);
  try {
    await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
    vi.spyOn(repository, 'capture').mockRejectedValueOnce(new StorageLimitExceededError());
    await controller.start();
    expect(controller.status.kind).toBe('error');
    // automatic captures stay blocked during the write backoff
    await controller.capture('automatic');
    expect(scan).toHaveBeenCalledTimes(1);

    const settings = { ...(await repository.metadata()).settings, maxStorageMB: 101 };
    expect(await controller.setStorageSettings(settings, 0)).toEqual({ kind: 'saved' });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(controller.status.kind).toBe('error');

    // the next reconcile capture runs and clears the error
    await controller.capture('automatic');
    expect(scan).toHaveBeenCalledTimes(2);
    expect(controller.status.kind).toBe('current');
  } finally { controller.stopTimers(); await repository.close(); }
});

it('recovers a running record from a stopped worker before saving storage settings', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('Current'));
  const controller = new Controller(repository, scan, port);
  try {
    await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
    await repository.setOperation({ kind: 'running', snapshotId: 'old', startedAt: 1, opened: 1, skipped: 0, failed: 0, groupErrors: 0, total: 2, errors: [] });
    const status = controller.status;
    const settings = { ...(await repository.metadata()).settings, maxStorageMB: 101 };

    expect(await controller.setStorageSettings(settings, 0)).toEqual({ kind: 'saved' });
    expect(scan).not.toHaveBeenCalled();
    expect(controller.status).toEqual(status);
    expect(await repository.metadata()).toMatchObject({ settings, operation: { kind: 'interrupted', snapshotId: 'old' } });
  } finally { controller.stopTimers(); await repository.close(); }
});
