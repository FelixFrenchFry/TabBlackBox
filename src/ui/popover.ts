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
