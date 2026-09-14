import { timestamp } from '../../src/ui/dates';
import { errorMessage, type Operation, type Overview, type Snapshot, type Summary } from '../../src/model';
import { FILE_ACCESS_MESSAGE, fileUrl, restorableUrl, selectWindows } from '../../src/session';
import { canRestore, createSessionDialogLock } from '../../src/ui/restore-state';
import { setup, brand, button, icons, icon, el, request, createStatusView, notice, plural } from '../../src/ui/shared';
import { createRefreshQueue } from '../../src/ui/refresh-queue';
import { createSettingsView } from '../../src/ui/settings';
import { HISTORY_INITIAL_LIMIT, HISTORY_PAGE_LIMIT, SESSION_NAME_LIMIT } from '../../src/protocol';

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
titles.append(el('h1', '', 'Backup history'), el('p', 'muted', 'TabBlackBox automatically saves your browser sessions, including the URLs and arrangement of your open tabs and windows. Expand a saved session to browse its tabs, open individual links, or restore the entire session in your browser.'));
const save = el('button', 'button primary');
save.type = 'button';
const saveLabel = document.createTextNode('Back up now');
save.append(icon(icons.Save), saveLabel);
heading.append(titles);
const statusCard = createStatusView(save);
const status = statusCard.element;
const feedback = el('div');
feedback.setAttribute('aria-live', 'polite');
const toast = el('div', 'toast-region');
toast.setAttribute('role', 'status');
toast.setAttribute('aria-atomic', 'true');
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showBackupToast(message: string, glyph = icons.Check): void
{
  clearTimeout(toastTimer);
  toast.replaceChildren();
  if (!message) return;
  const content = el('div', 'backup-toast');
  content.append(icon(glyph), el('span', '', message));
  toast.append(content);
  toastTimer = setTimeout(() => toast.replaceChildren(), 4000);
}

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
footer.append(icon(icons.HardDrive), el('span', '', 'Backups are stored on this device. Your storage settings determine how long they are kept.'));
main.append(heading, status, feedback, operationRegion, list, more, footer);
const settings = createSettingsView(() => { void refresh('backup'); });
root.append(header, nav, main, settings.element, toast);

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
  document.title = `${isSettings ? 'Settings' : 'Backup history'} · TabBlackBox`;
}
window.addEventListener('hashchange', showView);
showView();

let items: Summary[] = [];
let historyGeneration = 0;
let latestId: string | null = null;
let historyCount: number | null = null;
let historyRevision: number | null = null;
let restoring = false;
let backingUp = false;
let operationKey = '';
let fileAccess = false;
const restoreButtons = new Map<HTMLButtonElement, number>();
const sessionRows = new Map<string, ReturnType<typeof row>>();
const sessionDialogLock = createSessionDialogLock();

async function updateFileAccess(): Promise<void>
{
  fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  // refresh expanded previews when Chrome's file access setting changes
  for (const control of rows.querySelectorAll<HTMLButtonElement>('.file-open')) control.disabled = !fileAccess;
  for (const message of rows.querySelectorAll<HTMLElement>('.file-access-required')) message.hidden = fileAccess;
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

function renameSession(item: Summary, trigger: HTMLButtonElement): void
{
  const dialog = el('dialog', 'restore-dialog');
  const title = el('h2', '', 'Rename this session');
  title.id = 'rename-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const form = el('form');
  const label = el('label', 'setting-name', 'Session name');
  label.htmlFor = 'session-name';
  const input = el('input', 'session-name-input');
  input.id = label.htmlFor;
  input.type = 'text';
  input.maxLength = SESSION_NAME_LIMIT;
  input.value = item.name ?? '';
  input.placeholder = 'Unnamed session';
  const help = el('p', 'muted', 'Leave blank to use “Unnamed session”.');
  help.id = 'session-name-description';
  input.setAttribute('aria-describedby', help.id);
  const feedback = el('div');
  feedback.setAttribute('aria-live', 'polite');
  const actions = el('div', 'dialog-actions');
  const cancel = button('Cancel', icons.Check);
  const save = button('Save name', icons.Check, 'button primary');
  save.type = 'submit';
  actions.append(cancel, save);
  form.append(label, input, help, feedback, actions);
  dialog.append(title, form);
  let saving = false;
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
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
        const data = await request({ kind: 'rename', id: item.id, name: input.value });
        if (data.kind !== 'renamed') throw new Error('Unexpected rename response.');
        items = items.map(value => value.id === item.id ? data.summary : value);
        sessionRows.get(item.id)?.update(data.summary);
        dialog.close();
      } catch (error) { feedback.replaceChildren(notice(errorMessage(error))); }
      finally { saving = false; input.disabled = cancel.disabled = save.disabled = false; }
    })();
  });
  if (!sessionDialogLock.acquire()) return;
  try {
    updateDialogButtons();
    root.append(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  } catch (error) {
    dialog.remove();
    sessionDialogLock.release();
    updateDialogButtons();
    throw error;
  }
}

