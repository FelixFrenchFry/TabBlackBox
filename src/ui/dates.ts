export type DateFormat = 'exact' | 'relative' | 'combination';
const key = 'tabblackbox.date-format';
let initialized = false;

export function readDateFormat(): DateFormat
{
  try { const value = localStorage.getItem(key); return value === 'relative' || value === 'combination' ? value : 'exact'; }
  catch { return 'exact'; }
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
  if (Math.abs(seconds) < 60) return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.trunc(seconds), 'second');
  let minutes = Math.floor(Math.abs(seconds) / 60);
  const parts: string[] = [];
  for (const [unit, size] of [['day', 1440], ['hour', 60], ['minute', 1]] as const) {
    const count = Math.floor(minutes / size);
    minutes %= size;
    if (count > 0) parts.push(count + ' ' + unit + (count === 1 ? '' : 's'));
  }
  const duration = parts.join(' ');
  return seconds > 0 ? 'in ' + duration : duration + ' ago';
}

function updateTime(node: HTMLTimeElement): void
{
  const value = Number(node.dataset.timestamp);
  const text = formatDate(value, readDateFormat());
  if (node.textContent !== text) node.textContent = text;
  const title = formatDate(value, 'exact');
  if (node.title !== title) node.title = title;
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
export function initializeDates(): void
{
  if (initialized) return;
  initialized = true;
  // update visible timestamps without rebuilding session rows or closing expanded previews
  const update = () => document.querySelectorAll<HTMLTimeElement>('time[data-timestamp]').forEach(updateTime);
  window.addEventListener('dateformatchange', update);
  window.addEventListener('storage', event => { if (event.key === key || event.key === null) update(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
  setInterval(update, 1000);
}