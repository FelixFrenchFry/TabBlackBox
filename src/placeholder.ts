// lightweight restoration opens web tabs as an extension page that carries the saved page in its fragment
export const PLACEHOLDER_PAGE = 'restore.html';

export type PlaceholderTarget = { url: string; title: string };

export function webUrl(url: string | null): url is string
{
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch { return false; }
}

export function placeholderUrl(ownOrigin: string, url: string, title: string): string
{
  return `${ownOrigin}${PLACEHOLDER_PAGE}#${new URLSearchParams({ url, title })}`;
}

export function placeholderTarget(url: string | null, ownOrigin: string): PlaceholderTarget | null
{
  const prefix = `${ownOrigin}${PLACEHOLDER_PAGE}#`;
  if (!url?.startsWith(prefix)) return null;
  const params = new URLSearchParams(url.slice(prefix.length));
  const target = params.get('url');
  // only web pages are opened from placeholders
  return webUrl(target) ? { url: target, title: params.get('title') ?? '' } : null;
}
