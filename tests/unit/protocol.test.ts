import { describe, expect, it } from 'vitest';
import { parseRequest, TAB_URL_LIMIT } from '../../src/protocol';

describe('message boundary', () =>
{
  it('rejects the removed privacy acceptance messages', () =>
  {
    for (const input of [{ kind: 'privacy-status' }, { kind: 'privacy-choice', automatic: true }]) {
      expect(() => parseRequest(input)).toThrow('Invalid request');
    }
  });

  it('requires the result identity when dismissing a restoration', () =>
  {
    expect(parseRequest({ kind: 'dismiss-restore', id: 'saved', startedAt: 5 })).toEqual({ kind: 'dismiss-restore', id: 'saved', startedAt: 5 });
    for (const startedAt of [undefined, null, -1, 0.5, '5', Infinity]) {
      expect(() => parseRequest({ kind: 'dismiss-restore', id: 'saved', startedAt })).toThrow('Invalid request');
    }
    expect(() => parseRequest({ kind: 'dismiss-restore', id: '', startedAt: 5 })).toThrow('Invalid request');
  });

  it('requires a nonnegative integer index for individual window restoration', () =>
  {
    expect(parseRequest({ kind: 'restore-window', id: 'saved', windowIndex: 0 })).toEqual({ kind: 'restore-window', id: 'saved', windowIndex: 0 });
    for (const windowIndex of [undefined, null, -1, 1.5, '1', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseRequest({ kind: 'restore-window', id: 'saved', windowIndex })).toThrow('Invalid request');
    }
    expect(() => parseRequest({ kind: 'restore-window', id: '', windowIndex: 0 })).toThrow('Invalid request');
  });

  it('accepts only supported messages and valid history cursors', () =>
  {
    expect(parseRequest({ kind: 'backup' })).toEqual({ kind: 'backup' });
    expect(parseRequest({ kind: 'history', before: null })).toEqual({ kind: 'history', before: null });
    expect(parseRequest({ kind: 'history', before: { capturedAt: 50, number: 1, id: 'abc' } })).toEqual({ kind: 'history', before: { capturedAt: 50, number: 1, id: 'abc' } });
    for (const input of [null, 'backup', {}, { kind: 'erase' }, { kind: 'history', offset: 0 }, { kind: 'history', before: {} }, { kind: 'history', before: { capturedAt: -1, id: 'abc' } }, { kind: 'history', before: { capturedAt: 0.5, id: 'abc' } }, { kind: 'history', before: { capturedAt: 1, id: '' } }, { kind: 'snapshot', id: '' }]) {
      expect(() => parseRequest(input)).toThrow('Invalid request');
    }
  });

  it('accepts only supported automatic backup settings and drops extra fields', () =>
  {
    const valid = [
      { kind: 'enabled', value: true }, { kind: 'enabled', value: false },
      ...[0, 1, 5, 15, 60, 1440].map(value => ({ kind: 'frequency', value })),
      ...[15, 60, 1440].map(minutes => ({ kind: 'pause', minutes })),
      { kind: 'resume' },
    ];
    for (const update of valid) {
      expect(parseRequest({ kind: 'automatic-settings', update: { ...update, extra: 1 } })).toEqual({ kind: 'automatic-settings', update });
    }
    const invalid = [
      null, undefined, 'resume', 15, {}, { value: true }, { kind: '' }, { kind: 'disabled' },
      { kind: 'enabled' }, { kind: 'enabled', value: 'true' }, { kind: 'enabled', value: 1 }, { kind: 'enabled', minutes: true },
      { kind: 'frequency' }, { kind: 'frequency', minutes: 15 }, ...[2, -1, 15.5, '15', null, Infinity, true].map(value => ({ kind: 'frequency', value })),
      { kind: 'pause' }, { kind: 'pause', value: 15 }, { kind: 'pause', value: false }, { kind: 'resumed' }, ...[0, 1, 5, 30, '60', null].map(minutes => ({ kind: 'pause', minutes })),
    ];
    for (const update of invalid) {
      expect(() => parseRequest({ kind: 'automatic-settings', update })).toThrow('Invalid automatic backup setting.');
    }
    expect(() => parseRequest({ kind: 'automatic-settings' })).toThrow('Invalid request');
  });

  it('accepts tab searches and exact page filters within the URL length limit', () =>
  {
    expect(parseRequest({ kind: 'tab-search', query: 'docs example', limit: 10 })).toEqual({ kind: 'tab-search', query: 'docs example', limit: 10 });
    expect(parseRequest({ kind: 'history', before: null, tabUrl: 'https://example.test/' })).toEqual({ kind: 'history', before: null, tabUrl: 'https://example.test/' });
    for (const input of [{ kind: 'tab-search', limit: 10 }, { kind: 'tab-search', query: 1, limit: 10 }, { kind: 'tab-search', query: 'x'.repeat(TAB_URL_LIMIT + 1), limit: 10 }, { kind: 'tab-search', query: 'docs' }, ...[0, -1, 1.5, '10', Infinity].map(limit => ({ kind: 'tab-search', query: 'docs', limit }))]) {
      expect(() => parseRequest(input)).toThrow('Invalid request');
    }
    for (const tabUrl of ['', 1, null, 'x'.repeat(TAB_URL_LIMIT + 1)]) {
      expect(() => parseRequest({ kind: 'history', before: null, tabUrl })).toThrow('Invalid history search');
    }
  });
});
