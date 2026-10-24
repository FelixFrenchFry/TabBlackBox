import type { IconNode } from 'lucide';
import type { Overview } from '../model';
import { MB } from '../storage';
import { DATE_LOCALE, setTimestamp, timestamp } from './dates';
import { el, formatNumber, icon, icons, plural, request } from './shared';

const TREND_DAYS = 7;

function megabytes(bytes: number): string
{
  const mb = bytes / MB;
  return mb > 0 && mb < 0.01 ? '<0.01' : formatNumber(mb, 2);
}

// describe how long backups reach back in the largest whole unit
function span(milliseconds: number): string
{
  const hours = Math.floor(milliseconds / 3_600_000);
  if (hours >= 24) return plural(Math.floor(hours / 24), 'day');
  return hours >= 1 ? plural(hours, 'hour') : 'Less than 1 hour';
}

function setText(node: Node, text: string): void
{
  // leave unchanged text in place so polling does not clear selections
  if (node.textContent !== text) node.textContent = text;
}

function statistic(label: string, glyph: IconNode)
{
  const element = el('div', 'statistic');
  const heading = el('span', 'statistic-label muted', label);
  heading.prepend(icon(glyph, 14));
  const value = el('strong', 'statistic-value', '—');
  const detail = el('span', 'statistic-detail muted');
  const trend = el('span', 'statistic-trend muted');
  element.append(heading, value, detail, trend);
  return { element, value, detail, trend };
}

export function createStatisticsView(...panels: HTMLElement[])
{
  const element = el('main', 'history-main');
  const heading = el('div', 'page-heading');
  const titles = el('div');
  titles.append(el('h1', '', 'Statistics'), el('p', 'muted', 'Overview of your backups, storage use, and active tabs over time.'));
  heading.append(titles);
  const summary = el('section', 'statistics-summary');
  summary.setAttribute('aria-label', 'Backup summary');
  const automatic = statistic('Automatic backups', icons.Clock3);
  const manual = statistic('Manual backups', icons.Bookmark);
  const storage = statistic('Storage used', icons.Database);
  const latest = statistic('Latest backup', icons.AppWindow);
  // build the latest backup detail once so its time node survives polling
  const latestEmpty = el('span', '', 'No backups yet');
  const latestDetails = el('span');
  const latestWindows = document.createTextNode('');
  const latestDate = timestamp(null);
  latestDetails.append(latestWindows, latestDate);
  latest.detail.append(latestEmpty, latestDetails);
  const history = statistic('Backup history', icons.History);
  // show the oldest capture as a fixed date beside the relative span
  const historyDate = el('time');
  const dateLabel = new Intl.DateTimeFormat(DATE_LOCALE, { year: 'numeric', month: 'short', day: 'numeric' });
  summary.append(manual.element, automatic.element, storage.element, latest.element, history.element);
  element.append(heading, summary, ...panels);

  let loadedKey = '';
  let pendingKey = '';
  let generation = 0;

  function recentTrend(trend: HTMLElement, count: number): void
  {
    // color new backups as an increase and keep an empty period neutral
    trend.classList.toggle('increase', count > 0);
    if (!count) { setText(trend, `None in the last ${TREND_DAYS} days`); return; }
    const text = `${formatNumber(count)} in the last ${TREND_DAYS} days`;
    // rebuild only when the count changes so polling keeps the icon in place
    if (trend.textContent === text) return;
    trend.replaceChildren(icon(icons.ArrowUpRight, 12), text);
  }

  async function updateRecent(overview: Overview): Promise<void>
  {
    const now = Date.now();
    const { metadata } = overview;
    // count backups of the rolling period again for new backups and once per minute
    const key = `${Math.floor(now / 60_000)}:${metadata.historyRevision}:${metadata.count}:${metadata.latestId}`;
    if (key === loadedKey || key === pendingKey) return;
    const current = ++generation;
    pendingKey = key;
    try {
      // reuse the calendar day counts so the trend reads only summaries
      const reply = await request({ kind: 'calendar', range: { start: now - TREND_DAYS * 86_400_000, end: now + 1 } });
      if (current !== generation) return;
      if (reply.kind !== 'calendar') throw new Error('Unexpected statistics response.');
      recentTrend(automatic.trend, reply.days.reduce((total, day) => total + day.automatic, 0));
      recentTrend(manual.trend, reply.days.reduce((total, day) => total + day.saved, 0));
    } catch {
      if (current !== generation) return;
      // hide the trend until the next key change retries it
      automatic.trend.replaceChildren();
      manual.trend.replaceChildren();
    } finally {
      if (current === generation) {
        loadedKey = key;
        pendingKey = '';
      }
    }
  }

  return {
    element,
    update(overview: Overview): void
    {
      // derive manual totals from the overall counts the overview already provides
      const { metadata, automaticStorage, latest: latestBackup } = overview;
      setText(automatic.value, formatNumber(automaticStorage.count));
      setText(automatic.detail, `${megabytes(automaticStorage.bytes)} MB`);
      setText(manual.value, formatNumber(Math.max(0, metadata.count - automaticStorage.count)));
      setText(manual.detail, `${megabytes(metadata.savedBytes)} MB`);
      const percent = automaticStorage.bytes / MB / metadata.settings.maxStorageMB * 100;
      setText(storage.value, `${percent > 0 && percent < 0.1 ? '<0.1' : formatNumber(percent, 1)}%`);
      setText(storage.detail, `${megabytes(automaticStorage.bytes)} MB of ${formatNumber(metadata.settings.maxStorageMB)} MB for automatic backups`);
      setText(latest.value, latestBackup ? plural(latestBackup.tabCount, 'tab') : '—');
      setTimestamp(latestDate, latestBackup?.capturedAt ?? null);
      if (latestBackup) latestWindows.data = `${plural(latestBackup.windowCount, 'window')} · `;
      latestDetails.hidden = !latestBackup;
      latestEmpty.hidden = latestBackup !== null;
      // compare the latest backup with the previous one in its collection like the history rows
      const counts = latestBackup?.changeCounts;
      const changes = counts ? `${counts.opened}:${counts.closed}` : '';
      if (latest.trend.dataset.changes !== changes) {
        latest.trend.dataset.changes = changes;
        if (!counts) latest.trend.replaceChildren();
        else if (!counts.opened && !counts.closed) latest.trend.replaceChildren('No tab changes');
        else {
          const text = el('span', 'change-text');
          if (counts.opened) text.append(el('span', 'change-count-opened', `+${formatNumber(counts.opened)} opened`));
          if (counts.closed) text.append(el('span', 'change-count-closed', `−${formatNumber(counts.closed)} closed`));
          latest.trend.replaceChildren(text);
        }
      }
      // reach back to the oldest backup of either collection because manual backups are kept until deleted
      const oldest = overview.oldestCapturedAt;
      setText(history.value, oldest === null ? '—' : span(Math.max(0, Date.now() - oldest)));
      if (oldest === null) setText(history.detail, 'No backups yet');
      else {
        const date = dateLabel.format(oldest);
        historyDate.dateTime = new Date(oldest).toISOString();
        if (historyDate.textContent !== date || !history.detail.contains(historyDate)) {
          historyDate.textContent = date;
          history.detail.replaceChildren('Since ', historyDate, ' · oldest kept backup');
        }
      }
      void updateRecent(overview);
    },
  };
}
