import { createRestorePort } from '../support/restore';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { Controller } from '../../src/controller';
import { Repository } from '../../src/database';
import { parseRequest } from '../../src/protocol';

// capture after the settling delay instead of the product backup frequency
vi.mock('../../src/automatic', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/automatic')>();
  return { ...actual, DEFAULT_AUTOMATIC_SETTINGS: { ...actual.DEFAULT_AUTOMATIC_SETTINGS, enabled: true, intervalMinutes: 0 } };
});

const session = (title: string) => ({ windows: [{ groups: [], tabs: [{ title, url: 'https://example.test', pinned: false, group: null }] }] });
const port = createRestorePort();
afterEach(() => vi.useRealTimers());

it('disabled backups survive controller restart while manual captures remain available', async () => {
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('A'));
  let controller = new Controller(repository, scan, port);
  try {
    await controller.start();
    await controller.setAutomaticSettings({ kind: 'enabled', value: false });
    scan.mockImplementation(async () => session('B'));
    controller.changed();
    await controller.capture('automatic');
    expect(await repository.list()).toHaveLength(1);
    controller.stopTimers();
    await repository.close();
    controller = new Controller(repository, scan, port);
    await controller.start();
    expect(scan).toHaveBeenCalledTimes(1);
    await controller.capture('manual');
    expect(await repository.list()).toHaveLength(2);
    expect((await controller.overview()).metadata.automatic?.enabled).toBe(false);
    expect((await repository.history(null, 10, 'saved')).items).toHaveLength(1);
    expect((await controller.overview()).automaticStorage).toMatchObject({ count: 1 });
  } finally { controller.stopTimers(); await repository.close(); }
});

it.each([1, 5, 15, 60, 1440] as const)('captures pending changes at the %i-minute deadline without another event', async minutes => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  let current = session('A');
  const wake = vi.fn();
  const controller = new Controller(repository, async () => current, port, () => {}, wake);
  try {
    await controller.start();
    await controller.setAutomaticSettings({ kind: 'frequency', value: minutes });
    current = session('B');
    controller.changed();
    await vi.advanceTimersByTimeAsync(minutes * 60_000 - 1);
    await controller.idle();
    expect(await repository.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await controller.idle();
    expect(await repository.list()).toHaveLength(2);
    expect(controller.status.kind).toBe('current');
    expect(wake).toHaveBeenCalledWith({ id: expect.any(String), when: expect.any(Number) });
    await vi.advanceTimersByTimeAsync(minutes * 60_000);
    await controller.capture('automatic');
    expect(await repository.list()).toHaveLength(2);
  } finally { controller.stopTimers(); await repository.close(); }
});

it('pause expiry survives restart and resumes capture without another tab event', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  let current = session('A');
  let controller = new Controller(repository, async () => current, port);
  try {
    await controller.start();
    await controller.setAutomaticSettings({ kind: 'pause', minutes: 15 });
    current = session('B');
    controller.stopTimers();
    await repository.close();
    controller = new Controller(repository, async () => current, port);
    await controller.start();
    expect(controller.status.kind).toBe('paused');
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(await repository.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await controller.idle();
    expect(await repository.list()).toHaveLength(2);
  } finally { controller.stopTimers(); await repository.close(); }
});

it('manual capture during a pause preserves its deadline and resume now clears it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  let current = session('A');
  const controller = new Controller(repository, async () => current, port);
  try {
    await controller.start();
    await controller.setAutomaticSettings({ kind: 'pause', minutes: 60 });
    const until = (await repository.metadata()).automatic?.pausedUntil;
    current = session('B');
    await controller.capture('manual');
    expect(await repository.list()).toHaveLength(2);
    expect((await repository.metadata()).automatic?.pausedUntil).toBe(until);
    expect((await repository.history(null, 10, 'saved')).items).toHaveLength(1);
    await controller.setAutomaticSettings({ kind: 'resume' });
    current = session('C');
    await vi.advanceTimersByTimeAsync(2000);
    await controller.idle();
    expect(await repository.list()).toHaveLength(3);
  } finally { controller.stopTimers(); await repository.close(); }
});

it('validates automatic preferences and merges independent updates', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    expect(() => parseRequest({ kind: 'automatic-settings', update: { kind: 'frequency', value: 2 } })).toThrow();
    expect(() => parseRequest({ kind: 'automatic-settings', update: { kind: 'pause', minutes: -1 } })).toThrow();
    await repository.setAutomaticSettings({ kind: 'frequency', value: 5 }, Date.now());
    await repository.setAutomaticSettings({ kind: 'enabled', value: false }, Date.now());
    expect((await repository.metadata()).automatic).toEqual({ enabled: false, intervalMinutes: 5, pausedUntil: null });
  } finally { await repository.close(); }
});
it('preserves manual backup failures while automatic backups are disabled', async () => {
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('A'));
  const controller = new Controller(repository, scan, port);
  try {
    await controller.start();
    await controller.setAutomaticSettings({ kind: 'enabled', value: false });
    scan.mockRejectedValueOnce(new Error('Scan failed'));
    await controller.capture('manual');
    expect(controller.status).toEqual({ kind: 'error', message: 'Scan failed' });
    await controller.capture('automatic');
    expect(controller.status.kind).toBe('error');
  } finally { controller.stopTimers(); await repository.close(); }
});
