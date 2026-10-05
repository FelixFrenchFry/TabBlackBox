import { errorMessage, type Overview, type RestoreSettings } from '../model';
import { DEFAULT_RESTORE_SETTINGS, parseRestoreSettings, UNLOAD_THRESHOLD_MAX } from '../restore-settings';

import { el, notice, request } from './shared';

export function restoreSettings(onOverview: (overview: Overview) => void, onSaved: () => void)
{
  const element = el('div');
  const feedback = el('div');
  feedback.setAttribute('aria-live', 'polite');
  const row = el('div', 'storage-setting-row restore-setting-row');
  const text = el('div', 'setting-description');
  const label = el('label', 'setting-name', 'Lightweight tab restore');
  label.htmlFor = 'unload-threshold';
  const explanation = el('p', 'muted', 'Restoring many tabs at once can use a lot of memory. Above this number, tabs are restored as temporary placeholders. They wait to load until you click them.');
  explanation.id = 'unload-threshold-description';
  const validation = el('p', 'setting-validation');
  validation.id = 'unload-threshold-validation';
  validation.hidden = true;
  text.append(label, explanation, validation);
  const control = el('div', 'settings-number-control');
  const toggle = el('input', 'limit-switch');
  toggle.type = 'checkbox';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', 'Lightweight tab restore');
  const toggleLabel = el('label', 'limit-toggle');
  const toggleText = el('span', '', 'On');
  toggleLabel.append(toggleText, toggle);
  const input = el('input', 'settings-number');
  input.type = 'number';
  input.id = 'unload-threshold';
  input.min = '1';
  input.max = String(UNLOAD_THRESHOLD_MAX);
  input.step = '1';
  input.required = true;
  input.setAttribute('aria-describedby', `${explanation.id} ${validation.id}`);
  const field = el('div', 'settings-number-field');
  field.append(input, el('span', 'settings-number-unit', 'tabs'));
  control.append(toggleLabel, field);
  row.append(text, control);
  element.append(row, feedback);

  let settings: RestoreSettings = { ...DEFAULT_RESTORE_SETTINGS };
  let busy = true;
  let initialized = false;
  let invalid = false;
  function showValidation(value: boolean): void {
    invalid = value;
    input.setAttribute('aria-invalid', String(value));
    validation.hidden = !value;
    validation.textContent = value ? input.validationMessage : '';
  }
  function render(): void {
    toggle.checked = settings.unloadBackgroundTabs;
    toggle.disabled = busy;
    toggleText.textContent = settings.unloadBackgroundTabs ? 'On' : 'Off';
    // keep a threshold that is being edited or rejected when periodic overviews arrive
    if (document.activeElement !== input && !invalid) {
      input.value = String(settings.unloadThreshold);
      showValidation(false);
    }
    input.disabled = busy || !settings.unloadBackgroundTabs;
    row.classList.toggle('is-inactive', !settings.unloadBackgroundTabs);
  }
  async function change(next: RestoreSettings): Promise<void> {
    if (busy) return;
    const previous = settings;
    settings = next;
    busy = true;
    render();
    feedback.replaceChildren();
    try {
      const data = await request({ kind: 'restore-settings', settings: next });
      if (data.kind !== 'overview') throw new Error('Unexpected settings response.');
      settings = data.overview.metadata.restore;
      onOverview(data.overview);
      onSaved();
    } catch (error) { settings = previous; feedback.replaceChildren(notice(errorMessage(error))); }
    finally { busy = false; render(); }
  }
  toggle.addEventListener('change', () => { void change({ ...settings, unloadBackgroundTabs: toggle.checked }); });
  // editing a rejected threshold clears its message until the new value is committed
  input.addEventListener('input', () => { if (invalid) showValidation(false); });
  // commit the threshold when the field loses focus or Enter is pressed
  input.addEventListener('change', () => {
    showValidation(!input.validity.valid);
    if (input.validity.valid) void change(parseRestoreSettings({ ...settings, unloadThreshold: input.valueAsNumber }));
  });
  render();
  return {
    element,
    update(overview: Overview): void {
      if (busy && initialized) return;
      settings = overview.metadata.restore;
      // initial data unlocks controls while in-flight writes retain their busy state
      if (!initialized) { initialized = true; busy = false; }
      render();
    },
  };
}
