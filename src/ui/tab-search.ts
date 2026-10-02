import { parseTabSearchFields, TAB_SEARCH_FIELDS } from '../history';
import { errorMessage, type TabMatch } from '../model';
import { TAB_SEARCH_INITIAL_LIMIT, TAB_SEARCH_PAGE_LIMIT, TAB_URL_LIMIT } from '../protocol';
import { timestamp } from './dates';
import { createSearchFields } from './search-fields';
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
  let generation = 0;
  let shown = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // rerun the visible search when its scope changes
  const fields = createSearchFields({ id: 'tab-search-fields-menu', storageKey: 'tabblackbox.tab-search-fields', fields: TAB_SEARCH_FIELDS, labels: { title: 'Titles', url: 'URLs' }, parse: parseTabSearchFields }, () => {
    void search(Math.max(shown, TAB_SEARCH_INITIAL_LIMIT));
  });
  const group = el('div', 'search-group');
  group.append(fields.element, input);
  element.append(group, results);

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
    show.addEventListener('click', () => {
      dismiss();
      options.show(match);
    });
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
      const data = await request({ kind: 'tab-search', query, limit, fields: fields.fields() });
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

  function dismiss(): void
  {
    // cancel scheduled and pending searches so their replies cannot reopen the dropdown
    clearTimeout(timer);
    generation++;
    results.hidden = true;
  }

  // close the result dropdown on Escape or outside interaction and reopen it on focus
  element.addEventListener('keydown', event => { if (event.key === 'Escape') dismiss(); });
  document.addEventListener('pointerdown', event => { if (!(event.target instanceof Node && element.contains(event.target))) dismiss(); });
  input.addEventListener('focus', () => { if (results.hidden && input.value.trim().length >= 2) void search(Math.max(shown, TAB_SEARCH_INITIAL_LIMIT)); });
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
