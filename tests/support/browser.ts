import { vi } from 'vitest';
import background from '../../entrypoints/background';
import type { Reply } from '../../src/protocol';

function event<Arguments extends unknown[]>()
{
  const listeners: ((...arguments_: Arguments) => unknown)[] = [];
  return {
    addListener: vi.fn((listener: (...arguments_: Arguments) => unknown) => { listeners.push(listener); }),
    emit: (...arguments_: Arguments) => { for (const listener of listeners) listener(...arguments_); },
    listeners,
  };
}

export function createBrowser()
{
  return {
    runtime: {
      id: 'test', getURL: (path: string) => `chrome-extension://test${path}`,
      onUpdateAvailable: event<[{ version: string }]>(),
      onInstalled: event<[{ reason: string }]>(),
      onMessage: event<Parameters<Parameters<typeof chrome.runtime.onMessage.addListener>[0]>>(),
    },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    alarms: {
      create: vi.fn<typeof chrome.alarms.create>().mockResolvedValue(),
      clear: vi.fn(async () => true),
      get: vi.fn(async (): Promise<chrome.alarms.Alarm | undefined> => ({ name: 'reconcile-session', scheduledTime: 0, persistAcrossSessions: true })),
      getAll: vi.fn(async (): Promise<chrome.alarms.Alarm[]> => []),
      onAlarm: event<[chrome.alarms.Alarm]>(),
    },
    tabs: { create: vi.fn(async (_properties: chrome.tabs.CreateProperties): Promise<object> => ({ id: 1 })), onCreated: event<[]>(), onRemoved: event<[]>(), onMoved: event<[]>(), onAttached: event<[]>(), onDetached: event<[]>(), onReplaced: event<[]>(), onUpdated: event<[]>() },
    windows: { onCreated: event<[]>(), onRemoved: event<[]>() },
    tabGroups: { onCreated: event<[]>(), onUpdated: event<[]>(), onMoved: event<[]>(), onRemoved: event<[]>() },
  };
}

export async function startBackground(browser = createBrowser())
{
  vi.stubGlobal('chrome', browser);
  await background.main();
  const listener = browser.runtime.onMessage.listeners[0];
  if (!listener) throw new Error('Message listener missing');
  // requests exercise the registered listener with an allowed extension sender
  const request = (input: unknown) => new Promise<Reply>(resolve => {
    listener(input, { id: 'test', url: 'chrome-extension://test/backups.html' }, resolve);
  });
  return { browser, request, change: browser.tabs.onCreated.emit, alarm: browser.alarms.onAlarm.emit };
}
