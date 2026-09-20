import { timestamp } from '../../src/ui/dates';
import { errorMessage, type Collection, type Operation, type Overview, type Snapshot, type Summary } from '../../src/model';
import { parseArchive } from '../../src/archive';
import { MB } from '../../src/storage';
import { FILE_ACCESS_MESSAGE, fileUrl, restorableUrl, selectWindows } from '../../src/session';
import { canRestore, createSessionDialogLock } from '../../src/ui/restore-state';
import { setup, brand, button, icons, icon, el, request, createStatusView, notice, plural } from '../../src/ui/shared';
import { createRefreshQueue } from '../../src/ui/refresh-queue';
import { createBackupButton } from '../../src/ui/backup-button';
import { createToast } from '../../src/ui/toast';
import { createHelp } from '../../src/ui/help';
import { createSettingsView } from '../../src/ui/settings';
import { HISTORY_INITIAL_LIMIT, HISTORY_PAGE_LIMIT, SESSION_NAME_LIMIT } from '../../src/protocol';

const root = setup();
const header = el('header', 'app-header');
const headerInner = el('div', 'header-inner');
headerInner.append(brand(), el('span', 'local-label', 'Local browser session backups'));
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
titles.append(el('h1', '', 'Backup history'), el('p', 'muted', 'Browse manual and automatic browser session backups. Expand a backup to view its tabs, windows, and tab groups, open individual URLs, or restore the session.'));
const backup = createBackupButton(() => { void refresh('backup'); });
heading.append(titles);
const statusCard = createStatusView();
const status = statusCard.element;
const feedback = el('div');
feedback.setAttribute('aria-live', 'polite');
const toast = createToast();

function historyPanel(collection: Collection)
{
  const element = el('section', `history-panel ${collection}-backups`);
  const title = collection === 'saved' ? 'Manual backups' : 'Automatic backups';
  element.setAttribute('aria-label', title);
  const list = el('div', 'backup-list');
  const header = el('div', 'list-header');
  const count = el('span', 'badge', '0');
  const usage = el('span', 'muted panel-usage');
  const help = createHelp(`${collection}-help`, `About ${title.toLowerCase()}`, collection === 'saved' ? 'Sessions you choose to keep until you delete them. Select "Back up now" to save your current session, or select "Keep session" to move an automatic backup into this category. Manual backups are excluded from storage limits and automatic deletions. You can export sessions to keep a copy outside your browser, or import previously exported sessions.' : 'History of your tabs, windows, and tab groups. These sessions are saved periodically according to your automatic backup settings. Older backups are deleted automatically according to your storage limit settings.');
  header.append(icon(collection === 'saved' ? icons.Archive : icons.History), el('h2', '', title), help, count, usage);
  const rows = el('div');
  const more = button(collection === 'saved' ? 'Load more saved sessions' : 'Load older backups', icons.ChevronDown, 'button load-more');
  more.hidden = true;
  list.append(header, rows);
  element.append(list, more);
  const items: Summary[] = [];
  return { element, list, header, count, usage, rows, more, collection, query: '', items, generation: 0, sessionRows: new Map<string, ReturnType<typeof row>>() };
}

const savedPanel = historyPanel('saved');
const automaticPanel = historyPanel('automatic');
const panels = [savedPanel, automaticPanel];
const exportAll = button('Export all', icons.Download);
const importSessions = button('Import', icons.Upload);
const archiveActions = el('div', 'archive-toolbar');
const search = el('input', 'session-name-input archive-search');
search.type = 'search';
search.placeholder = 'Search session names';
search.setAttribute('aria-label', 'Search session names');
search.maxLength = SESSION_NAME_LIMIT;
archiveActions.append(search, backup.element, exportAll, importSessions);
savedPanel.list.insertBefore(archiveActions, savedPanel.rows);
const footer = el('footer', 'history-footer');
footer.append(icon(icons.HardDrive), el('span', '', 'Backups are stored on this device. Automatic backups are removed as needed. Manual backups stay until deleted explicitly. Export them to keep an external copy.'));
main.append(heading, status, feedback, ...panels.map(panel => panel.element), footer);
const settings = createSettingsView(() => toast.show('Settings have been saved'));
root.append(header, nav, main, settings.element, toast.element);

