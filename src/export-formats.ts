import type { Archive } from './archive';

export type ExportFormat = 'json' | 'markdown' | 'urls' | 'bookmarks';

export const EXPORT_FORMATS: readonly { format: ExportFormat; label: string; hint: string; extension: string; type: string }[] = [
  { format: 'json', label: 'TabBlackBox JSON', hint: 'Full backup, can be imported again', extension: 'json', type: 'application/json' },
  { format: 'markdown', label: 'Markdown', hint: 'Readable list with headings', extension: 'md', type: 'text/markdown' },
  { format: 'urls', label: 'URL list', hint: 'One link per line', extension: 'txt', type: 'text/plain' },
  { format: 'bookmarks', label: 'Bookmarks HTML', hint: 'Importable by any browser', extension: 'html', type: 'text/html' },
];

function sessionName(name: string | null): string
{
  return name ?? 'Unnamed session';
}

function singleLine(text: string): string
{
  return text.replace(/\s+/g, ' ').trim();
}

function markdownText(text: string): string
{
  return singleLine(text).replace(/[\\`*_[\]<>]/g, '\\$&');
}

function markdownUrl(url: string): string
{
  // percent-encode characters that end or break a link destination
  return url.replace(/[ ()<>]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function htmlText(text: string): string
{
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function markdown(archive: Archive): string
{
  const lines: string[] = [];
  for (const session of archive.sessions) {
    lines.push(`# ${markdownText(sessionName(session.name))}`, '', `Captured ${new Date(session.capturedAt).toISOString()}`, '');
    for (const [index, window] of session.windows.entries()) {
      lines.push(`## Window ${index + 1}`, '');
      for (const tab of window.tabs) {
        const title = markdownText(tab.title || tab.url || 'Untitled tab');
        const group = tab.group === null ? undefined : window.groups[tab.group]?.name;
        lines.push(`- ${tab.url === null ? title : `[${title}](${markdownUrl(tab.url)})`}${group ? ` _(${markdownText(group)})_` : ''}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function urls(archive: Archive): string
{
  const links = archive.sessions.flatMap(session => session.windows.flatMap(window => window.tabs.flatMap(tab => tab.url === null ? [] : [tab.url])));
  return links.map(url => `${url}\n`).join('');
}

function bookmarks(archive: Archive): string
{
  // use the Netscape bookmark layout understood by browser importers, with one folder per session and window
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>'];
  for (const session of archive.sessions) {
    const added = Math.floor(session.capturedAt / 1000);
    lines.push(`  <DT><H3 ADD_DATE="${added}">${htmlText(singleLine(sessionName(session.name)))}</H3>`, '  <DL><p>');
    for (const [index, window] of session.windows.entries()) {
      lines.push(`    <DT><H3 ADD_DATE="${added}">Window ${index + 1}</H3>`, '    <DL><p>');
      for (const tab of window.tabs) {
        if (tab.url !== null) lines.push(`      <DT><A HREF="${htmlText(tab.url)}" ADD_DATE="${added}">${htmlText(singleLine(tab.title || tab.url))}</A>`);
      }
      lines.push('    </DL><p>');
    }
    lines.push('  </DL><p>');
  }
  lines.push('</DL><p>', '');
  return lines.join('\n');
}

export function formatArchive(archive: Archive, format: ExportFormat): string
{
  switch (format) {
    case 'json': return JSON.stringify(archive, null, 2);
    case 'markdown': return markdown(archive);
    case 'urls': return urls(archive);
    case 'bookmarks': return bookmarks(archive);
  }
}
