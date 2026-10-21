import { describe, expect, it, vi } from 'vitest';
import { createRefreshQueue } from '../../src/ui/refresh-queue';

describe('manual backup queue', () =>
{
  it.each([false, true])('runs one queued backup after a poll (failure: %s)', async fails =>
  {
    const poll = Promise.withResolvers<void>();
    const backup = Promise.withResolvers<void>();
    const run = vi.fn((kind: string) => kind === 'backup' ? backup.promise : poll.promise);
    const saving = vi.fn();
    const refresh = createRefreshQueue(run, saving);
    const pendingPoll = refresh('overview');
    const pollResult = pendingPoll.catch(() => undefined);
    const pendingBackup = refresh('backup');
    expect(refresh('backup')).toBe(pendingBackup);
    await refresh('overview');
    expect(saving).toHaveBeenCalledExactlyOnceWith(true);
    expect(run.mock.calls).toEqual([['overview']]);
    if (fails) poll.reject(new Error('Poll failed'));
    else poll.resolve();
    await pollResult;
    await vi.waitFor(() => expect(run.mock.calls).toEqual([['overview'], ['backup']]));
    await refresh('overview');
    expect(run).toHaveBeenCalledTimes(2);
    backup.resolve();
    await pendingBackup;
    expect(saving.mock.calls).toEqual([[true], [false]]);
    await refresh('overview').catch(() => undefined);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('clears the busy state after a failed backup and permits another attempt', async () =>
  {
    const run = vi.fn(async () => {}).mockRejectedValueOnce(new Error('Backup failed'));
    const saving = vi.fn();
    const refresh = createRefreshQueue(run, saving);
    await expect(refresh('backup')).rejects.toThrow('Backup failed');
    expect(saving.mock.calls).toEqual([[true], [false]]);
    await refresh('backup');
    expect(run).toHaveBeenCalledTimes(2);
  });
});
