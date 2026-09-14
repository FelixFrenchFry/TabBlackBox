import { automaticSettings } from './automatic-settings';
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
  const explanation = el('p', 'muted', description);
  explanation.id = `${id}-description`;
  text.append(label, explanation);
  const control = el('div', 'settings-number-control');
  const input = el('input', 'settings-number');
  input.type = 'number';
  input.id = id;
  input.min = '1';
  input.max = String(max);
  input.step = '1';
  input.required = true;
  input.disabled = true;
  input.setAttribute('aria-describedby', explanation.id);
  control.append(input, el('span', 'muted', unit));
  row.append(text, control);
  return { row, input, control };
}

function confirmCleanup(count: number): Promise<boolean>
{
  return new Promise(resolve => {
    const dialog = el('dialog', 'restore-dialog');
    const title = el('h2', '', 'Delete older backups?');
    title.id = 'storage-confirm-title';
    dialog.setAttribute('aria-labelledby', title.id);
    dialog.append(title, el('p', '', `Applying these limits will delete ${plural(count, 'older backup')}. This cannot be undone. Your newest backup will be kept.`));
    const actions = el('div', 'dialog-actions');
    const cancel = button('Cancel', icons.Check);
    const confirm = button('Apply limits', icons.HardDrive, 'button primary');
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

export function createSettingsView(backUpNow: () => void)
{
  const element = el('main', 'history-main');
  const heading = el('div', 'page-heading');
  const titles = el('div');
  titles.append(el('h1', '', 'Settings'), el('p', 'muted', 'Choose your appearance and review local backup storage.'));
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
    try { setAppearance(value); appearanceFeedback.replaceChildren(); }
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
  const dateExplanation = el('p', 'muted', 'Choose between exact timestamps like "12. Sept., 2026, 20:55:07", or relative timestamps like “17 minutes ago”, or a combination of them.');
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
    try { setDateFormat(value); appearanceFeedback.replaceChildren(); }
    catch (error) { syncDates(); appearanceFeedback.replaceChildren(notice(errorMessage(error))); }
  });
  const dateControl = el('div', 'settings-select-control');
  dateControl.append(dateSelect, icon(icons.ChevronDown));
  dateRow.append(dateText, dateControl);
  appearanceBody.append(themeRow, dateRow, appearanceFeedback);

  const { element: storage, body: storageBody } = settingsPanel('Storage', icons.HardDrive);
  const usage = el('p', 'settings-storage muted', 'Checking storage…');
  const usageRow = el('div', 'storage-usage');
  const percentage = el('span', 'storage-percentage muted', '—');
  usageRow.append(usage, percentage);
  const meter = el('progress', 'storage-meter');
  meter.max = DEFAULT_STORAGE_SETTINGS.maxStorageMB * MB;
  meter.setAttribute('aria-label', 'Backup storage used');
  const age = storageSetting('Time limit', 'Time limit before a saved backup expires. Expired backups are deleted. This can be turned on/off.', 'retention-days', 'days', 3650);
  const count = storageSetting('Backup limit', 'Maximum number of saved backups. The oldest backup is deleted whenever this limit is exceeded. This can be turned on/off.', 'maximum-backups', 'backups', 100_000);
  const capacity = storageSetting('Storage limit', 'Maximum space available for backup data. The oldest backups are deleted whenever space is needed. This is always enforced.', 'maximum-storage', 'MB', 100_000);
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
  const save = el('button', 'button primary storage-save');
  const saveLabel = document.createTextNode('Save storage settings');
  const saveIcons = { idle: icon(icons.Save), saving: icon(icons.LoaderCircle), saved: icon(icons.Check) };
  saveIcons.saving.classList.add('save-spinner');
  let displayedState: keyof typeof saveIcons = 'idle';
  save.append(saveIcons.idle, saveLabel);
  save.setAttribute('aria-live', 'polite');
  save.type = 'submit';
  save.disabled = true;
  const storageFeedback = el('div');
  storageFeedback.setAttribute('aria-live', 'polite');

  function updateControls(): void
  {
    updateSave();
    capacity.input.disabled = saving;
    for (const { setting, toggle, sync } of optionalLimits) {
      sync();
      toggle.disabled = saving;
      setting.input.disabled = saving || !toggle.checked;
    }
  }
  let dirty = false;
  let saving = false;
  let saved = false;
  let baseline: StorageSettings | undefined;
  const draft = () => ({
    retentionDays: ageLimit.toggle.checked ? age.input.valueAsNumber : null,
    maxBackups: countLimit.toggle.checked ? count.input.valueAsNumber : null,
    maxStorageMB: capacity.input.valueAsNumber,
  });
  function updateSave(): void
  {
    const current = draft();
    dirty = baseline !== undefined && (current.retentionDays !== baseline.retentionDays || current.maxBackups !== baseline.maxBackups || current.maxStorageMB !== baseline.maxStorageMB);
    const state = saving ? 'saving' : saved ? 'saved' : 'idle';
    save.disabled = !baseline || !dirty || saving || saved;
    save.setAttribute('aria-busy', String(saving));
    save.classList.toggle('is-saving', state === 'saving');
    save.classList.toggle('is-saved', state === 'saved');
    if (state !== displayedState) {
      saveIcons[displayedState].replaceWith(saveIcons[state]);
      displayedState = state;
    }
    saveLabel.data = saving ? 'Saving…' : saved ? 'Saved' : 'Save storage settings';
  }
  const actions = el('div', 'storage-settings-actions');
  actions.append(save);
  form.append(capacity.row, count.row, age.row, actions, storageFeedback);
  form.addEventListener('input', updateSave);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (save.disabled || !form.reportValidity()) return;
    void (async () => {
      saving = true;
      save.disabled = true;
      updateControls();
      storageFeedback.replaceChildren();
      try {
        const settings = parseStorageSettings(draft());
        let confirmedRemovalCount = 0;
        // confirm the current deletion count before applying smaller limits
        for (;;) {
          const data = await request({ kind: 'storage-settings', settings, confirmedRemovalCount });
          if (data.kind !== 'storage-settings') throw new Error('Unexpected settings response.');
          if (data.result.kind === 'saved') break;
          if (!await confirmCleanup(data.result.removeCount)) return;
          confirmedRemovalCount = data.result.removeCount;
        }
        dirty = false;
        baseline = settings;
        saved = true;
        const data = await request({ kind: 'overview' });
        if (data.kind === 'overview') view.update(data.overview);
      } catch (error) { storageFeedback.replaceChildren(notice(errorMessage(error))); }
      finally {
        saving = false;
        updateControls();
        if (saved) setTimeout(() => { saved = false; updateSave(); }, 2000);
      }
    })();
  });
  storageBody.append(usageRow, meter, form);

  const { element: automatic, body: automaticBody } = settingsPanel('Automatic backups', icons.Clock3);
  const backupStatus = createStatusView();
  const statusContent = el('div', 'automatic-status-content');
  statusContent.append(...backupStatus.element.childNodes);
  const backUp = el('button', 'button primary');
  backUp.type = 'button';
  const backUpLabel = document.createTextNode('Back up now');
  backUp.append(icon(icons.Save), backUpLabel);
  backUp.disabled = true;
  backUp.addEventListener('click', () => { if (!backUp.disabled) backUpNow(); });
  backupStatus.element.classList.add('automatic-status');
  const statusWrapper = el('div', 'automatic-status-wrapper');
  statusWrapper.append(statusContent, backUp);
  backupStatus.element.append(statusWrapper);
  const automaticControls = automaticSettings(overview => view.update(overview));
  automaticBody.append(automaticControls.element, backupStatus.element);
  const feedback = el('div');
  feedback.setAttribute('aria-live', 'polite');
  element.append(heading, feedback, automatic, storage, appearance);
  const view = {
    element,
    update(overview: Overview): void
    {
      feedback.replaceChildren();
      const settings = overview.metadata.settings;
      const mb = overview.metadata.bytes / MB;
      const used = mb > 0 && mb < 0.01 ? '<0.01' : mb.toLocaleString(undefined, { maximumFractionDigits: 2 });
      const percent = mb / settings.maxStorageMB * 100;
      const percentText = percent > 0 && percent < 0.1 ? '<0.1' : percent.toLocaleString(undefined, { maximumFractionDigits: 1 });
      usage.textContent = `${plural(overview.metadata.count, 'saved backup')} · ${used} MB of ${settings.maxStorageMB.toLocaleString()} MB used`;
      percentage.textContent = `${percentText}%`;
      meter.max = settings.maxStorageMB * MB;
      meter.value = overview.metadata.bytes;
      meter.setAttribute('aria-valuetext', `${used} MB used, ${percentText}% of storage limit`);
      if (!dirty && !saving) {
        age.input.value = String(settings.retentionDays ?? 30);
        ageLimit.toggle.checked = settings.retentionDays !== null;
        count.input.value = String(settings.maxBackups ?? 2000);
        countLimit.toggle.checked = settings.maxBackups !== null;
        capacity.input.value = String(settings.maxStorageMB);
      }
      if (!saving) {
        baseline = settings;
        updateControls();
      }
      automaticControls.update(overview);
      backupStatus.update(overview);
    },
    setBackupState(backingUp: boolean, restoring: boolean): void {
      backUp.disabled = backingUp || restoring;
      const label = backingUp ? 'Backing up…' : 'Back up now';
      if (backUpLabel.data !== label) backUpLabel.data = label;
    },
    showError(message: string): void { feedback.replaceChildren(notice(message)); },
  };
  return view;
}
