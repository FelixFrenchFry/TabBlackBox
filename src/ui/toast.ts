import { el, icon, icons } from './shared';

export function createToast()
{
  const element = el('div', 'toast-region');
  element.setAttribute('role', 'status');
  element.setAttribute('aria-atomic', 'true');
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clear(): void
  {
    clearTimeout(timer);
    element.replaceChildren();
  }

  return {
    element,
    clear,
    show(message: string, glyph = icons.Check): void
    {
      // replace the previous message and give each notification its full display time
      clear();
      const content = el('div', 'backup-toast');
      content.classList.toggle('is-success', glyph === icons.Check);
      content.append(icon(glyph), el('span', '', message));
      element.append(content);
      timer = setTimeout(clear, 4000);
    },
  };
}
