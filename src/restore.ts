import { errorMessage, type Operation, type RestoreProgress, type SavedGroup, type Snapshot } from './model';
import { restorableUrl } from './session';

export interface RestorePort {
  createWindow(url: string): Promise<{ windowId: number; tabId: number }>;
  createTab(windowId: number, url: string, pinned: boolean): Promise<number>;
  pinTab(tabId: number): Promise<void>;
  groupTabs(windowId: number, tabIds: number[], group: SavedGroup): Promise<void>;
}

export async function restoreSession(snapshot: Snapshot, port: RestorePort, persist: (operation: Operation) => Promise<void>): Promise<Operation> {
  const allTabs = snapshot.windows.flatMap(window => window.tabs);
  const progress: RestoreProgress = {
    snapshotId: snapshot.id, startedAt: Date.now(), opened: 0,
    skipped: allTabs.filter(tab => !restorableUrl(tab.url)).length,
    failed: 0, groupErrors: 0, total: allTabs.length, errors: [],
  };
  const recordError = (message: string) => { if (progress.errors.length < 20) progress.errors.push(message); };
  const save = () => persist({ ...progress, errors: [...progress.errors], kind: 'running' });
  await save();

  for (const [windowIndex, window] of snapshot.windows.entries()) {
    const tabs = window.tabs.filter((tab): tab is typeof tab & { url: string } => restorableUrl(tab.url));
    const first = tabs[0];
    if (!first) continue;
    let created: { windowId: number; tabId: number };
    try { created = await port.createWindow(first.url); }
    catch (error) {
      progress.failed += tabs.length;
      recordError(`Window ${windowIndex + 1}: ${errorMessage(error)}`);
      await save();
      continue;
    }
    progress.opened++;
    await save();
    if (first.pinned) {
      try { await port.pinTab(created.tabId); }
      catch (error) { recordError(`Could not pin a restored tab: ${errorMessage(error)}`); }
      await save();
    }
    const grouped = new Map<number, number[]>();
    const addGroup = (group: number | null, tabId: number) => {
      if (group !== null) grouped.set(group, [...(grouped.get(group) ?? []), tabId]);
    };
    addGroup(first.group, created.tabId);
    for (const tab of tabs.slice(1)) {
      try {
        const tabId = await port.createTab(created.windowId, tab.url, tab.pinned);
        progress.opened++;
        addGroup(tab.group, tabId);
      } catch (error) {
        progress.failed++;
        recordError(`Window ${windowIndex + 1}, ${tab.title || tab.url}: ${errorMessage(error)}`);
      }
      // Persistence errors must escape, not be mistaken for a failed browser call.
      await save();
    }
    for (const [index, tabIds] of grouped) {
      const group = window.groups[index];
      try {
        if (!group) throw new Error('Saved group information is unavailable.');
        await port.groupTabs(created.windowId, tabIds, group);
      } catch (error) {
        progress.groupErrors++;
        recordError(`Window ${windowIndex + 1} group: ${errorMessage(error)}`);
      }
      await save();
    }
  }
  const completed: Operation = { ...progress, kind: 'completed', finishedAt: Date.now() };
  await persist(completed);
  return completed;
}
