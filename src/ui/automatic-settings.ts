import { applyAutomaticUpdate, DEFAULT_AUTOMATIC_SETTINGS } from '../automatic';
import { errorMessage, type AutomaticSettings, type AutomaticUpdate, type Overview } from '../model';

import { button, el, icon, icons, notice, request } from './shared';

export function automaticSettings(onOverview: (overview: Overview) => void, onSaved: () => void)
{
  const element = el('div');
  const feedback = el('div');
  feedback.setAttribute('aria-live', 'polite');
  function row(title: string, description: string, id: string, control: HTMLElement) {
    const row = el('div', 'storage-setting-row automatic-setting-row');
    const text = el('div', 'setting-description');
    const label = el('label', 'setting-name', title);
    label.htmlFor = id;
    const explanation = el('p', 'muted', description);
    explanation.id = id + '-description';
    control.id = id;
    control.setAttribute('aria-describedby', explanation.id);
    text.append(label, explanation);
    row.append(text, control);
    return row;
  }
  function dropdown(options: [string, string][]) {
    const select = el('select', 'settings-select');
    for (const [value, title] of options) {
      const option = el('option', '', title);
      option.value = value;
      select.append(option);
    }
    return select;
  }
  function wrapSelect(select: HTMLSelectElement) {
    const wrapper = el('div', 'settings-select-control');
    wrapper.append(select, icon(icons.ChevronDown));
    return wrapper;
  }
  const enabled = el('input', 'limit-switch');
  enabled.type = 'checkbox';
  enabled.setAttribute('role', 'switch');
  enabled.setAttribute('aria-label', 'Automatic backups');
  const enabledRow = row('Automatic backups', 'Automatically save backups of your tab sessions. Manual backups are still available on top of this.', 'automatic-enabled', enabled);
  const toggleLabel = el('label', 'limit-toggle');
  const toggleText = el('span', '', 'On');
  toggleLabel.append(toggleText, enabled);
  enabledRow.append(toggleLabel);

  const frequency = dropdown([['0', 'After every tab change'], ['1', 'At most once per 1 minute'], ['5', 'At most once per 5 minutes'], ['15', 'At most once per 15 minutes'], ['60', 'At most once per 1 hour'], ['1440', 'At most once per 24 hours']]);
  const frequencyRow = row('Backup frequency', 'Minimum time between automatic backups. Unchanged sessions are not saved multiple times regardless of this setting.', 'automatic-frequency', frequency);
  frequencyRow.append(wrapSelect(frequency));

  const duration = dropdown([['15', '15 minutes'], ['60', '1 hour'], ['1440', '24 hours']]);
  duration.value = '60';
  const pauseRow = row('Pause backups', 'Pause automatic backups temporarily. They resume when the pause timer ends.', 'automatic-pause', duration);
  const pause = button('Pause', icons.Clock3);
  const resume = button('Resume now', icons.RotateCcw);
  const pauseControls = el('div', 'automatic-pause-controls');
  pauseControls.append(wrapSelect(duration), pause, resume);
  pauseRow.append(pauseControls);
  element.append(enabledRow, frequencyRow, pauseRow, feedback);

  let settings: AutomaticSettings = { ...DEFAULT_AUTOMATIC_SETTINGS };
  let busy = true;
  let initialized = false;
  function render(): void {
    enabled.checked = settings.enabled;
    enabled.disabled = busy;
    toggleText.textContent = settings.enabled ? 'On' : 'Off';
    frequency.value = String(settings.intervalMinutes);
    frequency.disabled = busy || !settings.enabled;
    frequencyRow.classList.toggle('is-inactive', !settings.enabled);
    const paused = settings.pausedUntil !== null && settings.pausedUntil > Date.now();
    duration.disabled = busy || !settings.enabled || paused;
    pause.disabled = busy || !settings.enabled;
    resume.disabled = busy;
    pause.hidden = paused;
    resume.hidden = !paused;
  }
  async function change(update: AutomaticUpdate): Promise<void> {
    if (busy) return;
    const previous = settings;
    settings = applyAutomaticUpdate(settings, update, Date.now());
    busy = true;
    render();
    feedback.replaceChildren();
    try {
      const data = await request({ kind: 'automatic-settings', update });
      if (data.kind !== 'overview') throw new Error('Unexpected settings response.');
      settings = data.overview.metadata.automatic;
      onOverview(data.overview);
      onSaved();
    } catch (error) { settings = previous; feedback.replaceChildren(notice(errorMessage(error))); }
    finally { busy = false; render(); }
  }
  enabled.addEventListener('change', () => { void change({ kind: 'enabled', value: enabled.checked }); });
  frequency.addEventListener('change', () => {
    const value = Number(frequency.value);
    if (value === 0 || value === 1 || value === 5 || value === 15 || value === 60 || value === 1440) void change({ kind: 'frequency', value });
  });
  pause.addEventListener('click', () => {
    const minutes = Number(duration.value);
    if (minutes === 15 || minutes === 60 || minutes === 1440) void change({ kind: 'pause', minutes });
  });
  resume.addEventListener('click', () => { void change({ kind: 'resume' }); });
  render();
  return {
    element,
    update(overview: Overview): void {
      if (busy && initialized) return;
      settings = overview.metadata.automatic;
      // initial data unlocks controls while in-flight writes retain their busy state
      if (!initialized) { initialized = true; busy = false; }
      render();
    },
  };
}
