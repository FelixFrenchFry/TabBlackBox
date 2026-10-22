import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseArchive, type ArchiveSession } from '../../src/archive';
import { readArchiveFile } from '../../src/archive-file';
import { formatArchive } from '../../src/export-formats';
import { placeholderTarget, placeholderUrl } from '../../src/placeholder';
import { canonicalSession } from '../../src/session';
import { archive, archiveSession, text } from '../support/arbitraries';

const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';

// file that streams in chunks, also splitting multi-byte characters
function chunkedFile(content: string, cuts: number[]): Blob
{
  const bytes = new TextEncoder().encode(content);
  const positions = [...new Set(cuts.map(cut => cut % (bytes.length + 1)))].sort((a, b) => a - b);
  const chunks = [...positions, bytes.length].map((end, index) => bytes.slice(index ? positions[index - 1] : 0, end));
  return {
    size: bytes.length,
    stream: () => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }),
  } as unknown as Blob;
}

async function readAll(file: Blob): Promise<ArchiveSession[]>
{
  const sessions: ArchiveSession[] = [];
  for await (const session of readArchiveFile(file)) sessions.push(session);
  return sessions;
}

// bad input gives a readable error, not a crash
function expectValidationError(error: unknown): void
{
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(TypeError);
  expect(error).not.toBeInstanceOf(RangeError);
  expect((error as Error).message.length).toBeGreaterThan(0);
}

describe('archive validation', () =>
{
  it('accepts every valid archive unchanged', () =>
  {
    fc.assert(fc.property(archive, value => {
      expect(parseArchive(JSON.parse(JSON.stringify(value)))).toEqual(value);
    }));
  });

  it('rejects arbitrary JSON with a validation error', () =>
  {
    fc.assert(fc.property(fc.jsonValue(), value => {
      try { parseArchive(value); } catch (error) { expectValidationError(error); }
    }));
  });

  it('rejects archives with one field replaced by an arbitrary value', () =>
  {
    const paths = fc.constantFrom('format', 'version', 'sessions', 's.windows', 's.name', 's.capturedAt', 's.source', 's.tags', 'w.groups', 'w.tabs', 't.url', 't.title', 't.pinned', 't.group', 'g.name', 'g.color', 'g.collapsed');
    fc.assert(fc.property(archive, paths, fc.jsonValue(), (value, path, replacement) => {
      const copy = JSON.parse(JSON.stringify(value)) as Record<string, any>;
      const session = copy.sessions[0];
      const window = session.windows[0];
      const target = path === 'format' || path === 'version' || path === 'sessions' ? copy : path.startsWith('s.') ? session : path.startsWith('w.') ? window : path.startsWith('t.') ? window.tabs[0] : window.groups[0];
      if (!target) return;
      target[path.replace(/^\w\./, '')] = replacement;
      let parsed: ReturnType<typeof parseArchive>;
      try {
        parsed = parseArchive(copy);
      } catch (error) {
        expectValidationError(error);
        return;
      }
      // an accepted replacement must still parse the same
      expect(parseArchive(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }));
  });
});

describe('streamed archive reading', () =>
{
  it('reads exported archives like JSON.parse for any chunk boundaries', async () =>
  {
    await fc.assert(fc.asyncProperty(archive, fc.array(fc.nat(), { maxLength: 12 }), async (value, cuts) => {
      expect(await readAll(chunkedFile(formatArchive(value, 'json'), cuts))).toEqual(parseArchive(value).sessions);
    }));
  });

  it('reads pretty-printed archives with fields in any order', async () =>
  {
    await fc.assert(fc.asyncProperty(archive, fc.constantFrom(0, 1, 2, '\t', ' \r\n'), fc.boolean(), async (value, indent, sessionsFirst) => {
      const ordered = sessionsFirst ? { sessions: value.sessions, version: value.version, format: value.format } : value;
      expect(await readAll(new Blob([JSON.stringify(ordered, null, indent)]))).toEqual(parseArchive(value).sessions);
    }));
  });

  it('accepts or rejects corrupted archives without crashing or hanging', async () =>
  {
    await fc.assert(fc.asyncProperty(archive, fc.array(fc.tuple(fc.nat(), fc.nat({ max: 8 }), fc.string({ maxLength: 4 })), { minLength: 1, maxLength: 4 }), async (value, edits) => {
      let content = formatArchive(value, 'json');
      for (const [position, remove, insert] of edits) {
        const at = position % (content.length + 1);
        content = content.slice(0, at) + insert + content.slice(at + remove);
      }
      let sessions: ArchiveSession[];
      try {
        sessions = await readAll(new Blob([content]));
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(TypeError);
        return;
      }
      expect(parseArchive({ format: 'tabblackbox', version: 1, sessions }).sessions).toEqual(sessions);
    }), { numRuns: 300 });
  });
});

describe('placeholder addresses', () =>
{
  it('carry any web address and title through the placeholder page', () =>
  {
    fc.assert(fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), text(200), (url, title) => {
      expect(placeholderTarget(placeholderUrl(origin, url, title), origin)).toEqual({ url, title });
    }));
  });

  it('never open addresses that are not web pages', () =>
  {
    const scheme = fc.constantFrom('javascript:', 'JavaScript:', ' javascript:', 'data:', 'file:', 'chrome:', 'chrome-extension:', 'about:', 'blob:', 'vbscript:');
    fc.assert(fc.property(scheme, text(), text(), (prefix, rest, title) => {
      expect(placeholderTarget(placeholderUrl(origin, `${prefix}${rest}`, title), origin)).toBeNull();
    }));
  });

  it('ignore addresses of other extensions and pages', () =>
  {
    fc.assert(fc.property(fc.webUrl(), text(), (url, title) => {
      expect(placeholderTarget(placeholderUrl('chrome-extension://otherextensionidotherextensionid/', url, title), origin)).toBeNull();
    }));
  });
});

