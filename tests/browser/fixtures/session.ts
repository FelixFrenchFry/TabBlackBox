import { importArchive } from './archive';
import type { Archive } from '../../../src/archive';
import { expect, type Page } from '@playwright/test';

import type { Data, Reply, Request } from '../../../src/protocol';
import type { Snapshot } from '../../../src/model';

export async function send(page: Page, request: Request | { kind: 'import'; archive: Archive }): Promise<Data>
{
  if (request.kind === 'import') { await importArchive(page, request.archive); return { kind: 'accepted' }; }
  const reply: Reply = await page.evaluate(async message => chrome.runtime.sendMessage(message), request);
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

export async function saved(page: Page): Promise<Snapshot>
{
  const result = await send(page, { kind: 'backup' });
  if (result.kind !== 'overview' || !result.overview.metadata.latestId) throw new Error('No saved backup');
  const backup = await send(page, { kind: 'snapshot', id: result.overview.metadata.latestId });
  if (backup.kind !== 'snapshot') throw new Error('No snapshot response');
  return backup.snapshot;
}

export async function seed(page: Page, baseUrl: string): Promise<number[]>
{
  return page.evaluate(async url =>
  {
    const first = await chrome.windows.create({ url: [`${url}/one`, `${url}/two`, `${url}/two`, 'chrome://version/'], focused: false });
    const second = await chrome.windows.create({ url: `${url}/three`, focused: false });
    const firstTab = first?.tabs?.[0]?.id;
    const groupTab1 = first?.tabs?.[1]?.id;
    const groupTab2 = first?.tabs?.[2]?.id;
    if (first?.id === undefined || second?.id === undefined || firstTab === undefined || groupTab1 === undefined || groupTab2 === undefined) throw new Error('Fixture creation failed');
    await chrome.tabs.update(firstTab, { pinned: true });
    const groupId = await chrome.tabs.group({ createProperties: { windowId: first.id }, tabIds: [groupTab1, groupTab2] });
    await chrome.tabGroups.update(groupId, { title: 'Research', color: 'blue', collapsed: true });
    return [first.id, second.id];
  }, baseUrl);
}

export async function settledBackup(page: Page, tabCount: number): Promise<Snapshot>
{
  await expect.poll(async () =>
  {
    const result = await send(page, { kind: 'backup' });
    return result.kind === 'overview' && result.overview.status.kind === 'current' ? result.overview.latest?.tabCount : 0;
  }).toBe(tabCount);
  return saved(page);
}