function showView(): void
{
  const isSettings = location.hash === '#settings';
  main.hidden = isSettings;
  settings.element.hidden = !isSettings;
  for (const [link, selected] of [[active, !isSettings], [settingsLink, isSettings]] as const) {
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `TabBlackBox · ${isSettings ? 'Settings' : 'Backup history'}`;
}
window.addEventListener('hashchange', showView);
showView();

let latestId: string | null = null;
let historyCount: number | null = null;
let historyRevision: number | null = null;
let restoring = false;
let backingUp = false;
let lastOperation: Operation | null | undefined;
let fileAccess = false;
const restoreButtons = new Map<HTMLButtonElement, number>();
const sessionDialogLock = createSessionDialogLock();

async function updateFileAccess(): Promise<void>
{
  fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  // refresh expanded previews when Chrome's file access setting changes
  for (const control of main.querySelectorAll<HTMLButtonElement>('.file-open')) control.disabled = !fileAccess;
  for (const message of main.querySelectorAll<HTMLElement>('.file-access-required')) message.hidden = fileAccess;
}

function fileAccessNotice(): HTMLElement
{
  const message = el('div', 'notice warning-notice file-access-required');
  message.append(el('p', '', FILE_ACCESS_MESSAGE));
  const settings = button('Open extension settings', icons.Settings);
  settings.addEventListener('click', () => {
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }).catch((error: unknown) => message.append(notice(errorMessage(error))));
  });
  message.append(settings);
  return message;
}

function renderOperation(operation: Operation | null): void
{
  const previous = lastOperation;
  lastOperation = operation;
  // ignore stored results on page load and notify once even if a fast restore finishes between polls
  if (previous === undefined || !operation || operation.kind === 'running') return;
  if (previous && previous.snapshotId === operation.snapshotId && previous.startedAt === operation.startedAt && previous.kind !== 'running') return;
  const issues = operation.failed > 0 || operation.groupErrors > 0 || operation.errors.length > 0;
  const title = operation.kind === 'interrupted' ? 'Restoration interrupted' : issues ? 'Restoration finished with issues' : 'Restoration finished';
  const parts = [title, `${plural(operation.opened, 'tab')} opened`];
  if (operation.skipped) parts.push(`${operation.skipped} skipped`);
  if (operation.failed) parts.push(`${operation.failed} failed`);
  if (operation.groupErrors) parts.push(plural(operation.groupErrors, 'group error'));
  toast.show(parts.join(' · '), operation.kind === 'interrupted' || issues ? icons.CircleAlert : icons.Check);
}

async function confirmRestore(load: () => Snapshot | Promise<Snapshot>, trigger: HTMLButtonElement, windowIndex?: number): Promise<void>
{
  // reserve the dialog before loading snapshots or checking browser permissions
  if (restoring || backingUp || !sessionDialogLock.acquire()) return;
  let shown = false;
  let createdDialog: HTMLDialogElement | undefined;
  try {
    updateDialogButtons();
    const snapshot = await load();
    await updateFileAccess();
    if (restoring || backingUp) return;
    const selected = selectWindows(snapshot, windowIndex);
    const tabs = selected.flatMap(window => window.tabs);
    const supported = tabs.filter(tab => restorableUrl(tab.url, fileAccess)).length;
    const windows = selected.filter(window => window.tabs.some(tab => restorableUrl(tab.url, fileAccess))).length;
    const blockedFiles = !fileAccess ? tabs.filter(tab => fileUrl(tab.url)).length : 0;
    const dialog = el('dialog', 'restore-dialog');
    createdDialog = dialog;
    dialog.setAttribute('aria-labelledby', 'restore-title');
    const title = el('h2', '', windowIndex === undefined ? 'Restore this session?' : `Restore window ${windowIndex + 1}?`);
    title.id = 'restore-title';
    dialog.append(title, el('p', '', `${plural(supported, 'tab')} will open in ${plural(windows, 'new window')}. Your current windows will stay open.`));
    if (blockedFiles) {
      dialog.append(el('p', 'muted', `${plural(blockedFiles, 'local file')} will be skipped until file access is enabled.`), fileAccessNotice());
      dialog.append(el('p', 'muted', 'After enabling access, close this dialog and choose Restore again.'));
    }
    if (tabs.length > supported + blockedFiles) dialog.append(el('p', 'muted', `${plural(tabs.length - supported - blockedFiles, 'unsupported tab')} will be skipped. Their saved URLs remain in the preview.`));
    dialog.append(el('p', 'muted', windowIndex === undefined ? 'Restoring a session again creates another copy of its tabs.' : 'Restoring a window again creates another copy of its tabs.'));
    const actions = el('div', 'dialog-actions');
    const cancel = button('Cancel', icons.Check);
    const confirm = button(windowIndex === undefined ? 'Restore session' : `Restore window ${windowIndex + 1}`, icons.RotateCcw, 'button primary');
    confirm.disabled = supported === 0;
    actions.append(cancel, confirm);
    dialog.append(actions);
    root.append(dialog);
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      sessionDialogLock.release();
      dialog.remove();
      updateDialogButtons();
      trigger.focus();
    }, { once: true });
    confirm.addEventListener('click', () =>
    {
      confirm.disabled = true;
      void (async () =>
      {
        try {
          await request(windowIndex === undefined ? { kind: 'restore', id: snapshot.id } : { kind: 'restore-window', id: snapshot.id, windowIndex });
          restoring = true;
          updateDialogButtons();
          updateSave();
          dialog.close();
          await refresh('overview');
        } catch (error) { dialog.append(notice(errorMessage(error))); confirm.disabled = false; }
      })();
    });
    dialog.showModal();
    shown = true;
    cancel.focus();
  } finally {
    if (!shown) {
      sessionDialogLock.release();
      createdDialog?.remove();
      updateDialogButtons();
    }
  }
}

