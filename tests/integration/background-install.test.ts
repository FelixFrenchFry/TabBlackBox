import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { createBrowser, startBackground } from '../support/browser';

vi.mock('../../src/browser', () => ({ scanBrowser: vi.fn(async () => ({ windows: [] })), restoreBrowser: {} }));

async function launch(create: (properties: chrome.tabs.CreateProperties) => Promise<object>)
{
  const browser = createBrowser();
  browser.tabs.create.mockImplementation(create);
  browser.alarms.get.mockResolvedValue(undefined);
  const app = await startBackground(browser);
  await app.request({ kind: 'overview' });
  return async (reason: string) => {
    browser.runtime.onInstalled.emit({ reason });
    await new Promise(resolve => setTimeout(resolve, 0));
  };
}

it.each(['install', 'update', 'chrome_update', 'shared_module_update'])('opens no page after an %s', async reason =>
{
  const install = await launch(async () => ({ id: 1 }));
  await install(reason);
  expect(chrome.tabs.create).not.toHaveBeenCalled();
});
