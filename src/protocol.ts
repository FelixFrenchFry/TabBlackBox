import type { Overview, Snapshot, Summary } from './model';

export type Request = { kind: 'overview' | 'refresh' | 'backup' } | { kind: 'history'; offset: number } | { kind: 'snapshot' | 'restore'; id: string };
export type Data = { kind: 'overview'; overview: Overview } | { kind: 'history'; items: Summary[] } | { kind: 'snapshot'; snapshot: Snapshot } | { kind: 'accepted' };
export type Reply = { ok: true; data: Data } | { ok: false; error: string };

export function parseRequest(input: unknown): Request {
  if (typeof input === 'object' && input !== null && 'kind' in input) {
    if (input.kind === 'overview' || input.kind === 'refresh' || input.kind === 'backup') return { kind: input.kind };
    if (input.kind === 'history' && 'offset' in input && typeof input.offset === 'number' && Number.isSafeInteger(input.offset) && input.offset >= 0 && input.offset <= 1_000_000) return { kind: 'history', offset: input.offset };
    if ((input.kind === 'snapshot' || input.kind === 'restore') && 'id' in input && typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 100) return { kind: input.kind, id: input.id };
  }
  throw new Error('Invalid request.');
}
