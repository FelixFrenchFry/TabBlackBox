import { test, expect, chromium } from '@playwright/test';
import type { Archive } from '../../../src/archive';
import { formatArchive } from '../../../src/export-formats';

test('readable HTML exports expose only approved links and render other URLs as inert text', async () =>
{
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const executable = "javascript:document.documentElement.dataset.executed='yes'";
    const unsupported = [
      executable,
      executable.replace('javascript:', '\u0000 JaVa\nScRiPt:'),
      executable.replace('javascript:', 'javascript&#58;'),
      'data:text/html,<script>alert(1)</script>',
      'file:///C:/notes.html',
      'chrome://settings',
      'javascript:alert(1)`` [click](https://example.test) <img src=x onerror=alert(1)>',
    ];
    const approved = [' HTTPS://EXAMPLE.TEST/a b?q=one&copy;=yes', 'http://example.test/'];
    const title = '<img src=x onerror=alert(1)> "Research"';
    const archive: Archive = { format: 'tabblackbox', version: 1, sessions: [{ name: '<script>alert(1)</script>', capturedAt: 1000, source: 'manual', windows: [{ groups: [], tabs: [...unsupported, ...approved].map(url => ({ url, title, pinned: false, group: null })) }] }] };
    const dialogs: string[] = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.setContent(formatArchive(archive, 'bookmarks'));
    await expect(page.locator('a')).toHaveCount(2);
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('a'), link => link.href))).toEqual(approved.map(url => new URL(url).href));
    await expect(page.locator('a').first()).toHaveText(title);
    await expect(page.locator('code')).toHaveCount(unsupported.length);
    await expect(page.locator('code').first()).toHaveText(executable);
    await page.locator('code').first().click();
    expect(await page.evaluate(() => document.documentElement.dataset.executed)).toBeUndefined();
    await expect(page.locator('script, img, iframe, object, embed')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  } finally { await browser.close(); }
});