function favicon(url: string | null): HTMLElement
{
  const frame = el('span', 'tab-favicon');
  frame.setAttribute('aria-hidden', 'true');
  const fallback = icon(fileUrl(url) ? icons.FileText : icons.Globe);
  if (restorableUrl(url) && url !== 'about:blank') {
    // retrieve website icons through Chrome using the saved page URL
    const source = new URL(chrome.runtime.getURL('/_favicon/'));
    source.searchParams.set('pageUrl', url);
    source.searchParams.set('size', '32');
    const image = el('img');
    image.alt = '';
    image.width = 16;
    image.height = 16;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => frame.replaceChildren(fallback), { once: true });
    image.src = source.href;
    frame.append(image);
  } else frame.append(fallback);
  return frame;
}

function preview(snapshot: Snapshot): HTMLElement
{
  const content = el('div', 'snapshot-preview');
  if (snapshot.windows.some(window => window.tabs.some(tab => fileUrl(tab.url)))) {
    const message = fileAccessNotice();
    message.hidden = fileAccess;
    content.append(message);
  }
  for (const [index, window] of snapshot.windows.entries()) {
    const section = el('section', 'window-preview');
    const heading = el('h3', 'window-heading');
    heading.append(icon(icons.Monitor), document.createTextNode(`Window ${index + 1}`), el('span', 'muted', plural(window.tabs.length, 'tab')));
    const restore = button(`Restore window ${index + 1}`, icons.RotateCcw, 'button small window-restore');
    restore.disabled = sessionDialogLock.active || !canRestore({ tabCount: window.tabs.length, backingUp, restoring });
    restoreButtons.set(restore, window.tabs.length);
    restore.addEventListener('click', () => {
      void confirmRestore(() => snapshot, restore, index).catch((error: unknown) => feedback.replaceChildren(notice(errorMessage(error))));
    });
    heading.append(restore);
    section.append(heading);
    const tabs = el('ul', 'tab-list');
    for (const tab of window.tabs) {
      const item = el('li', 'tab-row');
      const label = el('div', 'tab-label');
      const title = el('span', 'tab-title', tab.title || tab.url || 'Unavailable tab');
      let open: HTMLAnchorElement | HTMLButtonElement;
      // allow individual navigation for the same URL schemes supported by restoration
      if (tab.url !== null && fileUrl(tab.url)) {
        const url = tab.url;
        const file = button('', icons.ArrowUpRight, 'tab-open file-open');
        file.disabled = !fileAccess;
        file.title = 'Open local file in new tab';
        file.addEventListener('click', () => {
          void (async () => {
            await updateFileAccess();
            if (!fileAccess) throw new Error(FILE_ACCESS_MESSAGE);
            await chrome.tabs.create({ url });
          })().catch((error: unknown) => feedback.replaceChildren(notice(errorMessage(error))));
        });
        open = file;
      } else if (restorableUrl(tab.url)) {
        open = el('a', 'tab-open');
        open.href = tab.url;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.title = 'Open in new tab';
        open.append(icon(icons.ArrowUpRight));
      } else {
        open = button('', icons.ArrowUpRight, 'tab-open');
        open.disabled = true;
        open.title = tab.url ? 'This URL cannot be opened from a saved session' : 'No saved URL is available';
      }
      open.setAttribute('aria-label', open.title);
      open.append(el('span', 'tab-url', tab.url ?? 'URL unavailable'));
      label.append(favicon(tab.url), title, open);
      item.append(label);
      if (tab.pinned) item.append(el('span', 'badge', 'Pinned'));
      if (tab.group !== null) {
        const group = window.groups[tab.group];
        if (group) item.append(el('span', `group-label group-${group.color}`, group.name || 'Unnamed group'));
      }
      if (fileUrl(tab.url)) {
        const badge = el('span', 'badge unsupported file-access-required', 'File access required');
        badge.hidden = fileAccess;
        item.append(badge);
      } else if (!restorableUrl(tab.url)) item.append(el('span', 'badge unsupported', 'Will be skipped'));
      tabs.append(item);
    }
    section.append(tabs);
    content.append(section);
  }
  return content;
}

