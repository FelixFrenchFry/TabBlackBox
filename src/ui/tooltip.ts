import { positionPopover } from './popover';

let initialized = false;

export function setTooltip(element: HTMLElement, text: string): void
{
  element.dataset.tooltip = text;
}

export function initializeTooltips(): void
{
  if (initialized) return;
  initialized = true;
  // share one tooltip across buttons so refreshed rows need no individual listeners
  const selector = '[data-tooltip]';
  let tooltip: HTMLDivElement | undefined;
  let target: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function close(): void
  {
    clearTimeout(timer);
    target?.removeAttribute('aria-describedby');
    target = null;
    if (tooltip?.matches(':popover-open')) tooltip.hidePopover();
  }

  function leave(): void
  {
    // allow the pointer to cross the gap without dismissing keyboard focus
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!target?.matches(':hover, :focus-visible') && !tooltip?.matches(':hover')) close();
    }, 150);
  }

  function show(node: HTMLElement): void
  {
    if (!node.isConnected || !node.getClientRects().length) { close(); return; }
    clearTimeout(timer);
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'button-tooltip';
      tooltip.className = 'panel-help-popover button-tooltip';
      tooltip.popover = 'auto';
      tooltip.setAttribute('role', 'tooltip');
      tooltip.addEventListener('pointerenter', () => clearTimeout(timer));
      tooltip.addEventListener('pointerleave', leave);
      tooltip.addEventListener('beforetoggle', event => {
        if (event.newState === 'closed') {
          clearTimeout(timer);
          target?.removeAttribute('aria-describedby');
          target = null;
        }
      });
      document.body.append(tooltip);
    }
    if (target !== node) target?.removeAttribute('aria-describedby');
    target = node;
    if (node.getAttribute('aria-describedby') !== tooltip.id) node.setAttribute('aria-describedby', tooltip.id);
    const text = node.dataset.tooltip ?? '';
    if (tooltip.textContent !== text) tooltip.textContent = text;
    if (!tooltip.matches(':popover-open')) tooltip.showPopover();
    positionPopover(tooltip, node);
  }

  function findTarget(value: EventTarget | null): HTMLElement | null
  {
    return value instanceof Element ? value.closest<HTMLElement>(selector) : null;
  }

  document.addEventListener('pointerover', event => {
    const node = findTarget(event.target);
    if (event.pointerType === 'mouse' && node) show(node);
  });
  document.addEventListener('pointerout', event => { if (target && findTarget(event.target) === target) leave(); });
  // show on keyboard focus only so focus returned after mouse-closed dialogs stays silent
  document.addEventListener('focusin', event => { const node = findTarget(event.target); if (node?.matches(':focus-visible')) show(node); });
  document.addEventListener('focusout', event => { if (target && findTarget(event.target) === target) leave(); });
  // close before a click opens a dialog or replaces the row
  document.addEventListener('click', event => { if (target && findTarget(event.target) === target) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  document.addEventListener('visibilitychange', close);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, { capture: true });
}
