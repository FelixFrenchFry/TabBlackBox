import { createElement, Archive, ArrowUpRight, Check, ChevronDown, CircleAlert, Clock3, HardDrive, History, LoaderCircle, Monitor, Palette, Pin, RotateCcw, Save, Settings, ShieldCheck, type IconNode } from 'lucide';
import type { Data, Reply, Request } from '../protocol';
import type { Overview } from '../model';
import { initializeAppearance } from './appearance';
import './style.css';

export const icons = { Archive, ArrowUpRight, Check, ChevronDown, CircleAlert, Clock3, HardDrive, History, LoaderCircle, Monitor, Palette, Pin, RotateCcw, Save, Settings, ShieldCheck };

export function icon(node: IconNode, size = 16): SVGElement {
  return createElement(node, { width: size, height: size, 'stroke-width': 1.75, 'aria-hidden': 'true', focusable: 'false' });
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

export function button(label: string, glyph: IconNode, className = 'button'): HTMLButtonElement {
  const element = el('button', className);
  element.type = 'button';
  element.append(icon(glyph), document.createTextNode(label));
  return element;
}

export async function request(message: Request): Promise<Data> {
  const reply: Reply | undefined = await chrome.runtime.sendMessage(message);
  if (!reply) throw new Error('The background service is unavailable. Try again.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

export function setup(): HTMLElement {
  initializeAppearance();
  const root = document.getElementById('app');
  if (!root) throw new Error('Application root is missing.');
  return root;
}

export function brand(): HTMLElement {
  const item = el('div', 'brand');
  const logo = el('img', 'logo');
  logo.src = '/icon/logo.svg';
  logo.alt = '';
  item.append(logo, el('span', '', 'TabBlackBox'));
  return item;
}

export function formatTime(value: number | null): string {
  return value === null ? 'Not yet saved' : new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function statusView(overview: Overview): HTMLElement {
  const { status, metadata, latest } = overview;
  const view = el('section', `status-card status-${status.kind}`);
  view.setAttribute('aria-label', 'Backup status');
  const title = el('div', 'status-title');
  const label = status.kind === 'error' ? 'Backup needs attention' : status.kind === 'pending' ? 'Changes waiting to be saved' : status.kind === 'restoring' ? 'Restoring session' : status.kind === 'empty' ? 'No eligible tabs open' : status.kind === 'current' ? 'Your tabs are backed up' : 'Checking your tabs';
  title.append(icon(status.kind === 'error' ? icons.CircleAlert : status.kind === 'current' ? icons.ShieldCheck : icons.Clock3, 20), el('strong', '', label));
  const detail = status.kind === 'error' ? status.message : status.kind === 'current' && latest ? `${latest.windowCount} windows · ${latest.tabCount} tabs in the latest backup` : status.kind === 'restoring' ? 'Opening your saved tabs in new windows.' : status.kind === 'empty' ? 'Your previous backups are still available.' : 'Automatic backups run when your tabs change.';
  view.append(title, el('p', 'muted', detail));
  const times = el('div', 'status-times');
  times.append(el('span', '', `Last saved ${formatTime(metadata.lastSavedAt)}`), el('span', '', `Last checked ${formatTime(metadata.lastCheckedAt)}`));
  view.append(times);
  return view;
}

export function notice(message: string): HTMLElement {
  const node = el('div', 'notice error-notice', message);
  node.setAttribute('role', 'alert');
  return node;
}

export function plural(count: number, label: string): string { return `${count} ${label}${count === 1 ? '' : 's'}`; }
