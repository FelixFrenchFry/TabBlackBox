import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import background from '../../entrypoints/background';
import { placeholderUrl } from '../../src/placeholder';
import { hasExtensionTabs, isNewerVersion } from '../../src/update';

vi.mock('../../src/browser', () => ({ scanBrowser: vi.fn(async () => ({ windows: [] })), restoreBrowser: {} }));
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const ownOrigin = 'chrome-extension://test/';
type Tab = { url?: string; pendingUrl?: string };

async function launch(query: () => Promise<Tab[]>, installed = '0.1.0')
{
  const updates: ((details: { version: string }) => void)[] = [];
  const alarmListeners: ((alarm: { name: string }) => void)[] = [];
  const alarms = new Set<string>();
  const event = { addListener: vi.fn() };
  const reload = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test${path}`, getManifest: () => ({ version: installed }), reload, onUpdateAvailable: { addListener: (listener: (details: { version: string }) => void) => updates.push(listener) }, onInstalled: event, onMessage: event },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    alarms: {
      create: vi.fn(async (name: string) => { alarms.add(name); }),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      get: vi.fn(async () => ({ name: 'reconcile-session' })),
      getAll: vi.fn(async () => [...alarms].map(name => ({ name }))),
      onAlarm: { addListener: (listener: (alarm: { name: string }) => void) => alarmListeners.push(listener) },
    },
    tabs: { query: vi.fn(query), onCreated: event, onRemoved: event, onMoved: event, onAttached: event, onDetached: event, onReplaced: event, onUpdated: event },
    windows: { onCreated: event, onRemoved: event },
    tabGroups: { onCreated: event, onUpdated: event, onMoved: event, onRemoved: event },
  });
  await background.main();
  // finish startup reconciliation before inspecting update work
  await vi.waitFor(() => expect(chrome.action.setBadgeText).toHaveBeenCalledTimes(2));
  // let each attempt finish its idle check, tab query, and alarm writes
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return {
    reload, alarms,
    async update(version = '0.2.0') {
      for (const listener of updates) listener({ version });
      await settle();
    },
    async alarm(name: string) {
      for (const listener of alarmListeners) listener({ name });
      await settle();
    },
  };
}

it('applies an available update when no extension pages are open', async () =>
{
  // a placeholder that is already loading its saved page no longer blocks the update
  const app = await launch(async () => [{ url: 'https://example.test/' }, { pendingUrl: 'https://example.test/next', url: placeholderUrl(ownOrigin, 'https://example.test/next', 'Opening') }]);
  await app.update();
  expect(app.reload).toHaveBeenCalledOnce();
  expect(app.alarms).toEqual(new Set());
});

it.each([
  ['the backups page', { url: `${ownOrigin}backups.html#settings` }],
  ['an unopened placeholder tab', { url: placeholderUrl(ownOrigin, 'https://example.test/later', 'Later') }],
  ['a tab loading an extension page', { url: 'https://example.test/', pendingUrl: `${ownOrigin}backups.html` }],
])('defers an available update while %s is open', async (_name, tab) =>
{
  const app = await launch(async () => [{ url: 'https://example.test/' }, tab]);
  await app.update();
  expect(app.reload).not.toHaveBeenCalled();
  expect(app.alarms).toEqual(new Set(['apply-update:0.2.0']));
});

it('retries a deferred update from its alarm after the extension pages close', async () =>
{
  let tabs: Tab[] = [{ url: `${ownOrigin}backups.html` }];
  const app = await launch(async () => tabs);
  await app.update();
  await app.alarm('apply-update:0.2.0');
  expect(app.reload).not.toHaveBeenCalled();
  tabs = [{ url: 'https://example.test/' }];
  await app.alarm('apply-update:0.2.0');
  expect(app.reload).toHaveBeenCalledOnce();
  // the retry alarm is cleared before reloading so an unapplied update cannot reload repeatedly
  expect(app.alarms).toEqual(new Set());
});

it('replaces the retry alarm of an older pending update', async () =>
{
  const app = await launch(async () => [{ url: `${ownOrigin}backups.html` }]);
  await app.update('0.2.0');
  await app.update('0.3.0');
  expect(app.alarms).toEqual(new Set(['apply-update:0.3.0']));
});

it('clears a retry alarm without reloading once its version is installed', async () =>
{
  const app = await launch(async () => [], '0.2.0');
  app.alarms.add('apply-update:0.2.0');
  await app.alarm('apply-update:0.2.0');
  expect(app.reload).not.toHaveBeenCalled();
  expect(chrome.tabs.query).not.toHaveBeenCalled();
  expect(app.alarms).toEqual(new Set());
});

it('defers an available update when the open tabs cannot be checked', async () =>
{
  const app = await launch(async () => { throw new Error('Tabs unavailable'); });
  await app.update();
  expect(app.reload).not.toHaveBeenCalled();
  expect(app.alarms).toEqual(new Set(['apply-update:0.2.0']));
});

it('detects extension pages by their pending or current address', () =>
{
  expect(hasExtensionTabs([{ url: 'https://example.test/' }, {}], ownOrigin)).toBe(false);
  expect(hasExtensionTabs([{ url: `${ownOrigin}popup.html` }], ownOrigin)).toBe(true);
  expect(hasExtensionTabs([{ url: 'chrome-extension://other/backups.html' }], ownOrigin)).toBe(false);
});

it('compares dotted manifest versions numerically', () =>
{
  expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
  expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true);
  expect(isNewerVersion('1.0', '0.9.9.9')).toBe(true);
  expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
  expect(isNewerVersion('1.0', '1.0.0')).toBe(false);
  expect(isNewerVersion('0.1.0', '0.2')).toBe(false);
});
