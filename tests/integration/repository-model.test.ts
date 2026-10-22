import fc from 'fast-check';
import { expect, it } from 'vitest';
import { Repository } from '../../src/database';
import type { Archive } from '../../src/archive';
import type { SavedGroup, SavedWindow, Session, StorageSettings } from '../../src/model';
import { canonicalSession } from '../../src/session';
import { expectConsistent, readDatabase } from '../support/invariants';

// few pages so sessions share tabs and get compared
const pages = [
  { url: 'https://example.com/', title: 'Example' },
  { url: 'https://example.org/docs', title: 'Docs' },
  { url: 'https://example.net/a?b=c#d', title: 'Query' },
  { url: 'file:///C:/notes.txt', title: 'Notes' },
  { url: null, title: 'No address' },
];
const window = fc.record({
  groups: fc.constantFrom<SavedGroup[]>([], [{ name: 'Work', color: 'blue', collapsed: false }]),
  tabs: fc.array(fc.record({ page: fc.constantFrom(...pages), pinned: fc.boolean(), grouped: fc.boolean() }), { minLength: 1, maxLength: 4 }),
}).map(({ groups, tabs }): SavedWindow => ({ groups, tabs: tabs.map(({ page, pinned, grouped }) => ({ ...page, pinned, group: grouped && groups.length ? 0 : null })) }));
const session = fc.array(window, { minLength: 1, maxLength: 2 }).map((windows): Session => ({ windows }));
const name = fc.option(fc.constantFrom('Research', 'Trip ✈', 'A'.repeat(100)), { nil: null });
const tags = fc.uniqueArray(fc.constantFrom('work', 'later', 'trip'), { maxLength: 3 });
const minutes = fc.integer({ min: 0, max: 3 * 24 * 60 });

type Expected = { windows: SavedWindow[]; name: string | null; tags: string[] };
type Model = { now: number; saved: Map<string, Expected> };
type Real = { repository: Repository; name: string };

async function ids(repository: Repository, collection: 'automatic' | 'saved'): Promise<string[]>
{
  return (await repository.history(null, 10_000, collection)).items.map(item => item.id).sort();
}

async function pick(repository: Repository, collection: 'automatic' | 'saved', index: number): Promise<string | undefined>
{
  const list = await ids(repository, collection);
  return list[index % Math.max(1, list.length)];
}

// after each command check the stores and every saved session
async function verify(model: Model, real: Real): Promise<void>
{
  expectConsistent(await readDatabase(real.name));
  expect(await ids(real.repository, 'saved')).toEqual([...model.saved.keys()].sort());
  for (const [id, expected] of model.saved) {
    const snapshot = await real.repository.get(id);
    expect({ windows: snapshot.windows, name: snapshot.name, tags: snapshot.tags ?? [] }).toEqual(expected);
  }
}

class Capture implements fc.AsyncCommand<Model, Real>
{
  constructor(readonly session: Session, readonly source: 'automatic' | 'manual', readonly name: string | null, readonly wait: number) {}
  check = () => true;
  async run(model: Model, real: Real)
  {
    model.now += this.wait * 60_000;
    const result = await real.repository.capture(this.session, this.source, model.now, this.name);
    if (this.source === 'manual') {
      expect(result.kind).toBe('saved');
      if (result.kind === 'saved') model.saved.set(result.id, { windows: this.session.windows, name: this.name, tags: [] });
    }
    await verify(model, real);
  }
  toString = () => `capture(${this.source}, ${canonicalSession(this.session).length} chars, +${this.wait}m)`;
}

class Keep implements fc.AsyncCommand<Model, Real>
{
  constructor(readonly index: number, readonly name: string | null, readonly tags: string[]) {}
  check = () => true;
  async run(model: Model, real: Real)
  {
    const id = await pick(real.repository, 'automatic', this.index);
    if (!id) return;
    const { windows } = await real.repository.get(id);
    await real.repository.keep(id, this.name, model.now, { tags: this.tags });
    model.saved.set(id, { windows, name: this.name, tags: this.tags });
    await verify(model, real);
  }
  toString = () => `keep(${this.index}, ${this.name}, [${this.tags}])`;
}

