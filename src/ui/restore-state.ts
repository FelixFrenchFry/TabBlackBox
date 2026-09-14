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
