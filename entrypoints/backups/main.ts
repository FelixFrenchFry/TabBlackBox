import { timestamp } from '../../src/ui/dates';
import { errorMessage, type ChangeCounts, type ClosedTabChange, type Collection, type HistoryRange, type HistorySort, type Operation, type Overview, type SearchField, type Snapshot, type Summary, type TabMatch, type TabSearchField } from '../../src/model';
import { changeCounts } from '../../src/changes';
import { compareHistory, parseHistorySort, parseSearchFields, SEARCH_FIELDS } from '../../src/history';
import { exportArchiveFile, readArchiveFile } from '../../src/archive-file';
import { Repository } from '../../src/database';
import { EXPORT_FORMATS, type ExportFormat } from '../../src/export-formats';
import { MB } from '../../src/storage';
import { FILE_ACCESS_MESSAGE, fileUrl, restorableUrl, selectWindows } from '../../src/session';
import { canRestore, createSessionDialogLock } from '../../src/ui/restore-state';
import { setup, brand, button, icons, icon, el, request, createStatusView, notice, plural, formatNumber } from '../../src/ui/shared';
import { createRefreshQueue } from '../../src/ui/refresh-queue';
import { createBackupButton } from '../../src/ui/backup-button';
import { createToast } from '../../src/ui/toast';
import { createRestoreDialog } from '../../src/ui/restore-dialog';
import { createHelp } from '../../src/ui/help';
import { createSettingsView } from '../../src/ui/settings';
import { createStatisticsView } from '../../src/ui/statistics';
import { createBackupCalendar } from '../../src/ui/calendar';
import { createTabChart } from '../../src/ui/tab-chart';
import { createTopSites } from '../../src/ui/top-sites';
import { createSearchFields } from '../../src/ui/search-fields';
import { createTabSearch } from '../../src/ui/tab-search';
import { createTagEditor } from '../../src/ui/tag-editor';
import { favicon } from '../../src/ui/favicon';
import { displayUrl, siteLabel } from '../../src/ui/site-label';
import { markMatches, type SearchHighlight } from '../../src/ui/highlight';
import { setTooltip } from '../../src/ui/tooltip';
import { HISTORY_INITIAL_LIMIT, HISTORY_PAGE_LIMIT, SESSION_NAME_LIMIT } from '../../src/protocol';
import { privacyLink } from '../../src/ui/privacy';

const root = setup();
const header = el('header', 'app-header');
const headerInner = el('div', 'header-inner');
const headerInfo = el('div', 'header-info');
headerInfo.append(el('span', 'local-label', 'Local browser session backups.'), privacyLink());
headerInner.append(brand(), headerInfo);
header.append(headerInner);
const nav = el('nav', 'navigation');
nav.setAttribute('aria-label', 'Main navigation');
const active = el('a', 'nav-item active', 'Backups');
active.href = '#backups';
active.setAttribute('aria-current', 'page');
active.prepend(icon(icons.History));
const statisticsLink = el('a', 'nav-item', 'Statistics');
statisticsLink.href = '#statistics';
statisticsLink.prepend(icon(icons.ChartLine));
const settingsLink = el('a', 'nav-item', 'Settings');
settingsLink.href = '#settings';
settingsLink.prepend(icon(icons.Settings));
nav.append(active, statisticsLink, settingsLink);
const main = el('main', 'history-main');
const heading = el('div', 'page-heading');
const titles = el('div', 'page-titles');
titles.append(el('h1', '', 'Backups'), el('p', 'muted', 'Browse manual and automatic browser session backups. Expand a backup to view its tabs, windows, and tab groups, open individual URLs, or restore the session.'));
const backup = createBackupButton(() => { void refresh('backup'); });
heading.append(titles);
const statusCard = createStatusView({ expandable: true });
const status = statusCard.element;
const feedback = el('div');
feedback.setAttribute('aria-live', 'polite');
const toast = createToast();
const restoreResult = createRestoreDialog((title, url) => tabLabel(title, url, { words: [], fields: [] }), {
  acquire: () => {
    if (!sessionDialogLock.acquire()) return false;
    updateDialogButtons();
    return true;
  },
  release: () => { sessionDialogLock.release(); updateDialogButtons(); },
  focus: () => { if (restoreResult.element.hidden) backup.element.focus(); else restoreResult.element.focus(); },
});
status.append(restoreResult.element);
const archiveRepository = new Repository();
let archiveOperation: AbortController | null = null;
// cancel page-owned file operations before the document and its database connection disappear
window.addEventListener('pagehide', () => { archiveOperation?.abort(); void archiveRepository.close(); });
window.addEventListener('beforeunload', event => { if (archiveOperation) event.preventDefault(); });
void archiveRepository.clearAbandonedImport().catch(showError);

function readHistorySort(collection: Collection): HistorySort
{
  try { return parseHistorySort(localStorage.getItem(`tabblackbox.history-sort.${collection}`)); }
  catch { return 'date-desc'; }
}

function historyPanel(collection: Collection)
{
  const element = el('section', `history-panel ${collection}-backups`);
  const title = collection === 'saved' ? 'Manual backups' : 'Automatic backups';
  element.setAttribute('aria-label', title);
  const list = el('div', 'backup-list');
  const header = el('div', 'list-header');
  const count = el('span', 'badge', '0');
  const usage = el('span', 'muted panel-usage');
  const help = createHelp(`${collection}-help`, `About ${title.toLowerCase()}`, collection === 'saved' ? 'Sessions you choose to keep until you delete them. Select "Back up now" to save your current session, or select the bookmark icon next to an automatic backup\'s name to move it into this category. Manual backups are excluded from storage limits and automatic deletions. You can export sessions to keep a copy outside your browser, or import previously exported sessions.' : 'History of your tabs, windows, and tab groups. These sessions are saved periodically according to your automatic backup settings. Older backups are deleted automatically according to your storage limit settings.');
  header.append(icon(collection === 'saved' ? icons.Bookmark : icons.History), el('h2', '', title), help, count);
  const toolbar = el('div', 'archive-toolbar');
  const sortControls = el('div', 'history-sort-controls');
  sortControls.setAttribute('role', 'group');
  sortControls.setAttribute('aria-label', 'Sort backups');
  const sortButtons = (['number', 'date'] as const).map(property => {
    const element = el('button', 'history-sort-button');
    element.type = 'button';
    sortControls.append(element);
    return { property, element };
  });
  const panelTools = el('div', 'panel-tools');
  panelTools.append(sortControls, usage);
  header.append(panelTools);
  function updateSort(sort: HistorySort): void
  {
    for (const { property, element } of sortButtons) {
      const selected = sort.startsWith(`${property}-`);
      const ascending = selected && sort.endsWith('-asc');
      const label = property === 'date' ? 'Date' : 'Number';
      const ascendingLabel = property === 'date' ? 'oldest first' : 'lowest first';
      const descendingLabel = property === 'date' ? 'newest first' : 'highest first';
      const current = selected ? ascending ? ascendingLabel : descendingLabel : 'not sorted';
      const next = selected && !ascending ? ascendingLabel : descendingLabel;
      element.title = `${label}, ${current}. Sort ${next}`;
      element.setAttribute('aria-label', element.title);
      element.setAttribute('aria-pressed', String(selected));
      element.replaceChildren(el('span', '', label), icon(selected ? ascending ? icons.ArrowUp : icons.ArrowDown : icons.ArrowUpDown, 14));
    }
  }
  const sort = readHistorySort(collection);
  updateSort(sort);
  const content = el('div', 'history-content');
  const rows = el('div', 'history-rows');
  const dateFeedback = el('div', 'history-date-feedback');
  dateFeedback.hidden = true;
  dateFeedback.setAttribute('aria-live', 'polite');
  const pagination = el('div', 'history-pagination');
  pagination.hidden = true;
  const more = button('Show more', icons.ChevronDown, 'history-pagination-button');
  more.hidden = true;
  const fewer = button('Show fewer', icons.ChevronDown, 'history-pagination-button history-pagination-fewer');
  fewer.hidden = true;
  pagination.append(more, fewer);
  list.append(header);
  if (collection === 'saved') list.append(toolbar);
  content.append(dateFeedback, rows);
  list.append(content, pagination);
  element.append(list);
  const items: Summary[] = [];
  const filter: { loadedRange: HistoryRange | null; loadedTabUrl: string | null; loadedSearch: SearchHighlight<SearchField> | null } = { loadedRange: null, loadedTabUrl: null, loadedSearch: null };
  return { element, list, content, header, toolbar, sortButtons, updateSort, sort, loadedSort: sort, rememberSort: false, count, usage, dateFeedback, rows, pagination, more, fewer, collection, query: '', tag: null as string | null, items, ...filter, generation: 0, sessionRows: new Map<string, ReturnType<typeof row>>() };
}

