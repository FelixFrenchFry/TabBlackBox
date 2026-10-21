import { expect, it } from 'vitest';
import { CLOSED_TAB_LIMIT, closedAgo, closedTabs } from '../../src/closed';
import { placeholderUrl } from '../../src/placeholder';

const own = 'chrome-extension://abc/';
const tab = (lastModified: number, url: string, title = url, sessionId = `s${lastModified}`) => ({ lastModified, tab: { sessionId, url, title } });

it('lists closed tabs newest first with millisecond times and falls back to the address for the title', () =>
{
  expect(closedTabs([tab(10, 'https://a.test', 'Alpha'), tab(30, 'https://c.test', ''), tab(20, 'https://b.test', 'Beta')], own)).toEqual([
    { sessionId: 's30', title: 'https://c.test', url: 'https://c.test', closedAt: 30_000 },
    { sessionId: 's20', title: 'Beta', url: 'https://b.test', closedAt: 20_000 },
    { sessionId: 's10', title: 'Alpha', url: 'https://a.test', closedAt: 10_000 },
  ]);
});

it('skips closed windows, own pages, new tab pages and entries without an id or address', () =>
{
  const sessions = [
    { lastModified: 9 },
    tab(8, `${own}popup.html`),
    tab(7, 'chrome://newtab/'),
    tab(6, ''),
    { lastModified: 5, tab: { url: 'https://noid.test' } },
    { lastModified: 4, tab: { sessionId: 'pending', pendingUrl: 'https://pending.test', title: 'Pending' } },
    tab(3, 'chrome://settings/', 'Settings'),
  ];
  expect(closedTabs(sessions, own).map(item => item.sessionId)).toEqual(['pending', 's3']);
});

it('lists closed placeholder tabs as their saved page', () =>
{
  const sessions = [tab(2, placeholderUrl(own, 'https://saved.test/page', 'Saved'), 'Placeholder'), tab(1, placeholderUrl(own, 'https://untitled.test', ''), '')];
  expect(closedTabs(sessions, own)).toEqual([
    { sessionId: 's2', title: 'Saved', url: 'https://saved.test/page', closedAt: 2_000 },
    { sessionId: 's1', title: 'https://untitled.test', url: 'https://untitled.test', closedAt: 1_000 },
  ]);
});

it('returns at most the last twenty closed tabs', () =>
{
  const sessions = Array.from({ length: 25 }, (_, index) => tab(index + 1, `https://${index}.test`));
  const tabs = closedTabs(sessions, own);
  expect(tabs).toHaveLength(CLOSED_TAB_LIMIT);
  expect(tabs[0]?.closedAt).toBe(25_000);
  expect(tabs.at(-1)?.closedAt).toBe(6_000);
});

it('shows short closed times for the popup list', () =>
{
  const now = 10 * 86_400_000;
  expect([now + 5_000, now - 59_000, now - 5 * 60_000, now - 90 * 60_000, now - 3 * 86_400_000].map(closedAt => closedAgo(closedAt, now))).toEqual(['now', 'now', '5 min', '1 h', '3 d']);
});
