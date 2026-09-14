export type RestoreAvailability = {
  tabCount: number;
  backingUp: boolean;
  restoring: boolean;
};

export function canRestore({ tabCount, backingUp, restoring }: RestoreAvailability): boolean
{
  // opening confirmation checks the snapshot against current file access
  return tabCount > 0 && !backingUp && !restoring;
}

export type RestoreDialogLock = {
  readonly active: boolean;
  acquire(): boolean;
  release(): void;
};

export function createRestoreDialogLock(): RestoreDialogLock
{
  let active = false;
  return {
    get active(): boolean { return active; },
    acquire(): boolean
    {
      if (active) return false;
      active = true;
      return true;
    },
    release(): void { active = false; },
  };
}
