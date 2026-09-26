import { createElement, Archive, ArrowDown, ArrowUp, ArrowUpDown, ArrowUpRight, Check, ChevronDown, CircleAlert, CircleQuestionMark, Clock3, Download, FileText, Globe, HardDrive, History, LoaderCircle, LockKeyhole, Monitor, Palette, Pencil, Pin, RotateCcw, Save, Settings, ShieldCheck, Trash2, Upload, type IconNode } from 'lucide';
import type { Data, Reply, Request } from '../protocol';
import type { Overview } from '../model';
import { initializeAppearance } from './appearance';
import { initializeDates, setTimestamp, timestamp } from './dates';
import './style.css';

export const icons = { Archive, ArrowDown, ArrowUp, ArrowUpDown, ArrowUpRight, Check, ChevronDown, CircleAlert, CircleQuestionMark, Clock3, Download, FileText, Globe, HardDrive, History, LoaderCircle, LockKeyhole, Monitor, Palette, Pencil, Pin, RotateCcw, Save, Settings, ShieldCheck, Trash2, Upload };

export function icon(node: IconNode, size = 16): SVGElement
{
  return createElement(node, { width: size, height: size, 'stroke-width': 1.75, 'aria-hidden': 'true', focusable: 'false' });
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K]
{
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

export function button(label: string, glyph: IconNode, className = 'button'): HTMLButtonElement
{
  const element = el('button', className);
  element.type = 'button';
  element.append(icon(glyph), document.createTextNode(label));
  return element;
}

export async function request(message: Request): Promise<Data>
{
  const reply: Reply | undefined = await chrome.runtime.sendMessage(message);
  if (!reply) throw new Error('The background service is unavailable. Try again.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

export function setup(): HTMLElement
{
  initializeAppearance();
  initializeDates();
  const root = document.getElementById('app');
  if (!root) throw new Error('Application root is missing.');
  return root;
}

export function brand(): HTMLElement
{
  const item = el('div', 'brand');
  const logo = el('img', 'logo');
  logo.src = '/icon/logo.svg';
  logo.alt = '';
  item.append(logo, el('span', '', 'TabBlackBox'));
  return item;
}

export function createStatusView(action?: HTMLButtonElement)
{
  const element = el('section', 'status-card');
  element.setAttribute('aria-label', 'Backup status');
  const title = el('div', 'status-title');
  const titleText = el('span');
  const heading = el('strong');
  const resumeAt = el('span', 'muted pause-resume-time');
  const resumeTime = timestamp(null);
  resumeAt.append(document.createTextNode(' ('), resumeTime, document.createTextNode(')'));
  resumeAt.hidden = true;
  titleText.append(heading, resumeAt);
  let glyph = icons.Clock3;
  let glyphNode = icon(glyph, 20);
  title.append(glyphNode, titleText);
  const description = el('p', 'muted');
  const detailCopy = el('span');
  const scheduledCopy = el('span', 'scheduled-backup');
  const scheduledTime = timestamp(null);
  const scheduledValue = el('strong', 'scheduled-backup-time');
  scheduledValue.append(scheduledTime);
  scheduledCopy.append(el('span', 'scheduled-backup-label', 'Next automatic backup:'), scheduledValue);
  scheduledCopy.hidden = true;
  description.append(detailCopy, scheduledCopy);
  const times = el('div', 'status-times');
  const saved = el('span', '', 'Last saved ');
  const savedTime = timestamp(null);
  saved.append(savedTime);
  const checked = el('span', '', 'Last checked ');
  const checkedTime = timestamp(null);
  checked.append(checkedTime);
  times.append(saved, checked);
  if (action) {
    const content = el('div', 'automatic-status-content');
    content.append(title, description, times);
    const wrapper = el('div', 'automatic-status-wrapper');
    wrapper.append(content, action);
    element.append(wrapper);
  } else element.append(title, description, times);
  return {
    element,
    update(overview: Overview): void
    {
      const { metadata, latest, status } = overview;
      const automatic = metadata.automatic;
      const suspended = status.kind !== 'error' && status.kind !== 'restoring'
        ? !automatic.enabled ? 'disabled' : automatic.pausedUntil !== null && automatic.pausedUntil > Date.now() ? 'paused' : null
        : null;
      const due = metadata.lastSavedAt === null ? null : metadata.lastSavedAt + automatic.intervalMinutes * 60_000;
      const waiting = suspended === null && status.kind === 'pending' && due !== null && due > Date.now();
      const currentLabel = latest?.source === 'automatic' ? 'Current tabs backed up automatically' : latest?.source === 'manual' ? 'Current tabs backed up manually' : 'Current session is backed up';
      const label = waiting ? 'Changes waiting for the next backup' : suspended === 'disabled' ? 'Automatic backups are off' : suspended === 'paused' ? 'Automatic backups are paused' : status.kind === 'error' ? 'Backup needs attention' : status.kind === 'pending' ? 'Changes waiting to be saved' : status.kind === 'restoring' ? 'Restoring session' : status.kind === 'empty' ? 'No eligible tabs open' : status.kind === 'current' ? currentLabel : 'Checking your tabs';
      const detail = suspended === 'disabled' ? 'Use Back up now to save your tabs manually.' : suspended === 'paused' ? 'Automatic backups will resume when the pause ends. Manual backups remain available.' : status.kind === 'error' ? status.message : status.kind === 'current' && latest ? `${latest.windowCount} windows · ${latest.tabCount} tabs in the latest backup` : status.kind === 'restoring' ? 'Opening your saved tabs in new windows.' : status.kind === 'empty' ? 'Your previous backups are still available.' : 'Automatic backups run when your tabs change.';
      const className = 'status-card status-' + (suspended ?? status.kind);
      if (element.className !== className) element.className = className;
      if (heading.textContent !== label) heading.textContent = label;
      if (detailCopy.textContent !== detail) detailCopy.textContent = detail;
      detailCopy.hidden = waiting;
      scheduledCopy.hidden = !waiting;
      setTimestamp(scheduledTime, waiting ? due : null);
      const nextGlyph = suspended ? icons.Clock3 : status.kind === 'error' ? icons.CircleAlert : status.kind === 'current' ? icons.ShieldCheck : icons.Clock3;
      if (glyph !== nextGlyph) {
        const nextNode = icon(nextGlyph, 20);
        glyphNode.replaceWith(nextNode);
        glyphNode = nextNode;
        glyph = nextGlyph;
      }
      // preserve time nodes across polls so only the date clock advances unchanged timestamps
      resumeAt.hidden = suspended !== 'paused';
      setTimestamp(resumeTime, suspended === 'paused' ? automatic.pausedUntil : null);
      setTimestamp(savedTime, metadata.lastSavedAt);
      setTimestamp(checkedTime, metadata.lastCheckedAt);
    },
  };
}
export function notice(message: string): HTMLElement
{
  const node = el('div', 'notice error-notice', message);
  node.setAttribute('role', 'alert');
  return node;
}

export function plural(count: number, label: string): string { return `${count} ${label}${count === 1 ? '' : 's'}`; }
