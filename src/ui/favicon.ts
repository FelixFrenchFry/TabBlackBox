import { fileUrl, restorableUrl } from '../session';
import { el, icon, icons } from './shared';

export function favicon(url: string | null): HTMLElement
{
  const frame = el('span', 'tab-favicon');
  frame.setAttribute('aria-hidden', 'true');
  const fallback = icon(fileUrl(url) ? icons.FileText : icons.Globe);
  if (restorableUrl(url) && url !== 'about:blank') {
    // retrieve website icons through Chrome using the saved page URL
    const source = new URL(chrome.runtime.getURL('/_favicon/'));
    source.searchParams.set('pageUrl', url);
    source.searchParams.set('size', '32');
    const image = el('img');
    image.alt = '';
    image.width = 16;
    image.height = 16;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => frame.replaceChildren(fallback), { once: true });
    image.src = source.href;
    frame.append(image);
  } else frame.append(fallback);
  return frame;
}
