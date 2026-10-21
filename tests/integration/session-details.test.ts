import { exportArchive } from '../support/archive';
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { Repository } from '../../src/database';
import { parseArchive, SESSION_TAG_LENGTH_LIMIT, SESSION_TAG_LIMIT } from '../../src/archive';
import { parseRequest } from '../../src/protocol';

const session = (title: string) => ({ windows: [{ groups: [], tabs: [{ url: 'https://example.test', title, pinned: false, group: null }] }] });

it('stores tags on manual backups and searches them', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    const automatic = await repository.capture(session('automatic'), 'automatic', 1000);
    const manual = await repository.capture(session('manual'), 'manual', 2000);
    if (automatic.kind !== 'saved' || manual.kind !== 'saved') throw new Error('Fixture missing');
    const kept = await repository.keep(automatic.id, 'Kept', 3000, { tags: ['research', 'deep work'] });
    expect(kept).toMatchObject({ tags: ['research', 'deep work'] });
    expect(await repository.get(automatic.id)).toMatchObject({ tags: ['research', 'deep work'] });
    const names = async (query: string) => (await repository.history(null, 10, 'saved', query)).items.map(item => item.id);
    expect(await names('deep')).toEqual([automatic.id]);
    expect(await names('kept')).toEqual([automatic.id]);
    expect(await names('')).toHaveLength(2);
    // omitted details leave tags unchanged while empty details clear them
    expect(await repository.rename(automatic.id, 'Renamed')).toMatchObject({ name: 'Renamed', tags: ['research', 'deep work'] });
    const cleared = await repository.rename(automatic.id, 'Renamed', { tags: [] });
    expect(cleared).not.toHaveProperty('tags');
    expect(await names('research')).toEqual([]);
  } finally { await repository.close(); }
});

it('rejects tags on automatic backups and rolls the update back', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    const automatic = await repository.capture(session('automatic'), 'automatic', 1000);
    if (automatic.kind !== 'saved') throw new Error('Fixture missing');
    const metadata = await repository.metadata();
    await expect(repository.rename(automatic.id, 'Named', { tags: ['research'] })).rejects.toThrow('only available for manual backups');
    await expect(repository.keep(automatic.id, 'Named', 2000, { tags: [] })).resolves.toMatchObject({ savedAt: 2000 });
    expect((await repository.metadata()).lastSessionNumbers.manual).toBe(metadata.lastSessionNumbers.manual + 1);
    expect(await repository.get(automatic.id)).not.toHaveProperty('tags');
  } finally { await repository.close(); }
});

it('exports and imports tags and accepts archives without them', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    const manual = await repository.capture(session('manual'), 'manual', 1000);
    if (manual.kind !== 'saved') throw new Error('Fixture missing');
    await repository.rename(manual.id, 'Tagged', { tags: ['research'] });
    const archive = parseArchive(JSON.parse(JSON.stringify(await exportArchive(repository))));
    expect(archive.sessions[0]).toMatchObject({ tags: ['research'] });
    await repository.importSaved(archive, 2000);
    expect((await repository.history(null, 10, 'saved', 'research')).items).toHaveLength(2);
    const plain = JSON.parse(JSON.stringify(archive)) as { sessions: Record<string, unknown>[] };
    delete plain.sessions[0]?.tags;
    expect(parseArchive(plain).sessions[0]).not.toHaveProperty('tags');
    expect(() => parseArchive({ ...plain, sessions: [{ ...plain.sessions[0], tags: 'research' }] })).toThrow('Invalid session tags.');
  } finally { await repository.close(); }
});

it('validates details at the message boundary', () =>
{
  const request = { kind: 'rename', id: 'saved', name: null };
  expect(parseRequest(request)).toEqual(request);
  expect(parseRequest({ ...request, details: { tags: [' A ', 'a', 'B'] } })).toEqual({ ...request, details: { tags: ['a', 'b'] } });
  const tooMany = Array.from({ length: SESSION_TAG_LIMIT + 1 }, (_, index) => `tag ${index}`);
  for (const details of [undefined, null, {}, { tags: 'a' }, { tags: [5] }, { tags: ['x'.repeat(SESSION_TAG_LENGTH_LIMIT + 1)] }, { tags: tooMany }]) {
    expect(() => parseRequest({ ...request, details })).toThrow();
  }
});

it('filters history by an exact tag instead of matching tag text', async () =>
{
  const repository = new Repository(crypto.randomUUID());
  try {
    const dev = await repository.capture(session('dev'), 'manual', 1000, 'Development');
    const devops = await repository.capture(session('devops'), 'manual', 2000, 'Operations');
    if (dev.kind !== 'saved' || devops.kind !== 'saved') throw new Error('Fixture missing');
    await repository.rename(dev.id, 'Development', { tags: ['dev'] });
    await repository.rename(devops.id, 'Operations', { tags: ['devops'] });
    const ids = async (tag?: string) => (await repository.history(null, 10, 'saved', 'dev', 'date-desc', undefined, undefined, undefined, tag)).items.map(item => item.id);
    expect(await ids()).toEqual([devops.id, dev.id]);
    expect(await ids('dev')).toEqual([dev.id]);
  } finally { await repository.close(); }
});

it('accepts only normalized tags as history filters', () =>
{
  const request = { kind: 'history', before: null, collection: 'saved', query: 'dev' };
  expect(parseRequest({ ...request, tag: 'dev' })).toEqual({ ...request, tag: 'dev' });
  for (const tag of ['', ' dev', 'Dev', 5, 'x'.repeat(SESSION_TAG_LENGTH_LIMIT + 1)]) expect(() => parseRequest({ ...request, tag })).toThrow();
});
