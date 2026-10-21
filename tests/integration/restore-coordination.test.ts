import { createRestorePort } from '../support/restore';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { Controller } from '../../src/controller';
import { Repository } from '../../src/database';
import type { Session } from '../../src/model';

// capture after the settling delay instead of the product backup frequency
vi.mock('../../src/automatic', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/automatic')>();
  return { ...actual, DEFAULT_AUTOMATIC_SETTINGS: { ...actual.DEFAULT_AUTOMATIC_SETTINGS, enabled: true, intervalMinutes: 0 } };
});

const session = (url = 'https://example.test'): Session => ({ windows: [{ groups: [], tabs: [{ url, title: url, pinned: false, group: null }] }] });
const port = createRestorePort();
afterEach(() => vi.useRealTimers());

it('validates and restores only the selected window through the shared reservation', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const fileAccess = vi.fn(async () => false);
  const gate = Promise.withResolvers<void>();
  const createWindow = vi.fn(async () => { await gate.promise; return { windowId: 1, tabId: 1 }; });
  const savedSession = { windows: [...session('file:///C:/paper.pdf').windows, ...session('https://selected.test').windows] };
  const controller = new Controller(repository, async () => savedSession, { ...port, fileAccess, createWindow });
  try {
    await repository.setAutomaticSettings({ kind: 'enabled', value: false }, Date.now());
    const saved = await repository.capture(savedSession, 'manual', Date.now());
    if (saved.kind !== 'saved') throw new Error('Fixture missing');
    await expect(controller.restore(saved.id, 2)).rejects.toThrow('saved window');
    await controller.restore(saved.id, 1);
    await expect(controller.restore(saved.id)).rejects.toThrow('already in progress');
    gate.resolve();
    await controller.idle();
    expect(fileAccess).not.toHaveBeenCalled();
    expect(createWindow).toHaveBeenCalledExactlyOnceWith('https://selected.test');
    expect((await repository.metadata()).operation).toMatchObject({ total: 1, opened: 1, skipped: 0 });
    expect((await repository.get(saved.id)).windows).toHaveLength(2);
    await expect(controller.restore(saved.id, 0)).rejects.toThrow('Allow access to file URLs');
  } finally { gate.resolve(); await controller.idle(); controller.stopTimers(); await repository.close(); }
});

it('checks current file access before admitting a file-only restore', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const fileAccess = vi.fn(async () => false);
  const createWindow = vi.fn(port.createWindow);
  const local = session('file:///C:/Research/My%20paper.pdf#page=2');
  const controller = new Controller(repository, async () => local, { ...port, fileAccess, createWindow });
  try {
    await repository.setAutomaticSettings({ kind: 'enabled', value: false }, Date.now());
    const saved = await repository.capture(local, 'manual', Date.now());
    if (saved.kind !== 'saved') throw new Error('Fixture missing');
    await expect(controller.restore(saved.id)).rejects.toThrow('Allow access to file URLs');
    expect(createWindow).not.toHaveBeenCalled();
    expect((await repository.metadata()).operation).toBeNull();
    fileAccess.mockResolvedValue(true);
    await controller.restore(saved.id);
    await controller.idle();
    expect(createWindow).toHaveBeenCalledWith('file:///C:/Research/My%20paper.pdf#page=2');
    expect((await repository.metadata()).operation).toMatchObject({ kind: 'completed', opened: 1, skipped: 0, failed: 0 });
  } finally { controller.stopTimers(); await repository.close(); }
});

it('preserves request order when capture and restore arrive during startup', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const gate = Promise.withResolvers<void>();
  const order: string[] = [];
  const controller = new Controller(repository, async () => { order.push('capture'); return session(); }, {
    ...port, createWindow: async () => { order.push('restore'); return { windowId: 1, tabId: 1 }; },
  });
  try {
    const saved = await repository.capture(session(), 'manual', Date.now());
    if (saved.kind !== 'saved') throw new Error('Fixture missing');
    vi.spyOn(repository, 'recoverOperation').mockImplementationOnce(() => gate.promise);
    const manual = controller.capture('manual');
    const restoring = controller.restore(saved.id);
    const late = expect(controller.capture('manual')).rejects.toThrow('Restoration in progress');
    gate.resolve();
    await Promise.all([manual, restoring, late]);
    await controller.idle();
    expect(order).toEqual(['capture', 'capture', 'restore', 'capture']);
  } finally { gate.resolve(); await controller.idle(); controller.stopTimers(); await repository.close(); }
});

