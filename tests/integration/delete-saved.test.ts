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

const session = (url: string): Session => ({ windows: [{ groups: [], tabs: [{ url, title: url, pinned: false, group: null }] }] });
const port = createRestorePort();

afterEach(() => vi.useRealTimers());

it('invalidates current coverage after deleting the latest save and waits for the automatic deadline', async () =>
{
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  let current = session('https://old.test');
  const scan = vi.fn(async () => current);
  const controller = new Controller(repository, scan, port);
  try {
    await controller.start();
    const original = (await repository.metadata()).latestId;
    await controller.setAutomaticSettings({ kind: 'frequency', value: 1440 });
    current = session('https://new.test');
    const saved = await controller.capture('manual');
    if (saved?.kind !== 'saved') throw new Error('Fixture missing');
    await controller.deleteSession(saved.id);
    expect((await controller.overview()).status.kind).toBe('pending');
    expect((await repository.metadata()).latestId).toBe(original);
    expect(scan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(86_400_000);
    await controller.idle();
    expect(controller.status.kind).toBe('current');
    const latest = (await controller.overview()).latest;
    if (!latest) throw new Error('Fixture missing');
    expect(latest.source).toBe('automatic');
    expect((await repository.get(latest.id)).windows).toEqual(current.windows);
    await expect(repository.get(saved.id)).rejects.toThrow('no longer available');
  } finally { controller.stopTimers(); await repository.close(); }
});

it.each(['disabled', 'paused'] as const)('honors %s automatic backups after deleting the only save', async mode =>
{
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('https://current.test'));
  const controller = new Controller(repository, scan, port);
  try {
    await repository.setAutomaticSettings(mode === 'disabled' ? { kind: 'enabled', value: false } : { kind: 'pause', minutes: 15 }, Date.now());
    const saved = await controller.capture('manual');
    if (saved?.kind !== 'saved') throw new Error('Fixture missing');
    await controller.deleteSession(saved.id);
    expect(controller.status.kind).toBe(mode);
    expect((await repository.metadata()).latestId).toBeNull();
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await controller.idle();
    expect(scan).toHaveBeenCalledTimes(mode === 'paused' ? 2 : 1);
    expect(controller.status.kind).toBe(mode === 'paused' ? 'current' : 'disabled');
  } finally { controller.stopTimers(); await repository.close(); }
});

it('captures current tabs immediately when automatic backups are due', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  let current = session('https://old.test');
  const controller = new Controller(repository, async () => current, port);
  try {
    await controller.start();
    current = session('https://new.test');
    const saved = await controller.capture('manual');
    if (saved?.kind !== 'saved') throw new Error('Fixture missing');
    await controller.deleteSession(saved.id);
    const latest = (await controller.overview()).latest;
    if (!latest) throw new Error('Fixture missing');
    expect(controller.status.kind).toBe('current');
    expect(latest.source).toBe('automatic');
    expect((await repository.get(latest.id)).windows).toEqual(current.windows);
  } finally { controller.stopTimers(); await repository.close(); }
});

it('keeps current coverage when deleting an older save or when deletion fails', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const scan = vi.fn(async () => session('https://current.test'));
  const controller = new Controller(repository, scan, port);
  try {
    const older = await controller.capture('manual');
    const latest = await controller.capture('manual');
    if (older?.kind !== 'saved' || latest?.kind !== 'saved') throw new Error('Fixture missing');
    const scans = scan.mock.calls.length;
    await controller.deleteSession(older.id);
    expect((await repository.metadata()).latestId).toBe(latest.id);
    expect(controller.status.kind).toBe('current');
    expect(scan).toHaveBeenCalledTimes(scans);
    await expect(controller.deleteSession(older.id)).rejects.toThrow('no longer available');
    expect((await repository.metadata()).latestId).toBe(latest.id);
    expect(controller.status.kind).toBe('current');
  } finally { controller.stopTimers(); await repository.close(); }
});

it('rejects deletion while restoration is running', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  const gate = Promise.withResolvers<void>();
  const controller = new Controller(repository, async () => session('https://current.test'), {
    ...port, createWindow: async () => { await gate.promise; return { windowId: 1, tabId: 1 }; },
  });
  try {
    const saved = await controller.capture('manual');
    if (saved?.kind !== 'saved') throw new Error('Fixture missing');
    await controller.restore(saved.id);
    await expect(controller.deleteSession(saved.id)).rejects.toThrow('Wait for restoration to finish');
    expect((await repository.get(saved.id)).id).toBe(saved.id);
  } finally { gate.resolve(); await controller.idle(); controller.stopTimers(); await repository.close(); }
});
