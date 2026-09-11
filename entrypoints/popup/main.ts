import { errorMessage } from '../../src/model';
import { setup, brand, button, icons, el, request, statusView, notice } from '../../src/ui/shared';

const root = setup();
const header = el('header', 'popup-header');
header.append(brand(), el('span', 'badge', 'Local'));
const content = el('main', 'popup-content');
const status = el('div', 'status-region');
const feedback = el('div');
feedback.setAttribute('aria-live', 'polite');
const save = button('Back up now', icons.Save, 'button primary');
const history = button('View backups', icons.History);
const actions = el('div', 'popup-actions');
actions.append(save, history);
content.append(status, feedback, actions);
root.append(header, content, el('footer', 'popup-footer', 'Stored on this device. No account needed.'));

let busy = false;
async function refresh(kind: 'overview' | 'refresh' | 'backup'): Promise<void> {
  if (busy) return;
  busy = true;
  if (kind === 'backup') save.disabled = true;
  try {
    const data = await request({ kind });
    if (data.kind !== 'overview') throw new Error('Unexpected background response.');
    status.replaceChildren(statusView(data.overview));
    save.disabled = data.overview.status.kind === 'restoring';
    if (kind === 'backup') feedback.replaceChildren(el('p', 'muted', data.overview.status.kind === 'current' ? 'Current session is saved.' : data.overview.status.kind === 'pending' ? 'Tabs changed during capture. Automatic backup will retry.' : ''));
  } catch (error) { feedback.replaceChildren(notice(errorMessage(error))); save.disabled = false; }
  finally { busy = false; }
}
save.addEventListener('click', () => { void refresh('backup'); });
history.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('/backups.html') }); });
void refresh('refresh');
setInterval(() => { void refresh('overview'); }, 1500);