it.each([1, 2])('releases the reservation after restore journal write %i fails', async failingWrite =>
{
  const repository = new Repository(crypto.randomUUID());
  const createWindow = vi.fn(port.createWindow);
  const controller = new Controller(repository, async () => session(), { ...port, createWindow });
  try {
    await controller.start();
    const id = (await repository.metadata()).latestId;
    if (!id) throw new Error('Fixture missing');
    const persist = repository.setOperation.bind(repository);
    let writes = 0;
    vi.spyOn(repository, 'setOperation').mockImplementation(operation =>
    {
      if (++writes === failingWrite) return Promise.reject(new Error('Disk full'));
      return persist(operation);
    });
    await controller.restore(id);
    await controller.idle();
    expect(controller.status).toEqual({ kind: 'error', message: 'Restoration interrupted: Disk full' });
    expect(createWindow).toHaveBeenCalledTimes(failingWrite - 1);
    if (failingWrite === 2) expect((await repository.metadata()).operation?.kind).toBe('interrupted');
    await controller.capture('manual');
    expect(controller.status.kind).toBe('current');
    await controller.restore(id);
    await controller.idle();
    expect((await repository.metadata()).operation?.kind).toBe('completed');
  } finally { await controller.idle(); controller.stopTimers(); await repository.close(); }
});

it('records a failed browser restore and allows subsequent backup and restoration', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const createWindow = vi.fn(port.createWindow).mockRejectedValueOnce(new Error('Browser refused window'));
  const controller = new Controller(repository, async () => session(), { ...port, createWindow });
  try {
    await controller.start();
    const id = (await repository.metadata()).latestId;
    if (!id) throw new Error('Fixture missing');
    await controller.restore(id);
    await controller.idle();
    expect((await repository.metadata()).operation).toMatchObject({ kind: 'completed', failed: 1, opened: 0 });
    await controller.capture('manual');
    await controller.restore(id);
    await controller.idle();
    expect((await repository.metadata()).operation).toMatchObject({ kind: 'completed', failed: 0, opened: 1 });
  } finally { await controller.idle(); controller.stopTimers(); await repository.close(); }
});

it('finishes all captures ahead of the restore reservation and rejects later manual requests', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const gate = Promise.withResolvers<Session>();
  const scanning = Promise.withResolvers<void>();
  const order: string[] = [];
  const scan = vi.fn(async () => session());
  const controller = new Controller(repository, scan, { ...port, createWindow: async () => { order.push('restore'); return { windowId: 1, tabId: 1 }; } });
  try {
    await controller.start();
    const id = (await repository.metadata()).latestId;
    if (!id) throw new Error('Fixture missing');
    const capture = repository.capture.bind(repository);
    vi.spyOn(repository, 'capture').mockImplementation(async (value, source, now) =>
    {
      const result = await capture(value, source, now);
      order.push(source);
      return result;
    });
    scan.mockImplementationOnce(() => { scanning.resolve(); return gate.promise; });
    const active = controller.capture('automatic');
    await scanning.promise;
    const earlier = [controller.capture('manual'), controller.capture('manual')];
    const restore = controller.restore(id);
    const late = expect(controller.capture('manual')).rejects.toThrow('Restoration in progress');
    const second = expect(controller.restore(id)).rejects.toThrow('already in progress');
    gate.resolve(session('https://changed.test'));
    await Promise.all([active, ...earlier, restore, late, second]);
    await controller.idle();
    expect(order).toEqual(['automatic', 'manual', 'manual', 'restore', 'automatic']);
    expect((await repository.metadata()).operation?.kind).toBe('completed');
  } finally { gate.resolve(session()); await controller.idle(); controller.stopTimers(); await repository.close(); }
});

it.each(['missing', 'unsupported'])('preserves the pending automatic timer when %s restore validation fails', async invalid =>
{
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  let current = session();
  const scan = vi.fn(async () => current);
  const createWindow = vi.fn(port.createWindow);
  const controller = new Controller(repository, scan, { ...port, createWindow });
  try {
    await controller.start();
    let id = 'missing';
    if (invalid === 'unsupported') {
      const saved = await repository.capture(session('chrome://settings'), 'manual', Date.now());
      if (saved.kind !== 'saved') throw new Error('Fixture missing');
      id = saved.id;
    }
    current = session('https://pending.test');
    controller.changed();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(controller.restore(id)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(999);
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await controller.idle();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(createWindow).not.toHaveBeenCalled();
    const latest = (await repository.metadata()).latestId;
    if (!latest) throw new Error('Backup missing');
    expect((await repository.get(latest)).windows).toEqual(current.windows);
  } finally { controller.stopTimers(); await repository.close(); }
});

it('resumes automatic capture when its timer expires during failed validation', async () =>
{
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session());
  const controller = new Controller(repository, scan, port);
  const lookup = Promise.withResolvers<never>();
  const validating = Promise.withResolvers<void>();
  try {
    await controller.start();
    vi.spyOn(repository, 'get').mockImplementationOnce(() => { validating.resolve(); return lookup.promise; });
    controller.changed();
    const restore = expect(controller.restore('missing')).rejects.toThrow('Gone');
    await validating.promise;
    await vi.advanceTimersByTimeAsync(2000);
    expect(scan).toHaveBeenCalledTimes(1);
    lookup.reject(new Error('Gone'));
    await restore;
    await vi.advanceTimersByTimeAsync(1);
    await controller.idle();
    expect(scan).toHaveBeenCalledTimes(2);
  } finally { controller.stopTimers(); await repository.close(); }
});
