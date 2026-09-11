import { defineBackground } from 'wxt/utils/define-background';
import { Repository } from '../src/database';
import { Controller } from '../src/controller';
import { scanBrowser, restoreBrowser } from '../src/browser';
import { errorMessage } from '../src/model';
import { parseRequest, type Data, type Reply } from '../src/protocol';

export default defineBackground(() => {
  const controller = new Controller(new Repository(), scanBrowser, restoreBrowser);
  const changed = () => controller.changed();
  const alarmName = 'reconcile-session';

  async function badge(): Promise<void> {
    const failed = controller.status.kind === 'error';
    await chrome.action.setBadgeText({ text: failed ? '!' : '' });
    if (failed) await chrome.action.setBadgeBackgroundColor({ color: '#cf222e' });
  }

  chrome.tabs.onCreated.addListener(changed);
  chrome.tabs.onRemoved.addListener(changed);
  chrome.tabs.onMoved.addListener(changed);
  chrome.tabs.onAttached.addListener(changed);
  chrome.tabs.onDetached.addListener(changed);
  chrome.tabs.onReplaced.addListener(changed);
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if ('url' in change || 'title' in change || 'pinned' in change || 'groupId' in change) changed();
  });
  chrome.windows.onCreated.addListener(changed);
  chrome.windows.onRemoved.addListener(changed);
  chrome.tabGroups.onCreated.addListener(changed);
  chrome.tabGroups.onUpdated.addListener(changed);
  chrome.tabGroups.onMoved.addListener(changed);
  chrome.tabGroups.onRemoved.addListener(changed);
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === alarmName) void controller.capture('automatic').then(badge);
  });

  async function handle(input: unknown): Promise<Data> {
    const request = parseRequest(input);
    await controller.start();
    switch (request.kind) {
      case 'overview': return { kind: 'overview', overview: await controller.overview() };
      case 'refresh':
      case 'backup':
        await controller.capture(request.kind === 'backup' ? 'manual' : 'automatic');
        await badge();
        return { kind: 'overview', overview: await controller.overview() };
      case 'history': return { kind: 'history', items: await controller.repository.list(request.offset) };
      case 'snapshot': return { kind: 'snapshot', snapshot: await controller.repository.get(request.id) };
      case 'restore':
        await controller.restore(request.id);
        return { kind: 'accepted' };
    }
  }

  chrome.runtime.onMessage.addListener((input: unknown, sender, sendResponse: (reply: Reply) => void) => {
    if (sender.id !== chrome.runtime.id || ![chrome.runtime.getURL('/popup.html'), chrome.runtime.getURL('/backups.html')].includes(sender.url ?? '')) return false;
    void handle(input).then(data => sendResponse({ ok: true, data }), (error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  });

  async function initialize(): Promise<void> {
    await controller.start();
    if (!await chrome.alarms.get(alarmName)) await chrome.alarms.create(alarmName, { periodInMinutes: 1 });
    await badge();
  }
  void initialize().catch((error: unknown) => { controller.status = { kind: 'error', message: errorMessage(error) }; void badge(); });
});
