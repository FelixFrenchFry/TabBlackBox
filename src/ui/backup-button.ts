import type { CaptureResult, Overview } from '../model';
import { el, icon, icons } from './shared';

export function createBackupButton(onClick: () => void)
{
  const element = el('button', 'button primary backup-button');
  element.type = 'button';
  element.setAttribute('aria-live', 'polite');
  const label = document.createTextNode('Back up now');
  const glyphs = { idle: icon(icons.Save), saving: icon(icons.LoaderCircle), saved: icon(icons.Check) };
  glyphs.saving.classList.add('save-spinner');
  element.append(glyphs.idle, label);
  let backingUp = false;
  let restoring = false;
  let saved = false;
  let displayedState: keyof typeof glyphs = 'idle';
  let timer: ReturnType<typeof setTimeout> | undefined;

  function render(): void
  {
    const state = backingUp ? 'saving' : saved ? 'saved' : 'idle';
    element.disabled = backingUp || saved || restoring;
    element.setAttribute('aria-busy', String(backingUp));
    element.classList.toggle('is-saving', state === 'saving');
    element.classList.toggle('is-saved', state === 'saved');
    // preserve button content during polls and start the hold when Saved becomes visible
    if (state !== displayedState) {
      glyphs[displayedState].replaceWith(glyphs[state]);
      displayedState = state;
      if (state === 'saved') {
        clearTimeout(timer);
        timer = setTimeout(() => { saved = false; render(); }, 2000);
      }
    }
    const text = backingUp ? 'Backing up…' : saved ? 'Saved' : 'Back up now';
    if (label.data !== text) label.data = text;
  }

  element.addEventListener('click', () => { if (!element.disabled) onClick(); });
  render();
  return {
    element,
    update(nextBackingUp: boolean, nextRestoring: boolean): void
    {
      if (nextBackingUp && !backingUp) { saved = false; clearTimeout(timer); }
      backingUp = nextBackingUp;
      restoring = nextRestoring;
      render();
    },
    finish(overview: Overview, result?: CaptureResult): void
    {
      if (overview.status.kind !== 'current' || (result?.kind !== 'saved' && result?.kind !== 'unchanged')) return;
      saved = true;
      render();
    },
  };
}
