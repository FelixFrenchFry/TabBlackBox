import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { startBackground } from '../support/browser';
import { scanBrowser } from '../../src/browser';
import { Repository } from '../../src/database';

vi.mock('../../src/browser', () => ({ scanBrowser: vi.fn(async () => ({ windows: [{ groups: [], tabs: [{ title: 'Private tab', url: 'https://example.test/private', pinned: false, group: null }] }] })), restoreBrowser: {} }));
beforeEach(() => { vi.mocked(scanBrowser).mockClear(); });

it('allows manual backups immediately without scanning automatically on a fresh install', async () =>
{
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const app = await startBackground();
  expect(await app.request({ kind: 'overview' })).toMatchObject({ ok: true, data: { overview: { status: { kind: 'disabled' }, metadata: { automatic: { enabled: false } } } } });
  app.change();
  app.alarm({ name: 'reconcile-session', scheduledTime: Date.now(), persistAcrossSessions: true });
  await vi.advanceTimersByTimeAsync(60_000);
  await app.request({ kind: 'refresh' });
  expect(scanBrowser).not.toHaveBeenCalled();
  expect(await app.request({ kind: 'backup' })).toMatchObject({ ok: true, data: { captureResult: { kind: 'saved' } } });
  expect(scanBrowser).toHaveBeenCalledTimes(1);
});

it('enables automatic backups through settings and keeps the preference after worker restart', async () =>
{
  const app = await startBackground();
  expect(await app.request({ kind: 'automatic-settings', update: { kind: 'enabled', value: true } })).toMatchObject({ ok: true, data: { overview: { metadata: { automatic: { enabled: true } } } } });
  await app.request({ kind: 'refresh' });
  expect(scanBrowser).toHaveBeenCalled();
  const restarted = await startBackground();
  expect(await restarted.request({ kind: 'overview' })).toMatchObject({ ok: true, data: { overview: { metadata: { automatic: { enabled: true } } } } });
  await restarted.request({ kind: 'automatic-settings', update: { kind: 'enabled', value: false } });
});

it('keeps automatic backups off when saving the setting fails', async () =>
{
  const app = await startBackground();
  const write = vi.spyOn(Repository.prototype, 'setAutomaticSettings').mockRejectedValueOnce(new Error('Disk full'));
  expect(await app.request({ kind: 'automatic-settings', update: { kind: 'enabled', value: true } })).toEqual({ ok: false, error: 'Disk full' });
  expect(scanBrowser).not.toHaveBeenCalled();
  write.mockRestore();
  expect(await app.request({ kind: 'backup' })).toMatchObject({ ok: true, data: { captureResult: { kind: 'saved' } } });
});
