import { afterEach, expect, it, vi } from 'vitest';
import { restoreBrowser } from '../../src/browser';

afterEach(() => vi.unstubAllGlobals());

it('checks file permission at the browser boundary and preserves the full URL', async () =>
{
  const allowed = vi.fn(async () => false);
  const createTab = vi.fn(async () => ({ id: 3 }));
  const createWindow = vi.fn(async () => ({ id: 1, tabs: [{ id: 2 }] }));
  vi.stubGlobal('chrome', { extension: { isAllowedFileSchemeAccess: allowed }, tabs: { create: createTab }, windows: { create: createWindow } });
  const url = 'file:///M:/My%20paper.pdf#page=4';
  await expect(restoreBrowser.createWindow(url)).rejects.toThrow('Allow access to file URLs');
  await expect(restoreBrowser.createTab(1, url, true)).rejects.toThrow('Allow access to file URLs');
  expect(createWindow).not.toHaveBeenCalled();
  expect(createTab).not.toHaveBeenCalled();
  allowed.mockResolvedValue(true);
  await expect(restoreBrowser.createWindow(url)).resolves.toEqual({ windowId: 1, tabId: 2 });
  await expect(restoreBrowser.createTab(1, url, true)).resolves.toBe(3);
  expect(createWindow).toHaveBeenCalledWith({ url, type: 'normal', focused: false });
  expect(createTab).toHaveBeenCalledWith({ windowId: 1, url, pinned: true, active: false });
});
