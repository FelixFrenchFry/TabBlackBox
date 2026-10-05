import { errorMessage } from '../model';
import { brand, button, el, icons, notice, request } from './shared';

export function privacyLink(): HTMLAnchorElement
{
  const link = el('a', 'privacy-link', 'Privacy');
  link.href = chrome.runtime.getURL('/privacy.html');
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

export function requirePrivacyChoice(root: HTMLElement): Promise<void>
{
  // keep application controls hidden until the persisted choice is available
  root.hidden = true;
  const panel = el('main', 'privacy-onboarding');
  const heading = el('h1', '', 'Your tabs stay on this device');
  const detail = el('p', '', 'TabBlackBox saves tab URLs, titles, window and group organization, and timestamps so you can restore your sessions. URLs may contain sensitive information or local file paths.');
  const sharing = el('p', '', 'No accounts, analytics or developer uploads. Backups and exported files are not encrypted.');
  const schedule = el('p', '', 'Automatic backups save session changes periodically. You can change their frequency, pause or disable them in Settings, or use manual backups only.');
  const automatic = button('Enable automatic backups', icons.History, 'button primary');
  const manual = button('Use manual backups', icons.Save);
  const actions = el('div', 'privacy-actions');
  actions.append(automatic, manual);
  const feedback = el('div');
  feedback.setAttribute('role', 'status');
  const retry = button('Retry', icons.RotateCcw);
  retry.hidden = true;
  automatic.disabled = manual.disabled = true;
  panel.append(brand(), heading, detail, sharing, schedule, privacyLink(), actions, feedback, retry);
  root.before(panel);

  return new Promise(resolve => {
    let finished = false;
    function finish(): void
    {
      if (finished) return;
      finished = true;
      window.removeEventListener('focus', check);
      panel.remove();
      root.hidden = false;
      resolve();
    }
    function showError(error: unknown): void
    {
      feedback.replaceChildren(notice(errorMessage(error)));
      retry.hidden = false;
    }
    async function load(): Promise<void>
    {
      retry.hidden = true;
      try {
        const data = await request({ kind: 'privacy-status' });
        if (data.kind !== 'privacy') throw new Error('Unexpected background response.');
        if (data.accepted) finish();
        else {
          feedback.replaceChildren();
          automatic.disabled = manual.disabled = false;
        }
      } catch (error) { showError(error); }
    }
    const check = () => { void load(); };
    async function choose(enabled: boolean): Promise<void>
    {
      automatic.disabled = manual.disabled = true;
      feedback.replaceChildren();
      try {
        const data = await request({ kind: 'privacy-choice', automatic: enabled });
        if (data.kind !== 'privacy' || !data.accepted) throw new Error('Your backup preference was not saved. Try again.');
        finish();
      } catch (error) {
        showError(error);
        automatic.disabled = manual.disabled = false;
      }
    }
    automatic.addEventListener('click', () => { void choose(true); });
    manual.addEventListener('click', () => { void choose(false); });
    retry.addEventListener('click', check);
    // another extension page may have already recorded the choice
    window.addEventListener('focus', check);
    check();
  });
}
