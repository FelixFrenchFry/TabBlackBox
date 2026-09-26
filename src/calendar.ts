import type { HistoryRange } from './model';

export const CALENDAR_LEVELS = 3;

export function calendarScale(counts: number[]): { minimum: number; maximum: number; level: number }[]
{
  const sorted = counts.filter(count => count > 0).sort((a, b) => a - b);
  const thresholds: number[] = [];
  // divide non-empty days into thirds and keep equal counts in the same color band
  for (let part = 1; part <= CALENDAR_LEVELS; part++) {
    const value = sorted[Math.ceil(sorted.length * part / CALENDAR_LEVELS) - 1];
    if (value !== undefined && value !== thresholds.at(-1)) thresholds.push(value);
  }
  // spread distinct bands across the palette without inventing differences between equal days
  return thresholds.map((maximum, index) => ({
    minimum: (thresholds[index - 1] ?? 0) + 1,
    maximum,
    level: thresholds.length === 1 ? 2 : 1 + Math.round(index * (CALENDAR_LEVELS - 1) / (thresholds.length - 1)),
  }));
}

export function dayRange(value: number): HistoryRange
{
  const date = new Date(value);
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  // resolve each day's start independently when daylight saving skips midnight
  return { start: new Date(year, month, day).getTime(), end: new Date(year, month, day + 1).getTime() };
}

export function calendarRange(now: number, offset = 0, months = 3): HistoryRange
{
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth() - months + 1 + offset, 1).getTime();
  const end = offset === 0 ? dayRange(now).end : new Date(date.getFullYear(), date.getMonth() + 1 + offset, 1).getTime();
  return { start, end };
}

export function parseHistoryRange(value: unknown): HistoryRange
{
  if (typeof value === 'object' && value !== null && 'start' in value && 'end' in value &&
      typeof value.start === 'number' && Number.isSafeInteger(value.start) && value.start >= -86400000 &&
      typeof value.end === 'number' && Number.isSafeInteger(value.end) && value.end <= 8_640_000_000_000_000 &&
      value.end > value.start && value.end - value.start <= 367 * 86400000) return { start: value.start, end: value.end };
  throw new Error('Invalid history date range.');
}
