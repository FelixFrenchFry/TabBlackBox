import { parseTopSitesScope, TOP_SITES_LIMIT, TOP_SITES_SCOPES } from '../sites';
import { errorMessage, type Metadata, type TopSites, type TopSitesScope } from '../model';
import { createHelp } from './help';
import { favicon } from './favicon';
import { button, el, formatNumber, icon, icons, request } from './shared';

function readTopSitesScope(): TopSitesScope
{
  try { return parseTopSitesScope(localStorage.getItem('tabblackbox.top-sites-scope')); }
  catch { return 'open'; }
}

function count(value: number, label: string): string
{
  return `${formatNumber(value)} ${label}${value === 1 ? '' : 's'}`;
}

function share(value: number, total: number): string
{
  const percent = value / total * 100;
  return percent > 0 && percent < 1 ? '<1%' : `${formatNumber(percent)}%`;
}

export function createTopSites()
{
  const element = el('section', 'top-sites');
  element.setAttribute('aria-label', 'Top websites');
  const details = el('details');
  details.open = true;
  const heading = el('summary', 'calendar-heading', 'Top websites');
  heading.prepend(icon(icons.ChevronDown));
  const content = el('div', 'calendar-content');
  const toolbar = el('div', 'calendar-toolbar');
  const title = el('div', 'tab-chart-title');
  const totals = el('span', '', '—');
  title.append(totals, createHelp('top-sites-help', 'About top websites', 'Shows which websites take up most of your tabs. You can choose to count your open tabs or all of the pages in your backups.'));
  // share the period button style of the tab count chart
  const scopes = el('div', 'tab-chart-periods');
  scopes.setAttribute('role', 'group');
  scopes.setAttribute('aria-label', 'Counted tabs');
  const scopeLabels: Record<TopSitesScope, string> = { open: 'Open now', all: 'All backups' };
  const scopeButtons = TOP_SITES_SCOPES.map(value => {
    const control = el('button', 'tab-chart-period', scopeLabels[value]);
    control.type = 'button';
    scopes.append(control);
    return { value, control };
  });
  toolbar.append(title, scopes);
  const message = el('div', 'calendar-message');
  message.setAttribute('role', 'status');
  const list = el('ol', 'top-sites-list');
  content.append(toolbar, message, list);
  details.append(heading, content);
  element.append(details);

  let scope = readTopSitesScope();
  let metadata: Metadata | undefined;
  let loadedKey = '';
  let pendingKey = '';
  let generation = 0;
  // websites listed above the other websites row, grown in steps of the initial list
  let shown = TOP_SITES_LIMIT;
  let rendered = '';

  function updateScope(): void
  {
    for (const { value, control } of scopeButtons) control.setAttribute('aria-pressed', String(value === scope));
  }
  updateScope();

  function render(data: TopSites): void
  {
    // leave an unchanged list in place so new backups do not reload icons or move focus
    const signature = JSON.stringify([scope, data]);
    if (signature === rendered) return;
    rendered = signature;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && list.contains(active) ? active : null;
    totals.textContent = `${count(data.total, scope === 'open' ? 'tab' : 'page')} on ${count(data.siteCount, 'website')}`;
    if (!data.total) {
      list.replaceChildren(el('li', 'muted top-sites-empty', 'No backups yet'));
      if (focused) heading.focus();
      return;
    }
    // scale bars to the largest site so the first bar fills its column
    const largest = data.sites[0]?.count ?? 1;
    const rows = data.sites.map((item, index) => {
      const row = el('li', 'top-sites-row');
      const site = el('span', 'top-sites-site');
      // number websites across expanded steps while the list itself conveys positions to assistive technology
      const rank = el('span', 'top-sites-rank', formatNumber(index + 1));
      rank.setAttribute('aria-hidden', 'true');
      const name = el('span', 'top-sites-name', item.site);
      name.title = item.site;
      site.append(rank, favicon(item.url), name);
      const track = el('span', 'top-sites-track');
      track.setAttribute('aria-hidden', 'true');
      const bar = el('span', 'top-sites-bar');
      bar.style.width = `${item.count / largest * 100}%`;
      track.append(bar);
      const amount = el('span', 'top-sites-count', formatNumber(item.count));
      amount.append(el('span', 'muted', ` · ${share(item.count, data.total)}`));
      row.append(site, track, amount);
      return row;
    });
    // summarize websites beyond the list in one row that lists the next ones or returns to the initial list
    const otherSites = data.siteCount - data.sites.length;
    // follow the listed websites so the controls match the reply even when it holds fewer than requested
    const expanded = data.sites.length > TOP_SITES_LIMIT;
    if (otherSites > 0 || expanded) {
      const row = el('li', 'top-sites-row top-sites-other');
      const fewer = expanded ? button('Show fewer', icons.ChevronDown, 'top-sites-toggle top-sites-fewer') : null;
      fewer?.addEventListener('click', () => expand(TOP_SITES_LIMIT));
      if (otherSites > 0) {
        const otherCount = data.total - data.sites.reduce((total, item) => total + item.count, 0);
        const more = el('button', 'top-sites-toggle top-sites-more');
        more.type = 'button';
        more.title = `Show ${Math.min(TOP_SITES_LIMIT, otherSites)} more`;
        const glyph = el('span', 'tab-favicon');
        glyph.append(icon(icons.ChevronDown));
        more.append(glyph, el('span', 'top-sites-name', count(otherSites, 'other website')));
        more.addEventListener('click', () => expand(data.sites.length + TOP_SITES_LIMIT));
        // keep both controls together across the name and bar columns
        const controls = el('span', 'top-sites-toggles');
        controls.append(more, ...(fewer ? [fewer] : []));
        row.append(controls, el('span', 'top-sites-count', `${formatNumber(otherCount)} · ${share(otherCount, data.total)}`));
      } else if (fewer) row.append(fewer);
      rows.push(row);
    }
    list.replaceChildren(...rows);
    // move focus from a replaced control to its replacement or to the remaining one
    if (focused) {
      const selector = focused.classList.contains('top-sites-fewer') ? '.top-sites-fewer' : '.top-sites-more';
      (list.querySelector<HTMLButtonElement>(selector) ?? list.querySelector<HTMLButtonElement>('.top-sites-toggle') ?? heading).focus();
    }
  }

  async function update(value: Metadata, force = false): Promise<void>
  {
    metadata = value;
    // count again only for new, removed, or changed backups
    const key = `${scope}:${shown}:${value.historyRevision}:${value.count}:${value.latestId}`;
    if ((!force && key === loadedKey && !pendingKey) || key === pendingKey) return;
    const current = ++generation;
    pendingKey = key;
    list.setAttribute('aria-busy', 'true');
    try {
      const reply = await request({ kind: 'top-sites', scope, limit: shown });
      if (current !== generation) return;
      if (reply.kind !== 'top-sites') throw new Error('Unexpected top websites response.');
      render(reply);
      message.replaceChildren();
      loadedKey = key;
    } catch (error) {
      if (current !== generation) return;
      // retry automatically only when the key changes so periodic refreshes keep the retry control stable
      loadedKey = key;
      const retry = button('Retry top websites', icons.RotateCcw, 'button small');
      retry.addEventListener('click', () => { if (metadata) void update(metadata, true); });
      message.replaceChildren(el('span', '', `Top websites could not be updated: ${errorMessage(error)}`), retry);
    } finally {
      if (current === generation) {
        pendingKey = '';
        list.setAttribute('aria-busy', 'false');
      }
    }
  }

  function expand(limit: number): void
  {
    shown = limit;
    if (metadata) void update(metadata);
  }

  for (const { value, control } of scopeButtons) control.addEventListener('click', () => {
    if (value === scope) return;
    // start each scope with the initial list
    scope = value;
    shown = TOP_SITES_LIMIT;
    updateScope();
    try { localStorage.setItem('tabblackbox.top-sites-scope', value); }
    catch { /* the selected scope still applies to this page */ }
    if (metadata) void update(metadata);
  });
  return { element, update };
}
