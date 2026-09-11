import { errorMessage, type Operation, type Overview, type Snapshot, type Summary } from '../../src/model';
import { restorableUrl } from '../../src/session';
import { canRestore } from '../../src/ui/restore-state';
import { setup, brand, button, icons, icon, el, request, statusView, notice, formatTime, plural } from '../../src/ui/shared';
import { createRefreshQueue } from '../../src/ui/refresh-queue';
import { createSettingsView } from '../../src/ui/settings';

const root = setup();
const header = el('header', 'app-header');
const headerInner = el('div', 'header-inner');
headerInner.append(brand(), el('span', 'local-label', 'Local session backups'));
header.append(headerInner);
const nav = el('nav', 'navigation');
nav.setAttribute('aria-label', 'Main navigation');
const active = el('a', 'nav-item active', 'Backup history');
active.href = '#history';
active.setAttribute('aria-current', 'page');
active.prepend(icon(icons.History));
const settingsLink = el('a', 'nav-item', 'Settings');
settingsLink.href = '#settings';
settingsLink.prepend(icon(icons.Settings));
nav.append(active, settingsLink);
const main = el('main', 'history-main');
const heading = el('div', 'page-heading');
const titles = el('div');
titles.append(el('h1', '', 'Backup history'), el('p', 'muted', 'Pick up where you left off. Restore a saved session in new windows.'));
const save = el('button', 'button primary');
save.type = 'button';
const saveLabel = document.createTextNode('Back up now');
save.append(icon(icons.Save), saveLabel);
heading.append(titles, save);
const status = el('div');
const feedback = el('div');
feedback.setAttribute('aria-live', 'polite');
const operationRegion = el('div');
operationRegion.setAttribute('aria-live', 'polite');
const list = el('div', 'backup-list');
const listHeader = el('div', 'list-header');
const listLabel = el('strong', '', 'Saved sessions');
const count = el('span', 'badge', '0');
listHeader.append(icon(icons.Archive), listLabel, count);
const rows = el('div');
const more = button('Load older backups', icons.ChevronDown, 'button load-more');
more.hidden = true;
list.append(listHeader, rows);
const footer = el('footer', 'history-footer');
footer.append(icon(icons.HardDrive), el('span', '', 'Saved on this device · Last 24 hours and at least 200 recent backups, within storage capacity.'));
main.append(heading, status, feedback, operationRegion, list, more, footer);
const settings = createSettingsView();
root.append(header, nav, main, settings.element);

