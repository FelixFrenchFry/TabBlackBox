import type { Overview } from '../model';
import { MB } from '../storage';
import { setTimestamp, timestamp } from './dates';
import { el, plural } from './shared';

function megabytes(bytes: number): string
{
  const mb = bytes / MB;
  return mb > 0 && mb < 0.01 ? '<0.01' : mb.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function setText(node: Node, text: string): void
{
  // leave unchanged text in place so polling does not clear selections
  if (node.textContent !== text) node.textContent = text;
}

function statistic(label: string)
{
  const element = el('div', 'statistic');
  const value = el('strong', 'statistic-value', '—');
  const detail = el('span', 'statistic-detail muted');
  element.append(el('span', 'statistic-label muted', label), value, detail);
  return { element, value, detail };
}

export function createStatisticsView(chart: HTMLElement)
{
  const element = el('main', 'history-main');
  const heading = el('div', 'page-heading');
  const titles = el('div');
  titles.append(el('h1', '', 'Statistics'), el('p', 'muted', 'Overview of your backups, storage use, and active tabs over time.'));
  heading.append(titles);
  const summary = el('section', 'statistics-summary');
  summary.setAttribute('aria-label', 'Backup summary');
  const automatic = statistic('Automatic backups');
  const manual = statistic('Manual backups');
  const storage = statistic('Storage used');
  const latest = statistic('Latest backup');
  // build the latest backup detail once so its time node survives polling
  const latestEmpty = el('span', '', 'No backups yet');
  const latestDetails = el('span');
  const latestWindows = document.createTextNode('');
  const latestDate = timestamp(null);
  latestDetails.append(latestWindows, latestDate);
  latest.detail.append(latestEmpty, latestDetails);
  summary.append(automatic.element, manual.element, storage.element, latest.element);
  element.append(heading, summary, chart);

  return {
    element,
    update(overview: Overview): void
    {
      // derive manual totals from the overall counts the overview already provides
      const { metadata, automaticStorage, latest: latestBackup } = overview;
      setText(automatic.value, automaticStorage.count.toLocaleString());
      setText(automatic.detail, `${megabytes(automaticStorage.bytes)} MB`);
      setText(manual.value, Math.max(0, metadata.count - automaticStorage.count).toLocaleString());
      setText(manual.detail, `${megabytes(metadata.savedBytes)} MB`);
      const percent = automaticStorage.bytes / MB / metadata.settings.maxStorageMB * 100;
      setText(storage.value, `${percent > 0 && percent < 0.1 ? '<0.1' : percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
      setText(storage.detail, `${megabytes(automaticStorage.bytes)} MB of ${metadata.settings.maxStorageMB.toLocaleString()} MB for automatic backups`);
      setText(latest.value, latestBackup ? plural(latestBackup.tabCount, 'tab') : '—');
      setTimestamp(latestDate, latestBackup?.capturedAt ?? null);
      if (latestBackup) latestWindows.data = `${plural(latestBackup.windowCount, 'window')} · `;
      latestDetails.hidden = !latestBackup;
      latestEmpty.hidden = latestBackup !== null;
    },
  };
}
