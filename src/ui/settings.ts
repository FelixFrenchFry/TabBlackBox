import { automaticSettings } from './automatic-settings';
import { restoreSettings } from './restore-settings';
import { readDateFormat, setDateFormat } from './dates';
import { errorMessage, type Overview, type StorageSettings } from '../model';
import { DEFAULT_STORAGE_SETTINGS, MB, parseStorageSettings } from '../storage';
import { readAppearance, setAppearance } from './appearance';
import { button, el, icon, icons, notice, plural, request, createStatusView } from './shared';

function settingsPanel(title: string, glyph: Parameters<typeof icon>[0])
{
  const element = el('section', 'settings-card');
  const header = el('h2', 'list-header', title);
  header.prepend(icon(glyph));
  const body = el('div', 'settings-body');
  element.append(header, body);
  return { element, body };
}

function storageSetting(name: string, description: string, id: string, unit: string, max: number)
{
  const row = el('div', 'storage-setting-row');
  const text = el('div', 'setting-description');
  const label = el('label', 'setting-name', name);
  label.htmlFor = id;
  const heading = el('div', 'setting-label');
  heading.append(label, el('span', 'badge', 'for automatic backups'));
  const explanation = el('p', 'muted', description);
  explanation.id = `${id}-description`;
  const validation = el('p', 'setting-validation');
  validation.id = `${id}-validation`;
  validation.hidden = true;
  text.append(heading, explanation, validation);
  const control = el('div', 'settings-number-control');
  const input = el('input', 'settings-number');
  input.type = 'number';
  input.id = id;
  input.min = '1';
  input.max = String(max);
  input.step = '1';
  input.required = true;
  input.disabled = true;
  input.setAttribute('aria-describedby', `${explanation.id} ${validation.id}`);
  control.append(input, el('span', 'muted', unit));
  row.append(text, control);
  return { row, input, control, validation };
}

