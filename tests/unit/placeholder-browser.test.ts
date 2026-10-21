import { afterEach, expect, it, vi } from 'vitest';
import { restoreBrowser } from '../../src/browser';

const ownOrigin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const limit = 2_097_152;

afterEach(() => vi.unstubAllGlobals());

function browser()
{
  const create = vi.fn(async (options: chrome.tabs.CreateProperties) => {
    if ((options.url?.length ?? 0) > limit) throw new Error('URL exceeds Chrome limit');
    return { id: 42 };
  });
  vi.stubGlobal('chrome', { runtime: { getURL: () => ownOrigin }, tabs: { create } });
  return create;
}

it.each([
  { name: 'encoded destination', url: `https://example.test/?q=${'='.repeat(700_000)}`, title: 'Saved page' },
  { name: 'encoded title', url: 'https://example.test/', title: '雪'.repeat(240_000) },
])('opens the original destination when the $name makes its placeholder too long', async ({ url, title }) =>
{
  const create = browser();
  await expect(restoreBrowser.createPlaceholderTab(7, url, title, true)).resolves.toBe(42);
  expect(create).toHaveBeenCalledExactlyOnceWith({ windowId: 7, url, pinned: true, active: false });
});

it.each([-1, 0, 1])('handles a placeholder %s characters from the Chrome URL limit', async extra =>
{
  const create = browser();
  const url = 'https://example.test/';
  const prefix = `${ownOrigin}restore.html#url=https%3A%2F%2Fexample.test%2F&title=`;
  const title = 'x'.repeat(limit - prefix.length + extra);
  const expectedUrl = extra > 0 ? url : `${prefix}${title}`;
  await expect(restoreBrowser.createPlaceholderTab(7, url, title, false)).resolves.toBe(42);
  expect(create).toHaveBeenCalledExactlyOnceWith({ windowId: 7, url: expectedUrl, pinned: false, active: false });
});

it('keeps ordinary tabs as placeholders with their encoded destination and title', async () =>
{
  const create = browser();
  await expect(restoreBrowser.createPlaceholderTab(7, 'https://example.test/?q=a&b=2#c', 'Saved & named', false)).resolves.toBe(42);
  expect(create).toHaveBeenCalledExactlyOnceWith({ windowId: 7, url: `${ownOrigin}restore.html#url=https%3A%2F%2Fexample.test%2F%3Fq%3Da%26b%3D2%23c&title=Saved+%26+named`, pinned: false, active: false });
});
