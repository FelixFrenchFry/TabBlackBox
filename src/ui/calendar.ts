import { CALENDAR_LEVELS, calendarRange, calendarScale, dayRange } from '../calendar';
import { errorMessage, type BackupDay, type HistoryRange, type Metadata } from '../model';
import { createHelp } from './help';
import { positionPopover } from './popover';
import { button, el, icon, icons, request } from './shared';

export function createBackupCalendar(onSelect: (range: HistoryRange | null) => void)
{
  const element = el('section', 'backup-calendar');
  element.setAttribute('aria-label', 'Backup calendar');
  const details = el('details', 'calendar-details');
  // restore whether the calendar was collapsed
  try { details.open = localStorage.getItem('tabblackbox.calendar-open') !== 'false'; }
  catch { details.open = true; }
  const heading = el('summary', 'calendar-heading', 'Backup calendar');
  heading.prepend(icon(icons.ChevronDown));
  const content = el('div', 'calendar-content');
  const toolbar = el('div', 'calendar-toolbar');
  const period = el('span');
  const periodLabel = el('div', 'calendar-period');
  const loading = el('span', 'calendar-loading');
  loading.setAttribute('role', 'status');
  loading.setAttribute('aria-label', 'Loading calendar…');
  loading.title = 'Loading calendar…';
  const spinner = icon(icons.LoaderCircle);
  spinner.classList.add('save-spinner');
  loading.append(spinner);
  periodLabel.append(period, createHelp('calendar-help', 'About the backup calendar', 'Browse backups by capture date. Darker colors indicate more backups, with details available when you hover over a day. Select a day to apply a filter to the backup lists.'), loading);
  const previous = button('Prev', icons.ArrowUp, 'button small calendar-previous');
  const next = button('Next', icons.ArrowUp, 'button small calendar-next');
  const message = el('div', 'calendar-message');
  message.setAttribute('role', 'status');
  const scroll = el('div', 'calendar-scroll');
  const grid = el('div', 'calendar-grid');
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'Backup days');
  scroll.append(grid);
  const tooltip = el('div', 'panel-help-popover calendar-day-tooltip');
  tooltip.id = 'calendar-day-tooltip';
  tooltip.popover = 'auto';
  tooltip.setAttribute('role', 'tooltip');
  const legend = el('div', 'calendar-legend muted');
  legend.setAttribute('aria-label', 'Backup counts relative to the displayed period');
  legend.append(el('span', '', 'Less'));
  const swatches: HTMLSpanElement[] = [];
  for (let level = 0; level <= CALENDAR_LEVELS; level++) {
    const swatch = el('span', 'calendar-swatch');
    swatch.dataset.level = String(level);
    swatch.tabIndex = 0;
    swatch.setAttribute('role', 'img');
    swatch.setAttribute('aria-label', 'Loading backup count scale');
    swatches.push(swatch);
    legend.append(swatch);
  }
  legend.append(el('span', '', 'More'));
  toolbar.append(periodLabel, legend, previous, next);
  content.append(toolbar, message, scroll);
  details.append(heading, content);
  const filter = el('div', 'calendar-filter');
  filter.hidden = true;
  const selectedDate = el('span');
  const clear = button('Clear date filter', icons.RotateCcw, 'button small');
  filter.append(selectedDate, clear);
  element.append(details, filter, tooltip);

  let offset = 0;
  let monthCount = 1;
  let selected: HistoryRange | null = null;
  let metadata: Metadata | undefined;
  let loadedKey = '';
  let pendingKey = '';
  let generation = 0;
  let displayedRange = '';
  const cells = new Map<number, HTMLButtonElement>();
  let counts = new Map<number, BackupDay>();
  const format = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  let tooltipTarget: HTMLButtonElement | null = null;
  let tooltipTimer: ReturnType<typeof setTimeout> | undefined;

  function closeTooltip(): void
  {
    clearTimeout(tooltipTimer);
    tooltipTarget = null;
    if (tooltip.matches(':popover-open')) tooltip.hidePopover();
  }

  function updateTooltip(): void
  {
    if (!tooltipTarget) return;
    const start = Number(tooltipTarget.dataset.start);
    const day = counts.get(start);
    const details = el('div');
    if (tooltipTarget.disabled) details.textContent = 'Future date';
    else if (!day || day.saved + day.automatic === 0) details.textContent = 'No stored backups';
    else details.append(el('strong', '', String(day.automatic)), ' automatic · ', el('strong', '', String(day.saved)), ' manual');
    tooltip.replaceChildren(el('div', '', format.format(start)), details);
    positionPopover(tooltip, tooltipTarget);
  }

  function showTooltip(cell: HTMLButtonElement): void
  {
    clearTimeout(tooltipTimer);
    if (!cell.isConnected || !cell.getClientRects().length) return;
    tooltipTarget = cell;
    if (!tooltip.matches(':popover-open')) tooltip.showPopover();
    updateTooltip();
  }

  function leaveTooltip(): void
  {
    // allow the pointer to cross the gap from a day to its tooltip
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => {
      if (!tooltipTarget?.matches(':focus-visible') && !tooltip.matches(':hover')) closeTooltip();
    }, 150);
  }

  tooltip.addEventListener('pointerenter', () => clearTimeout(tooltipTimer));
  tooltip.addEventListener('pointerleave', leaveTooltip);
  tooltip.addEventListener('beforetoggle', event => {
    if (event.newState === 'closed') { clearTimeout(tooltipTimer); tooltipTarget = null; }
  });
  // dismiss pending hover work as well as visible popovers when the calendar moves or closes
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeTooltip(); });
  window.addEventListener('resize', closeTooltip);
  window.addEventListener('scroll', closeTooltip, { capture: true });
  window.addEventListener('hashchange', closeTooltip);
  details.addEventListener('toggle', () => {
    if (!details.open) closeTooltip();
    try { localStorage.setItem('tabblackbox.calendar-open', String(details.open)); }
    catch { /* the calendar still opens and closes for this page */ }
  });

  function select(range: HistoryRange | null, notify = true): void
  {
    selected = range;
    filter.hidden = range === null;
    selectedDate.textContent = range ? `Showing backups from ${format.format(range.start)}` : '';
    for (const [start, cell] of cells) cell.setAttribute('aria-pressed', String(start === range?.start));
    if (notify) onSelect(range);
  }
  clear.addEventListener('click', () => select(null));

  function render(range: HistoryRange, days: BackupDay[]): void
  {
    const key = `${range.start}:${range.end}`;
    const today = dayRange(Date.now()).start;
    if (key !== displayedRange) {
      closeTooltip();
      displayedRange = key;
      cells.clear();
      grid.replaceChildren();
      const last = new Date(range.end - 1);
      const end = new Date(last.getFullYear(), last.getMonth() + 1, 1).getTime();
      let month = grid;
      let index = 0;
      for (let start = range.start; start < end; start = dayRange(start).end, index++) {
        const date = new Date(start);
        if (date.getDate() === 1) {
          index = (date.getDay() + 6) % 7;
          month = el('div', 'calendar-month-group');
          const name = date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
          month.setAttribute('role', 'group');
          month.setAttribute('aria-label', name);
          const label = el('span', 'calendar-month', name);
          label.setAttribute('aria-hidden', 'true');
          month.append(label);
          for (let weekday = 0; weekday < 7; weekday++) {
            const label = el('span', 'calendar-weekday muted', new Date(2024, 0, 1 + weekday).toLocaleDateString(undefined, { weekday: 'short' }));
            label.style.gridArea = `2 / ${weekday + 1}`;
            label.setAttribute('aria-hidden', 'true');
            month.append(label);
          }
          grid.append(month);
        }
        const cell = el('button', 'calendar-day', String(date.getDate()));
        cell.type = 'button';
        cell.dataset.start = String(start);
        cell.style.gridArea = `${Math.floor(index / 7) + 3} / ${index % 7 + 1}`;
        cell.disabled = start > today;
        if (start === today) cell.setAttribute('aria-current', 'date');
        cell.tabIndex = start === (selected?.start ?? dayRange(range.end - 1).start) ? 0 : -1;
        cell.addEventListener('click', () => {
          closeTooltip();
          select(selected?.start === start ? null : dayRange(start));
        });
        cell.addEventListener('pointerenter', event => {
          if (event.pointerType !== 'mouse') return;
          closeTooltip();
          tooltipTimer = setTimeout(() => showTooltip(cell), 250);
        });
        cell.addEventListener('pointerleave', leaveTooltip);
        cell.addEventListener('focus', () => {
          for (const item of cells.values()) item.tabIndex = item === cell ? 0 : -1;
          showTooltip(cell);
        });
        cell.addEventListener('blur', closeTooltip);
        cell.addEventListener('keydown', event => {
          const step = event.key === 'ArrowUp' ? -7 : event.key === 'ArrowDown' ? 7 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
          if (!step && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault();
          const target = new Date(start);
          target.setDate(target.getDate() + step);
          const time = event.key === 'Home' ? range.start : event.key === 'End' ? dayRange(range.end - 1).start : dayRange(target.getTime()).start;
          cells.get(time)?.focus();
        });
        cells.set(start, cell);
        month.append(cell);
      }
      if (![...cells.values()].some(cell => cell.tabIndex === 0)) cells.values().next().value?.setAttribute('tabindex', '0');
    }
    counts = new Map(days.map(day => [day.start, day]));
    const scale = calendarScale(days.map(day => day.saved + day.automatic));
    for (const [level, swatch] of swatches.entries()) {
      const band = scale.find(band => band.level === level);
      const label = level === 0 ? 'No stored backups' : band ? `${band.minimum === band.maximum ? band.minimum : `${band.minimum}–${band.maximum}`} backups` : 'Unused for this period';
      swatch.title = label;
      swatch.setAttribute('aria-label', label);
    }
    // update counts in place so background refreshes preserve focus and pending clicks
    for (const [start, cell] of cells) {
      const day = counts.get(start);
      const total = (day?.saved ?? 0) + (day?.automatic ?? 0);
      cell.dataset.level = String(total === 0 ? 0 : scale.find(band => total <= band.maximum)?.level ?? 0);
      const label = `${format.format(start)} · ${cell.disabled ? 'Future date' : total ? `${day?.automatic ?? 0} automatic · ${day?.saved ?? 0} manual` : 'No stored backups'}`;
      cell.setAttribute('aria-label', label);
      cell.setAttribute('aria-pressed', String(start === selected?.start));
    }
    updateTooltip();
  }

  async function update(value: Metadata): Promise<void>
  {
    metadata = value;
    const range = calendarRange(Date.now(), offset, monthCount);
    const key = `${range.start}:${range.end}:${value.historyRevision}:${value.count}:${value.latestId}`;
    if ((key === loadedKey && !pendingKey) || key === pendingKey) return;
    const current = ++generation;
    pendingKey = key;
    previous.disabled = calendarRange(Date.now(), offset - monthCount, monthCount).start < 0;
    next.disabled = offset === 0;
    if (displayedRange !== `${range.start}:${range.end}`) closeTooltip();
    message.replaceChildren();
    loading.classList.remove('active');
    grid.setAttribute('aria-busy', 'true');
    // retain the displayed period while loading and avoid flashing feedback for fast requests
    const loadingTimer = setTimeout(() => {
      if (current === generation) loading.classList.add('active');
    }, 250);
    try {
      const data = await request({ kind: 'calendar', range });
      if (current !== generation) return;
      if (data.kind !== 'calendar') throw new Error('Unexpected calendar response.');
      render(range, data.days);
      const months = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
      period.textContent = months.formatRange(range.start, range.end - 1);
      message.replaceChildren();
      loadedKey = key;
    } catch (error) {
      if (current !== generation) return;
      // allow retries after a failed request while preserving the displayed calendar
      loadedKey = '';
      const retry = button('Retry calendar', icons.RotateCcw, 'button small');
      retry.addEventListener('click', () => { if (metadata) void update(metadata); });
      message.replaceChildren(el('span', '', `Calendar could not be updated: ${errorMessage(error)}`), retry);
    } finally {
      clearTimeout(loadingTimer);
      if (current === generation) {
        pendingKey = '';
        loading.classList.remove('active');
        grid.setAttribute('aria-busy', 'false');
      }
    }
  }
  // fit complete months using the stylesheet dimensions and keep requests within one year
  const resize = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width;
    if (!width) return;
    const layout = getComputedStyle(grid);
    const padding = getComputedStyle(scroll);
    const available = width - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
    const gap = parseFloat(layout.columnGap);
    const minimum = parseFloat(layout.getPropertyValue('--calendar-month-width'));
    const count = Math.max(1, Math.min(12, Math.floor((available + gap) / (minimum + gap))));
    if (count === monthCount) return;
    monthCount = count;
    if (metadata) void update(metadata);
  });
  resize.observe(content);
  // page by the fitted month count and stop at the current month
  previous.addEventListener('click', () => { offset -= monthCount; if (metadata) void update(metadata); });
  next.addEventListener('click', () => { offset = Math.min(0, offset + monthCount); if (metadata) void update(metadata); });
  // let the caller reset other filters before reloading history
  return { element, update, clear: () => select(null, false) };
}
