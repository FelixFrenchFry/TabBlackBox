import { createRestorePort } from '../support/restore';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { Controller } from '../../src/controller';
import { Repository } from '../../src/database';
import type { Session } from '../../src/model';

const session: Session = { windows: [{ groups: [], tabs: [{ url: 'https://example.test', title: 'Example', pinned: false, group: null }] }] };
const port = createRestorePort();
afterEach(() => vi.useRealTimers());

it('notifies status observers after a startup retry succeeds', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
  const recover = vi.spyOn(repository, 'recoverOperation').mockRejectedValueOnce(new Error('Temporary database failure'));
  const observed: string[] = [];
  const controller = new Controller(repository, async () => session, port, status => observed.push(status.kind));
  try {
    await expect(controller.start()).rejects.toThrow('Temporary database failure');
    expect(observed).toEqual(['error']);
    await controller.start(true);
    expect(observed).toEqual(['error', 'current']);
    expect(recover).toHaveBeenCalledTimes(2);
  } finally {
    controller.stopTimers();
    await repository.close();
  }
});

it('keeps saved backups readable and backs off when recovery writes keep failing', async () =>
{
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
  const saved = await repository.capture(session, 'automatic', Date.now());
  if (saved.kind !== 'saved') throw new Error('Fixture backup missing');
  await repository.setOperation({ kind: 'running', snapshotId: saved.id, startedAt: 1, opened: 1, skipped: 0, failed: 0, groupErrors: 0, total: 2, errors: [] });
  const writes = vi.spyOn(repository, 'setOperation').mockRejectedValue(new Error('Disk full'));
  const recover = vi.spyOn(repository, 'recoverOperation');
  const scan = vi.fn(async () => session);
  const createWindow = vi.fn(port.createWindow);
  const controller = new Controller(repository, scan, { ...port, createWindow });
  try {
    await expect(controller.start()).rejects.toThrow('Disk full');
    for (let poll = 0; poll < 3; poll++) {
      await vi.advanceTimersByTimeAsync(1500);
      const overview = await controller.overview();
      expect(overview.status).toEqual({ kind: 'error', message: 'Disk full' });
      expect(overview.latest?.id).toBe(saved.id);
      expect(await repository.list()).toHaveLength(1);
      expect((await repository.get(saved.id)).windows).toEqual(session.windows);
    }
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await controller.overview();
    expect(recover).toHaveBeenCalledTimes(2);
    await expect(controller.capture('manual')).rejects.toThrow('Disk full');
    await expect(controller.restore(saved.id)).rejects.toThrow('Disk full');
    expect(recover).toHaveBeenCalledTimes(4);
    expect(scan).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
    writes.mockRestore();
    await controller.capture('manual');
    expect(controller.status.kind).toBe('current');
    expect((await repository.metadata()).operation?.kind).toBe('interrupted');
  } finally { controller.stopTimers(); await repository.close(); }
});

it('notifies observers for pending and externally assigned errors', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
  const observed: string[] = [];
  const controller = new Controller(repository, async () => session, port, status => observed.push(status.kind));
  try {
    await controller.start();
    controller.changed();
    controller.status = { kind: 'error', message: 'Alarm initialization failed' };
    expect(observed).toEqual(['current', 'pending', 'error']);
  } finally { controller.stopTimers(); await repository.close(); }
});

it('notifies only for changed status kinds or error messages', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
  const observed = vi.fn();
  const controller = new Controller(repository, async () => session, port, observed);
  try {
    await controller.start();
    observed.mockClear();
    for (let i = 0; i < 20; i++) controller.changed();
    expect(observed).toHaveBeenCalledExactlyOnceWith({ kind: 'pending' });
    controller.status = { kind: 'error', message: 'Disk full' };
    controller.status = { kind: 'error', message: 'Disk full' };
    controller.status = { kind: 'error', message: 'Database unavailable' };
    controller.status = { kind: 'current' };
    controller.status = { kind: 'current' };
    expect(observed.mock.calls).toEqual([[{ kind: 'pending' }], [{ kind: 'error', message: 'Disk full' }], [{ kind: 'error', message: 'Database unavailable' }], [{ kind: 'current' }]]);
  } finally { controller.stopTimers(); await repository.close(); }
});
