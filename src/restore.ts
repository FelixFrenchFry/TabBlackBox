import { errorMessage, type Operation, type RestoreIssue, type RestoreProgress, type SavedGroup, type Snapshot } from './model';
import { webUrl } from './placeholder';
import { restorableUrl, selectWindows } from './session';

export interface RestorePort {
  fileAccess(): Promise<boolean>;
  createWindow(url: string): Promise<{ windowId: number; tabId: number }>;
  createTab(windowId: number, url: string, pinned: boolean): Promise<number>;
  pinTab(tabId: number): Promise<void>;
  groupTabs(windowId: number, tabIds: number[], group: SavedGroup): Promise<void>;
  // open a web page as a placeholder tab that loads the page when it is first shown
  createPlaceholderTab(windowId: number, url: string, title: string, pinned: boolean): Promise<number>;
}

export async function restoreSession(snapshot: Snapshot, port: RestorePort, persist: (operation: Operation) => Promise<void>, fileAccess = false, windowIndex?: number, lightweightAbove: number | null = null): Promise<Operation>
{
  const windows = selectWindows(snapshot, windowIndex);
  const allTabs = windows.flatMap(window => window.tabs);
  const issues: RestoreIssue[] = [];
  const progress: RestoreProgress = {
    snapshotId: snapshot.id, name: snapshot.name, issues, startedAt: Date.now(), opened: 0,
    skipped: allTabs.filter(tab => !restorableUrl(tab.url, fileAccess)).length,
    failed: 0, groupErrors: 0, total: allTabs.length, errors: [],
  };
  // open background web tabs as placeholders when the restore exceeds the threshold
  const lightweight = lightweightAbove !== null && progress.total - progress.skipped > lightweightAbove;
  const recordError = (message: string) => { if (progress.errors.length < 20) progress.errors.push(message); };
  const recordIssue = (issue: RestoreIssue) => { if (issues.length < 20) issues.push(issue); };
  const save = () => persist({ ...progress, errors: [...progress.errors], issues: [...issues], kind: 'running' });
  await save();

  // restore windows in saved order and persist progress after each operation
  for (const [index, window] of windows.entries()) {
    const windowNumber = (windowIndex ?? index) + 1;
    const tabs = window.tabs.filter((tab): tab is typeof tab & { url: string } => restorableUrl(tab.url, fileAccess));
    const first = tabs[0];
    if (!first) continue;
    let created: { windowId: number; tabId: number };
    try { created = await port.createWindow(first.url); }
    catch (error) {
      progress.failed += tabs.length;
      recordError(`Window ${windowNumber}: ${errorMessage(error)}`);
      for (const tab of tabs) recordIssue({ kind: 'tab', title: tab.title, url: tab.url, message: errorMessage(error) });
      await save();
      continue;
    }
    progress.opened++;
    await save();
    if (first.pinned) {
      try { await port.pinTab(created.tabId); }
      catch (error) {
        recordError(`Could not pin a restored tab: ${errorMessage(error)}`);
        recordIssue({ kind: 'pin', title: first.title, url: first.url, message: `Could not pin the tab: ${errorMessage(error)}` });
      }
      await save();
    }
    // keep restored tabs in saved order for grouping
    const restored = [{ tabId: created.tabId, group: first.group }];
    for (const tab of tabs.slice(1)) {
      try {
        // the first tab of each window loads normally and local files never use placeholders
        const tabId = lightweight && webUrl(tab.url)
          ? await port.createPlaceholderTab(created.windowId, tab.url, tab.title, tab.pinned)
          : await port.createTab(created.windowId, tab.url, tab.pinned);
        progress.opened++;
        restored.push({ tabId, group: tab.group });
      } catch (error) {
        progress.failed++;
        recordError(`Window ${windowNumber}, ${tab.title || tab.url}: ${errorMessage(error)}`);
        recordIssue({ kind: 'tab', title: tab.title, url: tab.url, message: errorMessage(error) });
      }
      // let persistence errors escape instead of treating them as browser failures
      await save();
    }
    const grouped = new Map<number, number[]>();
    for (const { tabId, group } of restored) {
      if (group !== null) grouped.set(group, [...(grouped.get(group) ?? []), tabId]);
    }
    for (const [index, tabIds] of grouped) {
      const group = window.groups[index];
      try {
        if (!group) throw new Error('Saved group information is unavailable.');
        await port.groupTabs(created.windowId, tabIds, group);
      } catch (error) {
        progress.groupErrors++;
        recordError(`Window ${windowNumber} group: ${errorMessage(error)}`);
        recordIssue({ kind: 'group', title: group?.name || `Window ${windowNumber} group`, message: errorMessage(error) });
      }
      await save();
    }
  }
  const completed: Operation = { ...progress, kind: 'completed', finishedAt: Date.now() };
  await persist(completed);
  return completed;
}
