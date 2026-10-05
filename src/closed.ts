import { placeholderTarget } from './placeholder';

export const CLOSED_TAB_LIMIT = 20;

export type ClosedTab = { sessionId: string; title: string; url: string; closedAt: number };
type RecentSession = { lastModified: number; tab?: { sessionId?: string; url?: string; pendingUrl?: string; title?: string } };

export function closedTabs(sessions: readonly RecentSession[], ownOrigin: string, limit = CLOSED_TAB_LIMIT): ClosedTab[]
{
  // closed windows are separate sessions, so only individually closed tabs are listed
  const tabs: ClosedTab[] = [];
  for (const session of [...sessions].sort((a, b) => b.lastModified - a.lastModified)) {
    const tab = session.tab;
    const reported = tab?.url || tab?.pendingUrl;
    // list closed placeholder tabs as their saved page
    const { url, title } = placeholderTarget(reported || null, ownOrigin) ?? { url: reported, title: tab?.title };
    if (!tab?.sessionId || !url || url.startsWith(ownOrigin) || url.startsWith('chrome://newtab')) continue;
    // the browser reports modification times in seconds
    tabs.push({ sessionId: tab.sessionId, title: title || url, url, closedAt: session.lastModified * 1000 });
  }
  return tabs.slice(0, limit);
}