function confirmCleanup(count: number): Promise<boolean>
{
  return new Promise(resolve => {
    const dialog = el('dialog', 'restore-dialog');
    const title = el('h2', '', 'Delete older backups?');
    title.id = 'storage-confirm-title';
    dialog.setAttribute('aria-labelledby', title.id);
    dialog.append(title, el('p', '', `Applying these limits will delete ${plural(count, 'older backup')}. This cannot be undone. Your saved sessions and newest recovery backup will be kept.`));
    const actions = el('div', 'dialog-actions');
    const cancel = button('Cancel', icons.X);
    const confirm = button('Apply limits', icons.HardDrive, 'button danger');
    actions.append(cancel, confirm);
    dialog.append(actions);
    cancel.addEventListener('click', () => dialog.close());
    confirm.addEventListener('click', () => dialog.close('apply'));
    dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'apply'; dialog.remove(); resolve(accepted); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

export function createSettingsView(onSaved: () => void)
{
  const element = el('main', 'history-main');
  const heading = el('div', 'page-heading');
  const titles = el('div');
  titles.append(el('h1', '', 'Settings'), el('p', 'muted', 'Configure when automatic backups are saved, how long they are kept, and how things are displayed.'));
  heading.append(titles);
  const { element: appearance, body: appearanceBody } = settingsPanel('Appearance', icons.Palette);
  const themeRow = el('div', 'settings-row');
  const label = el('label', 'setting-name', 'Color theme');
  label.htmlFor = 'color-theme';
  const select = el('select', 'settings-select');
  select.id = 'color-theme';
  for (const [value, title] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const) {
    const option = el('option', '', title);
    option.value = value;
    select.append(option);
  }
  const sync = () => { select.value = readAppearance(); };
  sync();
  window.addEventListener('storage', sync);
  const appearanceFeedback = el('div');
  appearanceFeedback.setAttribute('aria-live', 'polite');
  select.addEventListener('change', () =>
  {
    const value = select.value;
    if (value !== 'system' && value !== 'light' && value !== 'dark') return;
    try { setAppearance(value); appearanceFeedback.replaceChildren(); onSaved(); }
    catch (error) { sync(); appearanceFeedback.replaceChildren(notice(errorMessage(error))); }
  });
  const selectControl = el('div', 'settings-select-control');
  selectControl.append(select, icon(icons.ChevronDown));
  const themeDescription = el('div', 'setting-description');
  const themeExplanation = el('p', 'muted', 'Choose a light or dark theme, or follow your device’s appearance.');
  themeExplanation.id = 'color-theme-description';
  select.setAttribute('aria-describedby', themeExplanation.id);
  themeDescription.append(label, themeExplanation);
  themeRow.append(themeDescription, selectControl);
  const dateRow = el('div', 'settings-row appearance-date-row');
  const dateText = el('div', 'setting-description');
  const dateLabel = el('label', 'setting-name', 'Date format');
  dateLabel.htmlFor = 'date-format';
  const dateExplanation = el('p', 'muted', 'Choose between exact timestamps like "12. Sept., 2026, 20:55:07", or relative timestamps like “17 min ago”, or a combination of them.');
  dateExplanation.id = 'date-format-description';
  dateText.append(dateLabel, dateExplanation);
  const dateSelect = el('select', 'settings-select');
  dateSelect.id = 'date-format';
  dateSelect.setAttribute('aria-describedby', dateExplanation.id);
  for (const [value, title] of [['exact', 'Exact'], ['relative', 'Relative'], ['combination', 'Combination']] as const) {
    const option = el('option', '', title);
    option.value = value;
    dateSelect.append(option);
  }
  const syncDates = () => { dateSelect.value = readDateFormat(); };
  syncDates();
  window.addEventListener('storage', syncDates);
  dateSelect.addEventListener('change', () => {
    const value = dateSelect.value;
    if (value !== 'exact' && value !== 'relative' && value !== 'combination') return;
    try { setDateFormat(value); appearanceFeedback.replaceChildren(); onSaved(); }
    catch (error) { syncDates(); appearanceFeedback.replaceChildren(notice(errorMessage(error))); }
  });
  const dateControl = el('div', 'settings-select-control');
  dateControl.append(dateSelect, icon(icons.ChevronDown));
  dateRow.append(dateText, dateControl);
  appearanceBody.append(themeRow, dateRow, appearanceFeedback);

  const { element: storage, body: storageBody } = settingsPanel('Storage limits', icons.HardDrive);
  const usage = el('p', 'settings-storage muted', 'Checking storage…');
  const usageRow = el('div', 'storage-usage');
  const percentage = el('span', 'storage-percentage muted', '—');
  usageRow.append(usage, percentage);
  const meter = el('progress', 'storage-meter');
  meter.max = DEFAULT_STORAGE_SETTINGS.maxStorageMB * MB;
  meter.setAttribute('aria-label', 'Backup storage used');
  const age = storageSetting('Time limit', 'Time limit before an automatically saved backup expires. Expired automatic backups are deleted. Manual backups are excluded from this.', 'retention-days', 'days', 3650);
  const count = storageSetting('Count limit', 'Maximum number of automatically saved backups. The oldest automatic backup is deleted when this limit is exceeded. Manual backups are excluded from this.', 'maximum-backups', 'backups', 100_000);
  const capacity = storageSetting('Space limit', 'Maximum disk space available for automatic backups. The oldest automatic backups are deleted when space is needed. Manual backups are excluded from this.', 'maximum-storage', 'MB', 100_000);
  function optionalLimit(setting: typeof age) {
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.className = 'limit-switch';
    toggle.setAttribute('role', 'switch');
    toggle.checked = true;
    toggle.disabled = true;
    toggle.setAttribute('aria-label', setting === age ? 'Enable time limit' : 'Enable backup limit');
    const label = el('label', 'limit-toggle');
    const state = el('span', '', 'On');
    label.append(state, toggle);
    setting.control.prepend(label);
    function sync(): void
    {
      setting.row.classList.toggle('is-inactive', !toggle.checked);
      state.textContent = toggle.checked ? 'On' : 'Off';
    }
    toggle.addEventListener('change', () => { setting.input.disabled = !toggle.checked; sync(); });
    return { setting, toggle, sync };
  }
  const ageLimit = optionalLimit(age);
  const countLimit = optionalLimit(count);
  const optionalLimits = [ageLimit, countLimit];
  const form = el('form', 'storage-settings-form');
  const storageFeedback = el('div');
  storageFeedback.setAttribute('aria-live', 'polite');
  let dirty = false;
  let saving = false;
  let baseline: StorageSettings | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let pressingToggle = false;
  const draft = () => ({
    retentionDays: ageLimit.toggle.checked ? age.input.valueAsNumber : null,
    maxBackups: countLimit.toggle.checked ? count.input.valueAsNumber : null,
    maxStorageMB: capacity.input.valueAsNumber,
  });
  function updateSave(): void
  {
    const current = draft();
    dirty = baseline !== undefined && (current.retentionDays !== baseline.retentionDays || current.maxBackups !== baseline.maxBackups || current.maxStorageMB !== baseline.maxStorageMB);
  }
  function updateControls(): void
  {
    updateSave();
    form.setAttribute('aria-busy', String(saving));
    capacity.input.disabled = saving || !baseline;
    for (const { setting, toggle, sync } of optionalLimits) {
      sync();
      toggle.disabled = saving || !baseline;
      setting.input.disabled = saving || !baseline || !toggle.checked;
    }
  }
  function restoreDraft(settings: StorageSettings): void
  {
    age.input.value = String(settings.retentionDays ?? 90);
    ageLimit.toggle.checked = settings.retentionDays !== null;
    count.input.value = String(settings.maxBackups ?? 5000);
    countLimit.toggle.checked = settings.maxBackups !== null;
    capacity.input.value = String(settings.maxStorageMB);
  }
  function validate(): boolean
  {
    let valid = true;
    for (const { input, validation } of [capacity, count, age]) {
      const invalid = !input.disabled && !input.validity.valid;
      input.setAttribute('aria-invalid', String(invalid));
      validation.hidden = !invalid;
      validation.textContent = invalid ? input.validationMessage : '';
      if (invalid) valid = false;
    }
    return valid;
  }
  async function saveSettings(): Promise<void>
  {
    clearTimeout(saveTimer);
    if (saving || !baseline) return;
    updateSave();
    if (!validate() || !dirty) return;
    const settings = parseStorageSettings(draft());
    const focused = document.activeElement;
    saving = true;
    updateControls();
    storageFeedback.replaceChildren();
    try {
      let confirmedRemovalCount = 0;
      // confirm the current deletion count before applying smaller limits
      for (;;) {
        const data = await request({ kind: 'storage-settings', settings, confirmedRemovalCount });
        if (data.kind !== 'storage-settings') throw new Error('Unexpected settings response.');
        if (data.result.kind === 'saved') break;
        if (!await confirmCleanup(data.result.removeCount)) {
          restoreDraft(baseline);
          return;
        }
        confirmedRemovalCount = data.result.removeCount;
      }
      baseline = settings;
      dirty = false;
      onSaved();
    } catch (error) {
      const retry = button('Retry', icons.RotateCcw, 'button small');
      retry.addEventListener('click', () => { if (!saving) void saveSettings(); });
      storageFeedback.replaceChildren(notice(errorMessage(error)), retry);
    } finally {
      saving = false;
      updateControls();
      if (!element.hidden && document.activeElement === document.body && focused instanceof HTMLInputElement && !focused.disabled) focused.focus();
    }
  }
  // settle numeric edits while toggles, Enter and leaving a field commit immediately
  form.append(capacity.row, count.row, age.row, storageFeedback);
  form.noValidate = true;
  form.addEventListener('input', event => {
    if (saving) return;
    clearTimeout(saveTimer);
    storageFeedback.replaceChildren();
    updateSave();
    if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') return;
    if (validate() && dirty) saveTimer = setTimeout(() => { void saveSettings(); }, 250);
  });
  form.addEventListener('change', event => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') void saveSettings();
  });
  // let pointer activation finish before saving disables the toggle and its label
  form.addEventListener('pointerdown', event => {
    if (!(event.target instanceof Element) || !event.target.closest('.limit-toggle')) return;
    pressingToggle = true;
    clearTimeout(saveTimer);
  });
  function releaseToggle(): void
  {
    if (!pressingToggle) return;
    pressingToggle = false;
    // a canceled click still saves the numeric edit after the pointer is released
    saveTimer = setTimeout(() => { void saveSettings(); }, 0);
  }
  document.addEventListener('pointerup', releaseToggle);
  document.addEventListener('pointercancel', releaseToggle);
  form.addEventListener('focusout', event => {
    if (pressingToggle) return;
    if (event.relatedTarget instanceof HTMLInputElement && event.relatedTarget.type === 'checkbox' && form.contains(event.relatedTarget)) return;
    if (event.target instanceof HTMLInputElement && event.target.type === 'number') void saveSettings();
  });
  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      void saveSettings();
    }
  });
  form.addEventListener('submit', event => { event.preventDefault(); void saveSettings(); });
  updateSave();
  storageBody.append(usageRow, meter, form);

  const { element: automatic, body: automaticBody } = settingsPanel('Automatic backups', icons.Clock3);
  const backupStatus = createStatusView();
  const automaticControls = automaticSettings(overview => view.update(overview), onSaved);
  automaticBody.append(automaticControls.element, backupStatus.element);
  const { element: restore, body: restoreBody } = settingsPanel('Restoring sessions', icons.RotateCcw);
  const restoreControls = restoreSettings(overview => view.update(overview), onSaved);
  restoreBody.append(restoreControls.element);
  const feedback = el('div');
  feedback.setAttribute('aria-live', 'polite');
  element.append(heading, feedback, automatic, storage, restore, appearance);
  const view = {
    element,
    update(overview: Overview): void
    {
      feedback.replaceChildren();
      const settings = overview.metadata.settings;
      const mb = overview.automaticStorage.bytes / MB;
      const used = mb > 0 && mb < 0.01 ? '<0.01' : mb.toLocaleString(undefined, { maximumFractionDigits: 2 });
      const percent = mb / settings.maxStorageMB * 100;
      const percentText = percent > 0 && percent < 0.1 ? '<0.1' : percent.toLocaleString(undefined, { maximumFractionDigits: 1 });
      usage.textContent = `${plural(overview.automaticStorage.count, 'automatic backup')} · ${used} MB of ${settings.maxStorageMB.toLocaleString()} MB used`;
      percentage.textContent = `${percentText}%`;
      meter.max = settings.maxStorageMB * MB;
      meter.value = overview.automaticStorage.bytes;
      meter.setAttribute('aria-valuetext', `${used} MB used, ${percentText}% of storage limit`);
      if (!dirty && !saving) restoreDraft(settings);
      if (!saving) {
        baseline = settings;
        updateControls();
      }
      automaticControls.update(overview);
      restoreControls.update(overview);
      backupStatus.update(overview);
    },
    showError(message: string): void { feedback.replaceChildren(notice(message)); },
  };
  return view;
}