function nameSession(item: Summary, trigger: HTMLButtonElement, action: 'rename' | 'keep'): void
{
  const events = new AbortController();
  const dialog = el('dialog', 'restore-dialog');
  const title = el('h2', '', action === 'rename' ? 'Rename this session' : 'Keep this session');
  title.id = 'rename-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const form = el('form');
  const label = el('label', 'setting-name', action === 'keep' ? 'Name' : 'Session name');
  label.htmlFor = 'session-name';
  const input = el('input', 'session-name-input');
  input.id = label.htmlFor;
  input.type = 'text';
  input.maxLength = SESSION_NAME_LIMIT;
  input.value = item.name ?? '';
  input.placeholder = 'Unnamed session';
  const heading = el('div', 'dialog-heading');
  heading.append(title);
  input.setAttribute('aria-describedby', 'session-name-description');
  form.append(label, input);
  if (action === 'keep') {
    heading.append(createHelp('session-name-description', 'About keeping this session', 'Turn this automatic backup into a manual backup, so it remains saved until you delete it. Give it a name, or leave it blank to use ‘Unnamed session’.', events.signal));
  } else {
    const help = el('p', 'muted', 'Leave blank to use “Unnamed session”.');
    help.id = 'session-name-description';
    form.append(help);
  }
  const feedback = el('div');
  feedback.setAttribute('aria-live', 'polite');
  const actions = el('div', 'dialog-actions');
  const cancel = button('Cancel', icons.Check);
  const save = button(action === 'rename' ? 'Save name' : 'Keep', icons.Check, 'button primary');
  save.type = 'submit';
  actions.append(cancel, save);
  form.append(feedback, actions);
  dialog.append(action === 'keep' ? heading : title, form);
  let saving = false;
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    events.abort();
    sessionDialogLock.release();
    dialog.remove();
    updateDialogButtons();
    trigger.focus();
  }, { once: true });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    input.disabled = cancel.disabled = save.disabled = true;
    feedback.replaceChildren();
    void (async () => {
      try {
        const data = await request({ kind: action, id: item.id, name: input.value });
        if (data.kind !== 'renamed') throw new Error('Unexpected session response.');
        for (const panel of panels) {
          panel.items = panel.items.map(value => value.id === item.id ? data.summary : value);
          panel.sessionRows.get(item.id)?.update(data.summary);
        }
        dialog.close();
        if (action === 'keep') await searchHistory('').catch(showError);
        await refresh('overview');
        if (action === 'rename') toast.show('Session renamed');
      } catch (error) { feedback.replaceChildren(notice(errorMessage(error))); }
      finally { saving = false; input.disabled = cancel.disabled = save.disabled = false; }
    })();
  });
  if (!sessionDialogLock.acquire()) { events.abort(); return; }
  try {
    updateDialogButtons();
    root.append(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  } catch (error) {
    events.abort();
    dialog.remove();
    sessionDialogLock.release();
    updateDialogButtons();
    throw error;
  }
}

