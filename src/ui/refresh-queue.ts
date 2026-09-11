type RefreshKind = 'overview' | 'refresh' | 'backup';

export function createRefreshQueue(run: (kind: RefreshKind) => Promise<void>, setBackingUp: (value: boolean) => void): (kind: RefreshKind) => Promise<void>
{
  let active: Promise<void> | undefined;
  let backup: Promise<void> | undefined;
  return kind =>
  {
    if (kind === 'backup') {
      if (backup) return backup;
      setBackingUp(true);
      const previous = active;
      backup = (async () =>
      {
        // keep the queued backup after a failed poll
        await previous?.catch(() => undefined);
        await run('backup');
      })().finally(() => { backup = undefined; setBackingUp(false); });
      return backup;
    }
    if (active || backup) return Promise.resolve();
    active = run(kind).finally(() => { active = undefined; });
    return active;
  };
}
