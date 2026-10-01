import { errorMessage, type TabMatch } from '../model';
import { TAB_SEARCH_INITIAL_LIMIT, TAB_SEARCH_PAGE_LIMIT, TAB_URL_LIMIT } from '../protocol';
import { timestamp } from './dates';
import { button, el, icons, notice, request } from './shared';

export function createTabSearch(options: { label: (title: string, url: string) => HTMLElement; show: (match: TabMatch) => void })
{
  const element = el('section', 'tab-search');
  element.setAttribute('aria-label', 'Search tabs in all backups');
  const input = el('input', 'session-name-input tab-search-input');
  input.type = 'search';
  input.placeholder = 'Search tabs in all backups';
  input.setAttribute('aria-label', input.placeholder);
  input.maxLength = TAB_URL_LIMIT;
  const results = el('div', 'tab-search-results');
  results.setAttribute('aria-live', 'polite');
  results.hidden = true;
  element.append(input, results);
  let generation = 0;
  let shown = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function result(match: TabMatch): HTMLElement
  {
    // match session preview rows with the title and link on the left and history details on the right
    const item = el('li', 'tab-row tab-search-result');
    // present history details in two rows styled like the calendar day tooltip
    const seen = el('div', 'tab-search-seen');
    const latest = el('div');
    latest.append('Last seen ', timestamp(match.lastSeen), match.lastSeenCollection === 'saved' ? ' in manual ' : ' in automatic ', el('strong', '', `#${match.lastSeenNumber}`));
    const counts = el('div');
    counts.append(el('strong', '', String(match.automaticCount)), ' automatic · ', el('strong', '', String(match.savedCount)), ' manual');
    seen.append(latest, counts);
    const show = button('Show backups', icons.History, 'button small');
    show.addEventListener('click', () => options.show(match));
    item.append(options.label(match.title, match.url), seen, show);
    return item;
  }

  async function search(limit: number): Promise<void>
  {
    clearTimeout(timer);
    const query = input.value.trim();
    // invalidate pending replies so older queries cannot replace newer results
    const current = ++generation;
    if (query.length < 2) {
      results.hidden = true;
      results.replaceChildren();
      shown = 0;
      return;
    }
    try {
      // request every loaded result again so the list stays ordered as new backups arrive
      const data = await request({ kind: 'tab-search', query, limit });
      if (current !== generation) return;
      if (data.kind !== 'tab-search') throw new Error('Unexpected search response.');
      const list = el('ul', 'tab-search-list');
      list.append(...data.items.map(result));
      results.replaceChildren(data.items.length ? list : el('p', 'muted tab-search-note', data.tooBroad ? 'Too many tabs match. Add more words.' : 'No tabs match your search'));
      results.hidden = false;
      shown = data.items.length;
      if (data.truncated) {
        // expand the list from the note that reports how many matches are shown
        const footer = el('div', 'tab-search-footer');
        const more = button(`Show ${TAB_SEARCH_PAGE_LIMIT} more`, icons.ChevronDown, 'tab-search-more');
        more.addEventListener('click', () => {
          more.disabled = true;
          void search(shown + TAB_SEARCH_PAGE_LIMIT);
        });
        footer.append(el('p', 'muted', `Showing the ${shown} most recently seen tabs. Add more words to narrow your search.`), more);
        results.append(footer);
      }
    } catch (error) {
      if (current !== generation) return;
      results.replaceChildren(notice(errorMessage(error)));
      results.hidden = false;
    }
  }

  // wait for typing to pause before scanning stored tabs
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { void search(TAB_SEARCH_INITIAL_LIMIT); }, 200);
  });

  return {
    element,
    refresh(): Promise<void> { return results.hidden ? Promise.resolve() : search(Math.max(shown, TAB_SEARCH_INITIAL_LIMIT)); },
  };
}
