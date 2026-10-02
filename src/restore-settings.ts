import type { RestoreSettings } from './model';

export const UNLOAD_THRESHOLD_MAX = 10_000;
export const DEFAULT_RESTORE_SETTINGS: Readonly<RestoreSettings> = { unloadBackgroundTabs: true, unloadThreshold: 30 };

export function parseRestoreSettings(value: unknown): RestoreSettings
{
  if (typeof value !== 'object' || value === null) throw new Error('Invalid restore settings.');
  if (!('unloadBackgroundTabs' in value) || typeof value.unloadBackgroundTabs !== 'boolean' ||
      !('unloadThreshold' in value) || typeof value.unloadThreshold !== 'number' || !Number.isSafeInteger(value.unloadThreshold) ||
      value.unloadThreshold < 1 || value.unloadThreshold > UNLOAD_THRESHOLD_MAX) throw new Error('Enter a valid whole-number tab threshold.');
  return { unloadBackgroundTabs: value.unloadBackgroundTabs, unloadThreshold: value.unloadThreshold };
}
