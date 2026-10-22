import { errorMessage } from '../../src/model';
import { setup, brand, button, icon, icons, el, request, createStatusView, notice } from '../../src/ui/shared';
import { createRefreshQueue } from '../../src/ui/refresh-queue';
import { createBackupButton } from '../../src/ui/backup-button';
import { createClosedTabs } from '../../src/ui/closed-tabs';
import { privacyLink } from '../../src/ui/privacy';

const root = setup();
const header = el('header', 'popup-header');
const settings = button('', icons.Settings, 'button invisible icon-button');
settings.setAttribute('aria-label', 'Settings');
settings.title = 'Settings';
header.append(brand(), settings);
const content = el('main', 'popup-content');
const statusCard = createStatusView();
const status = statusCard.element;
status.classList.add('status-region');
const feedback = el('div', 'popup-feedback');
feedback.setAttribute('aria-live', 'polite');
const backup = createBackupButton(() => { void refresh('backup'); });
const history = button('View backups', icons.History);
const actions = el('div', 'popup-actions');
const closedTabs = createClosedTabs(error => { feedback.replaceChildren(notice(errorMessage(error))); });
// place the backup button above a row holding the history and closed tabs buttons
actions.append(backup.element, history, closedTabs.element);
content.append(status, actions, feedback);
const footer = el('footer', 'popup-footer');
footer.append(icon(icons.LockKeyhole, 14), el('span', '', 'Backups stay on this device. No accounts. No cloud.'), privacyLink());
root.append(header, content, footer);

let backingUp = false;
let restoring = false;
function updateSave(): void
{
  backup.update(backingUp, restoring);
}
const refresh = createRefreshQueue(async kind =>
{
  if (kind === 'backup') feedback.replaceChildren();
  try {
    const data = await request({ kind });
    if (data.kind !== 'overview') throw new Error('Unexpected background response.');
    statusCard.update(data.overview);
    restoring = data.overview.status.kind === 'restoring';
    updateSave();
    if (kind === 'backup') backup.finish(data.captureResult);
  } catch (error) { feedback.replaceChildren(notice(errorMessage(error))); }
}, value => { backingUp = value; updateSave(); });
history.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('/backups.html') }); });
settings.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('/backups.html#settings') }); });
void refresh('refresh');
void closedTabs.load();
setInterval(() => { void refresh('overview'); }, 1500);
