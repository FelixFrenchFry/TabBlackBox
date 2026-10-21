import { expect, type Page } from '@playwright/test';
import type { Reply } from '../../../src/protocol';

export async function enableAutomaticBackups(page: Page): Promise<void>
{
  const reply: Reply = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'automatic-settings', update: { kind: 'enabled', value: true } }));
  if (!reply.ok) throw new Error(reply.error);
  const capture: Reply = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'refresh' }));
  if (!capture.ok) throw new Error(capture.error);
  await expect(page.locator('#app')).toBeVisible();
}
