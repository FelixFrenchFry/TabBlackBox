import type { SiteCount, TopSites, TopSitesScope } from './model';

export const TOP_SITES_SCOPES: readonly TopSitesScope[] = ['open', 'all'];
export const TOP_SITES_LIMIT = 10;

export function parseTopSitesScope(value: unknown): TopSitesScope
{
  const scope = TOP_SITES_SCOPES.find(item => item === value);
  if (scope === undefined) throw new Error('Invalid top sites scope.');
  return scope;
}

// group web pages by host and other addresses by kind
export function siteName(url: string | null): string
{
  try {
    const parsed = new URL(url ?? '');
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.hostname.replace(/^www\./, '');
    if (parsed.protocol === 'file:') return 'Local files';
  } catch { /* missing and malformed addresses are counted as browser pages */ }
  return 'Browser pages';
}

export function topSites(urls: Iterable<string | null>, limit = TOP_SITES_LIMIT): TopSites
{
  // keep the first address of each site so its icon can be looked up
  const sites = new Map<string, SiteCount>();
  let total = 0;
  for (const url of urls) {
    const site = siteName(url);
    const item = sites.get(site) ?? { site, url, count: 0 };
    item.count++;
    sites.set(site, item);
    total++;
  }
  const sorted = [...sites.values()].sort((a, b) => b.count - a.count || a.site.localeCompare(b.site));
  return { sites: sorted.slice(0, limit), siteCount: sites.size, total };
}
