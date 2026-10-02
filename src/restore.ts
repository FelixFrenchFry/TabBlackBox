import { errorMessage, type Operation, type RestoreProgress, type SavedGroup, type Snapshot } from './model';
import { restorableUrl, selectWindows } from './session';

export interface RestorePort {
  fileAccess(): Promise<boolean>;
  createWindow(url: string): Promise<{ windowId: number; tabId: number }>;
  createTab(windowId: number, url: string, pinned: boolean): Promise<number>;
  pinTab(tabId: number): Promise<void>;
  groupTabs(windowId: number, tabIds: number[], group: SavedGroup): Promise<void>;
  // unload a loaded tab and return the id it has afterwards
  unloadTab(tabId: number): Promise<number>;
}

// maximum restored tabs that may still be loading before the next tab is opened
export const UNLOAD_BATCH_SIZE = 5;

export async function restoreSession(snapshot: Snapshot, port: RestorePort, persist: (operation: Operation) => Promise<void>, fileAccess = false, windowIndex?: number, unloadAbove: number | null = null): Promise<Operation>
{
  const windows = selectWindows(snapshot, windowIndex);
  const allTabs = windows.flatMap(window => window.tabs);
  const progress: RestoreProgress = {
    snapshotId: snapshot.id, startedAt: Date.now(), opened: 0,
    skipped: allTabs.filter(tab => !restorableUrl(tab.url, fileAccess)).length,
    failed: 0, groupErrors: 0, total: allTabs.length, errors: [],
  };
  // unload background tabs once their pages have loaded when the restore exceeds the threshold
  const unload = unloadAbove !== null && progress.total - progress.skipped > unloadAbove;
  const recordError = (message: string) => { if (progress.errors.length < 20) progress.errors.push(message); };
  const save = () => persist({ ...progress, errors: [...progress.errors], kind: 'running' });
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
    // keep restored tabs in saved order and replace ids changed by unloading before grouping
    const restored = [{ tabId: created.tabId, group: first.group }];
    const unloading = new Set<Promise<void>>();
    for (const tab of tabs.slice(1)) {
      // the first tab of each window stays loaded and later tabs wait for a free unload slot
      if (unload && unloading.size >= UNLOAD_BATCH_SIZE) await Promise.race(unloading);
      try {
        const entry = { tabId: await port.createTab(created.windowId, tab.url, tab.pinned), group: tab.group };
        progress.opened++;
        restored.push(entry);
        if (unload) {
          const task: Promise<void> = port.unloadTab(entry.tabId)
            .then(tabId => { entry.tabId = tabId; })
            .catch((error: unknown) => recordError(`Could not unload a restored tab: ${errorMessage(error)}`))
            .finally(() => { unloading.delete(task); });
          unloading.add(task);
        }
      } catch (error) {
        progress.failed++;
        recordError(`Window ${windowNumber}, ${tab.title || tab.url}: ${errorMessage(error)}`);
      }
      // let persistence errors escape instead of treating them as browser failures
      await save();
    }
    await Promise.all(unloading);
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
      }
      await save();
    }
  }
  const completed: Operation = { ...progress, kind: 'completed', finishedAt: Date.now() };
  await persist(completed);
  return completed;
}