function showError(error: unknown): void
{
  feedback.replaceChildren(notice(errorMessage(error)));
}

async function downloadArchive(id?: string): Promise<void>
{
  const data = await request(id === undefined ? { kind: 'export' } : { kind: 'export', id });
  if (data.kind !== 'export') throw new Error('Unexpected export response.');
  // download through the page without requiring browser download permissions
  const url = URL.createObjectURL(new Blob([JSON.stringify(data.archive, null, 2)], { type: 'application/json' }));
  const link = el('a');
  link.href = url;
  link.download = `tabblackbox-${id === undefined ? 'sessions' : 'session'}-${new Date().toISOString().slice(0, 10)}.json`;
  root.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function deleteSession(item: Summary, trigger: HTMLButtonElement): void
{
  if (restoring || backingUp || !sessionDialogLock.acquire()) return;
  const dialog = el('dialog', 'restore-dialog');
  const title = el('h2', '', 'Delete saved session?');
  title.id = 'delete-session-title';
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.append(title, el('p', '', `“${item.name ?? 'Unnamed session'}” will be permanently deleted. Export a copy first if you want to keep it.`));
  const actions = el('div', 'dialog-actions');
  const cancel = button('Cancel', icons.Check);
  const remove = button('Delete session', icons.Trash2, 'button');
  const feedback = el('div');
  feedback.setAttribute('aria-live', 'polite');
  actions.append(cancel, remove);
  dialog.append(feedback, actions);
  let deleting = false;
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    sessionDialogLock.release();
    dialog.remove();
    updateDialogButtons();
    if (trigger.isConnected) trigger.focus();
    else backup.element.focus();
  }, { once: true });
  remove.addEventListener('click', () => {
    if (deleting) return;
    deleting = true;
    remove.disabled = cancel.disabled = true;
    void (async () => {
      try {
        await request({ kind: 'delete-saved', id: item.id });
        await refresh('overview');
        dialog.close();
        toast.show('Saved session deleted');
      } catch (error) { feedback.replaceChildren(notice(errorMessage(error))); }
      finally { deleting = false; remove.disabled = cancel.disabled = false; }
    })();
  });
  try {
    updateDialogButtons();
    root.append(dialog);
    dialog.showModal();
    cancel.focus();
  } catch (error) {
    dialog.remove();
    sessionDialogLock.release();
    updateDialogButtons();
    showError(error);
  }
}

function row(item: Summary)
{
  const wrapper = el('article', 'backup-row');
  const details = el('details');
  const summary = el('summary', 'backup-summary');
  const label = el('div', 'backup-label');
  const nameRow = el('div', 'backup-name');
  const title = el('strong', 'backup-title');
  const date = timestamp(item.capturedAt);
  date.className = 'backup-date';
  const number = el('span', 'backup-number', `#${item.number}`);
  const counts = el('span', 'muted', `${plural(item.windowCount, 'window')} · ${plural(item.tabCount, 'tab')}`);
  function update(value: Summary): void
  {
    item = value;
    // update labels while keeping timestamps and row structure in place
    const name = item.name ?? 'Unnamed session';
    if (title.textContent !== name) title.textContent = name;
    const sessionNumber = `#${item.number}`;
    if (number.textContent !== sessionNumber) number.textContent = sessionNumber;
    rename.title = `Rename session ${sessionNumber}`;
    rename.setAttribute('aria-label', rename.title);
  }
  nameRow.append(title);
  label.append(nameRow, counts);
  summary.append(icon(icons.ChevronDown), number, label, date);
  details.append(summary);
  const restore = button('Restore', icons.RotateCcw, 'button small');
  restore.disabled = sessionDialogLock.active || !canRestore({ tabCount: item.tabCount, backingUp, restoring });
  restoreButtons.set(restore, item.tabCount);
  const actions = el('div', 'backup-actions');
  const rename = button('', icons.Pencil, 'session-rename');
  rename.disabled = sessionDialogLock.active;
  update(item);
  rename.addEventListener('click', event => { event.preventDefault(); nameSession(item, rename, 'rename'); });
  nameRow.append(rename);
  const keep = button('', icons.Archive, 'button small');
  keep.title = 'Keep session';
  keep.setAttribute('aria-label', keep.title);
  keep.addEventListener('click', () => nameSession(item, keep, 'keep'));
  const exportSession = button('', icons.Download, 'button small');
  exportSession.title = 'Export session';
  exportSession.setAttribute('aria-label', exportSession.title);
  exportSession.addEventListener('click', () => { void downloadArchive(item.id).catch(showError); });
  const remove = button('', icons.Trash2, 'button small');
  remove.title = 'Delete session';
  remove.setAttribute('aria-label', remove.title);
  remove.addEventListener('click', () => deleteSession(item, remove));
  keep.hidden = item.savedAt !== undefined;
  exportSession.hidden = remove.hidden = item.savedAt === undefined;
  actions.append(keep, exportSession, remove, restore);
  wrapper.append(details, actions);
  let snapshot: Snapshot | undefined;
  async function load(): Promise<Snapshot>
  {
    if (snapshot) return snapshot;
    const data = await request({ kind: 'snapshot', id: item.id });
    if (data.kind !== 'snapshot') throw new Error('Unexpected backup response.');
    snapshot = data.snapshot;
    return snapshot;
  }
  let rendered = false;
  details.addEventListener('toggle', () =>
  {
    if (details.open && !rendered) {
      rendered = true;
      void load().then(value => {
        if (!details.isConnected) return;
        details.append(preview(value));
      }, (error: unknown) => { rendered = false; details.append(notice(errorMessage(error))); });
    }
  });
  restore.addEventListener('click', () =>
  {
    void confirmRestore(load, restore).catch((error: unknown) => feedback.replaceChildren(notice(errorMessage(error))));
  });
  return { element: wrapper, details, restore, rename, keep, remove, update };
}

