import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { createBrowser, startBackground } from '../support/browser';
import { scanBrowser } from '../../src/browser';
import type { Reply } from '../../src/protocol';

vi.mock('../../src/browser', () => ({ scanBrowser: vi.fn(), restoreBrowser: {} }));

const session = { windows: [{ groups: [], tabs: [{ title: 'Example', url: 'https://example.test/', pinned: false, group: null }] }] };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.mocked(scanBrowser).mockReset().mockResolvedValue(session);
});

// start with automatic backups on and the current tabs already saved
async function current()
{
  const browser = createBrowser();
  const app = await startBackground(browser);
  await app.request({ kind: 'automatic-settings', update: { kind: 'enabled', value: true } });
  // back up every settled change so a wake alarm always finds its capture due
  await app.request({ kind: 'automatic-settings', update: { kind: 'frequency', value: 0 } });
  await app.request({ kind: 'refresh' });
  const status = async () => {
    const reply: Reply = await app.request({ kind: 'overview' });
    return reply.ok && reply.data.kind === 'overview' ? reply.data.overview.status.kind : undefined;
  };
  expect(await status()).toBe('current');
  return { ...app, browser, status };
}

type Emitter = { emit: (...arguments_: never[]) => void };
const events: [string, (browser: ReturnType<typeof createBrowser>) => Emitter][] = [
  ['tab created', browser => browser.tabs.onCreated],
  ['tab removed', browser => browser.tabs.onRemoved],
  ['tab moved', browser => browser.tabs.onMoved],
  ['tab attached', browser => browser.tabs.onAttached],
  ['tab detached', browser => browser.tabs.onDetached],
  ['tab replaced', browser => browser.tabs.onReplaced],
  ['window created', browser => browser.windows.onCreated],
  ['window removed', browser => browser.windows.onRemoved],
  ['group created', browser => browser.tabGroups.onCreated],
  ['group updated', browser => browser.tabGroups.onUpdated],
  ['group moved', browser => browser.tabGroups.onMoved],
  ['group removed', browser => browser.tabGroups.onRemoved],
];

it.each(events)('marks changes pending after a %s event', async (_name, select) =>
{
  const app = await current();
  select(app.browser).emit();
  expect(await app.status()).toBe('pending');
});

it.each(['url', 'title', 'pinned', 'groupId'])('marks changes pending when a tab updates its %s', async field =>
{
  const app = await current();
  const emit = app.browser.tabs.onUpdated.emit as (id: number, change: object) => void;
  emit(1, { [field]: field === 'pinned' ? true : 'changed' });
  expect(await app.status()).toBe('pending');
});

it('ignores tab updates that a backup does not store', async () =>
{
  const app = await current();
  const emit = app.browser.tabs.onUpdated.emit as (id: number, change: object) => void;
  for (const change of [{ status: 'complete' }, { favIconUrl: 'https://example.test/icon.png' }, { audible: true }, { discarded: true }]) emit(1, change);
  expect(await app.status()).toBe('current');
});

it('captures from a wake alarm before the in-memory timer and then clears the alarm', async () =>
{
  const app = await current();
  vi.mocked(scanBrowser).mockClear();
  const changedAt = Date.now();
  app.change();
  await vi.waitFor(() => expect(app.browser.alarms.create).toHaveBeenLastCalledWith(expect.stringMatching(/^automatic-backup-wake:/), { when: changedAt + 2000 }));
  const name = app.browser.alarms.create.mock.lastCall?.[0];
  if (typeof name !== 'string') throw new Error('Missing wake alarm');
  app.alarm({ name, scheduledTime: Date.now(), persistAcrossSessions: true });
  await vi.waitFor(() => expect(scanBrowser).toHaveBeenCalledOnce());
  expect(Date.now()).toBeLessThan(changedAt + 2000);
  await vi.waitFor(() => expect(app.browser.alarms.clear).toHaveBeenCalledWith(name));
  // a cleared schedule creates no replacement alarm
  expect(app.browser.alarms.create.mock.lastCall?.[0]).toBe(name);
});
