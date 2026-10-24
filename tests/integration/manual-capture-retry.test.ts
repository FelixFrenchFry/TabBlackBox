import { createRestorePort } from '../support/restore';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { Controller } from '../../src/controller';
import { Repository } from '../../src/database';
import type { AutomaticUpdate } from '../../src/model';
import { BrowserChangedError } from '../../src/session';

const session = (title: string) => ({ windows: [{ groups: [], tabs: [{ title, url: 'https://example.test', pinned: false, group: null }] }] });
const port = createRestorePort();
afterEach(() => vi.restoreAllMocks());

const policies: AutomaticUpdate[] = [
  { kind: 'enabled', value: false },
  { kind: 'pause', minutes: 60 },
  { kind: 'frequency', value: 1440 },
];

it.each(policies)('retries a stale manual scan independently of $kind settings', async policy => {
  const repository = new Repository(crypto.randomUUID());
  await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
  const scan = vi.fn(async () => session('A'));
  const controller = new Controller(repository, scan, port);
  try {
    await controller.start();
    await controller.setAutomaticSettings(policy);
    const automatic = (await repository.metadata()).automatic;
    scan.mockClear();
    scan.mockImplementationOnce(async () => { controller.changed(); return session('stale'); });
    scan.mockImplementation(async () => session('B'));
    await controller.capture('manual');
    const history = await repository.list();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(history).toHaveLength(2);
    const latestId = (await repository.metadata()).latestId;
    if (!latestId) throw new Error('Missing latest backup');
    expect(await repository.get(latestId)).toMatchObject({ source: 'manual', windows: [{ tabs: [{ title: 'B' }] }] });
    expect(controller.status.kind).toBe('current');
    expect((await repository.metadata()).automatic).toEqual(automatic);
  } finally { controller.stopTimers(); await repository.close(); }
});

it.each([false, true])('retries a manual scan that saw the browser change, automatic backups %s', async automatic => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
  const scan = vi.fn(async () => session('A'));
  const controller = new Controller(repository, scan, port);
  try {
    await controller.start();
    await controller.setAutomaticSettings({ kind: 'enabled', value: automatic });
    scan.mockClear();
    scan.mockRejectedValueOnce(new BrowserChangedError('Browser changed during capture. Retrying.'));
    scan.mockImplementation(async () => session('B'));
    const capture = controller.capture('manual');
    await vi.advanceTimersByTimeAsync(250);
    expect(await capture).toMatchObject({ kind: 'saved' });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(controller.status.kind).toBe('current');
    expect((await repository.history(null, 10, 'saved')).items).toHaveLength(1);
    expect((await repository.history(null, 10, 'automatic')).items).toHaveLength(1);
  } finally { vi.useRealTimers(); controller.stopTimers(); await repository.close(); }
});

it('reports a manual backup that keeps seeing the browser change after bounded retries', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('A'));
  const controller = new Controller(repository, scan, port);
  try {
    await controller.start();
    scan.mockClear();
    scan.mockRejectedValue(new BrowserChangedError('Tab groups changed during capture. Retrying.'));
    const capture = controller.capture('manual');
    await vi.advanceTimersByTimeAsync(500);
    expect(await capture).toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(3);
    expect(controller.status).toEqual({ kind: 'error', message: 'Tabs kept changing during the backup. No backup was saved. Try Back up now again.' });
    expect(await repository.list()).toHaveLength(0);
    // other scan failures are reported at once without retries
    scan.mockClear();
    scan.mockRejectedValueOnce(new Error('Windows unavailable'));
    await controller.capture('manual');
    expect(scan).toHaveBeenCalledOnce();
    expect(controller.status).toEqual({ kind: 'error', message: 'Windows unavailable' });
  } finally { vi.useRealTimers(); controller.stopTimers(); await repository.close(); }
});

it('reports continuous changes after bounded manual retries and permits another attempt', async () => {
  const repository = new Repository(crypto.randomUUID());
  await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
  const scan = vi.fn(async () => session('A'));
  const controller = new Controller(repository, scan, port);
  try {
    await controller.start();
    await controller.setAutomaticSettings({ kind: 'enabled', value: false });
    scan.mockClear();
    scan.mockImplementation(async () => { controller.changed(); return session('stale'); });
    await controller.capture('manual');
    expect(scan).toHaveBeenCalledTimes(3);
    expect(controller.status).toEqual({ kind: 'error', message: 'Tabs kept changing during the backup. No backup was saved. Try Back up now again.' });
    expect(await repository.list()).toHaveLength(1);
    scan.mockImplementation(async () => session('B'));
    await controller.capture('manual');
    expect(controller.status.kind).toBe('current');
    expect(await repository.list()).toHaveLength(2);
  } finally { controller.stopTimers(); await repository.close(); }
});

it('finishes manual retries before a restoration queued during the first scan', async () => {
  const repository = new Repository(crypto.randomUUID());
  await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
  const scan = vi.fn(async () => session('A'));
  const createWindow = vi.fn(port.createWindow);
  const controller = new Controller(repository, scan, { ...port, createWindow });
  try {
    await controller.start();
    await controller.setAutomaticSettings({ kind: 'enabled', value: false });
    const original = (await repository.metadata()).latestId;
    if (!original) throw new Error('Missing original backup');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    scan.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      controller.changed();
      return session('stale');
    });
    scan.mockImplementation(async () => {
      expect(createWindow).not.toHaveBeenCalled();
      return session('B');
    });
    createWindow.mockImplementation(async url => {
      const latest = (await repository.metadata()).latestId;
      if (!latest) throw new Error('Missing manual backup');
      expect(await repository.get(latest)).toMatchObject({ source: 'manual', windows: [{ tabs: [{ title: 'B' }] }] });
      return port.createWindow(url);
    });
    const manual = controller.capture('manual');
    await entered.promise;
    const restore = controller.restore(original);
    release.resolve();
    await manual;
    await restore;
    await controller.idle();
    expect(createWindow).toHaveBeenCalledTimes(1);
  } finally { controller.stopTimers(); await repository.close(); }
});
