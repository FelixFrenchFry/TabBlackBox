export function positionPopover(content: HTMLElement, trigger: HTMLElement, placement: 'below' | 'above' = 'below'): void
{
  // position in the top layer so panel clipping cannot hide the explanation
  const anchor = trigger.getBoundingClientRect();
  const popup = content.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  content.style.left = `${Math.max(16, Math.min(anchor.left, width - popup.width - 16))}px`;
  const below = anchor.bottom + 8;
  const above = anchor.top - popup.height - 8;
  // prefer the requested side and switch when the popover does not fit there
  const top = placement === 'above' ? (above >= 16 ? above : below) : (anchor.bottom + popup.height + 24 <= height ? below : above);
  content.style.top = `${Math.max(16, top)}px`;
}
