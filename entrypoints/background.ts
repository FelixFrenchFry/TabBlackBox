import { defineBackground } from 'wxt/utils/define-background';
import { Repository } from '../src/database';
import { BackupBusyError, Controller, type CaptureSchedule } from '../src/controller';
import { scanBrowser, restoreBrowser } from '../src/browser';
import { errorMessage, type CaptureResult } from '../src/model';
import { HISTORY_INITIAL_LIMIT, HISTORY_PAGE_LIMIT, parseRequest, type Data, type Reply } from '../src/protocol';
import { hasExtensionTabs, isNewerVersion } from '../src/update';

export default defineBackground(() =>
{
  const wakePrefix = 'automatic-backup-wake:';
  let activeWake: string | undefined;
  // startup reconciliation rebuilds schedules after removing alarms from a previous worker
  let alarmWrites = Promise.resolve().then(async () => {
    for (const alarm of await chrome.alarms.getAll()) {
      if (alarm.name.startsWith(wakePrefix)) await chrome.alarms.clear(alarm.name);
    }
  }).catch(() => { /* stale alarm identities cannot claim a new worker's schedule */ });
  // alarms recover suspended timers but may fire later than the requested deadline
  const scheduleWake = (schedule: CaptureSchedule | null) => {
    alarmWrites = alarmWrites.then(async () => {
      if (activeWake !== undefined) await chrome.alarms.clear(activeWake);
      activeWake = schedule === null ? undefined : `${wakePrefix}${schedule.id}`;
      if (schedule !== null && activeWake !== undefined) await chrome.alarms.create(activeWake, { when: schedule.when });
    }).catch(() => { /* periodic reconciliation remains the fallback */ });
  };
  const controller = new Controller(new Repository(), scanBrowser, restoreBrowser, () => { void badge(); }, scheduleWake);
  function failed(error: unknown): void
  {
    controller.status = { kind: 'error', message: errorMessage(error) };
    void badge();
  }
  const changed = () => controller.changed();
  const alarmName = 'reconcile-session';
  const updatePrefix = 'apply-update:';

  async function badge(): Promise<void>
  {
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
  chrome.tabs.onUpdated.addListener((_id, change) =>
  {
    if ('url' in change || 'title' in change || 'pinned' in change || 'groupId' in change) changed();
  });
  chrome.windows.onCreated.addListener(changed);
  chrome.windows.onRemoved.addListener(changed);
  chrome.tabGroups.onCreated.addListener(changed);
  chrome.tabGroups.onUpdated.addListener(changed);
  chrome.tabGroups.onMoved.addListener(changed);
  chrome.tabGroups.onRemoved.addListener(changed);
  chrome.alarms.onAlarm.addListener(alarm =>
  {
    // retry pending updates independently of automatic backup settings
    if (alarm.name.startsWith(updatePrefix)) {
      void applyUpdate(alarm.name.slice(updatePrefix.length)).catch(() => { /* the next alarm retries */ });
      return;
    }
    void (async () => {
      if (alarm.name === alarmName) await controller.capture('automatic');
      else if (alarm.name.startsWith(wakePrefix)) await controller.captureScheduled(alarm.name.slice(wakePrefix.length));
      await badge();
    })().catch(failed);
  });
  // listening defers store updates to a reload or the next browser start
  chrome.runtime.onUpdateAvailable.addListener(({ version }) =>
  {
    // the event fires once per downloaded update, so an alarm keeps retrying across worker restarts
    void (async () => {
      try {
        for (const alarm of await chrome.alarms.getAll()) {
          if (alarm.name.startsWith(updatePrefix)) await chrome.alarms.clear(alarm.name);
        }
        await chrome.alarms.create(`${updatePrefix}${version}`, { periodInMinutes: 1 });
      } catch { /* the immediate attempt still runs and the next browser start applies the update */ }
      await applyUpdate(version);
    })().catch(() => { /* the retry alarm or the next browser start applies the update */ });
  });
  async function applyUpdate(version: string): Promise<void>
  {
    const alarm = `${updatePrefix}${version}`;
    // the retry alarm can outlive an update that a reload or browser start already applied
    if (!isNewerVersion(version, chrome.runtime.getManifest().version)) {
      await chrome.alarms.clear(alarm);
      return;
    }
    // reload only after queued captures and restorations and while no extension page would close
    const queue = controller.idle();
    await queue;
    if (hasExtensionTabs(await chrome.tabs.query({}), chrome.runtime.getURL('/'))) return;
    // work queued during the tab check waits for the next retry
    if (controller.idle() !== queue) return;
    // stop retrying first so a reload that does not apply the update cannot repeat every minute
    await chrome.alarms.clear(alarm);
    chrome.runtime.reload();
  }

  async function handle(input: unknown): Promise<Data>
  {
    const request = parseRequest(input);
    switch (request.kind) {
      case 'automatic-settings':
        await controller.setAutomaticSettings(request.update);
        return { kind: 'overview', overview: await controller.overview() };
      case 'overview': return { kind: 'overview', overview: await controller.overview() };
      case 'storage-settings': return { kind: 'storage-settings', result: await controller.setStorageSettings(request.settings, request.confirmedRemovalCount) };
      case 'restore-settings':
        await controller.repository.setRestoreSettings(request.settings);
        return { kind: 'overview', overview: await controller.overview() };
      case 'refresh':
      case 'backup': {
        let captureResult: CaptureResult | undefined;
        try { captureResult = await controller.capture(request.kind === 'backup' ? 'manual' : 'automatic'); }
        catch (error) {
          if (error instanceof BackupBusyError) throw error;
          // return the error status and saved history after startup recovery fails
        }
        await badge();
        return { kind: 'overview', overview: await controller.overview(), captureResult };
      }
      case 'calendar': return { kind: 'calendar', days: await controller.repository.calendar(request.range) };
      case 'tab-counts': return { kind: 'tab-counts', ...await controller.repository.tabCounts(request.range) };
      case 'top-sites': return { kind: 'top-sites', ...await controller.repository.topSites(request.scope, request.limit) };
      case 'history': return { kind: 'history', ...await controller.repository.history(request.before, request.before ? HISTORY_PAGE_LIMIT : HISTORY_INITIAL_LIMIT, request.collection, request.query, request.sort, request.range, request.tabUrl, request.fields, request.tag) };
      case 'tab-search': return { kind: 'tab-search', ...await controller.repository.searchTabs(request.query, request.limit, request.fields) };
      case 'snapshot': return { kind: 'snapshot', snapshot: await controller.repository.get(request.id) };
      case 'rename': return { kind: 'renamed', summary: await controller.repository.rename(request.id, request.name, request.details) };
      case 'keep': return { kind: 'renamed', summary: await controller.repository.keep(request.id, request.name, Date.now(), request.details) };
      case 'delete-session':
        await controller.deleteSession(request.id);
        return { kind: 'accepted' };
      case 'dismiss-restore':
        await controller.repository.dismissOperation(request.id, request.startedAt);
        return { kind: 'accepted' };
      case 'restore':
        await controller.restore(request.id);
        return { kind: 'accepted' };
      case 'restore-window':
        await controller.restore(request.id, request.windowIndex);
        return { kind: 'accepted' };
    }
  }

  chrome.runtime.onMessage.addListener((input: unknown, sender, sendResponse: (reply: Reply) => void) =>
  {
    if (sender.id !== chrome.runtime.id || ![chrome.runtime.getURL('/popup.html'), chrome.runtime.getURL('/backups.html')].includes(sender.url?.split('#')[0] ?? '')) return false;
    void handle(input).then(data => sendResponse({ ok: true, data }), (error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  });

  async function initialize(): Promise<void>
  {
    if (!await chrome.alarms.get(alarmName)) await chrome.alarms.create(alarmName, { periodInMinutes: 1 });
    await controller.start();
    await badge();
  }
  void initialize().catch(failed);
});
