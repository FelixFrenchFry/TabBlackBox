import { describe, expect, it } from 'vitest';
import type { Archive } from '../../src/archive';
import { EXPORT_FORMATS, formatArchive } from '../../src/export-formats';

const archive: Archive = {
  format: 'tabblackbox', version: 1,
  sessions: [
    {
      name: 'Research <1> & notes', capturedAt: 1_700_000_000_000, source: 'manual',
      windows: [
        { groups: [{ name: 'Reading_list', color: 'blue', collapsed: false }], tabs: [
          { url: 'https://example.test/a_(b)?q=1&r=2', title: 'Tab [one]', pinned: false, group: 0 },
          { url: 'chrome://settings', title: '', pinned: true, group: null },
          { url: null, title: 'No address', pinned: false, group: null },
        ] },
        { groups: [], tabs: [{ url: 'https://example.test/"quoted"', title: 'Second window', pinned: false, group: null }] },
      ],
    },
    { name: null, capturedAt: 1_700_000_100_000, source: 'manual', windows: [{ groups: [], tabs: [{ url: 'https://example.test/c', title: 'Plain', pinned: false, group: null }] }] },
  ],
};

describe('export formats', () =>
{
  it('lists each format once with a unique file extension', () =>
  {
    expect(EXPORT_FORMATS.map(item => item.format)).toEqual(['json', 'markdown', 'urls', 'bookmarks']);
    expect(new Set(EXPORT_FORMATS.map(item => item.extension)).size).toBe(EXPORT_FORMATS.length);
  });

  it('keeps the json archive importable', () =>
  {
    expect(JSON.parse(formatArchive(archive, 'json'))).toEqual(archive);
  });

  it('writes markdown with escaped titles, safe links, windows, and group names', () =>
  {
    const text = formatArchive(archive, 'markdown').split('\n');
    expect(text).toContain('# Research \\<1\\> & notes');
    expect(text).toContain('# Unnamed session');
    expect(text).toContain('Captured 2023-11-14T22:13:20.000Z');
    expect(text).toContain('## Window 1');
    expect(text).toContain('## Window 2');
    expect(text).toContain('- [Tab \\[one\\]](https://example.test/a_%28b%29?q=1&amp;r=2) _(Reading\\_list)_');
    expect(text).toContain('- ` chrome://settings `');
    expect(text).toContain('- No address');
  });

  it('lists every address once per line and skips tabs without one', () =>
  {
    expect(formatArchive(archive, 'urls')).toBe('https://example.test/a_(b)?q=1&r=2\nchrome://settings\nhttps://example.test/"quoted"\nhttps://example.test/c\n');
  });

  it('writes bookmark folders per session and window with escaped markup', () =>
  {
    const text = formatArchive(archive, 'bookmarks');
    expect(text.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true);
    expect(text).toContain('<DT><H3 ADD_DATE="1700000000">Research &lt;1&gt; &amp; notes</H3>');
    expect(text).toContain('<DT><H3 ADD_DATE="1700000100">Unnamed session</H3>');
    expect(text).toContain('<DT><A HREF="https://example.test/a_(b)?q=1&amp;r=2" ADD_DATE="1700000000">Tab [one]</A>');
    expect(text).toContain('<A HREF="https://example.test/%22quoted%22" ADD_DATE="1700000000">Second window</A>');
    expect(text).not.toContain('No address');
    // every opened list is closed again
    expect(text.match(/<DL>/g)?.length).toBe(text.match(/<\/DL>/g)?.length);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '\u0000 \tjavascript:alert(1)',
    'java\r\n\tscript:alert(1)',
    'javascript&#58;alert(1)',
    '&#106;avascript:alert(1)',
    'javascript%3Aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///C:/notes.html',
    'chrome://settings',
    'about:blank',
    'mailto:person@example.test',
    '//example.test/path',
    '/relative/path',
    'https://',
  ])('keeps unsupported URLs as text without changing backup data: %s', url =>
  {
    const input: Archive = { format: 'tabblackbox', version: 1, sessions: [{ name: null, capturedAt: 1000, source: 'manual', windows: [{ groups: [], tabs: [{ url, title: 'Research notes', pinned: false, group: null }] }] }] };
    const html = formatArchive(input, 'bookmarks');
    const markdown = formatArchive(input, 'markdown');
    expect(html).not.toContain('<A ');
    expect(html).toContain('Research notes: <CODE>');
    expect(markdown).toContain('- Research notes: ` ');
    expect(markdown).not.toContain('](');
    expect(JSON.parse(formatArchive(input, 'json'))).toEqual(input);
    expect(formatArchive(input, 'urls')).toBe(`${url}\n`);
  });

  it('normalizes approved links and escapes Markdown destinations without changing their targets', () =>
  {
    const input: Archive = { format: 'tabblackbox', version: 1, sessions: [{ name: null, capturedAt: 1000, source: 'manual', windows: [{ groups: [], tabs: [
      { url: ' \tHTTPS://EXAMPLE.TEST/a b?q=one\\two&copy;=yes', title: '![image] <tag>', pinned: false, group: null },
      { url: 'http://example.test/', title: 'HTTP', pinned: false, group: null },
    ] }] }] };
    expect(formatArchive(input, 'bookmarks')).toContain('HREF="https://example.test/a%20b?q=one\\two&amp;copy;=yes"');
    expect(formatArchive(input, 'markdown')).toContain('(https://example.test/a%20b?q=one%5Ctwo&amp;copy;=yes)');
    expect(formatArchive(input, 'markdown')).toContain('(http://example.test/)');
  });

  it('contains markup and backticks in unsupported URLs as literal text', () =>
  {
    const url = 'javascript:alert(1)`` [click](https://example.test) <img src=x onerror=alert(1)>';
    const input: Archive = { format: 'tabblackbox', version: 1, sessions: [{ name: '<script>alert(1)</script>', capturedAt: 1000, source: 'manual', windows: [{ groups: [], tabs: [{ url, title: '', pinned: false, group: null }] }] }] };
    expect(formatArchive(input, 'markdown')).toContain(`- \`\`\` ${url} \`\`\``);
    expect(formatArchive(input, 'bookmarks')).toContain('<CODE>javascript:alert(1)`` [click](https://example.test) &lt;img src=x onerror=alert(1)&gt;</CODE>');
    expect(formatArchive(input, 'bookmarks')).not.toMatch(/<(?:A |img|script)/);
  });
});
