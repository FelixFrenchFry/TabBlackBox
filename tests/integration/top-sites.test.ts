import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Repository } from '../../src/database';
import { parseRequest } from '../../src/protocol';
import { parseTopSitesScope, siteName, topSites } from '../../src/sites';
import type { SavedTab, Session } from '../../src/model';
import { DEFAULT_STORAGE_SETTINGS } from '../../src/storage';

const page = (url: string, title = url): SavedTab => ({ url, title, pinned: false, group: null });
const session = (...tabs: SavedTab[]): Session => ({ windows: [{ groups: [], tabs }] });

describe('top sites', () =>
{
  it('groups web pages by host and other addresses by kind', () =>
  {
    const urls = ['https://www.example.test/a', 'http://example.test:8080/b', 'https://docs.example.test/', 'file:///C:/notes.txt', 'chrome://settings/', 'about:blank', null, 'not a url'];
    expect(urls.map(siteName)).toEqual(['example.test', 'example.test', 'docs.example.test', 'Local files', 'Browser pages', 'Browser pages', 'Browser pages', 'Browser pages']);
  });

  it('orders sites by count and name and keeps the first address of each site', () =>
  {
    expect(topSites(['https://b.test/1', 'https://a.test/1', 'https://b.test/2', 'https://c.test/1', 'https://a.test/2'], 2)).toEqual({
      sites: [{ site: 'a.test', url: 'https://a.test/1', count: 2 }, { site: 'b.test', url: 'https://b.test/1', count: 2 }],
      siteCount: 3,
      total: 5,
    });
    expect(topSites([])).toEqual({ sites: [], siteCount: 0, total: 0 });
  });

  it('accepts only the offered scopes', () =>
  {
    expect(parseTopSitesScope('all')).toBe('all');
    for (const value of [null, '', 'latest', 1]) expect(() => parseTopSitesScope(value)).toThrow('Invalid top sites scope');
    expect(parseRequest({ kind: 'top-sites', scope: 'open', limit: 20 })).toEqual({ kind: 'top-sites', scope: 'open', limit: 20 });
    expect(() => parseRequest({ kind: 'top-sites', limit: 10 })).toThrow('Invalid request');
    for (const limit of [undefined, 0, -1, 1.5, '10']) expect(() => parseRequest({ kind: 'top-sites', scope: 'open', limit })).toThrow('Invalid request');
    expect(() => parseRequest({ kind: 'top-sites', scope: 'latest', limit: 10 })).toThrow('Invalid top sites scope');
  });

  it('counts tabs of the latest backup and pages of all retained backups', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    try {
      const none = { sites: [], siteCount: 0, total: 0 };
      expect(await repository.topSites('open')).toEqual(none);
      expect(await repository.topSites('all')).toEqual(none);
      await repository.capture(session(page('https://a.test/1'), page('https://a.test/1'), page('https://b.test/1')), 'automatic', 1000);
      expect(await repository.topSites('open')).toEqual({ sites: [{ site: 'a.test', url: 'https://a.test/1', count: 2 }, { site: 'b.test', url: 'https://b.test/1', count: 1 }], siteCount: 2, total: 3 });
      // the latest backup can be a manual backup
      await repository.capture(session(page('https://c.test/1'), page('https://a.test/2')), 'manual', 2000);
      expect(await repository.topSites('open')).toEqual({ sites: [{ site: 'a.test', url: 'https://a.test/2', count: 1 }, { site: 'c.test', url: 'https://c.test/1', count: 1 }], siteCount: 2, total: 2 });
      // title variants of a page are counted once across backups
      await repository.capture(session(page('https://a.test/1', 'Renamed')), 'automatic', 3000);
      expect(await repository.topSites('all')).toEqual({
        sites: [{ site: 'a.test', url: 'https://a.test/1', count: 2 }, { site: 'b.test', url: 'https://b.test/1', count: 1 }, { site: 'c.test', url: 'https://c.test/1', count: 1 }],
        siteCount: 3,
        total: 4,
      });
      // pages of removed backups are no longer counted
      expect(await repository.setStorageSettings({ ...DEFAULT_STORAGE_SETTINGS, maxBackups: 1 }, 1, 4000)).toEqual({ kind: 'saved' });
      expect(await repository.topSites('all')).toEqual({ sites: [{ site: 'a.test', url: 'https://a.test/1', count: 2 }, { site: 'c.test', url: 'https://c.test/1', count: 1 }], siteCount: 2, total: 3 });
      expect(await repository.topSites('open')).toEqual({ sites: [{ site: 'a.test', url: 'https://a.test/1', count: 1 }], siteCount: 1, total: 1 });
    } finally { await repository.close(); }
  });
});
