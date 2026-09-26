import { button, el, icons } from './shared';

export function positionPopover(content: HTMLElement, trigger: HTMLElement): void
{
  // position in the top layer so panel clipping cannot hide the explanation
  const anchor = trigger.getBoundingClientRect();
  const popup = content.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  content.style.left = `${Math.max(16, Math.min(anchor.left, width - popup.width - 16))}px`;
  content.style.top = `${Math.max(16, anchor.bottom + popup.height + 24 <= height ? anchor.bottom + 8 : anchor.top - popup.height - 8)}px`;
}

export function createHelp(id: string, label: string, message: string, signal?: AbortSignal): HTMLElement
{
  const element = el('span', 'panel-help');
  const trigger = button('', icons.CircleQuestionMark, 'panel-help-button');
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-describedby', id);
  trigger.setAttribute('aria-controls', id);
  trigger.setAttribute('aria-expanded', 'false');
  const content = el('div', 'panel-help-popover', message);
  content.id = id;
  content.popover = 'auto';
  content.setAttribute('role', 'tooltip');
  trigger.popoverTargetElement = content;
  element.append(trigger, content);
  let pinned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function close(): void
  {
    clearTimeout(timer);
    if (content.matches(':popover-open')) content.hidePopover();
  }

  function show(): void
  {
    clearTimeout(timer);
    if (content.matches(':popover-open')) return;
    content.showPopover();
    positionPopover(content, trigger);
  }

  function leave(): void
  {
    // allow the pointer to cross the gap between the icon and its explanation
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!pinned && !trigger.matches(':focus-visible') && !element.matches(':hover')) close();
    }, 150);
  }

  content.addEventListener('beforetoggle', event => {
    const open = event.newState === 'open';
    trigger.setAttribute('aria-expanded', String(open));
    if (!open) { pinned = false; clearTimeout(timer); }
  });
  trigger.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') show(); });
  trigger.addEventListener('pointerleave', leave);
  content.addEventListener('pointerenter', () => clearTimeout(timer));
  content.addEventListener('pointerleave', leave);
  trigger.addEventListener('focus', show);
  trigger.addEventListener('blur', close);
  // click keeps hover help open until the next click or native light dismissal
  trigger.addEventListener('click', event => {
    event.preventDefault();
    if (pinned) close();
    else { show(); pinned = true; }
  });
  window.addEventListener('resize', close, { signal });
  window.addEventListener('scroll', close, { capture: true, signal });
  window.addEventListener('hashchange', close, { signal });
  signal?.addEventListener('abort', close, { once: true });
  return element;
}
