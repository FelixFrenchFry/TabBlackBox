import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { Repository } from '../../src/database';
import { compareHistory } from '../../src/history';
import * as history from '../../src/history';
import type { HistorySort } from '../../src/model';
import { parseRequest } from '../../src/protocol';

const session = (title: string) => ({ windows: [{ groups: [], tabs: [{ url: 'https://example.test', title, pinned: false, group: null }] }] });
const orders: { sort: HistorySort; numbers: number[] }[] = [
  { sort: 'date-desc', numbers: [3, 1, 4, 2] },
  { sort: 'date-asc', numbers: [2, 4, 1, 3] },
  { sort: 'number-desc', numbers: [4, 3, 2, 1] },
  { sort: 'number-asc', numbers: [1, 2, 3, 4] },
];

it('returns collection totals without comparing sort keys for count-only requests', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    await repository.capture(session('first'), 'automatic', 100);
    await repository.capture(session('second'), 'automatic', 200);
    await repository.capture(session('manual'), 'manual', 300);
    const expected = await repository.history(null, 10, 'automatic');
    const compare = vi.spyOn(history, 'compareHistory');
    try {
      for (const { sort } of orders) {
        const result = await repository.history(null, 0, 'automatic', '', sort);
        expect(result).toEqual({ items: [], count: 2, bytes: expected.bytes });
      }
      expect(compare).not.toHaveBeenCalled();
    } finally { compare.mockRestore(); }
  } finally { await repository.close(); }
});

it.each(orders)('sorts the full collection and pages after a deleted anchor in $sort order', async ({ sort, numbers }) => {
  const repository = new Repository(crypto.randomUUID());
  try {
    // keep automatic captures in a different order from their capture dates
    for (const capturedAt of [300, 100, 400, 200]) {
      const result = await repository.capture(session(String(capturedAt)), 'automatic', capturedAt);
      if (result.kind !== 'saved') throw new Error('Fixture missing');
      await repository.keep(result.id, capturedAt >= 300 ? 'Research' : 'Other', 500);
    }
    await repository.capture(session('automatic'), 'automatic', 600);
    const first = await repository.history(null, 2, 'saved', '', sort);
    expect(first.items.map(item => item.number)).toEqual(numbers.slice(0, 2));
    expect(first.count).toBe(4);
    const anchor = first.items.at(-1);
    if (!anchor) throw new Error('Fixture missing');

    const search = await repository.history(null, 1, 'saved', 'research', sort);
    const found = search.items[0];
    if (!found) throw new Error('Fixture missing');
    const next = await repository.history(found, 1, 'saved', 'research', sort);
    expect([found, ...next.items].map(item => item.number)).toEqual(numbers.filter(number => number === 1 || number === 3));

    await repository.deleteSession(anchor.id);
    const rest = await repository.history(anchor, 2, 'saved', '', sort);
    expect(rest.items.map(item => item.number)).toEqual(numbers.slice(2));
    expect(rest.count).toBe(3);
    expect((await repository.history(null, 10, 'automatic', '', sort)).items).toHaveLength(1);
    expect((await repository.history()).items.map(item => item.capturedAt)).toEqual([600, 400, 300, 200, 100].filter(date => date !== anchor.capturedAt));
  } finally { await repository.close(); }
});

it.each(['date-desc', 'date-asc'] as const)('pages tied capture dates consistently in %s order', async sort => {
  const repository = new Repository(crypto.randomUUID());
  try {
    for (let index = 0; index < 4; index++) await repository.capture(session(String(index)), 'manual', 100);
    const all = (await repository.history(null, 10, 'saved', '', sort)).items;
    const ids = all.map(item => item.id).sort();
    if (sort === 'date-desc') ids.reverse();
    expect(all.map(item => item.id)).toEqual(ids);
    const first = await repository.history(null, 2, 'saved', '', sort);
    const anchor = first.items.at(-1);
    if (!anchor) throw new Error('Fixture missing');
    await repository.deleteSession(anchor.id);
    expect((await repository.history(anchor, 2, 'saved', '', sort)).items.map(item => item.id)).toEqual(ids.slice(2));
  } finally { await repository.close(); }
});

it('uses the selected order to decide when refresh has reached a retained row', () => {
  const a = { capturedAt: 100, number: 3, id: 'a' };
  const b = { capturedAt: 200, number: 1, id: 'b' };
  expect(compareHistory(a, b, 'date-asc')).toBeLessThan(0);
  expect(compareHistory(a, b, 'date-desc')).toBeGreaterThan(0);
  expect(compareHistory(a, b, 'number-asc')).toBeGreaterThan(0);
  expect(compareHistory(a, b, 'number-desc')).toBeLessThan(0);
});

it('validates sort choices and numeric cursor boundaries', () => {
  const before = { capturedAt: 100, number: 2, id: 'saved' };
  for (const { sort } of orders) expect(parseRequest({ kind: 'history', before, sort })).toEqual({ kind: 'history', before, sort });
  for (const sort of [null, '', 'date', 'number', 1]) expect(() => parseRequest({ kind: 'history', before: null, sort })).toThrow('Invalid history sort order');
  for (const number of [undefined, 0, -1, 1.5, Infinity, '2']) expect(() => parseRequest({ kind: 'history', before: { ...before, number }, sort: 'number-asc' })).toThrow('Invalid request');
});
