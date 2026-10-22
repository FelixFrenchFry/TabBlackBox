import fc from 'fast-check';
import type { Archive, ArchiveSession } from '../../src/archive';
import type { GroupColor, SavedWindow, Session } from '../../src/model';

const colors: GroupColor[] = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

// any Unicode text, including emoji, quotes, brackets and line breaks
export const text = (maxLength = 40) => fc.string({ unit: 'binary', maxLength });

// browser addresses plus ones that must never count as web pages
export const address = fc.oneof(
  { weight: 6, arbitrary: fc.webUrl({ withQueryParameters: true, withFragments: true }) },
  { weight: 1, arbitrary: fc.constantFrom('about:blank', 'chrome://settings/', 'file:///C:/notes.txt', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'https://example.com/a b(c)<d>&e') },
  { weight: 1, arbitrary: fc.constant(null) },
);

export const window = (maxTabs = 6): fc.Arbitrary<SavedWindow> => fc.array(fc.record({ name: text(20), color: fc.constantFrom(...colors), collapsed: fc.boolean() }), { maxLength: 3 }).chain(groups =>
  fc.record({
    groups: fc.constant(groups),
    tabs: fc.array(fc.record({
      url: address, title: text(), pinned: fc.boolean(),
      group: groups.length ? fc.option(fc.nat({ max: groups.length - 1 }), { nil: null }) : fc.constant(null),
    }), { minLength: 1, maxLength: maxTabs }),
  }));

export const session = (maxWindows = 3, maxTabs = 6): fc.Arbitrary<Session> => fc.record({ windows: fc.array(window(maxTabs), { minLength: 1, maxLength: maxWindows }) });

// normalized tags
const tag = fc.stringMatching(/^[a-z0-9äöü]+( [a-z0-9äöü]+)?$/).filter(value => value.length <= 30);

export const archiveSession: fc.Arbitrary<ArchiveSession> = fc.record({
  windows: session().map(value => value.windows),
  name: fc.option(text(100).map(value => value.trim()).filter(value => value.length > 0), { nil: null }),
  capturedAt: fc.integer({ min: 0, max: 8_640_000_000_000_000 }),
  source: fc.constantFrom('automatic' as const, 'manual' as const),
  tags: fc.uniqueArray(tag, { maxLength: 10 }),
}).map(({ tags, ...value }) => (tags.length ? { ...value, tags } : value));

export const archive: fc.Arbitrary<Archive> = fc.array(archiveSession, { minLength: 1, maxLength: 4 }).map(sessions => ({ format: 'tabblackbox', version: 1, sessions }));
