import { el } from './shared';

export function privacyLink(): HTMLAnchorElement
{
  const link = el('a', 'privacy-link', 'Privacy');
  link.href = chrome.runtime.getURL('/privacy.html');
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}