function renderHistory(panel: ReturnType<typeof historyPanel>): void
{
  const { items, rows, sessionRows } = panel;
  const ids = new Set(items.map(item => item.id));
  for (const [id, saved] of sessionRows) {
    if (ids.has(id)) continue;
    saved.element.remove();
    restoreButtons.delete(saved.restore);
    for (const button of saved.element.querySelectorAll<HTMLButtonElement>('.window-restore')) restoreButtons.delete(button);
    sessionRows.delete(id);
  }
  if (!sessionRows.size) rows.replaceChildren();
  // retain existing rows and previews while inserting new backups in order
  let next = rows.firstElementChild;
  for (const item of items) {
    let saved = sessionRows.get(item.id);
    if (!saved) {
      saved = row(item);
      sessionRows.set(item.id, saved);
    } else saved.update(item);
    if (saved.element === next) next = next.nextElementSibling;
    else rows.insertBefore(saved.element, next);
  }
  if (!items.length) {
    const empty = el('div', 'empty-state');
    const title = panel.query ? 'No matching saved sessions' : panel.collection === 'saved' ? 'Keep sessions for later' : 'Your backup history starts here';
    const description = panel.query ? 'Try another session name.' : panel.collection === 'saved' ? 'Choose Back up now or select Keep on an automatic backup below.' : 'Open some tabs and enable automatic backups in Settings. Changes will be saved according to your automatic backup settings.';
    empty.append(icon(icons.Archive, 32), el('h2', '', title), el('p', 'muted', description));
    rows.append(empty);
  }
}

async function loadHistory(panel: ReturnType<typeof historyPanel>, reset: boolean, preserveLoaded = false): Promise<void>
{
  const { items, more, sessionRows } = panel;
  const generation = reset ? ++panel.generation : panel.generation;
  const last = reset ? undefined : items.at(-1);
  more.disabled = true;
  try {
    const data = await request({ kind: 'history', before: last ? { capturedAt: last.capturedAt, id: last.id } : null, collection: panel.collection, query: panel.query });
    if (generation !== panel.generation) return;
    if (data.kind !== 'history') throw new Error('Unexpected history response.');
    panel.count.textContent = String(data.count);
    const mb = data.bytes / MB;
    panel.usage.textContent = `${mb > 0 && mb < 0.01 ? '<0.01' : mb.toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`;
    if (panel === savedPanel) exportAll.disabled = data.count === 0;
    let page = data.items;
    let pageLimit = last ? HISTORY_PAGE_LIMIT : HISTORY_INITIAL_LIMIT;
    const loaded = [...page];
    // retain loaded rows during renames and expanded sessions during new backups
    while (reset && page.length === pageLimit) {
      const oldestOpen = preserveLoaded ? items.at(-1) : items.findLast(item => sessionRows.get(item.id)?.details.open);
      const end = loaded.at(-1);
      if (!oldestOpen || !end || end.capturedAt < oldestOpen.capturedAt || (end.capturedAt === oldestOpen.capturedAt && end.id <= oldestOpen.id)) break;
      const older = await request({ kind: 'history', before: { capturedAt: end.capturedAt, id: end.id }, collection: panel.collection, query: panel.query });
      if (generation !== panel.generation) return;
      if (older.kind !== 'history') throw new Error('Unexpected history response.');
      page = older.items;
      pageLimit = HISTORY_PAGE_LIMIT;
      loaded.push(...page);
    }
    if (reset) panel.items = loaded;
    else panel.items.push(...loaded);
    renderHistory(panel);
    updateDialogButtons();
    more.hidden = page.length < pageLimit;
  } catch (error) {
    if (generation === panel.generation) throw error;
  } finally {
    if (generation === panel.generation) more.disabled = false;
  }
}

