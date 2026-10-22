import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Repository } from '../../src/database';
import { exportArchiveFile, readArchiveFile } from '../../src/archive-file';
import { parseArchive, type ArchiveSession } from '../../src/archive';
import { placeholderTarget, placeholderUrl } from '../../src/placeholder';
import type { Metadata, Snapshot, StoredSnapshot, StoredTab, Summary } from '../../src/model';
import { openReleasedDatabase } from '../support/released';
import { expectConsistent, readDatabase } from '../support/invariants';

// data written by the first released version, never edit these files
const directory = resolve(import.meta.dirname, '../fixtures/released');
type Dump = { version: number; stores: { snapshots: [string, StoredSnapshot][]; tabs: [number, StoredTab][]; summaries: [string, Summary][]; metadata: [string, Metadata][]; imports: [number, ArchiveSession][] } };
const dump = JSON.parse(readFileSync(resolve(directory, 'database-v9.json'), 'utf8')) as Dump;
const archiveText = readFileSync(resolve(directory, 'archive-v1.json'), 'utf8');

// load the dump with its original keys
async function loadReleasedDatabase(): Promise<string>
{
  const name = crypto.randomUUID();
  const db = await openReleasedDatabase(name);
  expect(db.version).toBe(dump.version);
  const tx = db.transaction(['snapshots', 'tabs', 'summaries', 'metadata', 'imports'], 'readwrite');
  for (const [, value] of dump.stores.snapshots) await tx.objectStore('snapshots').put(value);
  for (const [, value] of dump.stores.tabs) await tx.objectStore('tabs').put(value);
  for (const [, value] of dump.stores.summaries) await tx.objectStore('summaries').put(value);
  for (const [key, value] of dump.stores.metadata) await tx.objectStore('metadata').put(value, key);
  for (const [key, value] of dump.stores.imports) await tx.objectStore('imports').put(value, key);
  await tx.done;
  db.close();
  return name;
}

// decode windows without the app decoder
function expectedWindows(snapshot: StoredSnapshot): Snapshot['windows']
{
  const tabs = new Map(dump.stores.tabs.map(([id, tab]) => [id, tab]));
  return snapshot.windows.map(window => ({ groups: window.groups, tabs: window.tabs.map(id => {
    const tab = tabs.get(id);
    if (!tab) throw new Error(`fixture tab ${id} missing`);
    return { url: tab.url, title: tab.title, pinned: tab.pinned, group: tab.group };
  }) }));
}

const metadata = dump.stores.metadata[0]?.[1];
const later = (metadata?.lastSavedAt ?? 0) + 86_400_000;

