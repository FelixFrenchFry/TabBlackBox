import { test, expect, launchAutomaticBackups } from '../fixtures/extension';
import { send, saved, settledBackup } from '../fixtures/session';

test('committed snapshots survive a forced browser process termination', async ({ testServer: baseUrl }, testInfo) =>
{
  const profile = testInfo.outputPath('profile');
  let app = await launchAutomaticBackups(profile);
  try {
    await app.page.evaluate(async url => { await chrome.tabs.create({ url }); }, `${baseUrl}/crash`);
    const backup = await settledBackup(app.page, 1);
    const browser = app.context.browser();
    if (!browser) throw new Error('Test browser connection is unavailable');
    const cdp = await browser.newBrowserCDPSession();
    const processes = await cdp.send('SystemInfo.getProcessInfo');
    const processInfo = processes.processInfo.find(item => item.type === 'browser');
    if (!processInfo || !Number.isSafeInteger(processInfo.id) || processInfo.id === process.pid) throw new Error('Dedicated browser PID not found');
    // PID comes from the dedicated test browser
    const disconnected = new Promise<void>(resolve => browser.once('disconnected', () => resolve()));
    process.kill(processInfo.id, 'SIGKILL');
    await disconnected;
    await app.context.close().catch(() => undefined);
    app = await launchAutomaticBackups(profile);
    expect(await send(app.page, { kind: 'snapshot', id: backup.id })).toEqual({ kind: 'snapshot', snapshot: backup });
  } finally { await app.context.close(); }
});

test('interrupted restoration is reported without automatic replay', async ({ testServer: baseUrl }) =>
{
  const app = await launchAutomaticBackups();
  try {
    await app.page.evaluate(async url => { await chrome.windows.create({ url: Array.from({ length: 3 }, (_, index) => `${url}/interrupt/${index}`), focused: false }); }, baseUrl);
    const backup = await settledBackup(app.page, 3);
    const worker = app.context.serviceWorkers()[0];
    if (!worker) throw new Error('Test worker missing');
    // hold later tabs so worker termination always interrupts a partially restored window
    await worker.evaluate(() => {
      Object.defineProperty(chrome.tabs, 'create', { value: () => new Promise(() => {}) });
    });
    await send(app.page, { kind: 'restore', id: backup.id });
    await expect.poll(async () =>
    {
      const result = await send(app.page, { kind: 'overview' });
      return result.kind === 'overview' && result.overview.metadata.operation?.kind === 'running' && result.overview.metadata.operation.opened > 0;
    }).toBe(true);
    const cdp = await app.context.newCDPSession(app.page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.detach();
    const value = await send(app.page, { kind: 'refresh' });
    expect(value.kind === 'overview' && value.overview.metadata.operation?.kind).toBe('interrupted');
    const tabCount = await app.page.evaluate(async () => (await chrome.tabs.query({})).length);
    await send(app.page, { kind: 'refresh' });
    expect(await app.page.evaluate(async () => (await chrome.tabs.query({})).length)).toBe(tabCount);
    await app.page.getByRole('button', { name: 'View restore issues', exact: true }).click();
    const result = app.page.getByRole('region', { name: 'Restoration result' });
    await expect(result.getByRole('heading')).toHaveText('Restoration interrupted');
    await expect(result).toContainText('1 tab opened');
  } finally { await app.context.close(); }
});

test('automatic events and worker termination recover without duplicate snapshots', async ({ testServer: baseUrl }) =>
{
  const app = await launchAutomaticBackups();
  try {
    await send(app.page, { kind: 'automatic-settings', update: { kind: 'frequency', value: 0 } });
    await app.page.evaluate(async url => { await chrome.tabs.create({ url }); }, `${baseUrl}/automatic`);
    await expect.poll(async () =>
    {
      const value = await send(app.page, { kind: 'overview' });
      return value.kind === 'overview' ? value.overview.latest?.tabCount : null;
    }).toBe(1);
    const baseline = await saved(app.page);
    const before = await send(app.page, { kind: 'history', before: null, collection: 'automatic' });
    await send(app.page, { kind: 'backup' });
    expect(await send(app.page, { kind: 'history', before: null, collection: 'automatic' })).toEqual(before);
    const cdp = await app.context.newCDPSession(app.page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.detach();
    const value = await send(app.page, { kind: 'refresh' });
    expect(value.kind).toBe('overview');
    expect(await send(app.page, { kind: 'history', before: null, collection: 'automatic' })).toEqual(before);
    expect((await send(app.page, { kind: 'snapshot', id: baseline.id })).kind).toBe('snapshot');
    expect(await app.page.evaluate(async () => Boolean(await chrome.alarms.get('reconcile-session')))).toBe(true);
    await app.page.evaluate(async url =>
    {
      const tabs = await chrome.tabs.query({ url: `${url}/*` });
      const id = tabs[0]?.id;
      if (id === undefined) throw new Error('Test tab absent');
      await chrome.tabs.update(id, { url: `${url}/changed`, pinned: true });
    }, baseUrl);
    await expect.poll(async () =>
    {
      const value = await send(app.page, { kind: 'overview' });
      return value.kind === 'overview' ? value.overview.metadata.latestId : baseline.id;
    }).not.toBe(baseline.id);
    expect((await saved(app.page)).windows[0]?.tabs[0]).toMatchObject({ url: `${baseUrl}/changed`, pinned: true });
  } finally { await app.context.close(); }
});
