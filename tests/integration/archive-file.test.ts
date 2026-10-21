import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { openDB } from 'idb';
import { Repository } from '../../src/database';
import { ARCHIVE_FILE_LIMIT, ARCHIVE_VALUE_LIMIT, readArchiveFile, exportArchiveFile } from '../../src/archive-file';
import { parseArchive, type Archive, type ArchiveSession } from '../../src/archive';

const session: ArchiveSession = { name: 'Research 🧪', source: 'automatic', capturedAt: 1000, tags: ['work'], windows: [{ groups: [], tabs: [{ url: 'https://example.test', title: 'A "quoted" title } ], \\', pinned: false, group: null }] }] };
const archive = (sessions = [session]): Archive => ({ format: 'tabblackbox', version: 1, sessions });

async function collect(file: Blob): Promise<ArchiveSession[]>
{
  const result: ArchiveSession[] = [];
  for await (const item of readArchiveFile(file)) result.push(item);
  return result;
}

it('reads legacy archives across UTF-8 and JSON token boundaries with reordered properties', async () => {
  const text = JSON.stringify({ sessions: [session, session], extra: { ignored: [true, null] }, version: 1, format: 'tabblackbox' });
  const bytes = new TextEncoder().encode(text);
  const file = new Blob([bytes]);
  file.stream = () => new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  expect(await collect(file)).toEqual(parseArchive(JSON.parse(text)).sessions);
});

it('accepts archives saved with a UTF-8 byte order mark', async () => {
  const bytes = new TextEncoder().encode(`﻿${JSON.stringify(archive(), null, 2)}`);
  const file = new Blob([bytes]);
  file.stream = () => new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  expect(await collect(file)).toEqual([session]);
});

it.each([
  '{"format":"tabblackbox","version":1,"sessions":[]}',
  JSON.stringify(archive()).slice(0, -1),
  `${JSON.stringify(archive())} false`,
  JSON.stringify(archive()).replace(']}', ',]}'),
  JSON.stringify(archive()).replace('"version":1', '"version":2'),
  JSON.stringify(archive()).replace('"version":1', '"version":1,"version":1'),
])('rejects malformed or unsupported archive envelopes', async text => {
  await expect(collect(new Blob([text]))).rejects.toThrow();
});

it('keeps staged imports invisible and rolls back a late validation failure', async () => {
  const name = crypto.randomUUID();
  const repository = new Repository(name);
  try {
    const before = await repository.metadata();
    async function* invalid() {
      yield session;
      expect(await repository.list()).toEqual([]);
      throw new Error('Invalid archive tail');
    }
    await expect(repository.importSaved(invalid(), 2000)).rejects.toThrow('Invalid archive tail');
    expect(await repository.metadata()).toEqual(before);
    const db = await openDB(name);
    expect(await db.count('imports')).toBe(0);
    db.close();
  } finally { await repository.close(); }
});

it('aborts final publication without changing counters or recovery history', async () => {
  const repository = new Repository(crypto.randomUUID());
  const controller = new AbortController();
  try {
    await repository.capture(session, 'automatic', 500);
    const before = await repository.metadata();
    await expect(repository.importSaved(archive(), 2000, controller.signal, () => controller.abort())).rejects.toThrow();
    expect(await repository.metadata()).toEqual(before);
    expect((await repository.history(null, 10, 'saved')).count).toBe(0);
  } finally { await repository.close(); }
});

it('exports valid multi-session JSON without a progress callback', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.importSaved(archive([session, session]), 2000);
    expect(await collect(await exportArchiveFile(repository, 'json'))).toEqual([session, session]);
  } finally { await repository.close(); }
});

it('enforces the JSON session limit without a progress callback', async () => {
  const name = crypto.randomUUID();
  const repository = new Repository(name);
  try {
    await repository.capture(session, 'manual', 1000);
    const db = await openDB(name);
    try {
      const saved = (await db.getAll('snapshots'))[0];
      if (!saved) throw new Error('Fixture missing');
      const tx = db.transaction('snapshots', 'readwrite');
      await Promise.all(Array.from({ length: 25_000 }, (_, index) => tx.store.add({ ...saved, id: `export-${index}`, number: index + 2 })));
      await tx.done;
    } finally { db.close(); }
    await expect(exportArchiveFile(repository, 'json')).rejects.toThrow('25,000');
  } finally { await repository.close(); }
});

