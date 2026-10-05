import { positionPopover } from './popover';

let initialized = false;

export type TooltipOptions = { delay?: number; placement?: 'above'; boldNumbers?: boolean };

export function setTooltip(element: HTMLElement, text: string, options: TooltipOptions = {}): void
{
  element.dataset.tooltip = text;
  if (options.delay) element.dataset.tooltipDelay = String(options.delay);
  if (options.placement) element.dataset.tooltipPlacement = options.placement;
  if (options.boldNumbers) element.dataset.tooltipBoldNumbers = '';
}

export function initializeTooltips(): void
{
  if (initialized) return;
  initialized = true;
  // share one tooltip across buttons so refreshed rows need no individual listeners
  const selector = '[data-tooltip]';
  let tooltip: HTMLDivElement | undefined;
  let target: HTMLElement | null = null;
  let pending: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function close(): void
  {
    clearTimeout(timer);
    pending = null;
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
    pending = null;
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
    const bold = node.dataset.tooltipBoldNumbers !== undefined;
    // rebuild the content only when its text or emphasis changes
    const content = `${bold ? 'bold' : 'plain'}:${text}`;
    if (tooltip.dataset.content !== content) {
      tooltip.dataset.content = content;
      if (!bold) tooltip.textContent = text;
      else tooltip.replaceChildren(...text.split(/(\d+)/).map((part, index) => {
        if (index % 2 === 0) return document.createTextNode(part);
        const number = document.createElement('strong');
        number.textContent = part;
        return number;
      }));
    }
    if (!tooltip.matches(':popover-open')) tooltip.showPopover();
    positionPopover(tooltip, node, node.dataset.tooltipPlacement === 'above' ? 'above' : 'below');
  }

  function hover(node: HTMLElement): void
  {
    const delay = Number(node.dataset.tooltipDelay ?? 0);
    // keep an open tooltip without a new delay when a nested target repeats its text
    if (!delay || node === target || (target && target.dataset.tooltip === node.dataset.tooltip)) { show(node); return; }
    if (node === pending) return;
    // keep the running delay when a nested target repeats the pending text
    if (pending && pending.dataset.tooltip === node.dataset.tooltip) { pending = node; return; }
    // wait for the pointer to rest so sweeping across delayed targets opens nothing
    if (target) close();
    clearTimeout(timer);
    pending = node;
    timer = setTimeout(() => {
      // show the latest hovered target that shares the pending text
      const waiting = pending;
      pending = null;
      if (waiting?.matches(':hover')) show(waiting);
    }, delay);
  }

  function findTarget(value: EventTarget | null): HTMLElement | null
  {
    return value instanceof Element ? value.closest<HTMLElement>(selector) : null;
  }

  document.addEventListener('pointerover', event => {
    const node = findTarget(event.target);
    if (event.pointerType === 'mouse' && node) hover(node);
  });
  document.addEventListener('pointerout', event => { if (target && findTarget(event.target) === target) leave(); });
  // show on keyboard focus only so focus returned after mouse-closed dialogs stays silent
  document.addEventListener('focusin', event => { const node = findTarget(event.target); if (node?.matches(':focus-visible')) show(node); });
  document.addEventListener('focusout', event => { if (target && findTarget(event.target) === target) leave(); });
  // close before a click opens a dialog or replaces the row
  document.addEventListener('click', event => {
    const node = findTarget(event.target);
    if (node && (node === target || node === pending)) close();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  document.addEventListener('visibilitychange', close);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, { capture: true });
}
