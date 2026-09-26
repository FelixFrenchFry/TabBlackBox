import { positionPopover } from './popover';

export type DateFormat = 'exact' | 'relative' | 'combination';
const key = 'tabblackbox.date-format';
let initialized = false;

export function readDateFormat(): DateFormat
{
  try { const value = localStorage.getItem(key); return value === 'exact' || value === 'relative' || value === 'combination' ? value : 'relative'; }
  catch { return 'relative'; }
}

export function setDateFormat(value: DateFormat): void
{
  localStorage.setItem(key, value);
  window.dispatchEvent(new Event('dateformatchange'));
}

export function formatDate(value: number, format: DateFormat, now = Date.now()): string
{
  if (format === 'combination') return formatDate(value, 'exact', now) + ' (' + formatDate(value, 'relative', now) + ')';
  if (format === 'exact') return new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const seconds = (value - now) / 1000;
  const minutes = Math.floor(Math.abs(seconds) / 60);
  for (const [unit, size] of [['day', 1440], ['hour', 60], ['min', 1]] as const) {
    const count = Math.floor(minutes / size);
    if (count > 0) {
      const duration = count + ' ' + unit + (count === 1 || unit === 'min' ? '' : 's');
      return seconds > 0 ? 'in ' + duration : duration + ' ago';
    }
  }
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.trunc(seconds), 'second');
}

function updateTime(node: HTMLTimeElement): void
{
  const value = Number(node.dataset.timestamp);
  const format = readDateFormat();
  const text = formatDate(value, format);
  if (node.textContent !== text) node.textContent = text;
  node.removeAttribute('title');
  if (format === 'exact') node.removeAttribute('tabindex');
  else if (node.tabIndex !== 0) node.tabIndex = 0;
}

export function setTimestamp(node: HTMLTimeElement, value: number | null): void
{
  const stored = value === null ? undefined : String(value);
  // unchanged overview data must not trigger an extra relative-time update
  if (node.dataset.timestamp === stored && node.textContent !== '') return;
  if (value === null) {
    delete node.dataset.timestamp;
    node.removeAttribute('datetime');
    node.removeAttribute('title');
    node.removeAttribute('tabindex');
    node.removeAttribute('aria-describedby');
    node.textContent = 'Not yet saved';
    return;
  }
  node.dataset.timestamp = String(value);
  node.dateTime = new Date(value).toISOString();
  updateTime(node);
}

export function timestamp(value: number | null): HTMLTimeElement
{
  const node = document.createElement('time');
  setTimestamp(node, value);
  return node;
}

function initializeDateTooltip(): () => void
{
  // share one tooltip across timestamps so refreshed rows need no individual listeners
  const selector = 'time[data-timestamp][tabindex="0"]';
  let tooltip: HTMLDivElement | undefined;
  let target: HTMLTimeElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function close(): void
  {
    clearTimeout(timer);
    target?.removeAttribute('aria-describedby');
    target = null;
    if (tooltip?.matches(':popover-open')) tooltip.hidePopover();
  }

  function leave(): void
  {
    // allow the pointer to cross the gap without dismissing keyboard focus
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!target?.matches(':hover, :focus-visible') && !tooltip?.matches(':hover')) close();
    }, 150);
  }

  function update(): void
  {
    if (!target || !tooltip) return;
    if (!target.isConnected || !target.matches(selector) || !target.getClientRects().length) { close(); return; }
    const text = formatDate(Number(target.dataset.timestamp), 'exact');
    if (tooltip.textContent !== text) tooltip.textContent = text;
    positionPopover(tooltip, target);
  }

  function show(node: HTMLTimeElement): void
  {
    if (!node.isConnected || !node.matches(selector) || !node.getClientRects().length) { close(); return; }
    clearTimeout(timer);
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'timestamp-tooltip';
      tooltip.className = 'panel-help-popover timestamp-tooltip';
      tooltip.popover = 'auto';
      tooltip.setAttribute('role', 'tooltip');
      tooltip.addEventListener('pointerenter', () => clearTimeout(timer));
      tooltip.addEventListener('pointerleave', leave);
      tooltip.addEventListener('beforetoggle', event => {
        if (event.newState === 'closed') {
          clearTimeout(timer);
          target?.removeAttribute('aria-describedby');
          target = null;
        }
      });
      document.body.append(tooltip);
    }
    if (target !== node) target?.removeAttribute('aria-describedby');
    target = node;
    if (node.getAttribute('aria-describedby') !== tooltip.id) node.setAttribute('aria-describedby', tooltip.id);
    if (!tooltip.matches(':popover-open')) tooltip.showPopover();
    update();
  }

  function findTime(value: EventTarget | null): HTMLTimeElement | null
  {
    return value instanceof Element ? value.closest<HTMLTimeElement>(selector) : null;
  }

  document.addEventListener('pointerover', event => {
    const node = findTime(event.target);
    if (event.pointerType === 'mouse' && node) show(node);
  });
  document.addEventListener('pointerout', event => { if (target && findTime(event.target) === target) leave(); });
  document.addEventListener('focusin', event => { const node = findTime(event.target); if (node) show(node); });
  document.addEventListener('focusout', event => { if (target && findTime(event.target) === target) leave(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  document.addEventListener('visibilitychange', close);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, { capture: true });
  window.addEventListener('hashchange', close);
  return update;
}

export function initializeDates(): void
{
  if (initialized) return;
  initialized = true;
  const updateTooltip = initializeDateTooltip();
  // update visible timestamps without rebuilding session rows or closing expanded previews
  const update = () => {
    document.querySelectorAll<HTMLTimeElement>('time[data-timestamp]').forEach(updateTime);
    updateTooltip();
  };
  window.addEventListener('dateformatchange', update);
  window.addEventListener('storage', event => { if (event.key === key || event.key === null) update(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
  setInterval(update, 1000);
}
