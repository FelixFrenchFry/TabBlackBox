import { expect, type Page } from '@playwright/test';
import type { Archive } from '../../../src/archive';

export async function importArchive(page: Page, archive: Archive): Promise<void>
{
  await page.locator('input[type="file"]').setInputFiles({ name: 'sessions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
  await expect(page.getByText(`${archive.sessions.length} ${archive.sessions.length === 1 ? 'session' : 'sessions'} imported`, { exact: true })).toBeVisible();
}
