import { parseAutomaticUpdate } from './automatic';
import type { AutomaticUpdate, BackupDay, CaptureResult, Collection, HistoryCursor, HistoryRange, HistorySort, Overview, Snapshot, StorageSettings, StorageSettingsResult, Summary, TabMatch } from './model';
import { parseHistorySort } from './history';
import { parseHistoryRange } from './calendar';
import { parseStorageSettings } from './storage';
import { parseArchive, parseSessionName, SESSION_NAME_LIMIT, type Archive } from './archive';

export const HISTORY_INITIAL_LIMIT = 10;
export const HISTORY_PAGE_LIMIT = 20;
export const TAB_SEARCH_INITIAL_LIMIT = 5;
export const TAB_SEARCH_PAGE_LIMIT = 10;
export const TAB_URL_LIMIT = 2_097_152;
export { SESSION_NAME_LIMIT } from './archive';

export type Request = { kind: 'automatic-settings'; update: AutomaticUpdate } | { kind: 'overview' | 'refresh' | 'backup' } | { kind: 'calendar'; range: HistoryRange } | { kind: 'history'; before: HistoryCursor | null; collection?: Collection; query?: string; sort?: HistorySort; range?: HistoryRange; tabUrl?: string } | { kind: 'tab-search'; query: string; limit: number } | { kind: 'snapshot' | 'restore' | 'delete-saved'; id: string } | { kind: 'rename' | 'keep'; id: string; name: string | null } | { kind: 'export'; id?: string } | { kind: 'import'; archive: Archive } | { kind: 'restore-window'; id: string; windowIndex: number } | { kind: 'storage-settings'; settings: StorageSettings; confirmedRemovalCount: number };
export type Data = { kind: 'overview'; overview: Overview; captureResult?: CaptureResult } | { kind: 'calendar'; days: BackupDay[] } | { kind: 'history'; items: Summary[]; count: number; bytes: number } | { kind: 'tab-search'; items: TabMatch[]; truncated: boolean; tooBroad: boolean } | { kind: 'snapshot'; snapshot: Snapshot } | { kind: 'renamed'; summary: Summary } | { kind: 'export'; archive: Archive } | { kind: 'accepted' } | { kind: 'storage-settings'; result: StorageSettingsResult };
export type Reply = { ok: true; data: Data } | { ok: false; error: string };

export function parseRequest(input: unknown): Request
{
  if (typeof input === 'object' && input !== null && 'kind' in input) {
    if ((input.kind === 'rename' || input.kind === 'keep') && 'id' in input && typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 100 && 'name' in input) {
      return { kind: input.kind, id: input.id, name: parseSessionName(input.name) };
    }
    if (input.kind === 'import' && 'archive' in input) return { kind: 'import', archive: parseArchive(input.archive) };
    if (input.kind === 'export') {
      if (!('id' in input)) return { kind: 'export' };
      if (typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 100) return { kind: 'export', id: input.id };
    }
    if (input.kind === 'automatic-settings' && 'update' in input) return { kind: 'automatic-settings', update: parseAutomaticUpdate(input.update) };
    if (input.kind === 'storage-settings' && 'settings' in input && 'confirmedRemovalCount' in input && typeof input.confirmedRemovalCount === 'number' && Number.isSafeInteger(input.confirmedRemovalCount) && input.confirmedRemovalCount >= 0) {
      return { kind: 'storage-settings', settings: parseStorageSettings(input.settings), confirmedRemovalCount: input.confirmedRemovalCount };
    }
    if (input.kind === 'overview' || input.kind === 'refresh' || input.kind === 'backup') return { kind: input.kind };
    if (input.kind === 'calendar' && 'range' in input) return { kind: 'calendar', range: parseHistoryRange(input.range) };
    if (input.kind === 'tab-search' && 'query' in input && typeof input.query === 'string' && input.query.length <= TAB_URL_LIMIT &&
        'limit' in input && typeof input.limit === 'number' && Number.isSafeInteger(input.limit) && input.limit > 0) return { kind: 'tab-search', query: input.query, limit: input.limit };
    if (input.kind === 'history' && 'before' in input) {
      const collection = 'collection' in input ? input.collection : undefined;
      const query = 'query' in input ? input.query : undefined;
      const sort = 'sort' in input ? parseHistorySort(input.sort) : undefined;
      const range = 'range' in input ? parseHistoryRange(input.range) : undefined;
      const tabUrl = 'tabUrl' in input ? input.tabUrl : undefined;
      if (collection !== undefined && collection !== 'saved' && collection !== 'automatic') throw new Error('Invalid history collection.');
      if (query !== undefined && (typeof query !== 'string' || query.length > SESSION_NAME_LIMIT)) throw new Error('Invalid history search.');
      if (tabUrl !== undefined && (typeof tabUrl !== 'string' || !tabUrl.length || tabUrl.length > TAB_URL_LIMIT)) throw new Error('Invalid history search.');
      const filter: { collection?: Collection; query?: string; sort?: HistorySort; range?: HistoryRange; tabUrl?: string } = { ...(collection === undefined ? {} : { collection }), ...(query === undefined ? {} : { query }), ...(sort === undefined ? {} : { sort }), ...(range === undefined ? {} : { range }), ...(tabUrl === undefined ? {} : { tabUrl }) };
      const before = input.before;
      if (before === null) return { kind: 'history', before: null, ...filter };
      if (typeof before === 'object' && 'capturedAt' in before && typeof before.capturedAt === 'number' && Number.isSafeInteger(before.capturedAt) && before.capturedAt >= 0 &&
          'number' in before && typeof before.number === 'number' && Number.isSafeInteger(before.number) && before.number > 0 &&
          'id' in before && typeof before.id === 'string' && before.id.length > 0 && before.id.length <= 100) {
        return { kind: 'history', before: { capturedAt: before.capturedAt, number: before.number, id: before.id }, ...filter };
      }
    }
    if ((input.kind === 'snapshot' || input.kind === 'restore' || input.kind === 'delete-saved') && 'id' in input && typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 100) return { kind: input.kind, id: input.id };
    if (input.kind === 'restore-window' && 'id' in input && typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 100 &&
        'windowIndex' in input && typeof input.windowIndex === 'number' && Number.isSafeInteger(input.windowIndex) && input.windowIndex >= 0) return { kind: input.kind, id: input.id, windowIndex: input.windowIndex };
  }
  throw new Error('Invalid request.');
}
