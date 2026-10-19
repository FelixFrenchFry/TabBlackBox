import type { Operation, Status } from '../model';
import { button, el, icon, icons, notice, plural } from './shared';
import { createRestoreResult } from './restore-result';

type DialogLifecycle = { acquire(): boolean; release(): void; focus(): void };

export function createRestoreDialog(label: (title: string, url: string | null) => HTMLElement, lifecycle: DialogLifecycle)
{
  const element = button('View restore issues', icons.CircleAlert, 'button small restore-result-open');
  element.hidden = true;
  let operation: Operation | null = null;
  let dialog: HTMLDialogElement | null = null;
  let pending: { snapshotId: string; previous: Operation | null; accepted: boolean } | null = null;
  let interrupted = false;
  const result = createRestoreResult(label, () => { element.hidden = true; });
  const progress = el('div', 'restore-progress');
  const title = el('h2', 'dialog-heading', 'Restoring session');
  title.prepend(icon(icons.LoaderCircle));
  const counts = el('div', 'restore-progress-counts');
  counts.setAttribute('role', 'status');
  const meter = el('progress', 'storage-meter');
  meter.setAttribute('aria-label', 'Restoration progress');
  progress.append(title, counts, meter);
  const hide = button('Hide', icons.X);
  hide.addEventListener('click', () => dialog?.close());
  const actions = el('div', 'dialog-actions');
  actions.append(hide);

  function showContent(): void
  {
    if (!dialog?.open) return;
    const content = pending || interrupted || operation?.kind === 'running' ? progress : result.element;
    dialog.classList.add('restore-operation-dialog');
    dialog.classList.toggle('restore-operation-issues', interrupted || content === result.element);
    dialog.removeAttribute('aria-labelledby');
    dialog.setAttribute('aria-label', interrupted ? 'Restoration interrupted' : content === progress ? 'Restoring session' : 'Restoration result');
    // hiding keeps a running restoration available while closing a finished result dismisses it
    const label = !interrupted && content === progress ? 'Hide' : 'Close';
    if (hide.textContent !== label) hide.replaceChildren(icon(icons.X), document.createTextNode(label));
    if (dialog.firstElementChild === content) return;
    const focused = dialog.contains(document.activeElement);
    dialog.replaceChildren(content, actions);
    if (focused) hide.focus();
  }

  function track(element: HTMLDialogElement): void
  {
    dialog = element;
    element.addEventListener('close', () => {
      if (dialog === element) dialog = null;
      if (element.firstElementChild === result.element) void result.dismiss().catch(() => { /* the result stays available for another close */ });
    }, { once: true });
  }

  function showInterruption(message: string): void
  {
    interrupted = true;
    element.hidden = false;
    element.replaceChildren(icon(icons.CircleAlert), document.createTextNode('View restore issues'));
    title.replaceChildren(icon(icons.CircleAlert), document.createTextNode('Restoration interrupted'));
    counts.replaceChildren(notice(message));
    meter.hidden = true;
    showContent();
  }

  element.addEventListener('click', () => {
    if (element.hidden || !lifecycle.acquire()) return;
    const opened = el('dialog', 'restore-dialog');
    // dismiss a closed result before choosing the focus target so focus never lands on the hidden button
    track(opened);
    opened.addEventListener('close', () => { opened.remove(); lifecycle.release(); lifecycle.focus(); }, { once: true });
    document.getElementById('app')?.append(opened);
    opened.showModal();
    showContent();
    hide.focus();
  });

  return {
    element,
    get starting(): boolean { return pending !== null; },
    // identify overview requests made after admission without trusting older responses
    get pendingRequest(): object | null { return pending?.accepted ? pending : null; },
    accepted(): void { if (pending) pending.accepted = true; },
    begin(opened: HTMLDialogElement, snapshotId: string): void
    {
      // ignore the previous stored result until this request produces a new operation
      pending = { snapshotId, previous: operation, accepted: false };
      interrupted = false;
      title.replaceChildren(icon(icons.LoaderCircle), document.createTextNode('Restoring session'));
      // detach the old result so a delayed dismissal cannot affect this dialog
      result.update(null);
      element.hidden = false;
      element.replaceChildren(icon(icons.LoaderCircle), document.createTextNode('View restore progress'));
      counts.textContent = 'Preparing restoration…';
      meter.hidden = false;
      meter.removeAttribute('value');
      track(opened);
      showContent();
    },
    cancel(opened: HTMLDialogElement): void
    {
      pending = null;
      if (dialog === opened) dialog = null;
      opened.classList.remove('restore-operation-dialog', 'restore-operation-issues');
      this.update(operation);
    },
    update(next: Operation | null, status?: Status, pendingRequest?: object | null): void
    {
      if (pending) {
        if (!next || next.snapshotId !== pending.snapshotId || next.snapshotId === pending.previous?.snapshotId && next.startedAt === pending.previous.startedAt) {
          // initial persistence can fail before the new operation exists
          if (pendingRequest === pending && status && status.kind !== 'restoring') {
            pending = null;
            showInterruption(status.kind === 'error' ? status.message : 'Restoration stopped before progress could be saved. Check your open tabs before restoring again.');
          }
          return;
        }
        pending = null;
      }
      if (interrupted && next?.snapshotId === operation?.snapshotId && next?.startedAt === operation?.startedAt && next?.kind === operation?.kind) return;
      interrupted = false;
      operation = next;
      result.update(next);
      const running = next?.kind === 'running';
      // report a failed progress write even if recovery could not update the running record
      if (running && status?.kind === 'error') { showInterruption(status.message); return; }
      element.hidden = !running && result.element.hidden;
      element.replaceChildren(icon(running ? icons.LoaderCircle : icons.CircleAlert), document.createTextNode(running ? 'View restore progress' : 'View restore issues'));
      if (running) {
        const parts = [`${plural(next.opened, 'tab')} opened`];
        if (next.failed) parts.push(`${next.failed} failed`);
        if (next.skipped) parts.push(`${next.skipped} skipped`);
        if (next.groupErrors) parts.push(plural(next.groupErrors, 'group error'));
        const text = parts.join(' · ');
        if (counts.textContent !== text) counts.textContent = text;
        meter.max = Math.max(next.total, 1);
        meter.value = next.opened + next.failed + next.skipped;
      }
      // hidden operations stay hidden until explicitly reopened
      if (!dialog?.open) return;
      if (element.hidden) dialog.close();
      else showContent();
    },
  };
}
