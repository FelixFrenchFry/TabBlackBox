import { FILE_ACCESS_MESSAGE, fileUrl, normalizeSession } from './session';
import type { Session } from './model';
import type { RestorePort } from './restore';

const UNLOAD_TIMEOUT_MS = 10_000;

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
  async unloadTab(tabId)
  {
    // let the page finish loading so the unloaded tab keeps its title and icon
    await new Promise<void>(resolve =>
    {
      const finish = () => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(updated);
        chrome.tabs.onRemoved.removeListener(removed);
        resolve();
      };
      const updated = (id: number, change: { status?: string }) => { if (id === tabId && change.status === 'complete') finish(); };
      const removed = (id: number) => { if (id === tabId) finish(); };
      // unloading proceeds after the timeout when a page never finishes loading
      const timer = setTimeout(finish, UNLOAD_TIMEOUT_MS);
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.onRemoved.addListener(removed);
      // cover pages that finished loading before the listener was added
      chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') finish(); }, finish);
    });
    // discarding can give the tab a new id
    const discarded = await chrome.tabs.discard(tabId);
    return discarded?.id ?? tabId;
  },
  async groupTabs(windowId, tabIds, group)
  {
    const first = tabIds[0];
    if (first === undefined) return;
    const id = await chrome.tabs.group({ createProperties: { windowId }, tabIds: [first, ...tabIds.slice(1)] });
    await chrome.tabGroups.update(id, { title: group.name, color: group.color, collapsed: group.collapsed });
  },
};
