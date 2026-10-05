// name the site of a saved URL for single-line tab rows
export function siteLabel(url: string): string
{
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.hostname;
    if (parsed.protocol === 'file:') return decodeURIComponent(parsed.pathname.split('/').pop() || parsed.pathname);
  } catch { /* malformed addresses are shown as saved */ }
  return url;
}

// show a saved URL without its web scheme where the full address is listed
export function displayUrl(url: string): string
{
  return url.replace(/^https?:\/\//i, '');
}
