import { describe, expect, it, vi } from 'vitest';
import { Repository } from '../../src/database';
import type { Session } from '../../src/model';
import { expectConsistent, readDatabase, type DatabaseContents } from '../support/invariants';

const writes = ['put', 'add', 'delete', 'clear'] as const;
type Mode = 'quota' | 'abort';

// make the nth write fail like a full disk or an abandoned transaction
function failWrite(at: number, mode: Mode): { count: () => number; restore: () => void }
{
  let count = 0;
  const spies = writes.map(method => {
    const original = IDBObjectStore.prototype[method] as (...args: unknown[]) => IDBRequest;
    return vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
      if (++count !== at) return original.apply(this, args);
      if (mode === 'quota') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      const request = original.apply(this, args);
      this.transaction.abort();
      return request;
    } as never);
  });
  return { count: () => count, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

const tab = (path: string, title = path) => ({ url: `https://example.test/${path}`, title, pinned: false, group: null });
const session = (...paths: string[]): Session => ({ windows: [{ groups: [{ name: 'Work', color: 'green', collapsed: false }], tabs: paths.map((path, index) => ({ ...tab(path), group: index === 0 ? 0 : null })) }] });
const DAY = 86_400_000;

type Scenario = { name: string; setup: (repository: Repository) => Promise<Record<string, string>>; act: (repository: Repository, ids: Record<string, string>) => Promise<unknown> };

async function saved(result: Promise<{ kind: string; id?: string }>): Promise<string>
{
  const value = await result;
  if (value.kind !== 'saved' || !value.id) throw new Error('setup capture was not saved');
  return value.id;
}

// automatic history, a kept session and manual backups
async function history(repository: Repository): Promise<Record<string, string>>
{
  const first = await saved(repository.capture(session('a', 'b'), 'automatic', 1 * DAY));
  const second = await saved(repository.capture(session('a', 'b', 'c'), 'automatic', 2 * DAY));
  const third = await saved(repository.capture(session('b', 'c', 'd'), 'automatic', 3 * DAY));
  const manual = await saved(repository.capture(session('m', 'a'), 'manual', 4 * DAY, 'Manual'));
  const latest = await saved(repository.capture(session('c', 'd', 'e'), 'automatic', 5 * DAY));
  await repository.keep(second, 'Kept', 5 * DAY, { tags: ['kept'] });
  return { first, second, third, manual, latest };
}

const scenarios: Scenario[] = [
  { name: 'automatic capture with pruning', setup: async repository => {
    const ids = await history(repository);
    await repository.setStorageSettings({ retentionDays: null, maxBackups: 3, maxStorageMB: 100 }, 100, 5 * DAY);
    return ids;
  }, act: repository => repository.capture(session('x', 'c', 'y'), 'automatic', 6 * DAY) },
  { name: 'manual capture', setup: history, act: repository => repository.capture(session('n', 'a', 'b'), 'manual', 6 * DAY, 'New') },
  { name: 'keeping an automatic backup', setup: history, act: (repository, ids) => repository.keep(ids.third!, 'Later', 6 * DAY, { tags: ['later'] }) },
  { name: 'renaming a saved session', setup: history, act: (repository, ids) => repository.rename(ids.manual!, 'Renamed', { tags: ['a', 'b'] }) },
  { name: 'deleting a saved session', setup: history, act: (repository, ids) => repository.deleteSession(ids.second!) },
  { name: 'deleting an automatic backup', setup: history, act: (repository, ids) => repository.deleteSession(ids.third!) },
  { name: 'storage limits that remove backups', setup: history, act: repository => repository.setStorageSettings({ retentionDays: 1, maxBackups: null, maxStorageMB: 100 }, 100, 6 * DAY) },
  { name: 'importing sessions', setup: history, act: repository => repository.importSaved({ format: 'tabblackbox', version: 1, sessions: [
    { windows: session('i', 'a').windows, name: 'Imported', capturedAt: 2.5 * DAY, source: 'automatic', tags: ['import'] },
    { windows: session('j').windows, name: null, capturedAt: 4.5 * DAY, source: 'manual' },
  ] }, 6 * DAY) },
];

// committed state without import staging
function committed({ imports: _, ...contents }: DatabaseContents)
{
  return contents;
}

describe.each(scenarios)('$name', ({ setup, act }) =>
{
  async function prepare()
  {
    const name = crypto.randomUUID();
    const repository = new Repository(name);
    const ids = await setup(repository);
    return { name, repository, ids, before: await readDatabase(name) };
  }

  it('commits all of its changes or none at every failing write', async () =>
  {
    // count the writes of a normal run
    const reference = await prepare();
    const counter = failWrite(Infinity, 'quota');
    try { await act(reference.repository, reference.ids); } finally { counter.restore(); await reference.repository.close(); }
    const total = counter.count();
    expect(total).toBeGreaterThan(0);

    for (const mode of ['quota', 'abort'] as const) {
      let completed = 0;
      for (let at = 1; at <= total; at++) {
        const { name, repository, ids, before } = await prepare();
        const failure = failWrite(at, mode);
        let succeeded = false;
        try {
          await act(repository, ids);
          succeeded = true;
          completed++;
        } catch (error) {
          expect(error, `${mode} at write ${at} of ${total}`).toBeInstanceOf(Error);
        } finally { failure.restore(); }
        try {
          // pages clear leftover import staging on load
          await repository.clearAbandonedImport();
          const after = await readDatabase(name);
          expectConsistent(after);
          if (!succeeded) expect(committed(after), `${mode} at write ${at} of ${total} left partial changes`).toEqual(committed(before));
          // still works after the failure
          if (!succeeded) await act(repository, ids);
          expectConsistent(await readDatabase(name));
        } finally { await repository.close(); }
      }
      // only the cleanup after a finished import may fail silently
      expect(completed, `${mode} failures that did not stop the operation`).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});

it('reports a full disk as a storage error and keeps earlier backups', async () =>
{
  const name = crypto.randomUUID();
  const repository = new Repository(name);
  try {
    const ids = await history(repository);
    const before = await readDatabase(name);
    const failure = failWrite(1, 'quota');
    try {
      await expect(repository.capture(session('full'), 'manual', 6 * DAY)).rejects.toMatchObject({ name: 'QuotaExceededError' });
    } finally { failure.restore(); }
    expect(await readDatabase(name)).toEqual(before);
    expect((await repository.get(ids.manual!)).name).toBe('Manual');
  } finally { await repository.close(); }
});