describe('released schema-9 database', () =>
{
  it('is internally consistent as written by the released version', async () =>
  {
    expectConsistent(await readDatabase(await loadReleasedDatabase()));
  });

  it('opens with every backup, summary, and setting intact', async () =>
  {
    const repository = new Repository(await loadReleasedDatabase());
    try {
      expect(await repository.metadata()).toEqual(metadata);
      for (const [id, stored] of dump.stores.snapshots) {
        const snapshot = await repository.get(id);
        expect(snapshot.windows).toEqual(expectedWindows(stored));
        expect({ name: snapshot.name, number: snapshot.number, capturedAt: snapshot.capturedAt, source: snapshot.source, savedAt: snapshot.savedAt, tags: snapshot.tags })
          .toEqual({ name: stored.name, number: stored.number, capturedAt: stored.capturedAt, source: stored.source, savedAt: stored.savedAt, tags: stored.tags });
      }
      const history = await repository.history(null, 100);
      expect(history.count).toBe(dump.stores.summaries.length);
      expect(new Map(history.items.map(item => [item.id, item]))).toEqual(new Map(dump.stores.summaries));
      expect((await repository.searchTabs('example')).items.length).toBeGreaterThan(0);
      expect((await repository.topSites('all')).total).toBeGreaterThan(0);
      expect(await repository.oldestCapturedAt()).toBe(Math.min(...dump.stores.summaries.map(([, item]) => item.capturedAt)));
    } finally { await repository.close(); }
  });

  it('exports released saved sessions exactly like the released version', async () =>
  {
    const repository = new Repository(await loadReleasedDatabase());
    try {
      expect(await (await exportArchiveFile(repository, 'json')).text()).toBe(archiveText);
    } finally { await repository.close(); }
  });

  it('stays consistent while later versions capture, keep, delete, import, and prune', async () =>
  {
    const name = await loadReleasedDatabase();
    const repository = new Repository(name);
    const savedIds = dump.stores.snapshots.filter(([, item]) => item.savedAt !== undefined).map(([id]) => id);
    try {
      const capture = await repository.capture({ windows: [{ groups: [], tabs: [{ url: 'https://example.com/', title: 'Example Domain', pinned: true, group: null }, { url: 'https://example.com/after-update', title: 'After update', pinned: false, group: null }] }] }, 'automatic', later);
      expect(capture.kind).toBe('saved');
      expectConsistent(await readDatabase(name));
      if (capture.kind === 'saved') await repository.keep(capture.id, 'Kept after update', later + 1, { tags: ['update'] });
      expectConsistent(await readDatabase(name));
      const deleted = savedIds[0];
      if (!deleted) throw new Error('fixture has no saved sessions');
      await repository.deleteSession(deleted);
      expectConsistent(await readDatabase(name));
      await repository.importSaved(parseArchive(JSON.parse(archiveText)), later + 2);
      expectConsistent(await readDatabase(name));
      // short retention removes old automatic backups except the newest
      expect(await repository.setStorageSettings({ retentionDays: 1, maxBackups: null, maxStorageMB: 250 }, 100, later + 3)).toEqual({ kind: 'saved' });
      expectConsistent(await readDatabase(name));
      for (const id of savedIds.slice(1)) expect((await repository.get(id)).windows).toEqual(expectedWindows(dump.stores.snapshots.find(([key]) => key === id)![1]));
    } finally { await repository.close(); }
  });
});

describe('released version 1 archive', () =>
{
  it('parses as a whole file and as a stream', async () =>
  {
    const parsed = parseArchive(JSON.parse(archiveText));
    const streamed: ArchiveSession[] = [];
    for await (const session of readArchiveFile(new Blob([archiveText]))) streamed.push(session);
    expect(streamed).toEqual(parsed.sessions);
    expect(parsed.sessions.length).toBeGreaterThan(0);
  });

  it('imports into an empty installation with every tab, group, name, and tag', async () =>
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    try {
      const sessions = parseArchive(JSON.parse(archiveText)).sessions;
      expect(await repository.importSaved(readArchiveFile(new Blob([archiveText])), 1000)).toBe(sessions.length);
      expectConsistent(await readDatabase(name));
      const imported: ArchiveSession[] = [];
      await repository.exportSaved(session => { imported.push(session); });
      const key = (session: ArchiveSession) => JSON.stringify(session);
      expect(imported.map(key).sort()).toEqual(sessions.map(key).sort());
    } finally { await repository.close(); }
  });
});

describe('released placeholder tab addresses', () =>
{
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
  // placeholder tabs that may still be open after an update
  it.each([
    [`${origin}restore.html#url=https%3A%2F%2Fexample.org%2Fsearch%3Fq%3Dtab%2Bbackup%26lang%3Den%23results&title=Search%3A+%22tab+backup%22+%26+more`, { url: 'https://example.org/search?q=tab+backup&lang=en#results', title: 'Search: "tab backup" & more' }],
    [`${origin}restore.html#url=https%3A%2F%2F%E4%BE%8B%E3%81%88.%E3%83%86%E3%82%B9%E3%83%88%2F%E3%83%91%E3%82%B9%3F%E5%90%8D%E5%89%8D%3D%E5%80%A4&title=Unicode+%E3%83%9A%E3%83%BC%E3%82%B8`, { url: 'https://例え.テスト/パス?名前=値', title: 'Unicode ページ' }],
    [`${origin}restore.html#url=http%3A%2F%2F127.0.0.1%3A8080%2Fpage`, { url: 'http://127.0.0.1:8080/page', title: '' }],
  ])('reads %s', (address, target) =>
  {
    expect(placeholderTarget(address, origin)).toEqual(target);
    expect(placeholderTarget(placeholderUrl(origin, target.url, target.title), origin)).toEqual(target);
  });
});