function showView(): void {
  const isSettings = location.hash === '#settings';
  main.hidden = isSettings;
  settings.element.hidden = !isSettings;
  for (const [link, selected] of [[active, !isSettings], [settingsLink, isSettings]] as const) {
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${isSettings ? 'Settings' : 'Backup history'} · TabBlackBox`;
}
window.addEventListener('hashchange', showView);
showView();

let items: Summary[] = [];
let historyGeneration = 0;
let latestId: string | null = null;
let restoring = false;
let backingUp = false;
let operationKey = '';
const restoreButtons = new Map<HTMLButtonElement, number>();

function renderOperation(operation: Operation | null): void {
  const key = JSON.stringify(operation);
  if (operationKey === key) return;
  operationKey = key;
  operationRegion.replaceChildren();
  if (!operation) return;
  const section = el('section', `notice ${operation.kind === 'interrupted' || operation.errors.length ? 'warning-notice' : ''}`);
  section.setAttribute('aria-label', 'Restoration result');
  section.append(el('strong', '', operation.kind === 'running' ? 'Restoration in progress' : operation.kind === 'interrupted' ? 'Restoration was interrupted' : 'Restoration finished'));
  section.append(el('p', '', `${operation.opened} opened · ${operation.skipped} skipped · ${operation.failed} failed · ${operation.groupErrors} group errors`));
  if (operation.kind === 'interrupted') section.append(el('p', '', 'Progress may be incomplete. Tabs already opened remain available. Starting again can create duplicates.'));
  if (operation.errors.length) {
    const details = el('details');
    details.append(el('summary', '', 'View issues'));
    const errors = el('ul');
    for (const text of operation.errors) errors.append(el('li', '', text));
    details.append(errors);
    section.append(details);
  }
  operationRegion.append(section);
}

async function confirmRestore(snapshot: Snapshot, trigger: HTMLButtonElement): Promise<void> {
  if (restoring || backingUp) return;
  const tabs = snapshot.windows.flatMap(window => window.tabs);
  const supported = tabs.filter(tab => restorableUrl(tab.url)).length;
  const windows = snapshot.windows.filter(window => window.tabs.some(tab => restorableUrl(tab.url))).length;
  const dialog = el('dialog', 'restore-dialog');
  dialog.setAttribute('aria-labelledby', 'restore-title');
  const title = el('h2', '', 'Restore this session?');
  title.id = 'restore-title';
  dialog.append(title, el('p', '', `${plural(supported, 'tab')} will open in ${plural(windows, 'new window')}. Your current windows will stay open.`));
  if (tabs.length > supported) dialog.append(el('p', 'muted', `${plural(tabs.length - supported, 'unsupported tab')} will be skipped. Their saved URLs remain in the preview.`));
  dialog.append(el('p', 'muted', 'Restoring a session again creates another copy of its tabs.'));
  const actions = el('div', 'dialog-actions');
  const cancel = button('Cancel', icons.Check);
  const confirm = button('Restore session', icons.RotateCcw, 'button primary');
  actions.append(cancel, confirm);
  dialog.append(actions);
  root.append(dialog);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { dialog.remove(); trigger.focus(); });
  confirm.addEventListener('click', () => {
    confirm.disabled = true;
    void (async () => {
      try {
        await request({ kind: 'restore', id: snapshot.id });
        restoring = true;
        updateRestoreButtons();
        updateSave();
        dialog.close();
        await refresh('overview');
      } catch (error) { dialog.append(notice(errorMessage(error))); confirm.disabled = false; }
    })();
  });
  dialog.showModal();
  cancel.focus();
}

function preview(snapshot: Snapshot): HTMLElement {
  const content = el('div', 'snapshot-preview');
  for (const [index, window] of snapshot.windows.entries()) {
    const section = el('section', 'window-preview');
    const heading = el('h3', 'window-heading');
    heading.append(icon(icons.Monitor), document.createTextNode(`Window ${index + 1}`), el('span', 'muted', plural(window.tabs.length, 'tab')));
    section.append(heading);
    const tabs = el('ul', 'tab-list');
    for (const tab of window.tabs) {
      const item = el('li', 'tab-row');
      item.append(icon(tab.pinned ? icons.Pin : icons.ArrowUpRight));
      const label = el('div', 'tab-label');
      label.append(el('span', 'tab-title', tab.title || tab.url || 'Unavailable tab'), el('span', 'tab-url', tab.url ?? 'URL unavailable'));
      item.append(label);
      if (tab.pinned) item.append(el('span', 'badge', 'Pinned'));
      if (tab.group !== null) {
        const group = window.groups[tab.group];
        if (group) item.append(el('span', `group-label group-${group.color}`, group.name || 'Unnamed group'));
      }
      if (!restorableUrl(tab.url)) item.append(el('span', 'badge unsupported', 'Will be skipped'));
      tabs.append(item);
    }
    section.append(tabs);
    content.append(section);
  }
  return content;
}

function row(item: Summary): HTMLElement {
  const wrapper = el('article', 'backup-row');
  const details = el('details');
  const summary = el('summary', 'backup-summary');
  const label = el('div', 'backup-label');
  label.append(el('strong', '', formatTime(item.capturedAt)), el('span', 'muted', `${plural(item.windowCount, 'window')} · ${plural(item.tabCount, 'tab')}`));
  summary.append(icon(icons.ChevronDown), label, el('span', 'badge', item.source === 'manual' ? 'Manual' : 'Automatic'));
  details.append(summary);
  const restore = button('Restore', icons.RotateCcw, 'button small');
  restore.disabled = !canRestore({ supportedCount: item.supportedCount, backingUp, restoring });
  if (!item.supportedCount) restore.title = 'This backup has no supported tabs to restore.';
  restoreButtons.set(restore, item.supportedCount);
  wrapper.append(details, restore);
  let snapshot: Snapshot | undefined;
  async function load(): Promise<Snapshot> {
    if (snapshot) return snapshot;
    const data = await request({ kind: 'snapshot', id: item.id });
    if (data.kind !== 'snapshot') throw new Error('Unexpected backup response.');
    snapshot = data.snapshot;
    return snapshot;
  }
  let rendered = false;
  details.addEventListener('toggle', () => {
    if (details.open && !rendered) {
      rendered = true;
      void load().then(value => details.append(preview(value)), (error: unknown) => { rendered = false; details.append(notice(errorMessage(error))); });
    }
  });
  restore.addEventListener('click', () => {
    restore.disabled = true;
    void load().then(value => confirmRestore(value, restore)).catch((error: unknown) => feedback.replaceChildren(notice(errorMessage(error)))).finally(() => { restore.disabled = !canRestore({ supportedCount: item.supportedCount, backingUp, restoring }); });
  });
  return wrapper;
}

async function loadHistory(reset: boolean): Promise<void> {
  const generation = reset ? ++historyGeneration : historyGeneration;
  const last = reset ? undefined : items.at(-1);
  more.disabled = true;
  try {
    const data = await request({ kind: 'history', before: last ? { capturedAt: last.capturedAt, id: last.id } : null });
    if (generation !== historyGeneration) return;
    if (data.kind !== 'history') throw new Error('Unexpected history response.');
    if (reset) { items = []; restoreButtons.clear(); rows.replaceChildren(); }
    items.push(...data.items);
    for (const item of data.items) rows.append(row(item));
    if (!items.length) {
      const empty = el('div', 'empty-state');
      empty.append(icon(icons.Archive, 32), el('h2', '', 'Your backup history starts here'), el('p', 'muted', 'Open some tabs and choose Back up now. Future changes will be saved automatically.'));
      rows.append(empty);
    }
    more.hidden = data.items.length < 50;
  } catch (error) {
    if (generation === historyGeneration) throw error;
  } finally {
    if (generation === historyGeneration) more.disabled = false;
  }
}

function updateSave(): void {
  save.disabled = backingUp || restoring;
  const label = backingUp ? 'Backing up…' : 'Back up now';
  if (saveLabel.data !== label) saveLabel.data = label;
}

function updateRestoreButtons(): void {
  for (const [button, supportedCount] of restoreButtons) button.disabled = !canRestore({ supportedCount, backingUp, restoring });
}

function applyOverview(overview: Overview): void {
  settings.update(overview);
  status.replaceChildren(statusView(overview));
  count.textContent = String(overview.metadata.count);
  restoring = overview.status.kind === 'restoring';
  updateSave();
  updateRestoreButtons();
  renderOperation(overview.metadata.operation);
}

const refresh = createRefreshQueue(async kind => {
  if (kind === 'backup') feedback.replaceChildren();
  try {
    const data = await request({ kind });
    if (data.kind !== 'overview') throw new Error('Unexpected background response.');
    applyOverview(data.overview);
    if (latestId !== data.overview.metadata.latestId || !rows.childElementCount) {
      await loadHistory(true);
      latestId = data.overview.metadata.latestId;
      feedback.replaceChildren();
    }
    if (kind === 'backup') feedback.replaceChildren(el('p', 'muted', data.overview.status.kind === 'current' ? 'Current session is saved. Identical backups are kept only once.' : data.overview.status.kind === 'pending' ? 'Tabs changed during capture. Automatic backup will retry.' : ''));
  } catch (error) {
    feedback.replaceChildren(notice(errorMessage(error)));
    settings.showError(errorMessage(error));
  }
}, value => { backingUp = value; updateSave(); updateRestoreButtons(); });
save.addEventListener('click', () => { void refresh('backup'); });
more.addEventListener('click', () => {
  void loadHistory(false).catch((error: unknown) => feedback.replaceChildren(notice(errorMessage(error))));
});
void refresh('refresh');
setInterval(() => { if (!document.hidden) void refresh('overview'); }, 1500);
