import { errorMessage, type Overview } from '../model';
import { BYTE_BUDGET } from '../session';
import { readAppearance, setAppearance } from './appearance';
import { el, icon, icons, notice, plural, statusView } from './shared';

function settingsPanel(title: string, glyph: Parameters<typeof icon>[0])
{
  const element = el('section', 'settings-card');
  const header = el('h2', 'list-header', title);
  header.prepend(icon(glyph));
  const body = el('div', 'settings-body');
  element.append(header, body);
  return { element, body };
}

export function createSettingsView()
{
  const element = el('main', 'history-main');
  const heading = el('div', 'page-heading');
  const titles = el('div');
  titles.append(el('h1', '', 'Settings'), el('p', 'muted', 'Choose your appearance and review local backup storage.'));
  heading.append(titles);
  const { element: appearance, body: appearanceBody } = settingsPanel('Appearance', icons.Palette);
  const themeRow = el('div', 'settings-row');
  const label = el('label', '', 'Color theme');
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
  themeRow.append(label, selectControl);
  appearanceBody.append(themeRow, el('p', 'muted', 'System follows your device’s appearance. Your choice also applies to the popup.'), appearanceFeedback);

  const { element: storage, body: storageBody } = settingsPanel('Storage', icons.HardDrive);
  const usage = el('p', 'settings-storage muted', 'Checking storage…');
  const meter = el('progress', 'storage-meter');
  meter.max = BYTE_BUDGET;
  meter.setAttribute('aria-label', 'Backup storage used');
  storageBody.append(usage, meter,
    el('p', 'muted', 'Backups stay on this device. TabBlackBox keeps the last 24 hours and at least 200 recent backups, within the storage limit.'),
    el('p', 'muted', 'If the storage limit is reached, new backups pause and an error is shown. Existing backups are preserved.'));

  const { element: automatic, body: automaticBody } = settingsPanel('Automatic backups', icons.Clock3);
  const backupStatus = el('div');
  backupStatus.append(el('p', 'muted', 'Checking automatic backups…'));
  automaticBody.append(el('p', 'muted', 'Enabled automatically. Changes are saved after your tabs settle, with a periodic check every minute. Identical sessions are saved only once.'), backupStatus);
  const feedback = el('div');
  feedback.setAttribute('aria-live', 'polite');
  element.append(heading, appearance, feedback, storage, automatic);
  return {
    element,
    update(overview: Overview): void
    {
      feedback.replaceChildren();
      const mib = overview.metadata.bytes / 1024 / 1024;
      const used = mib > 0 && mib < 0.01 ? '<0.01' : mib.toLocaleString(undefined, { maximumFractionDigits: 2 });
      usage.textContent = `${plural(overview.metadata.count, 'saved backup')} · ${used} MiB of ${BYTE_BUDGET / 1024 / 1024} MiB backup data used`;
      meter.value = overview.metadata.bytes;
      backupStatus.replaceChildren(statusView(overview));
    },
    showError(message: string): void { feedback.replaceChildren(notice(message)); },
  };
}
