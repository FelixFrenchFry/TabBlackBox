import { test, expect } from '../fixtures/extension';
import { enableAutomaticBackups } from '../fixtures/automatic';
import { createServer } from 'node:http';
import type { Reply } from '../../../src/protocol';

test('saved tabs show favicons and open only supported URLs through the arrow', async ({ extensionContext }, testInfo) =>
{
  const server = createServer((request, response) =>
  {
    if (request.url === '/favicon.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="orange"/></svg>');
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Research notes with a longer title for checking narrow layouts</title><link rel="icon" href="/favicon.svg"><h1>Research notes</h1>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server unavailable');
  const url = `http://127.0.0.1:${address.port}/notes?topic=one&more=two#section`;

  const context = await extensionContext({ viewport: { width: 1100, height: 900 } });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const original = await context.newPage();
    await original.goto(url);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/backups.html`);
    await enableAutomaticBackups(page);
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'automatic-settings', update: { kind: 'frequency', value: 0 } }));
    await page.evaluate(async () => { await chrome.tabs.create({ url: 'chrome://version/', active: false }); });
    await expect.poll(async () => page.evaluate(async () =>
    {
      const reply: Reply = await chrome.runtime.sendMessage({ kind: 'refresh' });
      return reply.ok && reply.data.kind === 'overview' && reply.data.overview.status.kind === 'current';
    })).toBe(true);
    await page.reload();
    await page.locator('.backup-summary').first().click();
    // rows show the site name and keep the full address on the links and the title tooltip
    const row = page.locator('.tab-row').filter({ has: page.locator(`a.tab-open[href="${url}"]`) }).first();
    const arrow = row.getByRole('link', { name: 'Open in new tab' });
    await expect(arrow).toBeVisible({ timeout: 3000 });
    await expect(arrow).toHaveAttribute('href', url);
    await expect(arrow.locator('.tab-url')).toHaveText('127.0.0.1', { timeout: 3000 });
    await expect(row.locator('.tab-title')).toHaveAttribute('href', url);
    await expect(row.locator('.tab-title')).toHaveAttribute('data-tooltip', url);
    const image = row.locator('img');
    await expect.poll(() => image.evaluate(img => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0)).toBe(true);
    const source = new URL(await image.getAttribute('src') ?? '');
    expect(source.pathname).toBe('/_favicon/');
    expect(source.searchParams.get('pageUrl')).toBe(url);
    const unsupported = page.locator('.tab-row').filter({ has: page.locator('.tab-url', { hasText: 'chrome://version/' }) }).first();
    await expect(unsupported.getByRole('button')).toBeDisabled();
    await expect(unsupported.getByRole('link')).toHaveCount(0);
    await page.locator('.backup-row').first().evaluate(element => { element.setAttribute('data-open-session', 'true'); });
    const previousId = await page.evaluate(async () =>
    {
      const reply: Reply = await chrome.runtime.sendMessage({ kind: 'overview' });
      if (!reply.ok || reply.data.kind !== 'overview') throw new Error('Overview unavailable');
      return reply.data.overview.metadata.latestId;
    });
    const opened = context.waitForEvent('page');
    await row.locator('.tab-url').click();
    const destination = await opened;
    await expect(destination).toHaveURL(url);
    expect(await destination.evaluate(() => window.opener === null)).toBe(true);
    expect(original.url()).toBe(url);
    await page.bringToFront();
    await expect.poll(async () => page.evaluate(async () =>
    {
      const reply: Reply = await chrome.runtime.sendMessage({ kind: 'overview' });
      if (!reply.ok || reply.data.kind !== 'overview') throw new Error('Overview unavailable');
      return reply.data.overview.metadata.latestId;
    })).not.toBe(previousId);
    await expect(page.locator('.backup-row').first()).not.toHaveAttribute('data-open-session', 'true');
    await expect(page.locator('[data-open-session] > details')).toHaveAttribute('open', '');
    await destination.close();
    await page.screenshot({ path: testInfo.outputPath('tab-icons-wide.png') });
    await page.setViewportSize({ width: 400, height: 900 });
    const title = await row.locator('.tab-title').boundingBox();
    const link = await row.locator('.tab-url').boundingBox();
    const favicon = await image.boundingBox();
    const open = await arrow.boundingBox();
    if (!title || !link || !favicon || !open) throw new Error('Layout missing');
    expect(favicon.x).toBeLessThan(title.x);
    expect(Math.abs(favicon.y + 8 - title.y - 12)).toBeLessThan(2);
    expect(Math.abs(open.y - link.y)).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath('tab-icons-narrow.png') });
    await image.evaluate(img => { img.dispatchEvent(new Event('error')); });
    await expect(row.locator('.tab-favicon svg')).toBeVisible();
    await expect(row.locator('img')).toHaveCount(0);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