class Rename implements fc.AsyncCommand<Model, Real>
{
  constructor(readonly index: number, readonly name: string | null, readonly tags: string[]) {}
  check = (model: Readonly<Model>) => model.saved.size > 0;
  async run(model: Model, real: Real)
  {
    const id = await pick(real.repository, 'saved', this.index);
    const expected = id && model.saved.get(id);
    if (!id || !expected) return;
    await real.repository.rename(id, this.name, { tags: this.tags });
    model.saved.set(id, { ...expected, name: this.name, tags: this.tags });
    await verify(model, real);
  }
  toString = () => `rename(${this.index}, ${this.name}, [${this.tags}])`;
}

class Delete implements fc.AsyncCommand<Model, Real>
{
  constructor(readonly collection: 'automatic' | 'saved', readonly index: number) {}
  check = () => true;
  async run(model: Model, real: Real)
  {
    const id = await pick(real.repository, this.collection, this.index);
    if (!id) return;
    try {
      await real.repository.deleteSession(id);
      model.saved.delete(id);
    } catch (error) {
      // only the newest automatic backup cannot be deleted
      expect(this.collection).toBe('automatic');
      expect((error as Error).message).toBe('The newest automatic backup cannot be deleted.');
    }
    await verify(model, real);
  }
  toString = () => `delete(${this.collection}, ${this.index})`;
}

class Limits implements fc.AsyncCommand<Model, Real>
{
  constructor(readonly settings: StorageSettings) {}
  check = () => true;
  async run(model: Model, real: Real)
  {
    // limits only remove automatic backups
    expect(await real.repository.setStorageSettings(this.settings, Number.MAX_SAFE_INTEGER, model.now)).toEqual({ kind: 'saved' });
    await verify(model, real);
  }
  toString = () => `limits(${JSON.stringify(this.settings)})`;
}

class Import implements fc.AsyncCommand<Model, Real>
{
  constructor(readonly sessions: { session: Session; name: string | null; tags: string[]; ago: number }[]) {}
  check = () => true;
  async run(model: Model, real: Real)
  {
    const before = new Set(await ids(real.repository, 'saved'));
    const archive: Archive = { format: 'tabblackbox', version: 1, sessions: this.sessions.map(item => ({ windows: item.session.windows, name: item.name, capturedAt: Math.max(0, model.now - item.ago * 60_000), source: 'automatic', ...(item.tags.length ? { tags: item.tags } : {}) })) };
    expect(await real.repository.importSaved(archive, model.now)).toBe(this.sessions.length);
    const added = (await ids(real.repository, 'saved')).filter(id => !before.has(id));
    const imported = await Promise.all(added.map(async id => {
      const snapshot = await real.repository.get(id);
      const expected = { windows: snapshot.windows, name: snapshot.name, tags: snapshot.tags ?? [] };
      model.saved.set(id, expected);
      return JSON.stringify(expected);
    }));
    expect(imported.sort()).toEqual(this.sessions.map(item => JSON.stringify({ windows: item.session.windows, name: item.name, tags: item.tags })).sort());
    await verify(model, real);
  }
  toString = () => `import(${this.sessions.length})`;
}

const commands = [
  fc.tuple(session, fc.constantFrom('automatic' as const, 'manual' as const), name, minutes).map(([value, source, label, wait]) => new Capture(value, source, label, wait)),
  fc.tuple(fc.nat(), name, tags).map(([index, label, list]) => new Keep(index, label, list)),
  fc.tuple(fc.nat(), name, tags).map(([index, label, list]) => new Rename(index, label, list)),
  fc.tuple(fc.constantFrom('automatic' as const, 'saved' as const), fc.nat()).map(([collection, index]) => new Delete(collection, index)),
  fc.record({ retentionDays: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }), maxBackups: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }), maxStorageMB: fc.constant(100) }).map(settings => new Limits(settings)),
  fc.array(fc.record({ session, name, tags, ago: minutes }), { minLength: 1, maxLength: 3 }).map(items => new Import(items)),
];

it('keeps every saved session and consistent stores across random operation sequences', async () =>
{
  await fc.assert(fc.asyncProperty(fc.commands(commands, { maxCommands: 40, size: 'large' }), async sequence => {
    const real: Real = { name: crypto.randomUUID(), repository: undefined as unknown as Repository };
    real.repository = new Repository(real.name);
    try {
      await fc.asyncModelRun(() => ({ model: { now: Date.UTC(2026, 0, 1), saved: new Map() }, real }), sequence);
    } finally { await real.repository.close(); }
  }), { numRuns: 100 });
}, 120_000);
