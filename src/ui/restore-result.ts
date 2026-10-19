import type { Operation } from '../model';
import { timestamp } from './dates';
import { el, icon, icons, plural, request } from './shared';

export function createRestoreResult(label: (title: string, url: string | null) => HTMLElement, onDismiss: () => void = () => {})
{
  const element = el('section', 'restore-result');
  element.setAttribute('role', 'region');
  element.setAttribute('aria-label', 'Restoration result');
  element.hidden = true;
  let displayed: Operation | null = null;
  let dismissed: { snapshotId: string; startedAt: number } | null = null;

  function update(operation: Operation | null): void
  {
    const issues = operation?.issues ?? [];
    const visible = operation && operation.kind !== 'running' && !operation.dismissed &&
      !(dismissed?.snapshotId === operation.snapshotId && dismissed.startedAt === operation.startedAt) &&
      (operation.kind === 'interrupted' || operation.failed > 0 || operation.groupErrors > 0 || operation.errors.length > 0 || issues.length > 0);
    element.hidden = !visible;
    if (!visible) { displayed = null; return; }
    // keep expanded details and focused links intact during overview polling
    if (displayed?.snapshotId === operation.snapshotId && displayed.startedAt === operation.startedAt && displayed.kind === operation.kind) return;
    displayed = operation;
    const header = el('div', 'restore-result-header');
    const heading = el('h2', '', operation.kind === 'interrupted' ? 'Restoration interrupted' : 'Restoration finished with issues');
    heading.prepend(icon(operation.kind === 'interrupted' ? icons.CircleAlert : icons.TriangleAlert, 18));
    header.append(heading);
    const source = el('p', 'restore-result-source muted');
    source.append(document.createTextNode(`${operation.name || 'Unnamed session'} · `), timestamp(operation.finishedAt));
    const counts = el('div', 'restore-result-counts');
    const opened = el('span', 'restore-result-opened', `${plural(operation.opened, 'tab')} opened`);
    opened.prepend(icon(icons.Check));
    counts.append(opened);
    if (operation.failed) {
      const failed = el('span', 'restore-result-error', `${operation.failed} failed`);
      failed.prepend(icon(icons.CircleX));
      counts.append(failed);
    }
    if (operation.skipped) counts.append(el('span', 'muted', `${operation.skipped} skipped`));
    if (operation.groupErrors) counts.append(el('span', 'restore-result-error', plural(operation.groupErrors, 'group error')));
    element.replaceChildren(header, source, counts);
    if (operation.kind === 'interrupted') element.append(el('p', 'restore-result-interrupted', 'Restoration stopped before completion. Tabs already opened remain available. Restoring again can create duplicates.'));
    if (issues.length || operation.errors.length) {
      const details = el('details', 'restore-result-details');
      details.open = true;
      const summary = el('summary');
      summary.append(icon(icons.ChevronDown), document.createTextNode(issues.length && issues.every(issue => issue.kind === 'tab') ? plural(operation.failed, 'failed tab') : 'Restoration details'));
      const list = el('ul', 'tab-list');
      // released results have plain error strings without saved tab identities
      if (!issues.length) {
        for (const message of operation.errors) list.append(el('li', 'restore-result-item restore-result-error', message));
      }
      for (const issue of issues) {
        const item = el('li', 'restore-result-item');
        if (issue.kind === 'group') item.append(el('strong', '', issue.title));
        else item.append(label(issue.title, issue.url));
        item.append(el('p', 'restore-result-error', issue.message));
        list.append(item);
      }
      details.append(summary, list);
      if (issues.length === 20 || !issues.length && operation.errors.length === 20) details.append(el('p', 'muted', 'Details are limited to the first 20 issues.'));
      element.append(details);
    }
  }

  // closing the displayed result dismisses it for every page and later visits
  async function dismiss(): Promise<void>
  {
    const operation = displayed;
    if (!operation) return;
    const identity = { snapshotId: operation.snapshotId, startedAt: operation.startedAt };
    dismissed = identity;
    displayed = null;
    element.hidden = true;
    onDismiss();
    try {
      await request({ kind: 'dismiss-restore', id: identity.snapshotId, startedAt: identity.startedAt });
    } catch (error) {
      // a failed write shows the result again with the next overview
      if (dismissed === identity) dismissed = null;
      throw error;
    }
  }

  return { element, update, dismiss };
}
