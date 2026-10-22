import { openDB } from 'idb';
import { expect } from 'vitest';
import type { BackupDatabase } from '../../src/database';
import type { Metadata, StoredSnapshot, StoredTab, Summary } from '../../src/model';
import { compareHistory } from '../../src/history';
import { changedTabIds } from '../../src/changes';
import { canonicalTab, decodeSnapshot, snapshotTabIds, summarize } from '../../src/session';
import { storageTotals, storedBytes } from '../../src/storage';

export type DatabaseContents = { snapshots: StoredSnapshot[]; tabs: StoredTab[]; summaries: Summary[]; metadata: Metadata | undefined; imports: number };

// read every store in one transaction
export async function readDatabase(name: string): Promise<DatabaseContents>
{
  const db = await openDB<BackupDatabase>(name);
  try {
    const tx = db.transaction(['snapshots', 'tabs', 'summaries', 'metadata', 'imports']);
    const contents = {
      snapshots: await tx.objectStore('snapshots').getAll(),
      tabs: await tx.objectStore('tabs').getAll(),
      summaries: await tx.objectStore('summaries').getAll(),
      metadata: await tx.objectStore('metadata').get('state'),
      imports: await tx.objectStore('imports').count(),
    };
    await tx.done;
    return contents;
  } finally { db.close(); }
}

// relations between stores that every commit must keep
export function expectConsistent({ snapshots, tabs, summaries, metadata, imports }: DatabaseContents): void
{
  const tabMap = new Map(tabs.map(tab => [tab.id, tab]));
  expect(imports, 'import staging is empty').toBe(0);
  expect(new Set(tabs.map(canonicalTab)).size, 'tab records are shared, not duplicated').toBe(tabs.length);
  expect(summaries.map(item => item.id).sort(), 'each snapshot has one summary').toEqual(snapshots.map(item => item.id).sort());

  const referenced = new Set<number>();
  for (const snapshot of snapshots) {
    const windowTabs = snapshot.windows.flatMap(window => window.tabs);
    for (const id of [...windowTabs, ...changedTabIds(snapshot.changes)]) {
      expect(tabMap.has(id), `tab ${id} of ${snapshot.id} exists`).toBe(true);
    }
    for (const id of windowTabs) referenced.add(id);
    expect(snapshot.tabIds, 'tab index field matches windows').toEqual(snapshotTabIds(snapshot.windows));
    for (const window of snapshot.windows) {
      for (const id of window.tabs) {
        const group = tabMap.get(id)?.group;
        if (group !== null && group !== undefined) expect(group, 'tab group index is in range').toBeLessThan(window.groups.length);
      }
    }
    const summary = summaries.find(item => item.id === snapshot.id);
    expect(summary, `summary of ${snapshot.id} matches its snapshot`).toEqual(summarize(decodeSnapshot(snapshot, tabMap), storedBytes(snapshot)));
  }
  expect([...tabMap.keys()].filter(id => !referenced.has(id)), 'no orphaned tab records').toEqual([]);

  // each session is compared with the previous one in its panel
  for (const saved of [false, true]) {
    const ordered = snapshots.filter(item => (item.savedAt !== undefined) === saved).sort((a, b) => compareHistory(a, b, 'date-asc'));
    for (const [index, snapshot] of ordered.entries()) expect(snapshot.changes?.previousId ?? null, `comparison of ${snapshot.id}`).toBe(ordered[index - 1]?.id ?? null);
  }

  if (!metadata) {
    expect(snapshots).toEqual([]);
    return;
  }
  expect(metadata.count, 'metadata count').toBe(snapshots.length);
  expect({ bytes: metadata.bytes, automaticBytes: metadata.automaticBytes, savedBytes: metadata.savedBytes }, 'byte totals').toEqual(storageTotals(snapshots, tabMap));
  expect(metadata.lastTabId, 'tab counter covers stored records').toBeGreaterThanOrEqual(Math.max(0, ...tabMap.keys()));
  if (metadata.latestId !== null) expect(snapshots.some(item => item.id === metadata.latestId), 'latest backup exists').toBe(true);
  for (const snapshot of snapshots) {
    const counter = snapshot.savedAt === undefined ? metadata.lastSessionNumbers.automatic : metadata.lastSessionNumbers.manual;
    expect(snapshot.number, 'session numbers stay within their counter').toBeLessThanOrEqual(counter);
  }
}
