import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Repository } from '../../src/database';
import { parseSearchFields, parseTabSearchFields } from '../../src/history';
import { parseRequest } from '../../src/protocol';
import type { Session } from '../../src/model';

const session: Session = { windows: [{ groups: [], tabs: [{ url: 'https://example.test', title: 'Example', pinned: false, group: null }] }] };

describe('search fields', () =>
{
  it('accepts each searchable part once in a consistent order', () =>
  {
    expect(parseSearchFields(['tags', 'name'])).toEqual(['name', 'tags']);
    for (const value of [null, 'name', [], ['name', 'name'], ['note'], ['name', 1]]) expect(() => parseSearchFields(value)).toThrow('Invalid history search');
    expect(parseRequest({ kind: 'history', before: null, query: 'work', fields: ['tags'] })).toEqual({ kind: 'history', before: null, query: 'work', fields: ['tags'] });
    expect(() => parseRequest({ kind: 'history', before: null, fields: [] })).toThrow('Invalid history search');
  });

  it('searches only the selected parts of saved sessions', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    try {
      const names = async (query: string, fields?: ('name' | 'tags')[]) => (await repository.history(null, 10, 'saved', query, 'date-asc', undefined, undefined, fields)).items.map(item => item.name);
      for (const [index, name] of ['Homework', 'Tagged', 'Plain'].entries()) {
        const result = await repository.capture(session, 'manual', 1000 + index, name);
        if (result.kind !== 'saved') throw new Error('Fixture missing');
        if (name === 'Tagged') await repository.rename(result.id, name, { tags: ['work'] });
      }
      expect(await names('work')).toEqual(['Homework', 'Tagged']);
      expect(await names('work', ['name'])).toEqual(['Homework']);
      expect(await names('work', ['tags'])).toEqual(['Tagged']);
      expect(await names('', ['tags'])).toEqual(['Homework', 'Tagged', 'Plain']);
      // every word must appear in any order across the name and tags
      expect(await names('work tagged')).toEqual(['Tagged']);
      expect(await names('  WORK   home ')).toEqual(['Homework']);
      expect(await names('work tagged', ['name'])).toEqual([]);
      expect(await names('plain work')).toEqual([]);
    } finally { await repository.close(); }
  });

  it('searches only the selected parts of stored tabs', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    try {
      await repository.capture({ windows: [{ groups: [], tabs: [
        { url: 'https://docs.example.test/start', title: 'Getting started', pinned: false, group: null },
        { url: 'https://example.test/notes', title: 'Docs overview', pinned: false, group: null },
      ] }] }, 'automatic', 1000);
      const titles = async (fields?: ('title' | 'url')[]) => (await repository.searchTabs('docs', 10, fields)).items.map(item => item.title);
      expect(await titles()).toEqual(['Getting started', 'Docs overview']);
      expect(await titles(['title'])).toEqual(['Docs overview']);
      expect(await titles(['url'])).toEqual(['Getting started']);
      expect(parseTabSearchFields(['url', 'title'])).toEqual(['title', 'url']);
      expect(() => parseTabSearchFields(['name'])).toThrow('Invalid tab search');
      expect(parseRequest({ kind: 'tab-search', query: 'docs', limit: 5, fields: ['url'] })).toEqual({ kind: 'tab-search', query: 'docs', limit: 5, fields: ['url'] });
    } finally { await repository.close(); }
  });
});
