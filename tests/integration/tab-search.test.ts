import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Repository } from '../../src/database';
import type { SavedTab, Session } from '../../src/model';
import { DEFAULT_STORAGE_SETTINGS } from '../../src/storage';

const page = (path: string, title: string, pinned = false): SavedTab => ({ url: `https://example.test/${path}`, title, pinned, group: null });
const session = (...tabs: SavedTab[]): Session => ({ windows: [{ groups: [], tabs }] });

describe('tab search', () =>
{
  it('finds pages by title and URL words across backups and reports where they were last seen', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    const docs = 'https://example.test/docs';
    try {
      const first = await repository.capture(session(page('docs', 'Guide'), page('news', 'Headlines')), 'automatic', 1000);
      const second = await repository.capture(session(page('docs', 'Guide v2', true), page('mail', 'Inbox')), 'automatic', 2000);
      const saved = await repository.capture(session(page('docs', 'Guide v2', true)), 'manual', 3000);
      const latest = await repository.capture(session(page('mail', 'Inbox')), 'automatic', 4000);
      if (first.kind !== 'saved' || second.kind !== 'saved' || saved.kind !== 'saved' || latest.kind !== 'saved') throw new Error('Fixture missing');
      const guide = { url: docs, title: 'Guide v2', lastSeen: 3000, lastSeenNumber: 1, lastSeenCollection: 'saved', automaticCount: 2, savedCount: 1 };
      expect(await repository.searchTabs('guide')).toEqual({ items: [guide], truncated: false, tooBroad: false });
      expect((await repository.searchTabs('  GUIDE   example.test/docs ')).items).toEqual([guide]);
      expect((await repository.searchTabs('guide inbox')).items).toEqual([]);
      expect(await repository.searchTabs('   ')).toEqual({ items: [], truncated: false, tooBroad: false });
      expect((await repository.searchTabs('example')).items.map(item => [item.title, item.lastSeen])).toEqual([['Inbox', 4000], ['Guide v2', 3000], ['Headlines', 1000]]);
      expect(await repository.searchTabs('example', 2)).toMatchObject({ items: [{ title: 'Inbox' }, { title: 'Guide v2' }], truncated: true });
      expect((await repository.history(null, 10, undefined, '', 'date-desc', undefined, docs)).items.map(item => item.id)).toEqual([saved.id, second.id, first.id]);
      expect(await repository.history(null, 10, 'automatic', '', 'date-desc', undefined, docs)).toMatchObject({ items: [{ id: second.id }, { id: first.id }], count: 3 });
      expect((await repository.history(null, 10, undefined, '', 'date-desc', undefined, 'https://example.test/missing')).items).toEqual([]);
      await repository.setStorageSettings({ ...DEFAULT_STORAGE_SETTINGS, maxBackups: 1 }, 2, 5000);
      expect((await repository.searchTabs('headlines')).items).toEqual([]);
      expect((await repository.searchTabs('guide')).items).toEqual([{ ...guide, automaticCount: 0 }]);
    } finally { await repository.close(); }
  });

  it('stops before resolving backups when a query matches too many tab records', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    try {
      await repository.capture(session(...Array.from({ length: 501 }, (_, index) => page(`bulk/${index}`, `Bulk ${index}`))), 'automatic', 1000);
      expect(await repository.searchTabs('bulk')).toEqual({ items: [], truncated: false, tooBroad: true });
      expect((await repository.searchTabs('bulk/500')).items).toMatchObject([{ title: 'Bulk 500', lastSeenCollection: 'automatic' }]);
    } finally { await repository.close(); }
  });
});
