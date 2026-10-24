import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('initializes the date clock and listeners only once', async () => {
  const windowEvents = vi.fn();
  const documentEvents = vi.fn();
  const interval = vi.fn();
  vi.stubGlobal('window', { addEventListener: windowEvents });
  vi.stubGlobal('document', { addEventListener: documentEvents, documentElement: { dataset: {} } });
  vi.stubGlobal('setInterval', interval);
  const { initializeDates } = await import('../../src/ui/dates');
  initializeDates();
  const windowCount = windowEvents.mock.calls.length;
  const documentCount = documentEvents.mock.calls.length;
  initializeDates();
  expect(interval).toHaveBeenCalledTimes(1);
  expect(interval).toHaveBeenCalledWith(expect.any(Function), 1000);
  expect(windowEvents).toHaveBeenCalledTimes(windowCount);
  expect(documentEvents).toHaveBeenCalledTimes(documentCount);
});
it('names files by the local calendar day around midnight', async () => {
  const { fileDate } = await import('../../src/ui/dates');
  expect(fileDate(new Date(2026, 9, 24, 0, 30).getTime())).toBe('2026-10-24');
  expect(fileDate(new Date(2026, 9, 23, 23, 59, 59).getTime())).toBe('2026-10-23');
  expect(fileDate(new Date(2027, 0, 1, 0, 0).getTime())).toBe('2027-01-01');
});
it('formats relative durations using only the largest nonzero unit', async () => {
  const { formatDate } = await import('../../src/ui/dates');
  const now = Date.UTC(2026, 8, 12, 12);
  for (const [minutes, expected] of [[1, '1 min'], [5, '5 min'], [59, '59 min'], [60, '1 hour'], [65, '1 hour'], [1439, '23 hours'], [1440, '1 day'], [1505, '1 day'], [2885, '2 days'], [4745, '3 days']] as const) {
    expect(formatDate(now - minutes * 60_000, 'relative', now)).toBe(expected + ' ago');
    expect(formatDate(now + minutes * 60_000, 'relative', now)).toBe('in ' + expected);
  }
  expect(formatDate(now - 5000, 'relative', now)).toBe('5 seconds ago');
  expect(formatDate(now, 'relative', now)).toBe('now');
  expect(formatDate(now + 65 * 60_000, 'combination', now)).toBe(formatDate(now + 65 * 60_000, 'exact', now) + ' (in 1 hour)');
});