it('exports a consistent snapshot while a concurrent capture waits, and preserves all formats', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.importSaved(archive(), 2000);
    let capture: ReturnType<Repository['capture']> | undefined;
    const file = await exportArchiveFile(repository, 'json', undefined, undefined, () => { capture ??= repository.capture(session, 'manual', 3000); });
    expect(await collect(file)).toEqual([session]);
    await capture;
    expect((await repository.history(null, 10, 'saved')).count).toBe(2);
    for (const format of ['markdown', 'urls', 'bookmarks'] as const) {
      expect((await (await exportArchiveFile(repository, format)).text()).length).toBeGreaterThan(0);
    }
  } finally { await repository.close(); }
});

it('limits file size, individual values and nesting before publishing any sessions', async () => {
  const oversized = new Blob();
  Object.defineProperty(oversized, 'size', { value: ARCHIVE_FILE_LIMIT + 1 });
  await expect(collect(oversized)).rejects.toThrow('1 GB');
  await expect(collect(new Blob([JSON.stringify({ ...archive(), extra: 'x'.repeat(ARCHIVE_VALUE_LIMIT) })]))).rejects.toThrow('character import limit');
  await expect(collect(new Blob(['{"extra":', '['.repeat(33), '0', ']'.repeat(33), '}']))).rejects.toThrow('nesting');
});

it('cleans abandoned staging but never clears another active import', async () => {
  const name = crypto.randomUUID();
  const first = new Repository(name);
  const second = new Repository(name);
  try {
    await first.metadata();
    const db = await openDB(name);
    await db.add('imports', session, 1);
    await second.clearAbandonedImport();
    expect(await db.count('imports')).toBe(0);
    async function* sessions() {
      yield session;
      await second.clearAbandonedImport();
      expect(await db.count('imports')).toBe(1);
      await second.capture(session, 'automatic', 500);
      yield session;
    }
    await first.importSaved(sessions(), 2000);
    expect(await db.count('imports')).toBe(0);
    expect((await second.metadata()).lastSessionNumbers).toEqual({ automatic: 1, manual: 2 });
    expect((await second.history(null, 10, 'automatic')).count).toBe(1);
    db.close();
  } finally { await first.close(); await second.close(); }
});

it('rolls back staged sessions when the file has an invalid final envelope', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    const before = await repository.metadata();
    const file = new Blob([JSON.stringify({ sessions: [session], format: 'other', version: 1 })]);
    await expect(repository.importSaved(readArchiveFile(file), 2000)).rejects.toThrow('TabBlackBox');
    expect(await repository.metadata()).toEqual(before);
    expect(await repository.list()).toEqual([]);
  } finally { await repository.close(); }
});

it('refuses to download a JSON session that exceeds the importer value limit', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.capture({ windows: [{ groups: [], tabs: [{ url: null, title: 'x'.repeat(ARCHIVE_VALUE_LIMIT), pinned: false, group: null }] }] }, 'manual', 1000);
    await expect(exportArchiveFile(repository, 'json')).rejects.toThrow('character import limit');
  } finally { await repository.close(); }
});

it('cancels an export while its read transaction is queued behind a writer', async () => {
  const name = crypto.randomUUID();
  const repository = new Repository(name);
  let release = false;
  let db: Awaited<ReturnType<typeof openDB>> | undefined;
  try {
    await repository.importSaved(archive(), 2000);
    db = await openDB(name);
    const tx = db.transaction('snapshots', 'readwrite');
    const hold = async () => { while (!release) await tx.store.count(); };
    const held = hold();
    const controller = new AbortController();
    const result = exportArchiveFile(repository, 'json', undefined, controller.signal).then(() => 'completed', () => 'aborted');
    setTimeout(() => controller.abort(), 0);
    try {
      expect(await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('blocked'), 200))])).toBe('aborted');
    } finally { release = true; await held; await tx.done; await result; }
  } finally { release = true; db?.close(); await repository.close(); }
});
