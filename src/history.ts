import type { HistoryCursor, HistorySort, SearchField, TabSearchField } from './model';

export const SEARCH_FIELDS: readonly SearchField[] = ['name', 'tags'];
export const TAB_SEARCH_FIELDS: readonly TabSearchField[] = ['title', 'url'];

export function parseHistorySort(value: unknown): HistorySort
{
  if (value === 'date-desc' || value === 'date-asc' || value === 'number-desc' || value === 'number-asc') return value;
  throw new Error('Invalid history sort order.');
}

function parseFields<T extends string>(value: unknown, available: readonly T[], message: string): T[]
{
  // accept each searchable part once and require at least one
  if (!Array.isArray(value)) throw new Error(message);
  const fields = available.filter(field => value.includes(field));
  if (!fields.length || fields.length !== value.length) throw new Error(message);
  return fields;
}

export function parseSearchFields(value: unknown): SearchField[]
{
  return parseFields(value, SEARCH_FIELDS, 'Invalid history search.');
}

export function parseTabSearchFields(value: unknown): TabSearchField[]
{
  return parseFields(value, TAB_SEARCH_FIELDS, 'Invalid tab search.');
}

export function compareHistory(a: HistoryCursor, b: HistoryCursor, sort: HistorySort): number
{
  const difference = sort === 'number-asc' || sort === 'number-desc' ? a.number - b.number : a.capturedAt - b.capturedAt;
  // break ties consistently for sorting and pagination even after the anchor is deleted
  const order = difference || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return sort === 'date-asc' || sort === 'number-asc' ? order : -order;
}
