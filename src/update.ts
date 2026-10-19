// a reload closes every tab that shows an extension page, including the backups page and unopened placeholders
export function hasExtensionTabs(tabs: readonly { url?: string; pendingUrl?: string }[], ownOrigin: string): boolean
{
  return tabs.some(tab => (tab.pendingUrl || tab.url || '').startsWith(ownOrigin));
}

// compare dotted manifest versions numerically
export function isNewerVersion(candidate: string, current: string): boolean
{
  const next = candidate.split('.').map(Number);
  const installed = current.split('.').map(Number);
  for (let index = 0; index < Math.max(next.length, installed.length); index++) {
    const difference = (next[index] ?? 0) - (installed[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
