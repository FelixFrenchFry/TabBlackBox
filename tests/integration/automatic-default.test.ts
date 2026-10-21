import { createRestorePort } from '../support/restore';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMATIC_SETTINGS } from '../../src/automatic';
import { Controller } from '../../src/controller';
import { Repository } from '../../src/database';

const session = (title: string) => ({ windows: [{ groups: [], tabs: [{ title, url: 'https://example.test', pinned: false, group: null }] }] });
const port = createRestorePort();
afterEach(() => vi.useRealTimers());

it('starts new installations with automatic backups off and a 15-minute backup frequency', async () => {
  expect(DEFAULT_AUTOMATIC_SETTINGS).toEqual({ enabled: false, intervalMinutes: 15, pausedUntil: null });
  const repository = new Repository(crypto.randomUUID());
  try {
    expect((await repository.metadata()).automatic).toEqual({ enabled: false, intervalMinutes: 15, pausedUntil: null });
  } finally { await repository.close(); }
});

it('waits for the default frequency before capturing pending changes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const repository = new Repository(crypto.randomUUID());
  let current = session('A');
  const controller = new Controller(repository, async () => current, port, () => {}, vi.fn());
  try {
    await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
    // the first capture runs immediately because nothing has been saved yet
    await controller.start();
    expect(await repository.list()).toHaveLength(1);
    current = session('B');
    controller.changed();
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    await controller.idle();
    expect(await repository.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await controller.idle();
    expect(await repository.list()).toHaveLength(2);
  } finally { controller.stopTimers(); await repository.close(); }
});
