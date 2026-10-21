import { describe, expect, it } from 'vitest';
import { canonicalSession, normalizeSession, restorableUrl } from '../../src/session';
import { placeholderUrl } from '../../src/placeholder';

describe('session rules', () =>
{
  it('excludes incognito, app windows and our own pages while preserving duplicate URLs', () =>
  {
    const tab = { index: 0, url: 'https://example.test', title: 'Example', pinned: false, groupId: -1 };
    const result = normalizeSession([
      { id: 1, type: 'normal', incognito: false, tabs: [tab, { ...tab, index: 1 }, { ...tab, index: 2, url: 'chrome-extension://ours/history.html' }] },
      { id: 2, type: 'normal', incognito: true, tabs: [tab] },
      { id: 3, type: 'popup', incognito: false, tabs: [tab] },
    ], [], 'chrome-extension://ours/');
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.tabs).toHaveLength(2);
  });

  it('records placeholder tabs as their saved page and skips invalid placeholders', () =>
  {
    const own = 'chrome-extension://ours/';
    const placeholder = { index: 0, url: placeholderUrl(own, 'https://example.test/a?b=1#c', 'Saved & named'), title: 'Placeholder title', pinned: true, groupId: -1 };
    const result = normalizeSession([{ id: 1, type: 'normal', incognito: false, tabs: [
      placeholder,
      { ...placeholder, index: 1, url: `${own}restore.html#url=javascript%3Aalert(1)` },
      { ...placeholder, index: 2, url: undefined, pendingUrl: 'https://opening.test', title: 'Saved & named' },
    ] }], [], own);
    expect(result.windows[0]?.tabs).toEqual([
      { url: 'https://example.test/a?b=1#c', title: 'Saved & named', pinned: true, group: null },
      { url: 'https://opening.test', title: 'Saved & named', pinned: true, group: null },
    ]);
  });

  it('normalizes group IDs, window order and prefers pending URLs', () =>
  {
    const capture = (windowId: number, groupId: number) => normalizeSession([
      { id: windowId, type: 'normal', incognito: false, tabs: [{ index: 0, url: 'https://old.test', pendingUrl: 'https://new.test', title: 'New', pinned: false, groupId }] },
    ], [{ id: groupId, windowId, title: 'Research', color: 'blue', collapsed: true }], 'chrome-extension://ours/');
    expect(canonicalSession(capture(1, 7))).toBe(canonicalSession(capture(8, 23)));
    expect(capture(1, 7).windows[0]?.tabs[0]?.url).toBe('https://new.test');
    const first = capture(1, 7).windows[0];
    const second = { tabs: [{ url: 'about:blank', title: '', pinned: false, group: null }], groups: [] };
    if (!first) throw new Error('fixture missing');
    expect(canonicalSession({ windows: [first, second] })).toBe(canonicalSession({ windows: [second, first] }));
  });

  it('compares tab and group values independently of object property order', () =>
  {
    const first = { tabs: [{ url: 'about:blank', title: 'Blank', pinned: false, group: 0 }], groups: [{ name: 'Research', color: 'blue' as const, collapsed: false }] };
    const second = { groups: [{ collapsed: false, color: 'blue' as const, name: 'Research' }], tabs: [{ title: 'Blank', group: 0, pinned: false, url: 'about:blank' }] };
    expect(canonicalSession({ windows: [first] })).toBe(canonicalSession({ windows: [second] }));
  });

  it('rejects an incomplete group scan', () =>
  {
    expect(() => normalizeSession([{ id: 1, type: 'normal', incognito: false, tabs: [{ index: 0, groupId: 5, pinned: false }] }], [], 'chrome-extension://ours/')).toThrow();
  });

  it('allows only safe supported restore URLs', () =>
  {
    expect(restorableUrl('https://example.test/a')).toBe(true);
    expect(restorableUrl('about:blank')).toBe(true);
    expect(restorableUrl('file:///C:/Research/My%20paper.pdf#page=3', true)).toBe(true);
    expect(restorableUrl('file:///M:/Research/paper.pdf', true)).toBe(true);
    for (const url of [null, '', 'javascript:alert(1)', 'data:text/html,hi', 'file:///x', 'chrome://settings', 'https://', 'blob:https://example.test/x']) {
      expect(restorableUrl(url)).toBe(false);
      if (url !== 'file:///x') expect(restorableUrl(url, true)).toBe(false);
    }
  });

});
