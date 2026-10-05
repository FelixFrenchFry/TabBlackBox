import { placeholderTarget } from '../../src/placeholder';
import { initializeAppearance } from '../../src/ui/appearance';

initializeAppearance();
const heading = document.getElementById('title');
const address = document.getElementById('address');
const message = document.getElementById('message');
const target = placeholderTarget(location.href, chrome.runtime.getURL('/'));

if (target && heading && address && message) {
  document.title = target.title || target.url;
  // show the saved page icon from Chrome's favicon cache without contacting the website
  const source = new URL(chrome.runtime.getURL('/_favicon/'));
  source.searchParams.set('pageUrl', target.url);
  source.searchParams.set('size', '32');
  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.href = source.href;
  document.head.append(icon);
  heading.textContent = document.title;
  address.textContent = target.url;
  const link = document.createElement('a');
  link.href = target.url;
  link.textContent = 'Open page';
  message.append('Restored by TabBlackBox. This page has not been loaded yet. ', link);
  // open the saved page once the tab is shown and replace the placeholder in the tab history
  const open = () => { location.replace(target.url); };
  // new background tabs can briefly report visible, so the browser's active tab state decides when to load
  void chrome.tabs.getCurrent().then(async tab =>
  {
    const id = tab?.id;
    if (id === undefined) return;
    chrome.tabs.onActivated.addListener(({ tabId }) => { if (tabId === id) open(); });
    // check after listening so an activation during setup is not missed
    if ((await chrome.tabs.get(id)).active) open();
  });
} else if (heading) heading.textContent = 'This restored tab has no valid web address.';
