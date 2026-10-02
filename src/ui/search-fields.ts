import { positionPopover } from './popover';
import { button, el, icons } from './shared';

export type SearchFieldOptions<T extends string> = {
  id: string; storageKey: string; fields: readonly T[]; labels: Record<T, string>; parse: (value: unknown) => T[];
};

export function createSearchFields<T extends string>({ id, storageKey, fields: available, labels, parse }: SearchFieldOptions<T>, onChange: () => void)
{
  const element = el('span', 'search-fields');
  const trigger = button('Search in', icons.ListFilter);
  trigger.setAttribute('aria-expanded', 'false');
  const menu = el('div', 'panel-help-popover search-fields-menu');
  menu.id = id;
  menu.popover = 'auto';
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', 'Search in');
  trigger.setAttribute('aria-controls', menu.id);
  trigger.popoverTargetElement = menu;
  element.append(trigger, menu);
  let fields: T[];
  try { fields = parse(JSON.parse(localStorage.getItem(storageKey) ?? 'null')); }
  catch { fields = [...available]; }

  const options = available.map(field => {
    const label = el('label', 'search-fields-option');
    const input = el('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => {
      select(available.filter(value => options.find(option => option.field === value)?.input.checked));
      onChange();
    });
    label.append(input, labels[field]);
    menu.append(label);
    return { field, input };
  });

  function select(value: T[]): void
  {
    fields = value;
    // keep at least one part searchable and mark the trigger while the search is narrowed
    for (const { field, input } of options) {
      input.checked = fields.includes(field);
      input.disabled = input.checked && fields.length === 1;
    }
    trigger.classList.toggle('is-filtered', fields.length < available.length);
    try { localStorage.setItem(storageKey, JSON.stringify(fields)); }
    catch { /* the selection still applies to this page */ }
  }
  select(fields);

  menu.addEventListener('beforetoggle', event => trigger.setAttribute('aria-expanded', String(event.newState === 'open')));
  menu.addEventListener('toggle', event => { if (event.newState === 'open') positionPopover(menu, trigger); });
  // keep the open menu beside its trigger while results reload and the page moves
  const reposition = () => { if (menu.matches(':popover-open')) positionPopover(menu, trigger); };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, { capture: true });
  window.addEventListener('hashchange', () => { if (menu.matches(':popover-open')) menu.hidePopover(); });

  return {
    element,
    fields: (): T[] => [...fields],
    // add a part to the search without notifying so the caller can search once
    include(field: T): void
    {
      if (!fields.includes(field)) select(available.filter(value => value === field || fields.includes(value)));
    },
  };
}
