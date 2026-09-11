import { errorMessage } from '../../src/model';
import { setup, brand, button, icon, icons, el, request, statusView, notice } from '../../src/ui/shared';
import { createRefreshQueue } from '../../src/ui/refresh-queue';

const root = setup();
const header = el('header', 'popup-header');
const headerActions = el('div', 'popup-header-actions');
const settings = button('', icons.Settings, 'button icon-button');
settings.setAttribute('aria-label', 'Settings');
settings.title = 'Settings';
headerActions.append(el('span', 'badge', 'Local'), settings);
header.append(brand(), headerActions);
const content = el('main', 'popup-content');
const status = el('div', 'status-region');
const feedback = el('div');
feedback.setAttribute('aria-live', 'polite');
const save = el('button', 'button primary');
save.type = 'button';
const saveLabel = document.createTextNode('Back up now');
save.append(icon(icons.Save), saveLabel);
const history = button('View backups', icons.History);
const actions = el('div', 'popup-actions');
actions.append(save, history);
content.append(status, feedback, actions);
root.append(header, content, el('footer', 'popup-footer', 'Stored on this device. No account needed.'));

let backingUp = false;
let restoring = false;
function updateSave(): void {
  save.disabled = backingUp || restoring;
  const label = backingUp ? 'Backing up…' : 'Back up now';
  if (saveLabel.data !== label) saveLabel.data = label;
}
const refresh = createRefreshQueue(async kind => {
  if (kind === 'backup') feedback.replaceChildren();
  try {
    const data = await request({ kind });
    if (data.kind !== 'overview') throw new Error('Unexpected background response.');
    status.replaceChildren(statusView(data.overview));
    restoring = data.overview.status.kind === 'restoring';
    updateSave();
    if (kind === 'backup') feedback.replaceChildren(el('p', 'muted', data.overview.status.kind === 'current' ? 'Current session is saved.' : data.overview.status.kind === 'pending' ? 'Tabs changed during capture. Automatic backup will retry.' : ''));
  } catch (error) { feedback.replaceChildren(notice(errorMessage(error))); }
}, value => { backingUp = value; updateSave(); });
save.addEventListener('click', () => { void refresh('backup'); });
history.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('/backups.html') }); });
settings.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('/backups.html#settings') }); });
void refresh('refresh');
setInterval(() => { void refresh('overview'); }, 1500);
