import { test, expect, launchExtension } from '../fixtures/extension';
import type { BrowserContext, Page } from '@playwright/test';
import type { Overview } from '../../../src/model';
import type { Reply } from '../../../src/protocol';

async function overview(page: Page): Promise<Overview>
{
  const reply: Reply = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'overview' }));
  if (!reply.ok) throw new Error(reply.error);
  if (reply.data.kind !== 'overview') throw new Error('Missing overview');
  return reply.data.overview;
}

for (const automatic of [false, true]) test(`fresh installations open directly and retain automatic backups ${automatic ? 'on' : 'off'} after restart`, async ({}, testInfo) =>
{
  const profile = testInfo.outputPath('profile');
  const launch = () => launchExtension(profile, { viewport: { width: 380, height: 720 } });
  let context: BrowserContext = await launch();
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    const page = await context.newPage();
    await page.goto(origin + '/popup.html');
    await expect(page.getByRole('button', { name: 'Back up now', exact: true })).toBeVisible();
    await expect(page.locator('.privacy-onboarding')).toHaveCount(0);
    await expect(page.getByText('Automatic backups are off', { exact: true })).toBeVisible();
    const initial = await overview(page);
    expect(initial.metadata.automatic).toEqual({ enabled: false, intervalMinutes: 15, pausedUntil: null });
    expect(initial.metadata.count).toBe(0);
    await page.getByRole('button', { name: 'Back up now', exact: true }).click();
    await expect.poll(async () => (await overview(page)).metadata.count).toBe(1);
    const saved = (await overview(page)).latest;
    if (!saved) throw new Error('Manual backup missing');
    await page.goto(origin + '/backups.html#settings');
    const enabled = page.getByRole('switch', { name: 'Automatic backups', exact: true });
    await expect(enabled).not.toBeChecked();
    await expect(page.getByLabel('Backup frequency', { exact: true })).toBeDisabled();
    if (automatic) {
      await enabled.check();
      await expect.poll(async () => (await overview(page)).metadata.automatic.enabled).toBe(true);
    }
    await context.close();
    context = await launch();
    const reopened = await context.newPage();
    await reopened.goto(origin + '/backups.html');
    await expect(reopened.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();
    await expect(reopened.locator('.privacy-onboarding')).toHaveCount(0);
    expect((await overview(reopened)).metadata.automatic.enabled).toBe(automatic);
    const snapshot: Reply = await reopened.evaluate(id => chrome.runtime.sendMessage({ kind: 'snapshot', id }), saved.id);
    expect(snapshot).toMatchObject({ ok: true, data: { kind: 'snapshot', snapshot: { id: saved.id, source: 'manual' } } });
  } finally { await context.close(); }
});
