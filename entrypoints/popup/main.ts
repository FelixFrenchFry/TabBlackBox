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
const feedback = el('div', 'popup-feedback');
feedback.setAttribute('aria-live', 'polite');
const save = el('button', 'button primary popup-save');
save.type = 'button';
const saveLabel = document.createTextNode('Back up now');
const saveIcons = { idle: icon(icons.Save), saving: icon(icons.LoaderCircle), saved: icon(icons.Check) };
saveIcons.saving.classList.add('save-spinner');
let displayedState: keyof typeof saveIcons = 'idle';
save.setAttribute('aria-live', 'polite');
save.append(saveIcons.idle, saveLabel);
const history = button('View backups', icons.History);
const actions = el('div', 'popup-actions');
actions.append(save, history);
content.append(status, actions, feedback);
const footer = el('footer', 'popup-footer');
footer.append(icon(icons.LockKeyhole, 14), el('span', '', 'Backups are stored on this device. No accounts. No cloud.'));
root.append(header, content, footer);

let backingUp = false;
let restoring = false;
let saved = false;
function updateSave(): void
{
  const state = backingUp ? 'saving' : saved ? 'saved' : 'idle';
  save.disabled = backingUp || saved || restoring;
  save.setAttribute('aria-busy', String(backingUp));
  save.classList.toggle('is-saved', state === 'saved');
  save.classList.toggle('is-saving', state === 'saving');
  // preserve the icon and text during polls so pointer clicks remain intact
  if (state !== displayedState) {
    saveIcons[displayedState].replaceWith(saveIcons[state]);
    displayedState = state;
  }
  const label = backingUp ? 'Backing up…' : saved ? 'Saved' : 'Back up now';
  if (saveLabel.data !== label) saveLabel.data = label;
}
const refresh = createRefreshQueue(async kind =>
{
  if (kind === 'backup') feedback.replaceChildren();
  try {
    const data = await request({ kind });
    if (data.kind !== 'overview') throw new Error('Unexpected background response.');
    status.replaceChildren(statusView(data.overview));
    restoring = data.overview.status.kind === 'restoring';
    updateSave();
    if (kind === 'backup' && data.overview.status.kind === 'current') {
      saved = true;
      // hold the confirmation independently of subsequent status polls
      setTimeout(() => { saved = false; updateSave(); }, 2000);
    } else if (kind === 'backup' && data.overview.status.kind === 'pending') {
      feedback.replaceChildren(el('p', 'muted', 'Tabs changed during capture. Automatic backup will retry.'));
    }
  } catch (error) { feedback.replaceChildren(notice(errorMessage(error))); }
}, value => { backingUp = value; updateSave(); });
save.addEventListener('click', () => { if (!save.disabled) void refresh('backup'); });
history.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('/backups.html') }); });
settings.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('/backups.html#settings') }); });
void refresh('refresh');
setInterval(() => { void refresh('overview'); }, 1500);
