import type { GroupColor, SavedWindow, Snapshot } from './model';

export const SESSION_NAME_LIMIT = 100;
export type ArchiveSession = Pick<Snapshot, 'windows' | 'name' | 'capturedAt' | 'source'>;
export type Archive = { format: 'tabblackbox'; version: 1; sessions: ArchiveSession[] };

export function parseSessionName(value: unknown): string | null
{
  if (value !== null && typeof value !== 'string') throw new Error('Invalid session name.');
  const name = value?.trim() || null;
  if (name !== null && name.length > SESSION_NAME_LIMIT) throw new Error(`Session names must be ${SESSION_NAME_LIMIT} characters or fewer.`);
  return name;
}

function record(value: unknown): Record<string, unknown>
{
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid session archive.');
  return { ...value };
}

function groupColor(value: unknown): GroupColor
{
  switch (value) {
    case 'grey': case 'blue': case 'red': case 'yellow': case 'green': case 'pink': case 'purple': case 'cyan': case 'orange': return value;
    default: throw new Error('Invalid group color in session archive.');
  }
}

function parseWindow(value: unknown): SavedWindow
{
  const window = record(value);
  if (!Array.isArray(window.groups) || !Array.isArray(window.tabs) || !window.tabs.length) throw new Error('Invalid window in session archive.');
  const groups = window.groups.map((value: unknown) => {
    const group = record(value);
    if (typeof group.name !== 'string' || typeof group.collapsed !== 'boolean') throw new Error('Invalid group in session archive.');
    return { name: group.name, color: groupColor(group.color), collapsed: group.collapsed };
  });
  const tabs = window.tabs.map((value: unknown) => {
    const tab = record(value);
    if ((tab.url !== null && typeof tab.url !== 'string') || typeof tab.title !== 'string' || typeof tab.pinned !== 'boolean' ||
        (tab.group !== null && (typeof tab.group !== 'number' || !Number.isSafeInteger(tab.group) || tab.group < 0 || tab.group >= groups.length))) throw new Error('Invalid tab in session archive.');
    return { url: tab.url, title: tab.title, pinned: tab.pinned, group: tab.group };
  });
  return { groups, tabs };
}

export function parseArchive(value: unknown): Archive
{
  // validate imported data before it reaches storage or browser restoration
  const archive = record(value);
  if (archive.format !== 'tabblackbox' || archive.version !== 1 || !Array.isArray(archive.sessions) || !archive.sessions.length) throw new Error('Choose a TabBlackBox session archive with at least one session.');
  const sessions = archive.sessions.map((value: unknown): ArchiveSession => {
    const session = record(value);
    if (!Array.isArray(session.windows) || !session.windows.length || typeof session.capturedAt !== 'number' || !Number.isSafeInteger(session.capturedAt) || session.capturedAt < 0 || session.capturedAt > 8_640_000_000_000_000 ||
        (session.source !== 'automatic' && session.source !== 'manual')) throw new Error('Invalid session in archive.');
    return { windows: session.windows.map(parseWindow), name: parseSessionName(session.name), capturedAt: session.capturedAt, source: session.source };
  });
  return { format: 'tabblackbox', version: 1, sessions };
}
