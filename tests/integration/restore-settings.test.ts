import { createRestorePort } from '../support/restore';
import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { Controller } from '../../src/controller';
import { Repository } from '../../src/database';
import type { Session } from '../../src/model';
import { parseRequest } from '../../src/protocol';
import { DEFAULT_RESTORE_SETTINGS, parseRestoreSettings } from '../../src/restore-settings';

const tabs = (count: number): Session => ({ windows: [{ groups: [], tabs: Array.from({ length: count }, (_, index) => ({ url: `https://tab${index}.test`, title: '', pinned: false, group: null })) }] });
const port = createRestorePort();

it.each([
  { count: 100, enabled: false, placeholders: 0 },
  { count: 101, enabled: false, placeholders: 0 },
  { count: 100, enabled: true, placeholders: 0 },
  { count: 101, enabled: true, placeholders: 100 },
])('restores $count tabs with lightweight enabled=$enabled and $placeholders placeholders', async ({ count, enabled, placeholders }) =>
{
  const repository = new Repository(crypto.randomUUID());
  const createPlaceholderTab = vi.fn(async () => 2);
  const controller = new Controller(repository, async () => tabs(count), { ...port, createPlaceholderTab });
  try {
    await repository.setAutomaticSettings({ kind: 'enabled', value: false }, Date.now());
    if (enabled) await repository.setRestoreSettings({ ...DEFAULT_RESTORE_SETTINGS, unloadBackgroundTabs: true });
    const saved = await repository.capture(tabs(count), 'manual', Date.now());
    if (saved.kind !== 'saved') throw new Error('Fixture missing');
    await controller.restore(saved.id);
    await controller.idle();
    expect(createPlaceholderTab).toHaveBeenCalledTimes(placeholders);
  } finally { await controller.idle(); controller.stopTimers(); await repository.close(); }
});

it.each([0, -1, 1.5, 10_001, Number.NaN, '5', null])('rejects threshold %s', unloadThreshold =>
{
  expect(() => parseRestoreSettings({ unloadBackgroundTabs: true, unloadThreshold })).toThrow('threshold');
  expect(() => parseRequest({ kind: 'restore-settings', settings: { unloadBackgroundTabs: true, unloadThreshold } })).toThrow();
});

it('accepts valid settings and rejects other shapes', () =>
{
  const settings = { unloadBackgroundTabs: false, unloadThreshold: 10_000 };
  expect(parseRequest({ kind: 'restore-settings', settings: { ...settings, extra: 1 } })).toEqual({ kind: 'restore-settings', settings });
  expect(() => parseRestoreSettings({ unloadBackgroundTabs: 'yes', unloadThreshold: 5 })).toThrow();
  expect(() => parseRestoreSettings(null)).toThrow('Invalid restore settings');
  expect(() => parseRequest({ kind: 'restore-settings' })).toThrow('Invalid request');
});

it('persists settings and starts with the defaults', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    expect((await repository.metadata()).restore).toEqual({ unloadBackgroundTabs: false, unloadThreshold: 100 });
    await repository.setRestoreSettings({ unloadBackgroundTabs: true, unloadThreshold: 80 });
    await repository.close();
    expect((await repository.metadata()).restore).toEqual({ unloadBackgroundTabs: true, unloadThreshold: 80 });
  } finally { await repository.close(); }
});

it.each([
  { settings: { unloadBackgroundTabs: true, unloadThreshold: 2 }, placeholders: 2 },
  { settings: { unloadBackgroundTabs: true, unloadThreshold: 3 }, placeholders: 0 },
  { settings: { unloadBackgroundTabs: false, unloadThreshold: 1 }, placeholders: 0 },
])('restores 3 tabs with $settings and opens $placeholders placeholders', async ({ settings, placeholders }) =>
{
  const repository = new Repository(crypto.randomUUID());
  const createPlaceholderTab = vi.fn(async () => 2);
  const controller = new Controller(repository, async () => tabs(3), { ...port, createPlaceholderTab });
  try {
    await repository.setAutomaticSettings({ kind: 'enabled', value: false }, Date.now());
    await repository.setRestoreSettings(settings);
    const saved = await repository.capture(tabs(3), 'manual', Date.now());
    if (saved.kind !== 'saved') throw new Error('Fixture missing');
    await controller.restore(saved.id);
    await controller.idle();
    expect(createPlaceholderTab).toHaveBeenCalledTimes(placeholders);
  } finally { await controller.idle(); controller.stopTimers(); await repository.close(); }
});
