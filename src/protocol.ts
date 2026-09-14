import { parseAutomaticUpdate } from './automatic';
import type { AutomaticUpdate, HistoryCursor, Overview, Snapshot, StorageSettings, StorageSettingsResult, Summary } from './model';
import { parseStorageSettings } from './storage';

export const HISTORY_INITIAL_LIMIT = 25;
export const HISTORY_PAGE_LIMIT = 50;

export type Request = { kind: 'automatic-settings'; update: AutomaticUpdate } | { kind: 'overview' | 'refresh' | 'backup' } | { kind: 'history'; before: HistoryCursor | null } | { kind: 'snapshot' | 'restore'; id: string } | { kind: 'restore-window'; id: string; windowIndex: number } | { kind: 'storage-settings'; settings: StorageSettings; confirmedRemovalCount: number };
export type Data = { kind: 'overview'; overview: Overview } | { kind: 'history'; items: Summary[] } | { kind: 'snapshot'; snapshot: Snapshot } | { kind: 'accepted' } | { kind: 'storage-settings'; result: StorageSettingsResult };
export type Reply = { ok: true; data: Data } | { ok: false; error: string };

export function parseRequest(input: unknown): Request
{
  if (typeof input === 'object' && input !== null && 'kind' in input) {
    if (input.kind === 'automatic-settings' && 'update' in input) return { kind: 'automatic-settings', update: parseAutomaticUpdate(input.update) };
    if (input.kind === 'storage-settings' && 'settings' in input && 'confirmedRemovalCount' in input && typeof input.confirmedRemovalCount === 'number' && Number.isSafeInteger(input.confirmedRemovalCount) && input.confirmedRemovalCount >= 0) {
      return { kind: 'storage-settings', settings: parseStorageSettings(input.settings), confirmedRemovalCount: input.confirmedRemovalCount };
    }
    if (input.kind === 'overview' || input.kind === 'refresh' || input.kind === 'backup') return { kind: input.kind };
    if (input.kind === 'history' && 'before' in input) {
      const before = input.before;
      if (before === null) return { kind: 'history', before: null };
      if (typeof before === 'object' && 'capturedAt' in before && typeof before.capturedAt === 'number' && Number.isSafeInteger(before.capturedAt) && before.capturedAt >= 0 &&
          'id' in before && typeof before.id === 'string' && before.id.length > 0 && before.id.length <= 100) {
        return { kind: 'history', before: { capturedAt: before.capturedAt, id: before.id } };
      }
    }
    if ((input.kind === 'snapshot' || input.kind === 'restore') && 'id' in input && typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 100) return { kind: input.kind, id: input.id };
    if (input.kind === 'restore-window' && 'id' in input && typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 100 &&
        'windowIndex' in input && typeof input.windowIndex === 'number' && Number.isSafeInteger(input.windowIndex) && input.windowIndex >= 0) return { kind: input.kind, id: input.id, windowIndex: input.windowIndex };
  }
  throw new Error('Invalid request.');
}
