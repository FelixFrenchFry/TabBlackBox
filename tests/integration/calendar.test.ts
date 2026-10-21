import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { Repository } from '../../src/database';
import { parseRequest } from '../../src/protocol';
import { calendarRange, calendarScale, dayRange } from '../../src/calendar';

const session = (title: string) => ({ windows: [{ groups: [], tabs: [{ url: 'https://example.test', title, pinned: false, group: null }] }] });
const start = new Date(2026, 8, 20).getTime();
const end = new Date(2026, 8, 21).getTime();
// host zone before any test changes TZ
const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// run a check in another zone and restore by assignment, since deleting TZ keeps the cached zone
function withTimeZone(zone: string, check: () => void): void
{
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { check(); }
  finally { process.env.TZ = previous ?? hostTimeZone; }
}

it('scales non-empty days by thirds without splitting equal counts', () => {
  const thresholds = (counts: number[]) => calendarScale(counts).map(band => band.maximum);
  const counts = [1000, 0, 80, 40, 70, 50, 60, 90, 100, 0];
  expect(thresholds(counts)).toEqual([60, 90, 1000]);
  expect(counts[0]).toBe(1000);
  expect(thresholds([0, 0])).toEqual([]);
  expect(thresholds([])).toEqual([]);
  expect(thresholds([283, 283, 283])).toEqual([283]);
  expect(thresholds([1, 15])).toEqual([1, 15]);
  expect(thresholds([1, 1, 1, 1, 1, 1, 2, 1000])).toEqual([1, 1000]);
});

it('spreads color bands across the palette and uses a medium green for equal days', () => {
  expect(calendarScale([0, 0])).toEqual([]);
  expect(calendarScale([0, 283, 283])).toEqual([{ minimum: 1, maximum: 283, level: 2 }]);
  expect(calendarScale([1, 15])).toEqual([
    { minimum: 1, maximum: 1, level: 1 },
    { minimum: 2, maximum: 15, level: 3 },
  ]);
  expect(calendarScale([1, 5, 15]).map(band => band.level)).toEqual([1, 2, 3]);
  expect(calendarScale([1, 5, 10, 15]).map(band => band.level)).toEqual([1, 2, 3]);
  expect(calendarScale([1, 1, 1, 1, 1, 1, 2, 1000]).map(band => band.level)).toEqual([1, 3]);
});

it('uses local calendar boundaries across daylight saving and year changes', () => {
  withTimeZone('Europe/Berlin', () => {
    const spring = dayRange(new Date(2026, 2, 29, 12).getTime());
    const autumn = dayRange(new Date(2026, 9, 25, 12).getTime());
    expect(spring.end - spring.start).toBe(23 * 3600000);
    expect(autumn.end - autumn.start).toBe(25 * 3600000);
    const now = new Date(2026, 0, 15, 12).getTime();
    expect(calendarRange(now)).toEqual({ start: new Date(2025, 10, 1).getTime(), end: new Date(2026, 0, 16).getTime() });
    expect(calendarRange(now, -3)).toEqual({ start: new Date(2025, 7, 1).getTime(), end: new Date(2025, 10, 1).getTime() });
  });
});

it('keeps adjacent day ranges aligned when daylight saving skips midnight', () => {
  withTimeZone('America/Santiago', () => {
    const day = dayRange(new Date(2026, 8, 6, 12).getTime());
    const next = dayRange(new Date(2026, 8, 7, 12).getTime());
    expect(day).toEqual({ start: new Date(2026, 8, 6, 1).getTime(), end: new Date(2026, 8, 7).getTime() });
    expect(day.end).toBe(next.start);
    expect(day.end - day.start).toBe(23 * 3600000);
  });
});

it('filters a complete day before sorting and pagination without changing collection totals', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    for (const at of [start - 1, start, start + 1, end - 1, end]) await repository.capture(session(String(at)), 'manual', at);
    const first = await repository.history(null, 2, 'saved', '', 'date-asc', { start, end });
    expect(first.items.map(item => item.capturedAt)).toEqual([start, start + 1]);
    expect(first.count).toBe(5);
    const anchor = first.items[1];
    if (!anchor) throw new Error('Fixture missing');
    expect((await repository.history(anchor, 2, 'saved', '', 'date-asc', { start, end })).items.map(item => item.capturedAt)).toEqual([end - 1]);
    expect((await repository.history(null, 10, 'saved', 'missing', 'number-desc', { start, end })).items).toEqual([]);
  } finally { await repository.close(); }
});

it('keeps the latest month anchored when the visible month count changes', () => {
  const now = new Date(2026, 0, 15, 12).getTime();
  expect(calendarRange(now, 0, 4)).toEqual({ start: new Date(2025, 9, 1).getTime(), end: new Date(2026, 0, 16).getTime() });
  expect(calendarRange(now, 0, 1)).toEqual({ start: new Date(2026, 0, 1).getTime(), end: new Date(2026, 0, 16).getTime() });
  expect(calendarRange(now, -1, 4)).toEqual({ start: new Date(2025, 8, 1).getTime(), end: new Date(2026, 0, 1).getTime() });
  expect(calendarRange(new Date(2024, 2, 15).getTime(), -1, 1)).toEqual({ start: new Date(2024, 1, 1).getTime(), end: new Date(2024, 2, 1).getTime() });
});

it('counts all stored backups by local capture day and current collection', async () => {
  const repository = new Repository(crypto.randomUUID());
  try {
    const first = await repository.capture(session('automatic'), 'automatic', start);
    if (first.kind !== 'saved') throw new Error('Fixture missing');
    await repository.capture(session('manual'), 'manual', end - 1);
    await repository.capture(session('next day'), 'manual', end);
    expect(await repository.calendar({ start, end })).toEqual([{ start, saved: 1, automatic: 1 }]);
    await repository.keep(first.id, null, end + 100);
    expect(await repository.calendar({ start, end })).toEqual([{ start, saved: 2, automatic: 0 }]);
    await repository.deleteSession(first.id);
    expect(await repository.calendar({ start, end })).toEqual([{ start, saved: 1, automatic: 0 }]);
  } finally { await repository.close(); }
});

it('validates date ranges at the message boundary', () => {
  const range = { start, end };
  expect(parseRequest({ kind: 'calendar', range })).toEqual({ kind: 'calendar', range });
  expect(parseRequest({ kind: 'history', before: null, range })).toEqual({ kind: 'history', before: null, range });
  for (const range of [null, {}, { start, end: start }, { start, end: start - 1 }, { start: '0', end }, { start: NaN, end }, { start, end: Infinity }, { start, end: start + 400 * 86400000 }]) {
    expect(() => parseRequest({ kind: 'calendar', range })).toThrow();
    expect(() => parseRequest({ kind: 'history', before: null, range })).toThrow();
  }
});