const savedPanel = historyPanel('saved');
const automaticPanel = historyPanel('automatic');
const panels = [savedPanel, automaticPanel];
let historyRange: HistoryRange | null = null;
let historyTabUrl: string | null = null;
const calendar = createBackupCalendar(range => {
  historyRange = range;
  void Promise.all(panels.map(panel => loadHistory(panel, true))).catch(showError);
});
const tabChart = createTabChart();
const topSites = createTopSites();
const statistics = createStatisticsView(tabChart.element, topSites.element);
const tabSearch = createTabSearch({ label: tabLabel, show: filterByTab });
const statusSearch = el('div', 'status-search');
statusSearch.append(tabSearch.element, status);
const tabFilter = el('div', 'tab-filter');
tabFilter.hidden = true;
const tabFilterLabel = el('p');
const clearTabFilter = button('Clear', icons.RotateCcw, 'button small');
clearTabFilter.addEventListener('click', () => filterByTab(null));
tabFilter.append(tabFilterLabel, clearTabFilter);
const exportAll = button('Export all', icons.Download);
const importSessions = button('Import', icons.Upload);
const search = el('input', 'session-name-input archive-search');
search.type = 'search';
search.placeholder = 'Search session names';
search.setAttribute('aria-label', 'Search session names');
search.maxLength = SESSION_NAME_LIMIT;
const searchFields = createSearchFields({ id: 'search-fields-menu', storageKey: 'tabblackbox.search-fields', fields: SEARCH_FIELDS, labels: { name: 'Names', tags: 'Tags' }, parse: parseSearchFields }, () => {
  void searchHistory(search.value).catch(showError);
});
// attach the search scope to the start of the search field
const searchGroup = el('div', 'search-group');
searchGroup.append(searchFields.element, search);
savedPanel.toolbar.prepend(searchGroup);
savedPanel.toolbar.append(backup.element, exportAll, importSessions);
const footer = el('footer', 'history-footer');
footer.append(icon(icons.HardDrive), el('span', '', 'Backups stay on this device. Automatic backups are removed as needed. Manual backups stay until deleted explicitly. Export them to keep an external copy.'));
main.append(heading, statusSearch, feedback, calendar.element, tabFilter, ...panels.map(panel => panel.element), footer);
const settings = createSettingsView(() => toast.show('Settings have been saved'));
root.append(header, nav, main, statistics.element, settings.element, toast.element);

function showView(): void
{
  // show one view per hash and fall back to backups
  const views = [{ link: active, element: main, title: 'Backups' }, { link: statisticsLink, element: statistics.element, title: 'Statistics' }, { link: settingsLink, element: settings.element, title: 'Settings' }];
  const current = views.find(view => view.link.hash === location.hash) ?? views[0];
  for (const view of views) {
    const selected = view === current;
    view.element.hidden = !selected;
    view.link.classList.toggle('active', selected);
    if (selected) view.link.setAttribute('aria-current', 'page');
    else view.link.removeAttribute('aria-current');
  }
  document.title = `TabBlackBox · ${current?.title ?? 'Backups'}`;
}
window.addEventListener('hashchange', showView);
showView();

const sortFeedback = new WeakMap<ReturnType<typeof historyPanel>, HTMLElement>();
for (const panel of panels) {
  const element = el('div', 'history-sort-feedback');
  element.hidden = true;
  element.setAttribute('aria-live', 'polite');
  panel.list.insertBefore(element, panel.content);
  sortFeedback.set(panel, element);
}

function historySortFeedback(panel: ReturnType<typeof historyPanel>): HTMLElement
{
  const element = sortFeedback.get(panel);
  if (!element) throw new Error('History sort feedback is missing.');
  return element;
}

let latestId: string | null = null;
let newestId: string | null = null;
let historyCount: number | null = null;
let historyRevision: number | null = null;
let historyInvalidated = false;
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
  for (const control of root.querySelectorAll<HTMLButtonElement>('.file-open')) control.disabled = !fileAccess;
  for (const message of root.querySelectorAll<HTMLElement>('.file-access-required')) message.hidden = fileAccess;
}

// keep the warning icon aligned with the first text line
function warningText(text: string): HTMLParagraphElement
{
  const paragraph = el('p', 'warning-text');
  paragraph.append(icon(icons.TriangleAlert), el('span', '', text));
  return paragraph;
}

function fileAccessNotice(): HTMLElement
{
  const message = el('div', 'notice warning-notice file-access-required');
  message.append(warningText(FILE_ACCESS_MESSAGE));
  const settings = button('Open extension settings', icons.Settings);
  settings.addEventListener('click', () => {
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }).catch((error: unknown) => message.append(notice(errorMessage(error))));
  });
  message.append(settings);
  return message;
}