function searchHistory(query: string): Promise<void>
{
  search.value = savedPanel.query = query;
  // invalidate pending results and reload independently of overview polling
  return loadHistory(savedPanel, true);
}

function updateSave(): void
{
  backup.update(backingUp, restoring);
}

function updateDialogButtons(): void
{
  for (const [button, tabCount] of restoreButtons) button.disabled = sessionDialogLock.active || !canRestore({ tabCount, backingUp, restoring });
  for (const panel of panels) for (const saved of panel.sessionRows.values()) {
    saved.rename.disabled = sessionDialogLock.active;
    saved.keep.disabled = saved.remove.disabled = sessionDialogLock.active || backingUp || restoring;
  }
}

function applyOverview(overview: Overview): void
{
  settings.update(overview);
  statusCard.update(overview);
  restoring = overview.status.kind === 'restoring';
  updateSave();
  updateDialogButtons();
  renderOperation(overview.metadata.operation);
}

const refresh = createRefreshQueue(async kind =>
{
  if (kind === 'backup') { feedback.replaceChildren(); toast.clear(); }
  try {
    const data = await request({ kind });
    if (data.kind !== 'overview') throw new Error('Unexpected background response.');
    if (kind === 'backup' && data.captureResult?.kind === 'saved') await searchHistory('');
    await updateFileAccess();
    applyOverview(data.overview);
    if (latestId !== data.overview.metadata.latestId || historyCount !== data.overview.metadata.count || historyRevision !== data.overview.metadata.historyRevision || panels.some(panel => !panel.rows.childElementCount)) {
      await Promise.all(panels.map(panel => loadHistory(panel, true, historyRevision !== null && historyRevision !== data.overview.metadata.historyRevision)));
      latestId = data.overview.metadata.latestId;
      historyCount = data.overview.metadata.count;
      historyRevision = data.overview.metadata.historyRevision;
      feedback.replaceChildren();
    }
    if (kind === 'backup') {
      backup.finish(data.captureResult);
    }
  } catch (error) {
    feedback.replaceChildren(notice(errorMessage(error)));
    settings.showError(errorMessage(error));
  }
}, value => { backingUp = value; updateSave(); updateDialogButtons(); });
for (const panel of panels) panel.more.addEventListener('click', () =>
{
  void loadHistory(panel, false).catch(showError);
});
search.addEventListener('input', () => {
  void searchHistory(search.value).catch(showError);
});
exportAll.addEventListener('click', () => { void downloadArchive().catch(showError); });
const importFile = el('input');
importFile.type = 'file';
importFile.accept = '.json,application/json';
importFile.hidden = true;
root.append(importFile);
importSessions.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', () => {
  const file = importFile.files?.[0];
  if (!file) return;
  importSessions.disabled = true;
  feedback.replaceChildren();
  void (async () => {
    try {
      const archive = parseArchive(JSON.parse(await file.text()));
      await request({ kind: 'import', archive });
      await searchHistory('');
      await refresh('overview');
      toast.show(`${plural(archive.sessions.length, 'session')} imported`);
    } catch (error) { showError(error); }
    finally { importSessions.disabled = false; importFile.value = ''; }
  })();
});
void refresh('refresh');
setInterval(() => { if (!document.hidden) void refresh('overview'); }, 1500);
