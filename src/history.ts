import type { HistoryCursor, HistorySort } from './model';

export function parseHistorySort(value: unknown): HistorySort
{
  if (value === 'date-desc' || value === 'date-asc' || value === 'number-desc' || value === 'number-asc') return value;
  throw new Error('Invalid history sort order.');
}

export function compareHistory(a: HistoryCursor, b: HistoryCursor, sort: HistorySort): number
{
  const difference = sort === 'number-asc' || sort === 'number-desc' ? a.number - b.number : a.capturedAt - b.capturedAt;
  // break ties consistently for sorting and pagination even after the anchor is deleted
  const order = difference || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return sort === 'date-asc' || sort === 'number-asc' ? order : -order;
}