function renderOperation(operation: Operation | null, status: Overview['status'], pendingRequest: object | null): void
{
  restoreResult.update(operation, status, pendingRequest);
  const previous = lastOperation;
  lastOperation = operation;
  // show successful restores once as a toast and keep issues in the persistent report
  if (previous === undefined || !operation || operation.kind === 'running') return;
  if (previous && previous.snapshotId === operation.snapshotId && previous.startedAt === operation.startedAt && previous.kind !== 'running') return;
  if (operation.kind === 'interrupted' || operation.failed > 0 || operation.groupErrors > 0 || operation.errors.length > 0 || operation.issues?.length) return;
  const parts = ['Restoration finished', `${plural(operation.opened, 'tab')} opened`];
  if (operation.skipped) parts.push(`${operation.skipped} skipped`);
  toast.show(parts.join(' · '), icons.Check);
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
    dialog.append(title, sessionCard({ ...snapshot, windowCount: snapshot.windows.length, tabCount: snapshot.windows.reduce((total, window) => total + window.tabs.length, 0) }), el('p', '', `${plural(supported, 'tab')} will open in ${plural(windows, 'new window')}. Your current windows will stay open.`));
    if (blockedFiles) {
      dialog.append(el('p', 'muted', `${plural(blockedFiles, 'local file')} will be skipped until file access is enabled.`), fileAccessNotice());
      dialog.append(el('p', 'muted', 'After enabling access, close this dialog and choose Restore again.'));
    }
    if (tabs.length > supported + blockedFiles) dialog.append(el('p', 'muted', `${plural(tabs.length - supported - blockedFiles, 'unsupported tab')} will be skipped. Their saved URLs remain in the preview.`));
    const duplicates = el('div', 'notice warning-notice');
    duplicates.append(warningText(windowIndex === undefined ? 'Restoring a session again creates another copy of its tabs.' : 'Restoring a window again creates another copy of its tabs.'));
    dialog.append(duplicates);
    const feedback = el('div');
    feedback.setAttribute('aria-live', 'polite');
    const actions = el('div', 'dialog-actions');
    const cancel = button('Cancel', icons.X);
    const confirm = button('Restore', icons.RotateCcw, 'button primary');
    confirm.disabled = supported === 0;
    actions.append(cancel, confirm);
    dialog.append(feedback, actions);
    root.append(dialog);
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      sessionDialogLock.release();
      dialog.remove();
      updateDialogButtons();
      if (trigger.isConnected) trigger.focus();
      else backup.element.focus();
    }, { once: true });
    confirm.addEventListener('click', () =>
    {
      confirm.disabled = true;
      feedback.replaceChildren();
      const confirmation = [...dialog.childNodes];
      restoreResult.begin(dialog, snapshot.id);
      restoring = true;
      updateDialogButtons();
      updateSave();
      void (async () =>
      {
        try {
          await request(windowIndex === undefined ? { kind: 'restore', id: snapshot.id } : { kind: 'restore-window', id: snapshot.id, windowIndex });
          restoreResult.accepted();
          restoring = true;
          updateDialogButtons();
          updateSave();
          await refresh('overview');
        } catch (error) {
          restoreResult.cancel(dialog);
          restoring = lastOperation?.kind === 'running';
          updateDialogButtons();
          updateSave();
          if (dialog.open) {
            dialog.replaceChildren(...confirmation);
            dialog.removeAttribute('aria-label');
            dialog.setAttribute('aria-labelledby', title.id);
            feedback.replaceChildren(notice(errorMessage(error)));
            confirm.disabled = false;
            confirm.focus();
          } else showError(error);
        }
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

function filterByTab(match: TabMatch | null): void
{
  historyTabUrl = match?.url ?? null;
  tabFilter.hidden = match === null;
  if (match) {
    tabFilterLabel.replaceChildren(document.createTextNode('Showing backups that contain '), el('strong', '', match.title || match.url));
    tabFilter.scrollIntoView({ block: 'start' });
  }
  // reload both panels with the page filter while keeping name and date filters
  void Promise.all(panels.map(panel => loadHistory(panel, true))).catch(showError);
}

function tabLabel(text: string, url: string | null, search?: SearchHighlight<TabSearchField>): HTMLElement
{
  const label = el('div', 'tab-label');
  const name = text || url || 'Unavailable tab';
  let title: HTMLElement;
  let open: HTMLAnchorElement | HTMLButtonElement;
  let openLabel: string;
  // allow individual navigation for the same URL schemes supported by restoration
  if (url !== null && fileUrl(url)) {
    const openFile = () => {
      void (async () => {
        await updateFileAccess();
        if (!fileAccess) throw new Error(FILE_ACCESS_MESSAGE);
        await chrome.tabs.create({ url });
      })().catch((error: unknown) => feedback.replaceChildren(notice(errorMessage(error))));
    };
    const file = button('', icons.ArrowUpRight, 'tab-open file-open');
    openLabel = 'Open local file in new tab';
    // the title opens the file like the site link and follows the same file access state
    const fileTitle = el('button', 'tab-title tab-title-link file-open', name);
    fileTitle.type = 'button';
    for (const control of [file, fileTitle]) {
      control.disabled = !fileAccess;
      control.addEventListener('click', openFile);
    }
    open = file;
    title = fileTitle;
  } else if (restorableUrl(url)) {
    open = el('a', 'tab-open');
    openLabel = 'Open in new tab';
    open.append(icon(icons.ArrowUpRight));
    // the title and the site link both open the saved page
    const pageTitle = el('a', 'tab-title tab-title-link', name);
    for (const link of [open, pageTitle]) {
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    title = pageTitle;
  } else {
    title = el('span', 'tab-title', name);
    open = button('', icons.ArrowUpRight, 'tab-open');
    open.disabled = true;
    openLabel = url ? 'This URL cannot be opened from a saved session' : 'No saved URL is available';
  }
  open.setAttribute('aria-label', openLabel);
  // open row tooltips above so moving down the list keeps the next tab visible
  setTooltip(open, openLabel, { placement: 'above' });
  // delay address tooltips like the popup's closed tabs so sweeping across titles opens nothing
  if (url !== null) setTooltip(title, url, { delay: 800, placement: 'above' });
  const address = el('span', 'tab-url', url === null ? 'URL unavailable' : search ? displayUrl(url) : siteLabel(url));
  open.prepend(address);
  if (!search) {
    // keep the row on one line with the site after the title and the full address on hover
    label.append(favicon(url), title, open);
    return label;
  }
  // list search results with the address below the title and mark the words that matched
  markMatches(title, name, search.fields.includes('title') ? search.words : []);
  if (url !== null) markMatches(address, displayUrl(url), search.fields.includes('url') ? search.words : []);
  const lines = el('div', 'tab-lines');
  lines.append(title, open);
  label.classList.add('search-label');
  label.append(favicon(url), lines);
  return label;
}

// name the session each comparison refers to by the panel it is shown in
function previousBackup(item: Pick<Summary, 'savedAt'>): string
{
  return `the previous ${item.savedAt === undefined ? 'automatic' : 'manual'} backup`;
}

function closedTabRow(tab: Omit<ClosedTabChange, 'after'>): HTMLElement
{
  // show tabs missing from the previous session without making them part of the restorable session
  const item = el('li', 'tab-row tab-closed');
  item.append(tabLabel(tab.title, tab.url), el('span', 'visually-hidden', 'Closed'));
  return item;
}

function changeLegend(snapshot: Snapshot): HTMLElement
{
  const legend = el('p', 'change-legend muted', `Compared to ${previousBackup(snapshot)}`);
  legend.append(el('span', 'change-key change-key-opened', 'opened'), el('span', 'change-key change-key-closed', 'closed'));
  return legend;
}

type PreviewView = 'tabs' | 'changes';

function foldUnchanged(tabs: HTMLElement): { fold: HTMLElement; rows: HTMLElement[] }[]
{
  // group consecutive tabs without changes behind a row that shows them again
  const runs: HTMLElement[][] = [];
  let run: HTMLElement[] | null = null;
  for (const item of tabs.querySelectorAll<HTMLElement>(':scope > .tab-row')) {
    if (item.matches('.tab-opened, .tab-closed')) { run = null; continue; }
    if (!run) runs.push(run = []);
    run.push(item);
  }
  return runs.map(rows => {
    const fold = el('li', 'tab-row tab-fold');
    const expand = button(plural(rows.length, 'unchanged tab'), icons.UnfoldVertical, 'tab-fold-button');
    expand.addEventListener('click', () => {
      fold.hidden = true;
      for (const row of rows) row.hidden = false;
    });
    fold.append(expand);
    rows[0]?.before(fold);
    return { fold, rows };
  });
}

function preview(snapshot: Snapshot, view: PreviewView, select: (view: PreviewView) => void): { element: HTMLElement; show: (view: PreviewView) => void }
{
  const content = el('div', 'snapshot-preview');
  if (snapshot.windows.some(window => window.tabs.some(tab => fileUrl(tab.url)))) {
    const message = fileAccessNotice();
    message.hidden = fileAccess;
    content.append(message);
  }
  const changes = snapshot.changes;
  const counts = changes ? changeCounts(changes) : null;
  const folds: ReturnType<typeof foldUnchanged> = [];
  const views: { value: PreviewView; control: HTMLButtonElement }[] = [];
  if (counts && (counts.opened || counts.closed)) {
    // switch between every tab and only the changes with unchanged tabs folded in place
    const toolbar = el('div', 'change-toolbar');
    const group = el('div', 'change-views');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Show tabs or changes');
    const tabCount = snapshot.windows.reduce((total, window) => total + window.tabs.length, 0);
    for (const [value, label, count] of [['tabs', 'Tabs', tabCount], ['changes', 'Changes', counts.opened + counts.closed]] as const) {
      const control = el('button', 'change-view');
      control.type = 'button';
      control.append(el('span', '', label), el('span', 'muted', String(count)));
      control.addEventListener('click', () => { select(value); show(value); });
      group.append(control);
      views.push({ value, control });
    }
    toolbar.append(group, changeLegend(snapshot));
    content.append(toolbar);
  }
  function show(next: PreviewView): void
  {
    for (const { value, control } of views) control.setAttribute('aria-pressed', String(value === next));
    // hide folded rows in place so file access updates still reach them
    for (const { fold, rows } of folds) {
      fold.hidden = next === 'tabs';
      for (const row of rows) row.hidden = next === 'changes';
    }
  }
  for (const [index, window] of snapshot.windows.entries()) {
    const section = el('section', 'window-preview');
    const heading = el('h3', 'window-heading');
    heading.append(icon(icons.Monitor), document.createTextNode(`Window ${index + 1}`), el('span', 'muted', plural(window.tabs.length, 'tab')));
    const restore = button('', icons.RotateCcw, 'button small icon-button invisible window-restore');
    restore.setAttribute('aria-label', `Restore this window ${index + 1}`);
    setTooltip(restore, 'Restore only this window and its tabs');
    restore.disabled = sessionDialogLock.active || !canRestore({ tabCount: window.tabs.length, backingUp, restoring });
    restoreButtons.set(restore, window.tabs.length);
    restore.addEventListener('click', () => {
      void confirmRestore(() => snapshot, restore, index).catch((error: unknown) => feedback.replaceChildren(notice(errorMessage(error))));
    });
    heading.append(restore);
    section.append(heading);
    const tabs = el('ul', 'tab-list');
    const opened = new Set(changes?.opened[index] ?? []);
    // place closed tabs after the open tab that preceded them in the previous backup
    const closed = Map.groupBy(changes?.closed[index] ?? [], tab => tab.after);
    for (const tab of closed.get(-1) ?? []) tabs.append(closedTabRow(tab));
    for (const [tabIndex, tab] of window.tabs.entries()) {
      const item = el('li', 'tab-row');
      const label = tabLabel(tab.title, tab.url);
      item.append(label);
      if (opened.has(tabIndex)) {
        item.classList.add('tab-opened');
        item.append(el('span', 'visually-hidden', 'Opened'));
      }
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
      for (const closedTab of closed.get(tabIndex) ?? []) tabs.append(closedTabRow(closedTab));
    }
    if (views.length) folds.push(...foldUnchanged(tabs));
    section.append(tabs);
    content.append(section);
  }
  // list windows whose pages are all gone after the windows that can be restored
  for (const window of changes?.closedWindows ?? []) {
    const section = el('section', 'window-preview window-closed');
    const heading = el('h3', 'window-heading');
    heading.append(icon(icons.Monitor), document.createTextNode('Closed window'), el('span', 'muted', plural(window.length, 'tab')));
    const tabs = el('ul', 'tab-list');
    tabs.append(...window.map(closedTabRow));
    section.append(heading, tabs);
    content.append(section);
  }
  show(views.length ? view : 'tabs');
  return { element: content, show };
}

// 20 steps of 4px so each step shows 5% of the tabs involved
const CHANGE_BAR_STEPS = 20;
const CHANGE_BAR_STEP_PX = 4;

function changeStrip(counts: ChangeCounts, item: Pick<Summary, 'tabCount' | 'savedAt'>): HTMLButtonElement | null
{
  if (!counts.opened && !counts.closed) return null;
  // scale the bar to every tab involved so a closed window stands out from a single tab
  const total = Math.max(1, item.tabCount + counts.closed);
  const strip = el('button', 'change-strip');
  strip.type = 'button';
  const bar = el('span', 'change-bar');
  const text = el('span', 'change-text');
  let free = CHANGE_BAR_STEPS;
  for (const [kind, count, sign] of [['opened', counts.opened, '+'], ['closed', counts.closed, '−']] as const) {
    if (!count) continue;
    // round up to whole steps so every change stays visible and keep one step for closed tabs
    const reserved = kind === 'opened' && counts.closed ? 1 : 0;
    const steps = Math.min(free - reserved, Math.max(1, Math.ceil(count * CHANGE_BAR_STEPS / total)));
    free -= steps;
    const part = el('span', `change-part change-part-${kind}`);
    part.style.width = `${steps * CHANGE_BAR_STEP_PX}px`;
    bar.append(part);
    text.append(el('span', `change-count-${kind}`, `${sign}${count}`));
  }
  strip.append(bar, text);
  setTooltip(strip, `${plural(counts.opened, 'tab')} opened and ${plural(counts.closed, 'tab')} closed compared to ${previousBackup(item)}`, { boldNumbers: true });
  return strip;
}

function updateSummary(summary: Summary): void
{
  for (const panel of panels) {
    panel.items = panel.items.map(value => value.id === summary.id ? summary : value);
    panel.sessionRows.get(summary.id)?.update(summary);
  }
}

function nameSession(item: Summary, trigger: HTMLButtonElement, action: 'rename' | 'keep'): void
{
  const events = new AbortController();
  const dialog = el('dialog', 'restore-dialog');
  const title = el('h2', '', action === 'rename' ? 'Rename this session' : 'Keep this session');
  title.id = 'rename-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const form = el('form');
  const label = el('label', 'setting-name', 'Name');
  label.htmlFor = 'session-name';
  const input = el('input', 'session-name-input');
  input.id = label.htmlFor;
  input.type = 'text';
  input.maxLength = SESSION_NAME_LIMIT;
  input.value = item.name ?? '';
  input.placeholder = 'Unnamed session';
  const heading = el('div', 'dialog-heading');
  heading.append(title);
  // place naming actions in the shared dialog action row
  const actions = el('div', 'dialog-actions');
  const cancel = button('Cancel', icons.X);
  const save = button(action === 'rename' ? 'Save' : 'Keep', action === 'rename' ? icons.Pencil : icons.Bookmark, 'button primary');
  save.type = 'submit';
  actions.append(cancel, save);
  // show which automatic backup is being kept
  if (action === 'keep') form.append(sessionCard(item));
  form.append(label, input);
  // offer tags only for manual backups
  const manual = action === 'keep' || item.savedAt !== undefined;
  // preview created and removed tags in the session row while the dialog is open
  const editor = createTagEditor(item.tags ?? [], tags => updateSummary({ ...item, tags }));
  if (manual) {
    const tagsLabel = el('label', 'setting-name session-detail', 'Tags');
    tagsLabel.htmlFor = editor.input.id = 'session-tags';
    form.append(tagsLabel, editor.element);
  }
  if (action === 'keep') {
    input.setAttribute('aria-describedby', 'session-name-description');
    heading.append(createHelp('session-name-description', 'About keeping this session', 'Turn this automatic backup into a manual backup, so it remains saved until you delete it. Give it a name, or leave it blank to use ‘Unnamed session’.', events.signal));
  }
  const feedback = el('div');
  feedback.setAttribute('aria-live', 'polite');
  form.append(feedback, actions);
  dialog.append(action === 'keep' ? heading : title, form);
  const controls = [input, cancel, save];
  let saving = false;
  let saved = false;
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    // discard the tag preview unless the session was saved
    if (manual && !saved) updateSummary(item);
    events.abort();
    sessionDialogLock.release();
    dialog.remove();
    updateDialogButtons();
    if (trigger.isConnected) trigger.focus();
    else backup.element.focus();
  }, { once: true });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    for (const control of controls) control.disabled = true;
    editor.setDisabled(true);
    feedback.replaceChildren();
    void (async () => {
      try {
        const data = await request({ kind: action, id: item.id, name: input.value, ...(manual ? { details: { tags: editor.tags() } } : {}) });
        if (data.kind !== 'renamed') throw new Error('Unexpected session response.');
        updateSummary(data.summary);
        saved = true;
        dialog.close();
        if (action === 'keep') await searchHistory('').catch(showError);
        await refresh('overview');
        if (action === 'rename') toast.show('Session renamed');
      } catch (error) { feedback.replaceChildren(notice(errorMessage(error))); }
      finally { saving = false; for (const control of controls) control.disabled = false; editor.setDisabled(false); }
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

async function downloadArchive(format: ExportFormat, id: string | undefined, signal: AbortSignal, progress: (count: number) => void): Promise<void>
{
  const details = EXPORT_FORMATS.find(item => item.format === format);
  if (!details) throw new Error('Unknown export format.');
  const file = await exportArchiveFile(archiveRepository, format, id, signal, progress);
  signal.throwIfAborted();
  // download through the page without requiring browser download permissions
  const url = URL.createObjectURL(file);
  const link = el('a');
  link.href = url;
  link.download = `tabblackbox-${id === undefined ? 'sessions' : 'session'}-${new Date().toISOString().slice(0, 10)}.${details.extension}`;
  root.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function savedRange(): Promise<{ count: number; oldest: number; newest: number } | null>
{
  // read the oldest and newest saved sessions through the history request
  const [first, last] = await Promise.all((['date-asc', 'date-desc'] as const).map(sort => request({ kind: 'history', before: null, collection: 'saved', sort })));
  if (first?.kind !== 'history' || last?.kind !== 'history') throw new Error('Unexpected history response.');
  const oldest = first.items[0];
  const newest = last.items[0];
  return oldest && newest ? { count: first.count, oldest: oldest.capturedAt, newest: newest.capturedAt } : null;
}

// identify a session inside a dialog
function sessionCard(item: Pick<Summary, 'name' | 'number' | 'capturedAt' | 'windowCount' | 'tabCount'>): HTMLElement
{
  const card = el('div', 'session-card');
  const name = el('div', 'session-card-name');
  name.append(el('strong', 'session-card-title', item.name ?? 'Unnamed session'), el('span', 'muted', `#${item.number}`));
  const details = el('div', 'muted');
  details.append(timestamp(item.capturedAt), document.createTextNode(` · ${plural(item.windowCount, 'window')} · ${plural(item.tabCount, 'tab')}`));
  card.append(name, details);
  return card;
}

function savedSessionsCard(): HTMLElement
{
  const card = el('div', 'session-card');
  const name = el('div', 'session-card-name');
  const count = el('span', 'muted');
  name.append(el('strong', 'session-card-title', 'All saved sessions'), count);
  const details = el('div', 'muted');
  card.append(name, details);
  // fill in the count and capture range once loaded
  void savedRange().then(range => {
    if (!range) return;
    count.textContent = plural(range.count, 'session');
    details.append(timestamp(range.oldest));
    if (range.newest !== range.oldest) details.append(document.createTextNode(' to '), timestamp(range.newest));
  }).catch(() => { /* the card keeps its name when the range is unavailable */ });
  return card;
}

function exportSessions(trigger: HTMLButtonElement, item?: Summary): void
{
  if (!sessionDialogLock.acquire()) return;
  const dialog = el('dialog', 'restore-dialog');
  const title = el('h2', '', item ? 'Export session' : 'Export sessions');
  title.id = 'export-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const form = el('form');
  form.append(item ? sessionCard(item) : savedSessionsCard());
  const formatLabel = el('label', 'setting-name export-format-label', 'Format');
  formatLabel.htmlFor = 'export-format';
  const formatSelect = el('select', 'settings-select');
  formatSelect.id = formatLabel.htmlFor;
  for (const { format, label: formatName } of EXPORT_FORMATS) {
    const option = el('option', '', formatName);
    option.value = format;
    formatSelect.append(option);
  }
  const formatControl = el('div', 'settings-select-control export-format');
  const hint = el('span', 'muted export-hint');
  hint.id = 'export-format-hint';
  // show the description inside the menu button, beside the chosen format
  formatControl.append(formatSelect, hint, icon(icons.ChevronDown));
  formatSelect.setAttribute('aria-describedby', hint.id);
  let selected: ExportFormat = 'json';
  function selectFormat(): void
  {
    // describe the chosen format beside it
    const current = EXPORT_FORMATS.find(item => item.format === formatSelect.value);
    if (!current) return;
    selected = current.format;
    hint.textContent = current.hint;
  }
  formatSelect.addEventListener('change', selectFormat);
  selectFormat();
  const actions = el('div', 'dialog-actions');
  const cancel = button('Cancel', icons.X);
  const save = button('Export', icons.Download, 'button primary');
  save.type = 'submit';
  actions.append(cancel, save);
  const feedback = el('div');
  feedback.setAttribute('aria-live', 'polite');
  form.append(formatLabel, formatControl, feedback, actions);
  dialog.append(title, form);
  const controls = [formatSelect, save];
  let exporting = false;
  cancel.addEventListener('click', () => { if (exporting) archiveOperation?.abort(); else dialog.close(); });
  dialog.addEventListener('cancel', event => { if (exporting) { event.preventDefault(); archiveOperation?.abort(); } });
  dialog.addEventListener('close', () => {
    sessionDialogLock.release();
    dialog.remove();
    updateDialogButtons();
    if (trigger.isConnected) trigger.focus();
    else backup.element.focus();
  }, { once: true });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (exporting) return;
    exporting = true;
    const operation = new AbortController();
    archiveOperation = operation;
    for (const control of controls) control.disabled = true;
    feedback.textContent = 'Preparing export…';
    void (async () => {
      try {
        await downloadArchive(selected, item?.id, operation.signal, count => { feedback.textContent = `Preparing ${plural(count, 'session')}…`; });
        dialog.close();
      } catch (error) {
        if (operation.signal.aborted) dialog.close();
        else feedback.replaceChildren(notice(errorMessage(error)));
      } finally { archiveOperation = null; exporting = false; for (const control of controls) control.disabled = false; }
    })();
  });
  try {
    updateDialogButtons();
    root.append(dialog);
    dialog.showModal();
    formatSelect.focus();
  } catch (error) {
    dialog.remove();
    sessionDialogLock.release();
    updateDialogButtons();
    showError(error);
  }
}

function deleteSession(item: Summary, trigger: HTMLButtonElement): void
{
  if (restoring || backingUp || !sessionDialogLock.acquire()) return;
  const dialog = el('dialog', 'restore-dialog');
  const saved = item.savedAt !== undefined;
  const title = el('h2', '', saved ? 'Delete saved session?' : 'Delete automatic backup?');
  title.id = 'delete-session-title';
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.append(title, sessionCard(item), el('p', '', `“${item.name ?? 'Unnamed session'}” will be permanently deleted. Export a copy first if you want to keep it.`));
  const actions = el('div', 'dialog-actions');
  const cancel = button('Cancel', icons.X);
  const remove = button('Delete', icons.Trash2, 'button danger');
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
        await request({ kind: 'delete-session', id: item.id });
        await refresh('overview');
        dialog.close();
        toast.show(saved ? 'Saved session deleted' : 'Automatic backup deleted');
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

function tagChip(tag: string, words: readonly string[]): HTMLButtonElement
{
  const chip = el('button', 'tag-chip');
  chip.type = 'button';
  markMatches(chip, tag, words);
  setTooltip(chip, 'Search saved sessions for this tag');
  // filter by this exact tag without toggling the session row even when tags were excluded from the search
  chip.addEventListener('click', event => {
    event.preventDefault();
    searchFields.include('tags');
    void searchHistory(tag, tag).catch(showError);
  });
  return chip;
}

function row(item: Summary, highlight: () => SearchHighlight<SearchField> | null)
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
  const tags = el('div', 'backup-tags');
  const countRow = el('div', 'backup-counts');
  let renderedName = '';
  let renderedTags = '';
  let renderedChanges: string | null = null;
  let strip: HTMLElement | null = null;
  let snapshot: Snapshot | undefined;
  let rendered = false;
  let previewVersion = 0;
  // remember the chosen preview view while the row stays on the page
  let view: PreviewView = 'tabs';
  let shown: ReturnType<typeof preview> | undefined;
  function update(value: Summary): void
  {
    item = value;
    // update labels while keeping timestamps and row structure in place
    // mark the words of the loaded session search in the searched name and tags
    const search = highlight();
    const nameWords = search?.fields.includes('name') ? search.words : [];
    const tagWords = search?.fields.includes('tags') ? search.words : [];
    const name = item.name ?? 'Unnamed session';
    const nameKey = JSON.stringify([name, nameWords]);
    if (renderedName !== nameKey) {
      renderedName = nameKey;
      markMatches(title, name, nameWords);
    }
    const sessionNumber = `#${item.number}`;
    if (number.textContent !== sessionNumber) number.textContent = sessionNumber;
    rename.setAttribute('aria-label', `Rename session ${sessionNumber}`);
    // rebuild tags only when they change
    const sessionTags = item.tags ?? [];
    const tagKey = JSON.stringify([sessionTags, tagWords]);
    if (renderedTags !== tagKey) {
      renderedTags = tagKey;
      tags.replaceChildren(...sessionTags.map(tag => tagChip(tag, tagWords)));
    }
    tags.hidden = !sessionTags.length;
    // follow comparisons that changed after captures, keeps, imports, or deletions
    const changes = JSON.stringify([item.changeCounts ?? null, item.savedAt === undefined]);
    if (renderedChanges === changes) return;
    const outdated = renderedChanges !== null;
    renderedChanges = changes;
    strip?.remove();
    strip = item.changeCounts ? changeStrip(item.changeCounts, item) : null;
    // open the session on its changes and switch an expanded preview between changes and tabs
    strip?.addEventListener('click', event => {
      event.preventDefault();
      view = details.open && view === 'changes' ? 'tabs' : 'changes';
      shown?.show(view);
      details.open = true;
    });
    if (strip) countRow.append(strip);
    if (outdated) resetPreview();
  }
  nameRow.append(title);
  countRow.append(counts);
  label.append(nameRow, countRow);
  summary.append(icon(icons.ChevronDown), number, label, date);
  details.append(summary);
  // show session actions as icons with short accessible names and descriptive shared tooltips
  const restore = button('', icons.RotateCcw, 'button small icon-button invisible');
  restore.setAttribute('aria-label', 'Restore');
  setTooltip(restore, 'Restore session in new windows');
  restore.disabled = sessionDialogLock.active || !canRestore({ tabCount: item.tabCount, backingUp, restoring });
  restoreButtons.set(restore, item.tabCount);
  const actions = el('div', 'backup-actions');
  const rename = button('', icons.Pencil, 'session-rename');
  rename.disabled = sessionDialogLock.active;
  setTooltip(rename, 'Rename this session');
  update(item);
  rename.addEventListener('click', event => { event.preventDefault(); nameSession(item, rename, 'rename'); });
  // offer keeping next to renaming because both open the naming dialog
  const keep = button('', icons.Bookmark, 'session-keep');
  keep.setAttribute('aria-label', 'Keep session');
  setTooltip(keep, 'Keep as a manual backup');
  keep.hidden = item.savedAt !== undefined;
  keep.addEventListener('click', event => { event.preventDefault(); nameSession(item, keep, 'keep'); });
  nameRow.append(rename, keep, tags);
  const exportSession = button('', icons.Download, 'button small icon-button invisible');
  exportSession.setAttribute('aria-label', 'Export session');
  setTooltip(exportSession, 'Export session to a file');
  exportSession.addEventListener('click', () => exportSessions(exportSession, item));
  const remove = button('', icons.Trash2, 'button small icon-button invisible danger');
  remove.setAttribute('aria-label', 'Delete session');
  setTooltip(remove, item.savedAt === undefined ? 'Delete this automatic backup' : 'Delete this saved session');
  remove.addEventListener('click', () => deleteSession(item, remove));
  actions.append(exportSession, remove, restore);
  wrapper.append(details, actions);
  async function load(): Promise<Snapshot>
  {
    if (snapshot) return snapshot;
    const version = previewVersion;
    const data = await request({ kind: 'snapshot', id: item.id });
    if (data.kind !== 'snapshot') throw new Error('Unexpected backup response.');
    // cache only responses requested after the latest comparison change
    if (version === previewVersion) snapshot = data.snapshot;
    return data.snapshot;
  }
  function showPreview(): void
  {
    if (!details.open || rendered) return;
    rendered = true;
    const version = previewVersion;
    void load().then(value => {
      if (!details.isConnected || version !== previewVersion) return;
      shown = preview(value, view, next => { view = next; });
      details.append(shown.element);
    }, (error: unknown) => {
      if (version !== previewVersion) return;
      rendered = false;
      details.append(notice(errorMessage(error)));
    });
  }
  function resetPreview(): void
  {
    // reload the session so an open preview shows the new comparison
    previewVersion++;
    snapshot = undefined;
    shown = undefined;
    rendered = false;
    for (const content of details.querySelectorAll('.snapshot-preview')) {
      for (const button of content.querySelectorAll<HTMLButtonElement>('.window-restore')) restoreButtons.delete(button);
      content.remove();
    }
    showPreview();
  }
  details.addEventListener('toggle', showPreview);
  restore.addEventListener('click', () =>
  {
    void confirmRestore(load, restore).catch((error: unknown) => feedback.replaceChildren(notice(errorMessage(error))));
  });
  return { element: wrapper, details, restore, rename, keep, remove, update };
}

function renderHistory(panel: ReturnType<typeof historyPanel>): void
{
  const { items, rows, sessionRows } = panel;
  panel.rows.inert = false;
  const sortStatus = historySortFeedback(panel);
  sortStatus.hidden = true;
  sortStatus.replaceChildren();
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
      saved = row(item, () => panel.loadedSearch);
      sessionRows.set(item.id, saved);
    } else saved.update(item);
    if (saved.element === next) next = next.nextElementSibling;
    else rows.insertBefore(saved.element, next);
  }
  if (!items.length) {
    const empty = el('div', 'empty-state');
    const title = panel.loadedTabUrl ? 'No backups contain this tab' : panel.loadedRange ? 'No matching backups on this date' : panel.query ? 'No matching saved sessions' : panel.collection === 'saved' ? 'Keep sessions for later' : 'Your backup history starts here';
    const description = panel.loadedTabUrl ? 'Clear the tab filter to see all backups.' : panel.loadedRange ? 'Choose another day or clear the date filter.' : panel.query ? 'Try another session name.' : panel.collection === 'saved' ? 'Choose Back up now or select the bookmark icon on an automatic backup below.' : 'Open some tabs and enable automatic backups in Settings. Changes will be saved according to your automatic backup settings.';
    empty.append(icon(icons.Archive, 32), el('h2', '', title), el('p', 'muted', description));
    rows.append(empty);
  }
}

function updateHistoryPagination(panel: ReturnType<typeof historyPanel>, hasMore: boolean): void
{
  const { more, fewer, pagination, items } = panel;
  const active = document.activeElement;
  more.disabled = false;
  fewer.disabled = false;
  more.hidden = !hasMore;
  fewer.hidden = items.length <= HISTORY_INITIAL_LIMIT;
  pagination.hidden = more.hidden && fewer.hidden;
  // keep keyboard focus on the remaining control when a page boundary hides one
  if (active === more && more.hidden && !fewer.hidden) fewer.focus();
  else if (active === fewer && fewer.hidden && !more.hidden) more.focus();
}

async function loadHistory(panel: ReturnType<typeof historyPanel>, reset: boolean, preserveLoaded = false): Promise<void>
{
  const { items, more, sessionRows, sort, query, tag } = panel;
  const range = historyRange;
  const tabUrl = historyTabUrl;
  const rangeChanged = range?.start !== panel.loadedRange?.start || range?.end !== panel.loadedRange?.end || tabUrl !== panel.loadedTabUrl;
  const dateFilter = { ...(range ? { range } : {}), ...(tabUrl === null ? {} : { tabUrl }) };
  const sortChanged = sort !== panel.loadedSort;
  const rememberSort = panel.rememberSort;
  const externalSort = sortChanged && !rememberSort;
  const generation = reset ? ++panel.generation : panel.generation;
  const last = reset ? undefined : items.at(-1);
  const focused = document.activeElement === more ? more : document.activeElement === panel.fewer ? panel.fewer : null;
  more.disabled = true;
  panel.fewer.disabled = true;
  // retain the list height while preventing interaction with a different day's rows
  panel.rows.inert = rangeChanged;
  panel.dateFeedback.hidden = !rangeChanged;
  if (rangeChanged) panel.dateFeedback.replaceChildren(el('p', 'muted', 'Loading backups…'));
  try {
    const fields = searchFields.fields();
    const data = await request({ kind: 'history', before: last ? { capturedAt: last.capturedAt, number: last.number, id: last.id } : null, collection: panel.collection, query, fields, ...(tag === null ? {} : { tag }), sort, ...dateFilter });
    if (generation !== panel.generation) return;
    if (data.kind !== 'history') throw new Error('Unexpected history response.');
    panel.count.textContent = String(data.count);
    const mb = data.bytes / MB;
    panel.usage.textContent = `${mb > 0 && mb < 0.01 ? '<0.01' : formatNumber(mb, 2)} MB`;
    if (panel === savedPanel) exportAll.disabled = data.count === 0;
    let page = data.items;
    let pageLimit = last ? HISTORY_PAGE_LIMIT : HISTORY_INITIAL_LIMIT;
    const loaded = [...page];
    // retain loaded rows during renames and expanded sessions during new backups
    while (reset && !sortChanged && !rangeChanged && page.length === pageLimit) {
      const lastVisible = preserveLoaded ? items.at(-1) : items.findLast(item => sessionRows.get(item.id)?.details.open);
      const end = loaded.at(-1);
      if (!lastVisible || !end || compareHistory(end, lastVisible, sort) >= 0) break;
      const older = await request({ kind: 'history', before: { capturedAt: end.capturedAt, number: end.number, id: end.id }, collection: panel.collection, query, fields, ...(tag === null ? {} : { tag }), sort, ...dateFilter });
      if (generation !== panel.generation) return;
      if (older.kind !== 'history') throw new Error('Unexpected history response.');
      page = older.items;
      pageLimit = HISTORY_PAGE_LIMIT;
      loaded.push(...page);
    }
    if (reset) panel.items = loaded;
    else panel.items.push(...loaded);
    panel.loadedRange = range;
    panel.loadedTabUrl = tabUrl;
    // split the query into words like the stored session search
    panel.loadedSearch = { words: query.toLocaleLowerCase().split(/\s+/).filter(word => word.length > 0), fields };
    panel.dateFeedback.hidden = true;
    renderHistory(panel);
    updateDialogButtons();
    updateHistoryPagination(panel, page.length === pageLimit);
    panel.loadedSort = sort;
    if (externalSort) panel.updateSort(sort);
    // remember successful user selections without republishing another page's choice
    if (panel.rememberSort) {
      panel.rememberSort = false;
      try { localStorage.setItem(`tabblackbox.history-sort.${panel.collection}`, sort); }
      catch (error) { showError(error); }
    }
  } catch (error) {
    if (generation === panel.generation) {
      if (rangeChanged) {
        const retry = button('Retry loading backups', icons.RotateCcw);
        retry.addEventListener('click', () => { void loadHistory(panel, true).catch(showError); });
        panel.dateFeedback.replaceChildren(notice(errorMessage(error)), retry);
      }
      // keep the visible rows and their pagination boundary in the same order
      panel.rememberSort = false;
      if (sortChanged && rememberSort) {
        panel.sort = panel.loadedSort;
        panel.updateSort(panel.sort);
      }
      if (externalSort) {
        // retain the displayed order while allowing the external preference to be retried
        const status = historySortFeedback(panel);
        const retry = button('Retry loading backups', icons.RotateCcw);
        retry.addEventListener('click', () => { void sortHistory(panel, panel.sort, false).catch(showError); });
        status.hidden = false;
        status.replaceChildren(notice(errorMessage(error)), retry);
      }
      throw error;
    }
  } finally {
    if (generation === panel.generation) {
      more.disabled = panel.sort !== panel.loadedSort || panel.loadedRange?.start !== historyRange?.start || panel.loadedRange?.end !== historyRange?.end || panel.loadedTabUrl !== historyTabUrl;
      panel.fewer.disabled = more.disabled;
      // restore pagination focus after loading unless the user focused another control
      if (focused && document.activeElement === document.body) {
        const target = focused.hidden ? more.hidden ? panel.fewer : more : focused;
        if (!target.hidden && !target.disabled) target.focus();
      }
    }
  }
}

function resetHistoryFilters(): void
{
  search.value = savedPanel.query = '';
  savedPanel.tag = null;
  historyRange = null;
  calendar.clear();
  historyTabUrl = null;
  tabFilter.hidden = true;
  // discard pending filtered results and reload both panels through the next overview
  historyInvalidated = true;
  for (const panel of panels) {
    panel.generation++;
    panel.more.disabled = true;
    panel.fewer.disabled = true;
  }
}

function searchHistory(query: string, tag: string | null = null): Promise<void>
{
  search.value = savedPanel.query = query;
  // filter by an exact tag until the search text changes
  savedPanel.tag = tag;
  // invalidate pending results and reload independently of overview polling
  return loadHistory(savedPanel, true);
}

function sortHistory(panel: ReturnType<typeof historyPanel>, sort: HistorySort, remember = true): Promise<void>
{
  panel.sort = sort;
  panel.rememberSort = remember;
  // external preferences update the sort indication together with their loaded rows
  panel.updateSort(remember ? sort : panel.loadedSort);
  const status = historySortFeedback(panel);
  status.hidden = true;
  status.replaceChildren();
  return loadHistory(panel, true);
}

function updateSave(): void
{
  backup.update(backingUp, restoring);
}

function updateDialogButtons(): void
{
  restoreResult.element.disabled = sessionDialogLock.active;
  for (const [button, tabCount] of restoreButtons) button.disabled = sessionDialogLock.active || !canRestore({ tabCount, backingUp, restoring });
  for (const panel of panels) for (const [id, saved] of panel.sessionRows) {
    saved.rename.disabled = sessionDialogLock.active;
    saved.keep.disabled = sessionDialogLock.active || backingUp || restoring;
    // show deletion as unavailable for the protected newest automatic backup
    saved.remove.disabled = saved.keep.disabled || (panel.collection === 'automatic' && id === newestId);
  }
}

function applyOverview(overview: Overview, pendingRequest: object | null): void
{
  newestId = overview.automaticStorage.newestId;
  settings.update(overview);
  statistics.update(overview);
  statusCard.update(overview);
  renderOperation(overview.metadata.operation, overview.status, pendingRequest);
  restoring = restoreResult.starting || overview.status.kind === 'restoring';
  updateSave();
  updateDialogButtons();
}

const refresh = createRefreshQueue(async kind =>
{
  if (kind === 'backup') { feedback.replaceChildren(); toast.clear(); }
  try {
    const pendingRequest = restoreResult.pendingRequest;
    const data = await request({ kind });
    if (data.kind !== 'overview') throw new Error('Unexpected background response.');
    if (kind === 'backup' && data.captureResult?.kind === 'saved') resetHistoryFilters();
    await updateFileAccess();
    applyOverview(data.overview, pendingRequest);
    void calendar.update(data.overview.metadata);
    void tabChart.update(data.overview.metadata);
    void topSites.update(data.overview.metadata);
    if (historyInvalidated || latestId !== data.overview.metadata.latestId || historyCount !== data.overview.metadata.count || historyRevision !== data.overview.metadata.historyRevision || panels.some(panel => !panel.rows.childElementCount)) {
      historyInvalidated = false;
      try {
        await Promise.all(panels.map(panel => loadHistory(panel, true, historyRevision !== null && historyRevision !== data.overview.metadata.historyRevision)));
      } catch (error) { historyInvalidated = true; throw error; }
      latestId = data.overview.metadata.latestId;
      historyCount = data.overview.metadata.count;
      historyRevision = data.overview.metadata.historyRevision;
      feedback.replaceChildren();
      // keep visible tab search results in line with the reloaded history
      void tabSearch.refresh();
    }
    if (kind === 'backup') {
      backup.finish(data.captureResult);
    }
  } catch (error) {
    feedback.replaceChildren(notice(errorMessage(error)));
    settings.showError(errorMessage(error));
  }
}, value => { backingUp = value; updateSave(); updateDialogButtons(); });
for (const panel of panels) {
  panel.more.addEventListener('click', () => { void loadHistory(panel, false).catch(showError); });
  panel.fewer.addEventListener('click', () => {
    if (panel.fewer.disabled) return;
    // collapse only the displayed rows and keep their loaded filters and order
    panel.generation++;
    panel.items = panel.items.slice(0, Math.max(HISTORY_INITIAL_LIMIT, panel.items.length - HISTORY_PAGE_LIMIT));
    renderHistory(panel);
    updateDialogButtons();
    updateHistoryPagination(panel, true);
  });
  for (const { property, element } of panel.sortButtons) element.addEventListener('click', () => {
    const current = panel.rememberSort ? panel.sort : panel.loadedSort;
    const sort: HistorySort = property === 'date'
      ? current === 'date-desc' ? 'date-asc' : 'date-desc'
      : current === 'number-desc' ? 'number-asc' : 'number-desc';
    void sortHistory(panel, sort).catch(showError);
  });
}
window.addEventListener('storage', event => {
  for (const panel of panels) {
    if (event.key !== null && event.key !== `tabblackbox.history-sort.${panel.collection}`) continue;
    const sort = readHistorySort(panel.collection);
    if (sort !== panel.sort) void sortHistory(panel, sort, false).catch(showError);
  }
});
search.addEventListener('input', () => {
  void searchHistory(search.value).catch(showError);
});
exportAll.addEventListener('click', () => exportSessions(exportAll));
const importFile = el('input');
importFile.type = 'file';
importFile.accept = '.json,application/json';
importFile.hidden = true;
root.append(importFile);
importSessions.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', () => {
  const file = importFile.files?.[0];
  if (!file) return;
  if (!sessionDialogLock.acquire()) { importFile.value = ''; return; }
  const operation = new AbortController();
  archiveOperation = operation;
  const dialog = el('dialog', 'restore-dialog');
  const title = el('h2', '', 'Import sessions');
  title.id = 'import-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const progress = el('p', '', 'Reading archive…');
  progress.setAttribute('aria-live', 'polite');
  const cancel = button('Cancel', icons.X);
  const actions = el('div', 'dialog-actions');
  actions.append(cancel);
  dialog.append(title, progress, actions);
  cancel.addEventListener('click', () => operation.abort());
  dialog.addEventListener('cancel', event => { event.preventDefault(); operation.abort(); });
  importSessions.disabled = true;
  updateDialogButtons();
  feedback.replaceChildren();
  void (async () => {
    try {
      root.append(dialog);
      dialog.showModal();
      const sessions = readArchiveFile(file, operation.signal, bytes => { progress.textContent = `Reading archive… ${Math.floor(bytes / Math.max(file.size, 1) * 100)}%`; });
      const count = await archiveRepository.importSaved(sessions, Date.now(), operation.signal, count => { progress.textContent = `Importing ${plural(count, 'session')}…`; });
      archiveOperation = null;
      dialog.close();
      resetHistoryFilters();
      await refresh('overview');
      toast.show(`${plural(count, 'session')} imported`);
    } catch (error) { if (!operation.signal.aborted) showError(error); }
    finally {
      archiveOperation = null;
      dialog.close();
      dialog.remove();
      sessionDialogLock.release();
      updateDialogButtons();
      importSessions.disabled = false;
      importFile.value = '';
      importSessions.focus();
    }
  })();
});
void refresh('refresh');
setInterval(() => { if (!document.hidden) void refresh('overview'); }, 1500);
