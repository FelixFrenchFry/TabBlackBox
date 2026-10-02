import { closedTabs, type ClosedTab } from '../closed';
import { restorableUrl } from '../session';
import { favicon } from './favicon';
import { button, el, icon, icons } from './shared';

export function createClosedTabs(onError: (error: unknown) => void)
{
  const element = el('section', 'closed-tabs');
  // menu row that expands the list below it
  const row = el('button', 'button closed-tabs-row');
  row.type = 'button';
  row.setAttribute('aria-expanded', 'false');
  const count = el('span', 'closed-tabs-row-count');
  row.append(icon(icons.Undo2), el('span', 'closed-tabs-row-label', 'Recently closed tabs'), count, icon(icons.ChevronDown));
  const body = el('div', 'closed-tabs-body');
  body.hidden = true;
  const list = el('ul', 'tab-list');
  const empty = el('p', 'muted closed-tab-empty', 'No recently closed tabs');
  body.append(list, empty);
  element.append(row, body);

  function entry(item: ClosedTab): HTMLElement
  {
    const tab = el('li', 'tab-row');
    const label = el('div', 'tab-label');
    let open: HTMLAnchorElement | HTMLButtonElement;
    let openLabel: string;
    // link only the URL schemes that extension pages may open
    if (restorableUrl(item.url)) {
      open = el('a', 'tab-open');
      open.href = item.url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      openLabel = 'Open in new tab';
      open.append(icon(icons.ArrowUpRight));
    } else {
      open = button('', icons.ArrowUpRight, 'tab-open');
      open.disabled = true;
      openLabel = 'This URL cannot be opened from here';
    }
    open.setAttribute('aria-label', openLabel);
    open.append(el('span', 'tab-url', item.url));
    label.append(favicon(item.url), el('span', 'tab-title', item.title), open);
    tab.append(label);
    return tab;
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
