import type { AutomaticSettings, AutomaticUpdate } from './model';

export const DEFAULT_AUTOMATIC_SETTINGS: Readonly<AutomaticSettings> = { enabled: true, intervalMinutes: 0, pausedUntil: null };

export function parseAutomaticUpdate(value: unknown): AutomaticUpdate
{
  if (typeof value === 'object' && value !== null && 'kind' in value) {
    if (value.kind === 'enabled' && 'value' in value && typeof value.value === 'boolean') return { kind: 'enabled', value: value.value };
    if (value.kind === 'frequency' && 'value' in value && (value.value === 0 || value.value === 1 || value.value === 5 || value.value === 15 || value.value === 60 || value.value === 1440)) return { kind: 'frequency', value: value.value };
    if (value.kind === 'pause' && 'minutes' in value && (value.minutes === 15 || value.minutes === 60 || value.minutes === 1440)) return { kind: 'pause', minutes: value.minutes };
    if (value.kind === 'resume') return { kind: 'resume' };
  }
  throw new Error('Invalid automatic backup setting.');
}

export function applyAutomaticUpdate(settings: AutomaticSettings, update: AutomaticUpdate, now: number): AutomaticSettings
{
  switch (update.kind) {
    case 'enabled': return { ...settings, enabled: update.value, pausedUntil: null };
    case 'frequency': return { ...settings, intervalMinutes: update.value };
    case 'pause':
      if (!settings.enabled) throw new Error('Enable automatic backups before pausing them.');
      return { ...settings, pausedUntil: now + update.minutes * 60_000 };
    case 'resume': return { ...settings, pausedUntil: null };
  }
}