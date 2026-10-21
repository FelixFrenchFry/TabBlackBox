import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { createBrowser, startBackground } from '../support/browser';
import { scanBrowser } from '../../src/browser';

vi.mock('../../src/browser', () => ({ scanBrowser: vi.fn(async () => ({ windows: [] })), restoreBrowser: {} }));

it('routes named alarms through the shared claim and removes orphaned wake alarms', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const browser = createBrowser();
  const create = browser.alarms.create;
  const clear = browser.alarms.clear;
  browser.alarms.getAll.mockResolvedValue([
    { name: 'automatic-backup-wake:old-worker', scheduledTime: 0, persistAcrossSessions: true },
    { name: 'reconcile-session', scheduledTime: 0, persistAcrossSessions: true },
  ]);
  const { request, change: changed, alarm: onAlarm } = await startBackground(browser);
  try {
    await request({ kind: 'automatic-settings', update: { kind: 'enabled', value: true } });
    await request({ kind: 'refresh' });
    await request({ kind: 'overview' });
    expect(clear).toHaveBeenCalledWith('automatic-backup-wake:old-worker');
    expect(clear).not.toHaveBeenCalledWith('reconcile-session');
    vi.mocked(scanBrowser).mockClear();
    changed();
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    const alarmName = create.mock.lastCall?.[0];
    if (typeof alarmName !== 'string') throw new Error('Missing alarm name');
    expect(alarmName).toMatch(/^automatic-backup-wake:/);
    const alarm = { name: alarmName, scheduledTime: Date.now() + 2000, persistAcrossSessions: true };
    onAlarm(alarm);
    onAlarm(alarm);
    await request({ kind: 'overview' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(scanBrowser).toHaveBeenCalledTimes(1);
    onAlarm(alarm);
    onAlarm({ name: 'automatic-backup-wake:old-worker', scheduledTime: 0, persistAcrossSessions: true });
    await request({ kind: 'overview' });
    expect(scanBrowser).toHaveBeenCalledTimes(1);
    onAlarm({ name: 'reconcile-session', scheduledTime: Date.now(), persistAcrossSessions: true });
    await vi.waitFor(() => expect(scanBrowser).toHaveBeenCalledTimes(2));
  } finally { await request({ kind: 'automatic-settings', update: { kind: 'enabled', value: false } }); }
});
