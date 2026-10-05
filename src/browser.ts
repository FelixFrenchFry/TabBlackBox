import { FILE_ACCESS_MESSAGE, fileUrl, normalizeSession } from './session';
import type { Session } from './model';
import { placeholderUrl } from './placeholder';
import { TAB_URL_LIMIT } from './protocol';
import type { RestorePort } from './restore';

export async function scanBrowser(): Promise<Session>
{
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const groups = await chrome.tabGroups.query({});
  return normalizeSession(windows, groups, chrome.runtime.getURL('/'));
}

export const restoreBrowser: RestorePort = {
  async fileAccess() { return chrome.extension.isAllowedFileSchemeAccess(); },
  async createWindow(url)
  {
    if (fileUrl(url) && !await chrome.extension.isAllowedFileSchemeAccess()) throw new Error(FILE_ACCESS_MESSAGE);
    const window = await chrome.windows.create({ url, type: 'normal', focused: false });
    const tabId = window?.tabs?.[0]?.id;
    if (window?.id === undefined || tabId === undefined) throw new Error('Chrome did not return the created window. Its outcome is uncertain.');
    return { windowId: window.id, tabId };
  },
  async createTab(windowId, url, pinned)
  {
    if (fileUrl(url) && !await chrome.extension.isAllowedFileSchemeAccess()) throw new Error(FILE_ACCESS_MESSAGE);
    const tab = await chrome.tabs.create({ windowId, url, pinned, active: false });
    if (tab.id === undefined) throw new Error('Chrome did not return the created tab. Its outcome is uncertain.');
    return tab.id;
  },
  async pinTab(tabId) { await chrome.tabs.update(tabId, { pinned: true }); },
  async createPlaceholderTab(windowId, url, title, pinned)
  {
    const placeholder = placeholderUrl(chrome.runtime.getURL('/'), url, title);
    // open directly if encoding makes the placeholder exceed Chrome's URL limit
    const target = placeholder.length > TAB_URL_LIMIT ? url : placeholder;
    const tab = await chrome.tabs.create({ windowId, url: target, pinned, active: false });
    if (tab.id === undefined) throw new Error('Chrome did not return the created tab. Its outcome is uncertain.');
    return tab.id;
  },
  async groupTabs(windowId, tabIds, group)
  {
    const first = tabIds[0];
    if (first === undefined) return;
    const id = await chrome.tabs.group({ createProperties: { windowId }, tabIds: [first, ...tabIds.slice(1)] });
    await chrome.tabGroups.update(id, { title: group.name, color: group.color, collapsed: group.collapsed });
  },
};
