import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Repository } from '../../src/database';
import { parseRequest } from '../../src/protocol';
import { chartMaximum, parseTabChartPeriod, tabChartRange, thinTabCounts } from '../../src/chart';
import type { SavedTab, Session } from '../../src/model';

const page = (path: string): SavedTab => ({ url: `https://example.test/${path}`, title: path, pinned: false, group: null });
const session = (count: number): Session => ({ windows: [{ groups: [], tabs: Array.from({ length: count }, (_, index) => page(String(index))) }] });

describe('tab count chart', () =>
{
  it('accepts only the offered periods and ends the range after now', () =>
  {
    expect(parseTabChartPeriod('30')).toBe(30);
    for (const value of [null, '', '2', 7, 'seven']) expect(() => parseTabChartPeriod(value)).toThrow('Invalid tab chart period');
    expect(tabChartRange(10 * 86_400_000, 7)).toEqual({ start: 3 * 86_400_000, end: 10 * 86_400_000 + 1 });
  });

  it('rounds the count axis up to whole midpoints', () =>
  {
    expect([0, 1, 10, 11, 20, 21, 50, 51, 100, 101, 999, 1000].map(chartMaximum)).toEqual([10, 10, 10, 20, 20, 50, 50, 100, 100, 200, 1000, 1000]);
  });

  it('keeps dense history within the limit while preserving drops, peaks, and the newest count', () =>
  {
    const range = { start: 0, end: 1000 };
    const points = Array.from({ length: 1000 }, (_, index) => ({ capturedAt: index, tabCount: index === 500 ? 0 : index === 501 ? 999 : 100 + index % 7 }));
    expect(thinTabCounts(points.slice(0, 10), range, 20)).toEqual(points.slice(0, 10));
    const thinned = thinTabCounts(points, range, 101);
    expect(thinned.length).toBeLessThanOrEqual(101);
    expect(thinned).toContain(points[500]);
    expect(thinned).toContain(points[501]);
    expect(thinned.at(-1)).toBe(points.at(-1));
    expect(thinned.map(point => point.capturedAt)).toEqual([...thinned.map(point => point.capturedAt)].sort((a, b) => a - b));
  });

  it('keeps the final count of each bucket so step levels match after a temporary peak', () =>
  {
    const range = { start: 0, end: 100 };
    const points = Array.from({ length: 100 }, (_, index) => ({ capturedAt: index, tabCount: index % 10 === 5 ? 60 : 50 }));
    const thinned = thinTabCounts(points, range, 31);
    expect(thinned.length).toBeLessThanOrEqual(31);
    for (let bucket = 0; bucket < 10; bucket++) expect(thinned).toContain(points[bucket * 10 + 9]);
  });

  it('returns counts within the period and the newest earlier automatic count', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    try {
      const early = await repository.capture(session(3), 'automatic', 1000);
      await repository.capture(session(9), 'manual', 1500);
      const inside = await repository.capture(session(5), 'automatic', 2000);
      const manual = await repository.capture(session(4), 'manual', 2500);
      await repository.capture(session(6), 'automatic', 4000);
      if (early.kind !== 'saved' || inside.kind !== 'saved' || manual.kind !== 'saved') throw new Error('Fixture missing');
      expect(await repository.tabCounts({ start: 2000, end: 4000 })).toEqual({
        points: [
          { id: inside.id, number: 2, capturedAt: 2000, tabCount: 5, windowCount: 1, collection: 'automatic' },
          { id: manual.id, number: 2, capturedAt: 2500, tabCount: 4, windowCount: 1, collection: 'saved' },
        ],
        before: { id: early.id, number: 1, capturedAt: 1000, tabCount: 3, windowCount: 1, collection: 'automatic' },
      });
      expect(await repository.tabCounts({ start: 0, end: 500 })).toEqual({ points: [], before: null });
    } finally { await repository.close(); }
  });

  it('accepts chart requests with a valid range', () =>
  {
    expect(parseRequest({ kind: 'tab-counts', range: { start: 0, end: 1 } })).toEqual({ kind: 'tab-counts', range: { start: 0, end: 1 } });
    expect(() => parseRequest({ kind: 'tab-counts' })).toThrow('Invalid request');
    expect(() => parseRequest({ kind: 'tab-counts', range: { start: 1, end: 1 } })).toThrow('Invalid history date range');
  });
});
