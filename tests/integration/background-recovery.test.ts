import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { createBrowser, startBackground } from '../support/browser';
import { Repository } from '../../src/database';

vi.mock('../../src/browser', () => ({ scanBrowser: vi.fn(async () => ({ windows: [] })), restoreBrowser: {} }));

it('serves history, previews and error overviews when recovery cannot write', async () =>
{
  const repository = new Repository();
  await repository.setAutomaticSettings({ kind: 'enabled', value: true }, Date.now());
  const saved = await repository.capture({ windows: [{ groups: [], tabs: [{ url: 'https://example.test', title: 'Example', pinned: false, group: null }] }] }, 'automatic', Date.now());
  if (saved.kind !== 'saved') throw new Error('Fixture backup missing');
  await repository.setOperation({ kind: 'running', snapshotId: saved.id, startedAt: 1, opened: 1, skipped: 0, failed: 0, groupErrors: 0, total: 2, errors: [] });
  const writes = vi.spyOn(Repository.prototype, 'setOperation').mockRejectedValue(new Error('Disk full'));
  const browser = createBrowser();
  const setBadgeText = browser.action.setBadgeText;
  try {
    const { request } = await startBackground(browser);
    await vi.waitFor(() => expect(setBadgeText).toHaveBeenCalledWith({ text: '!' }));
    expect(await request({ kind: 'history', before: null })).toMatchObject({ ok: true, data: { kind: 'history', items: [{ id: saved.id }] } });
    expect(await request({ kind: 'snapshot', id: saved.id })).toMatchObject({ ok: true, data: { kind: 'snapshot', snapshot: { id: saved.id } } });
    for (const kind of ['overview', 'refresh', 'overview'] as const) {
      expect(await request({ kind })).toMatchObject({ ok: true, data: { kind: 'overview', overview: { status: { kind: 'error', message: 'Disk full' }, latest: { id: saved.id } } } });
    }
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await request({ kind: 'restore', id: saved.id })).toEqual({ ok: false, error: 'Disk full' });
  } finally { await repository.close(); }
});