describe('readable exports', () =>
{
  const lines = (value: string) => value.split('\n');

  it('link only web pages in Markdown', () =>
  {
    fc.assert(fc.property(archive, value => {
      const markdown = formatArchive(value, 'markdown');
      const tabs = value.sessions.flatMap(session => session.windows.flatMap(window => window.tabs));
      const items = lines(markdown).filter(line => line.startsWith('- '));
      expect(items).toHaveLength(tabs.length);
      for (const [index, line] of items.entries()) {
        const url = tabs[index]?.url ?? null;
        let web = false;
        try { web = url !== null && ['http:', 'https:'].includes(new URL(url).protocol); } catch { /* not a URL */ }
        expect(line.startsWith('- ['), line).toBe(web);
        if (web) expect(line).toMatch(/^- \[.*\]\(https?:\/\/[^\s]*\)/);
      }
    }));
  });

  it('escape all page text in bookmarks HTML', () =>
  {
    const markup = /<(?:!DOCTYPE NETSCAPE-Bookmark-file-1|META HTTP-EQUIV="Content-Type" CONTENT="text\/html; charset=UTF-8"|\/?TITLE|\/?H1|\/?DL|p|DT|\/?H3(?: ADD_DATE="\d+")?|A HREF="[^"<>]*" ADD_DATE="\d+"|\/A|\/?CODE)>/g;
    fc.assert(fc.property(archive, value => {
      const html = formatArchive(value, 'bookmarks');
      expect(html.replace(markup, '')).not.toMatch(/[<>]/);
      for (const match of html.matchAll(/HREF="([^"]*)"/g)) expect(match[1]).toMatch(/^https?:\/\//);
    }));
  });

  it('list one address per tab in URL lists', () =>
  {
    fc.assert(fc.property(archive, value => {
      const urls = value.sessions.flatMap(session => session.windows.flatMap(window => window.tabs.flatMap(tab => tab.url === null ? [] : [tab.url])));
      expect(formatArchive(value, 'urls')).toBe(urls.map(url => `${url}\n`).join(''));
    }));
  });

  it('compare sessions independently of window order', () =>
  {
    fc.assert(fc.property(archiveSession, session => {
      expect(canonicalSession({ windows: [...session.windows].reverse() })).toBe(canonicalSession(session));
    }));
  });
});
