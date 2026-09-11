export type RestoreAvailability = {
  supportedCount: number;
  backingUp: boolean;
  restoring: boolean;
};

export function canRestore({ supportedCount, backingUp, restoring }: RestoreAvailability): boolean {
  return supportedCount > 0 && !backingUp && !restoring;
}
