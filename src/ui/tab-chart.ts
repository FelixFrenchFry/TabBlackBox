import { chartMaximum, parseTabChartPeriod, TAB_CHART_PERIODS, tabChartRange, type TabChartPeriod } from '../chart';
import { errorMessage, type HistoryRange, type Metadata, type TabCountPoint } from '../model';
import { createHelp } from './help';
import { positionPopover } from './popover';
import { button, el, icon, icons, request } from './shared';

const CHART_HEIGHT = 160;
const CHART_MARGIN = { top: 10, right: 12, bottom: 24, left: 44 };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K]
{
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function readTabChartPeriod(): TabChartPeriod
{
  try { return parseTabChartPeriod(localStorage.getItem('tabblackbox.tab-chart-period')); }
  catch { return 7; }
}

export function createTabChart()
{
  const element = el('section', 'tab-chart');
  element.setAttribute('aria-label', 'Active tab count chart');
  const details = el('details');
  details.open = true;
  const heading = el('summary', 'calendar-heading', 'Active tab count');
  heading.prepend(icon(icons.ChevronDown));
  const content = el('div', 'calendar-content');
  const toolbar = el('div', 'calendar-toolbar');
  const title = el('div', 'tab-chart-title');
  const period = el('span');
  title.append(period, createHelp('tab-chart-help', 'About the active tab count chart', 'Number of tabs in your automatic backups over the selected period. Manual backups are shown as dots. Hover over the chart for details.'));
  const legend = el('div', 'tab-chart-legend muted');
  legend.append(el('span', 'tab-chart-key automatic', 'Automatic'), el('span', 'tab-chart-key manual', 'Manual'));
  const periods = el('div', 'tab-chart-periods');
  periods.setAttribute('role', 'group');
  periods.setAttribute('aria-label', 'Chart period');
  const periodLabels: Record<TabChartPeriod, string> = { 1: '24 hours', 7: '7 days', 30: '30 days', 90: '90 days' };
  const periodButtons = TAB_CHART_PERIODS.map(days => {
    const control = el('button', 'tab-chart-period', periodLabels[days]);
    control.type = 'button';
    periods.append(control);
    return { days, control };
  });
  toolbar.append(title, legend, periods);
  const message = el('div', 'calendar-message');
  message.setAttribute('role', 'status');
  const plot = el('div', 'tab-chart-plot');
  plot.tabIndex = 0;
  plot.setAttribute('role', 'group');
  plot.setAttribute('aria-label', 'Tab counts. Use the arrow keys to view backup details.');
  const marker = el('span', 'tab-chart-marker');
  const empty = el('p', 'muted tab-chart-empty', 'No backups in this period');
  empty.hidden = true;
  plot.append(marker, empty);
  content.append(toolbar, message, plot);
  details.append(heading, content);
  const tooltip = el('div', 'panel-help-popover tab-chart-tooltip');
  tooltip.popover = 'manual';
  tooltip.setAttribute('role', 'tooltip');
  element.append(details, tooltip);

  let days = readTabChartPeriod();
  let metadata: Metadata | undefined;
  let loadedKey = '';
  let pendingKey = '';
  let generation = 0;
  let width = 0;
  let data: { range: HistoryRange; points: TabCountPoint[]; before: TabCountPoint | null } | undefined;
  let targets: { point: TabCountPoint; x: number; y: number }[] = [];
  let active = -1;
  let guide: SVGLineElement | undefined;
  let highlight: SVGCircleElement | undefined;
  const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const dateLabel = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const timeLabel = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

  function updatePeriod(): void
  {
    period.textContent = `Last ${periodLabels[days]}`;
    for (const { days: value, control } of periodButtons) control.setAttribute('aria-pressed', String(value === days));
  }
  updatePeriod();

  function hideTooltip(): void
  {
    active = -1;
    if (guide) guide.style.visibility = 'hidden';
    if (highlight) highlight.style.visibility = 'hidden';
    if (tooltip.matches(':popover-open')) tooltip.hidePopover();
  }

  function showTarget(index: number): void
  {
    const target = targets[index];
    if (!target || !guide || !highlight || !plot.getClientRects().length) return;
    active = index;
    const { point, x, y } = target;
    guide.setAttribute('x1', String(x));
    guide.setAttribute('x2', String(x));
    guide.style.visibility = 'visible';
    highlight.setAttribute('cx', String(x));
    highlight.setAttribute('cy', String(y));
    highlight.style.visibility = 'visible';
    marker.style.left = `${x}px`;
    marker.style.top = `${y}px`;
    const counts = el('div');
    counts.append(el('strong', '', String(point.tabCount)), point.tabCount === 1 ? ' tab · ' : ' tabs · ', el('strong', '', String(point.windowCount)), point.windowCount === 1 ? ' window' : ' windows');
    tooltip.replaceChildren(el('div', '', dateTime.format(point.capturedAt)), counts, el('div', '', `${point.collection === 'saved' ? 'Manual' : 'Automatic'} backup #${point.number}`));
    if (!tooltip.matches(':popover-open')) tooltip.showPopover();
    positionPopover(tooltip, marker);
  }

  function render(): void
  {
    if (!data || !width) return;
    const { range, points, before } = data;
    // keep the hovered or focused backup selected across periodic redraws
    const previous = tooltip.matches(':popover-open') ? targets[active]?.point.id : undefined;
    hideTooltip();
    plot.querySelector('svg')?.remove();
    targets = [];
    empty.hidden = points.length > 0 || before !== null;
    if (!empty.hidden) return;
    const right = width - CHART_MARGIN.right;
    const bottom = CHART_HEIGHT - CHART_MARGIN.bottom;
    const maximum = chartMaximum(Math.max(before?.tabCount ?? 0, ...points.map(point => point.tabCount)));
    const x = (time: number) => CHART_MARGIN.left + (time - range.start) / (range.end - range.start) * (right - CHART_MARGIN.left);
    const y = (count: number) => bottom - count / maximum * (bottom - CHART_MARGIN.top);
    const chart = svg('svg', { width, height: CHART_HEIGHT, viewBox: `0 0 ${width} ${CHART_HEIGHT}`, 'aria-hidden': 'true' });
    for (const value of [0, maximum / 2, maximum]) {
      const label = svg('text', { class: 'tab-chart-label', x: CHART_MARGIN.left - 8, y: y(value), 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      label.textContent = value.toLocaleString();
      chart.append(svg('line', { class: 'tab-chart-grid', x1: CHART_MARGIN.left, x2: right, y1: y(value), y2: y(value) }), label);
    }
    const ticks = 4;
    for (let tick = 0; tick <= ticks; tick++) {
      const time = range.start + (range.end - range.start) * tick / ticks;
      const label = svg('text', { class: 'tab-chart-label', x: x(time), y: CHART_HEIGHT - 6, 'text-anchor': tick === 0 ? 'start' : tick === ticks ? 'end' : 'middle' });
      label.textContent = (days === 1 ? timeLabel : dateLabel).format(time);
      chart.append(label);
    }
    // draw automatic counts as steps because each count holds until the next backup
    const steps = [...(before ? [{ capturedAt: range.start, tabCount: before.tabCount }] : []), ...points.filter(point => point.collection === 'automatic')];
    const first = steps[0];
    if (first) {
      let line = `M ${x(first.capturedAt)} ${y(first.tabCount)}`;
      for (const step of steps.slice(1)) line += ` H ${x(step.capturedAt)} V ${y(step.tabCount)}`;
      line += ` H ${right}`;
      chart.append(svg('path', { class: 'tab-chart-area', d: `${line} V ${bottom} H ${x(first.capturedAt)} Z` }), svg('path', { class: 'tab-chart-line', d: line }));
    }
    for (const point of points.filter(point => point.collection === 'saved')) chart.append(svg('circle', { class: 'tab-chart-manual', cx: x(point.capturedAt), cy: y(point.tabCount), r: 4 }));
    guide = svg('line', { class: 'tab-chart-guide', y1: CHART_MARGIN.top, y2: bottom });
    highlight = svg('circle', { class: 'tab-chart-point', r: 5 });
    guide.style.visibility = highlight.style.visibility = 'hidden';
    chart.append(guide, highlight);
    plot.prepend(chart);
    // order hover and keyboard targets by capture time across both collections
    targets = points.map(point => ({ point, x: x(point.capturedAt), y: y(point.tabCount) })).sort((a, b) => a.point.capturedAt - b.point.capturedAt);
    if (previous !== undefined) showTarget(targets.findIndex(target => target.point.id === previous));
  }

  function nearest(clientX: number): number
  {
    const offset = clientX - plot.getBoundingClientRect().left;
    let index = -1;
    for (const [candidate, target] of targets.entries()) {
      if (index === -1 || Math.abs(target.x - offset) < Math.abs((targets[index]?.x ?? 0) - offset)) index = candidate;
    }
    return index;
  }

  plot.addEventListener('pointermove', event => {
    const index = nearest(event.clientX);
    if (index !== active) showTarget(index);
  });
  plot.addEventListener('pointerleave', () => { if (!plot.matches(':focus-visible')) hideTooltip(); });
  plot.addEventListener('focus', () => { if (active === -1) showTarget(targets.length - 1); });
  plot.addEventListener('blur', hideTooltip);
  plot.addEventListener('keydown', event => {
    const index = event.key === 'ArrowLeft' ? active - 1 : event.key === 'ArrowRight' ? active + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? targets.length - 1 : null;
    if (index === null) return;
    event.preventDefault();
    showTarget(Math.max(0, Math.min(targets.length - 1, index)));
  });
  // dismiss the tooltip when the chart moves, closes, or the page view changes
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
  window.addEventListener('scroll', hideTooltip, { capture: true });
  window.addEventListener('hashchange', hideTooltip);
  details.addEventListener('toggle', () => { if (!details.open) hideTooltip(); });

  async function update(value: Metadata, force = false): Promise<void>
  {
    metadata = value;
    const now = Date.now();
    // refresh for new backups and advance the period once per minute
    const key = `${days}:${Math.floor(now / 60_000)}:${value.historyRevision}:${value.count}:${value.latestId}`;
    if ((!force && key === loadedKey && !pendingKey) || key === pendingKey) return;
    const current = ++generation;
    pendingKey = key;
    plot.setAttribute('aria-busy', 'true');
    try {
      const range = tabChartRange(now, days);
      const reply = await request({ kind: 'tab-counts', range });
      if (current !== generation) return;
      if (reply.kind !== 'tab-counts') throw new Error('Unexpected chart response.');
      data = { range, points: reply.points, before: reply.before };
      render();
      message.replaceChildren();
      loadedKey = key;
    } catch (error) {
      if (current !== generation) return;
      // retry automatically only when the key changes so periodic refreshes keep the retry control stable
      loadedKey = key;
      const retry = button('Retry chart', icons.RotateCcw, 'button small');
      retry.addEventListener('click', () => { if (metadata) void update(metadata, true); });
      message.replaceChildren(el('span', '', `Chart could not be updated: ${errorMessage(error)}`), retry);
    } finally {
      if (current === generation) {
        pendingKey = '';
        plot.setAttribute('aria-busy', 'false');
      }
    }
  }

  for (const { days: value, control } of periodButtons) control.addEventListener('click', () => {
    if (value === days) return;
    days = value;
    updatePeriod();
    try { localStorage.setItem('tabblackbox.tab-chart-period', String(value)); }
    catch { /* the selected period still applies to this page */ }
    if (metadata) void update(metadata);
  });
  // redraw at the available width without requesting the counts again
  const resize = new ResizeObserver(entries => {
    const next = Math.floor(entries[0]?.contentRect.width ?? 0);
    if (!next || next === width) return;
    width = next;
    render();
  });
  resize.observe(plot);
  return { element, update };
}
