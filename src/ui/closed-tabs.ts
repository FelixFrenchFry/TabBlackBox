import { closedAgo, closedTabs, type ClosedTab } from '../closed';
import { restorableUrl } from '../session';
import { formatDate } from './dates';
import { favicon } from './favicon';
import { el, icon, icons } from './shared';
import { setTooltip } from './tooltip';

export function createClosedTabs(onError: (error: unknown) => void)
{
  const element = el('section', 'closed-tabs');
  // menu row that expands the list below it
  const row = el('button', 'button closed-tabs-row');
  row.type = 'button';
  row.setAttribute('aria-expanded', 'false');
  const count = el('span', 'closed-tabs-row-count');
  row.append(icon(icons.Undo2), el('span', 'closed-tabs-row-label', 'Recently closed'), count, icon(icons.ChevronDown));
  const body = el('div', 'closed-tabs-body');
  body.hidden = true;
  const list = el('ul', 'tab-list');
  const empty = el('p', 'muted closed-tab-empty', 'No recently closed tabs');
  body.append(list, empty);
  element.append(row, body);
  let reopening = false;

  function entry(item: ClosedTab): HTMLElement
  {
    const tab = el('li', 'tab-row');
    const label = el('div', 'tab-label');
    const title = el('a', 'tab-title tab-title-link', item.title);
    // link only the URL schemes that extension pages may open and keep other titles focusable
    if (restorableUrl(item.url)) title.href = item.url;
    else {
      title.tabIndex = 0;
      title.setAttribute('role', 'link');
    }
    // delay tooltips and open them above the row so moving down the list never covers the next tab
    const tooltip = { delay: 800, placement: 'above' } as const;
    setTooltip(tab, item.url, tooltip);
    // repeat the address on the focusable title so keyboard focus can show it
    setTooltip(title, item.url, tooltip);
    const closed = el('time', 'closed-tab-time', closedAgo(item.closedAt));
    closed.dateTime = new Date(item.closedAt).toISOString();
    setTooltip(closed, `Closed ${formatDate(item.closedAt, 'exact')}`, tooltip);
    label.append(favicon(item.url), title, closed);
    tab.append(label);
    // the whole row reopens the closed tab with its history like the browser's reopen command
    tab.addEventListener('click', event => {
      event.preventDefault();
      // ignore repeated clicks until the restore and list refresh finish so a spent session cannot fall back to a duplicate tab
      if (reopening) return;
      reopening = true;
      void reopen(item).catch(onError).finally(() => { reopening = false; });
    });
    title.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !title.href) tab.click();
    });
    return tab;
  }

  async function reopen(item: ClosedTab): Promise<void>
  {
    try { await chrome.sessions.restore(item.sessionId); }
    catch (error) {
      // open the saved address when Chrome no longer has the closed session
      if (!restorableUrl(item.url)) throw error;
      await chrome.tabs.create({ url: item.url });
    }
    await load();
  }

  async function load(): Promise<void>
  {
    try {
      const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: chrome.sessions.MAX_SESSION_RESULTS });
      const tabs = closedTabs(sessions, chrome.runtime.getURL('/'));
      list.replaceChildren(...tabs.map(entry));
      empty.hidden = tabs.length > 0;
      count.textContent = String(tabs.length);
    } catch (error) { onError(error); }
  }

  row.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    row.setAttribute('aria-expanded', String(open));
    // refresh the list whenever it opens
    if (open) void load();
  });

  return { element, load };
}
