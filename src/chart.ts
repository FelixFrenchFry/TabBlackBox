import type { HistoryRange, TabCountPoint } from './model';
import { DAY_MS } from './session';

export const TAB_CHART_PERIODS = [1, 7, 30, 90] as const;
export type TabChartPeriod = typeof TAB_CHART_PERIODS[number];
export const TAB_CHART_POINT_LIMIT = 1000;

export function parseTabChartPeriod(value: unknown): TabChartPeriod
{
  const period = TAB_CHART_PERIODS.find(days => String(days) === value);
  if (period === undefined) throw new Error('Invalid tab chart period.');
  return period;
}

export function tabChartRange(now: number, days: TabChartPeriod): HistoryRange
{
  // end just after now so backups captured in the current millisecond are included
  return { start: now - days * DAY_MS, end: now + 1 };
}

export function thinTabCounts<T extends Pick<TabCountPoint, 'capturedAt' | 'tabCount'>>(points: readonly T[], range: HistoryRange, limit = TAB_CHART_POINT_LIMIT): T[]
{
  if (points.length <= limit) return [...points];
  // keep the lowest, highest, and final count of each time bucket so drops, peaks, and step levels stay accurate
  const buckets = Math.max(1, Math.floor((limit - 1) / 3));
  const width = (range.end - range.start) / buckets;
  const kept = new Map<number, { low: T; high: T; last: T }>();
  for (const point of points) {
    const index = Math.min(buckets - 1, Math.max(0, Math.floor((point.capturedAt - range.start) / width)));
    const bucket = kept.get(index);
    if (!bucket) kept.set(index, { low: point, high: point, last: point });
    else {
      if (point.tabCount < bucket.low.tabCount) bucket.low = point;
      if (point.tabCount > bucket.high.tabCount) bucket.high = point;
      bucket.last = point;
    }
  }
  // retain the newest point because its count continues to the end of the period
  const last = points.at(-1);
  const selected = new Set([...kept.values()].flatMap(bucket => [bucket.low, bucket.high, bucket.last]));
  if (last) selected.add(last);
  return points.filter(point => selected.has(point));
}

export function chartMaximum(value: number): number
{
  // round the axis up to 1, 2, or 5 times a power of ten so its midpoint stays whole
  if (value <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map(step => step * magnitude).find(step => step >= value) ?? 10 * magnitude;
}
