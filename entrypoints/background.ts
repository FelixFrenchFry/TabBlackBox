import { defineBackground } from 'wxt/utils/define-background';
import { Repository } from '../src/database';
import { BackupBusyError, Controller } from '../src/controller';
import { scanBrowser, restoreBrowser } from '../src/browser';
import { errorMessage } from '../src/model';
import { parseRequest, type Data, type Reply } from '../src/protocol';

export default defineBackground(() => {
  const controller = new Controller(new Repository(), scanBrowser, restoreBrowser, () => { void badge(); });
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
    if (alarm.name === alarmName) void controller.capture('automatic').then(badge, badge);
  });

  async function handle(input: unknown): Promise<Data> {
    const request = parseRequest(input);
    switch (request.kind) {
      case 'overview': return { kind: 'overview', overview: await controller.overview() };
      case 'refresh':
      case 'backup':
        try { await controller.capture(request.kind === 'backup' ? 'manual' : 'automatic'); }
        catch (error) {
          if (error instanceof BackupBusyError) throw error;
          // return the error status and saved history after startup recovery fails
        }
        await badge();
        return { kind: 'overview', overview: await controller.overview() };
      case 'history': return { kind: 'history', items: await controller.repository.list(request.before) };
      case 'snapshot': return { kind: 'snapshot', snapshot: await controller.repository.get(request.id) };
      case 'restore':
        await controller.restore(request.id);
        return { kind: 'accepted' };
    }
  }

  chrome.runtime.onMessage.addListener((input: unknown, sender, sendResponse: (reply: Reply) => void) => {
    if (sender.id !== chrome.runtime.id || ![chrome.runtime.getURL('/popup.html'), chrome.runtime.getURL('/backups.html')].includes(sender.url?.split('#')[0] ?? '')) return false;
    void handle(input).then(data => sendResponse({ ok: true, data }), (error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  });

  async function initialize(): Promise<void> {
    if (!await chrome.alarms.get(alarmName)) await chrome.alarms.create(alarmName, { periodInMinutes: 1 });
    await controller.start();
    await badge();
  }
  void initialize().catch((error: unknown) => { controller.status = { kind: 'error', message: errorMessage(error) }; void badge(); });
});