function row(item: Summary)
{
  const wrapper = el('article', 'backup-row');
  const details = el('details');
  const summary = el('summary', 'backup-summary');
  const label = el('div', 'backup-label');
  const title = el('strong', 'backup-title');
  const date = timestamp(item.capturedAt);
  date.className = 'backup-date';
  const number = el('span', 'backup-number', `#${item.number}`);
  const counts = el('span', 'muted', `${plural(item.windowCount, 'window')} · ${plural(item.tabCount, 'tab')}`);
  function update(value: Summary): void
  {
    item = value;
    // update only the name while keeping timestamps and row structure in place
    const name = item.name ?? 'Unnamed session';
    if (title.textContent !== name) title.textContent = name;
  }
  update(item);
  label.append(title, counts);
  summary.append(icon(icons.ChevronDown), number, label, date, el('span', 'badge', item.source === 'manual' ? 'Manual' : 'Automatic'));
  details.append(summary);
  const restore = button('Restore', icons.RotateCcw, 'button small');
  restore.disabled = sessionDialogLock.active || !canRestore({ tabCount: item.tabCount, backingUp, restoring });
  restoreButtons.set(restore, item.tabCount);
  const actions = el('div', 'backup-actions');
  const rename = button('', icons.Pencil, 'button small');
  rename.disabled = sessionDialogLock.active;
  rename.title = `Rename session #${item.number}`;
  rename.setAttribute('aria-label', rename.title);
  rename.addEventListener('click', () => renameSession(item, rename));
  actions.append(rename, restore);
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
  return { element: wrapper, details, restore, rename, update };
}

function renderHistory(): void
{
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
    empty.append(icon(icons.Archive, 32), el('h2', '', 'Your backup history starts here'), el('p', 'muted', 'Open some tabs and choose Back up now. Future changes will be saved automatically.'));
    rows.append(empty);
  }
}

async function loadHistory(reset: boolean, preserveLoaded = false): Promise<void>
{
  const generation = reset ? ++historyGeneration : historyGeneration;
  const last = reset ? undefined : items.at(-1);
  more.disabled = true;
  try {
    const data = await request({ kind: 'history', before: last ? { capturedAt: last.capturedAt, id: last.id } : null });
    if (generation !== historyGeneration) return;
    if (data.kind !== 'history') throw new Error('Unexpected history response.');
    let page = data.items;
    let pageLimit = last ? HISTORY_PAGE_LIMIT : HISTORY_INITIAL_LIMIT;
    const loaded = [...page];
    // retain loaded rows during renames and expanded sessions during new backups
    while (reset && page.length === pageLimit) {
      const oldestOpen = preserveLoaded ? items.at(-1) : items.findLast(item => sessionRows.get(item.id)?.details.open);
      const end = loaded.at(-1);
      if (!oldestOpen || !end || end.capturedAt < oldestOpen.capturedAt || (end.capturedAt === oldestOpen.capturedAt && end.id <= oldestOpen.id)) break;
      const older = await request({ kind: 'history', before: { capturedAt: end.capturedAt, id: end.id } });
      if (generation !== historyGeneration) return;
      if (older.kind !== 'history') throw new Error('Unexpected history response.');
      page = older.items;
      pageLimit = HISTORY_PAGE_LIMIT;
      loaded.push(...page);
    }
    if (reset) items = loaded;
    else items.push(...loaded);
    renderHistory();
    more.hidden = page.length < pageLimit;
  } catch (error) {
    if (generation === historyGeneration) throw error;
  } finally {
    if (generation === historyGeneration) more.disabled = false;
  }
}

function updateSave(): void
{
  save.disabled = backingUp || restoring;
  settings.setBackupState(backingUp, restoring);
  const label = backingUp ? 'Backing up…' : 'Back up now';
  if (saveLabel.data !== label) saveLabel.data = label;
}

function updateDialogButtons(): void
{
  for (const [button, tabCount] of restoreButtons) button.disabled = sessionDialogLock.active || !canRestore({ tabCount, backingUp, restoring });
  for (const saved of sessionRows.values()) saved.rename.disabled = sessionDialogLock.active;
}

function applyOverview(overview: Overview): void
{
  settings.update(overview);
  statusCard.update(overview);
  count.textContent = String(overview.metadata.count);
  restoring = overview.status.kind === 'restoring';
  updateSave();
  updateDialogButtons();
  renderOperation(overview.metadata.operation);
}

const refresh = createRefreshQueue(async kind =>
{
  if (kind === 'backup') { feedback.replaceChildren(); showBackupToast(''); }
  try {
    const data = await request({ kind });
    if (data.kind !== 'overview') throw new Error('Unexpected background response.');
    await updateFileAccess();
    applyOverview(data.overview);
    if (latestId !== data.overview.metadata.latestId || historyCount !== data.overview.metadata.count || historyRevision !== data.overview.metadata.historyRevision || !rows.childElementCount) {
      await loadHistory(true, historyRevision !== null && historyRevision !== data.overview.metadata.historyRevision);
      latestId = data.overview.metadata.latestId;
      historyCount = data.overview.metadata.count;
      historyRevision = data.overview.metadata.historyRevision;
      feedback.replaceChildren();
    }
    if (kind === 'backup') {
      if (data.overview.status.kind === 'current' && data.captureResult?.kind === 'saved') showBackupToast('Your session is saved.');
      else if (data.overview.status.kind === 'current' && data.captureResult?.kind === 'unchanged') showBackupToast('Your session is already up to date.');
      else if (data.overview.status.kind === 'pending') showBackupToast('Tabs changed during capture. Automatic backup will retry.', icons.Clock3);
    }
  } catch (error) {
    feedback.replaceChildren(notice(errorMessage(error)));
    settings.showError(errorMessage(error));
  }
}, value => { backingUp = value; updateSave(); updateDialogButtons(); });
save.addEventListener('click', () => { void refresh('backup'); });
more.addEventListener('click', () =>
{
  void loadHistory(false).catch((error: unknown) => feedback.replaceChildren(notice(errorMessage(error))));
});
void refresh('refresh');
setInterval(() => { if (!document.hidden) void refresh('overview'); }, 1500);
