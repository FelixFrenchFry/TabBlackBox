import { el } from './shared';

export type SearchHighlight<T extends string = string> = { words: readonly string[]; fields: readonly T[] };
type Range = [start: number, end: number];
type Marked = { text: string; ranges: Range[] };

// characters kept before a match that follows a cut
const CONTEXT = 8;
const marked = new WeakMap<HTMLElement, Marked>();

export function matchRanges(text: string, words: readonly string[]): Range[]
{
  // find every case-insensitive occurrence like the substring search and merge overlaps
  const ranges: Range[] = [];
  for (const word of words) {
    if (!word) continue;
    const pattern = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function boundary(text: string, index: number): number
{
  // keep surrogate pairs together when a cut starts or ends between them
  const code = text.charCodeAt(index - 1);
  return index > 0 && index < text.length && code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

function render(element: HTMLElement, { text, ranges }: Marked, gap?: Range): HTMLElement | null
{
  const nodes: Node[] = [];
  let last = null as HTMLElement | null;
  const append = (start: number, end: number) => {
    let position = start;
    for (const [from, to] of ranges) {
      if (to <= start || from >= end) continue;
      if (from > position) nodes.push(document.createTextNode(text.slice(position, from)));
      last = el('mark', 'search-match', text.slice(from, to));
      nodes.push(last);
      position = to;
    }
    if (end > position) nodes.push(document.createTextNode(text.slice(position, end)));
  };
  if (gap) {
    append(0, gap[0]);
    // draw the cut with CSS and keep the removed text for screen readers and copied text
    const cut = el('span', 'match-gap');
    cut.append(el('span', 'visually-hidden', text.slice(gap[0], gap[1])));
    nodes.push(cut);
    append(gap[1], text.length);
  } else append(0, text.length);
  element.replaceChildren(...nodes);
  return last;
}

export function markMatches(element: HTMLElement, text: string, words: readonly string[]): void
{
  const entry = { text, ranges: matchRanges(text, words) };
  marked.set(element, entry);
  element.classList.add('has-matches');
  render(element, entry);
}

function fit(element: HTMLElement): void
{
  const entry = marked.get(element);
  if (!entry?.ranges.length) return;
  render(element, entry);
  if (!element.isConnected || element.scrollWidth <= element.clientWidth) return;
  // leave room for the end ellipsis that covers the last visible characters
  const limit = element.getBoundingClientRect().right - parseFloat(getComputedStyle(element).fontSize);
  const marks = [...element.querySelectorAll('mark')];
  const hidden = marks.findIndex(mark => mark.getBoundingClientRect().right > limit);
  const range = entry.ranges[hidden];
  if (!range) return;
  // cut only text after the matches that are already visible
  const low = boundary(entry.text, hidden > 0 ? entry.ranges[hidden - 1]?.[1] ?? 0 : 0);
  const end = boundary(entry.text, Math.max(low, range[0] - CONTEXT));
  if (end <= low) return;
  const fits = (start: number) => (render(element, entry, [boundary(entry.text, start), end])?.getBoundingClientRect().right ?? Infinity) <= limit;
  // keep the widest cut when the remaining matches are too far apart to fit
  if (!fits(low)) return;
  // keep as much of the beginning as possible while the last match stays visible
  let keep = low;
  let over = end - 1;
  while (keep < over) {
    const middle = Math.ceil((keep + over) / 2);
    if (fits(middle)) keep = middle;
    else over = middle - 1;
  }
  render(element, entry, [boundary(entry.text, keep), end]);
}

export function fitMatches(root: HTMLElement): void
{
  // cut the middle of lines whose matches fall behind the end ellipsis
  for (const element of root.querySelectorAll<HTMLElement>('.has-matches')) fit(element);
}
