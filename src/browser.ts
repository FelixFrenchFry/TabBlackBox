import { normalizeSession } from './session';
import type { Session } from './model';
import type { RestorePort } from './restore';

export async function scanBrowser(): Promise<Session>
{
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const groups = await chrome.tabGroups.query({});
  return normalizeSession(windows, groups, chrome.runtime.getURL('/'));
}

export const restoreBrowser: RestorePort = {
  async createWindow(url)
  {
    const window = await chrome.windows.create({ url, type: 'normal', focused: false });
    const tabId = window?.tabs?.[0]?.id;
    if (window?.id === undefined || tabId === undefined) throw new Error('Chrome did not return the created window. Its outcome is uncertain.');
    return { windowId: window.id, tabId };
  },
  async createTab(windowId, url, pinned)
  {
    const tab = await chrome.tabs.create({ windowId, url, pinned, active: false });
    if (tab.id === undefined) throw new Error('Chrome did not return the created tab. Its outcome is uncertain.');
    return tab.id;
  },
  async pinTab(tabId) { await chrome.tabs.update(tabId, { pinned: true }); },
  async groupTabs(windowId, tabIds, group)
  {
    const first = tabIds[0];
    if (first === undefined) return;
    const id = await chrome.tabs.group({ createProperties: { windowId }, tabIds: [first, ...tabIds.slice(1)] });
    await chrome.tabGroups.update(id, { title: group.name, color: group.color, collapsed: group.collapsed });
  },
};
