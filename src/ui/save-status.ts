import { el, icon, icons } from './shared';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function createSaveStatus()
{
  const element = el('span', 'settings-save-status is-idle');
  element.setAttribute('role', 'status');
  element.setAttribute('aria-hidden', 'true');
  const label = document.createTextNode('');
  const glyphs = { idle: icon(icons.Check), saving: icon(icons.LoaderCircle), saved: icon(icons.Check), error: icon(icons.CircleAlert) };
  glyphs.saving.classList.add('save-spinner');
  let current: SaveState = 'idle';
  let timer: ReturnType<typeof setTimeout> | undefined;
  element.append(glyphs.idle, label);
  function update(state: SaveState): void
  {
    clearTimeout(timer);
    element.classList.toggle('is-idle', state === 'idle');
    element.setAttribute('aria-hidden', String(state === 'idle'));
    // retain the previous content and color while fading out
    if (state !== 'idle') {
      element.dataset.state = state;
      glyphs[current].replaceWith(glyphs[state]);
      current = state;
      label.data = state === 'saving' ? 'Saving…' : state === 'error' ? 'Not saved' : 'Saved';
    }
    if (state === 'saved') timer = setTimeout(() => update('idle'), 2000);
  }
  return { element, update };
}
