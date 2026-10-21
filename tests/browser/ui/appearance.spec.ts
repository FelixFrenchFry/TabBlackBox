import { test, expect, launchAutomaticBackups } from '../fixtures/extension';
import { send, settledBackup } from '../fixtures/session';

test('settings navigation, popup shortcut and appearance work across views', async ({ testServer: baseUrl }, testInfo) =>
{
  const app = await launchAutomaticBackups();
  try {
    await app.page.evaluate(async url => { await chrome.tabs.create({ url }); }, `${baseUrl}/settings`);
    await settledBackup(app.page, 1);
    await app.page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(app.page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(app.page.getByRole('heading', { name: 'Backups', exact: true })).not.toBeVisible();
    await expect(app.page.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(app.page.locator('.settings-storage')).toContainText('automatic backup');
    expect((await send(app.page, { kind: 'overview' })).kind).toBe('overview');
    await app.page.getByLabel('Color theme').selectOption('dark');
    await expect(app.page.locator('html')).toHaveAttribute('data-color-mode', 'dark');
    await app.page.reload();
    await expect(app.page.getByLabel('Color theme')).toHaveValue('dark');
    await expect(app.page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await app.page.screenshot({ path: testInfo.outputPath('settings-dark.png') });
    await app.page.getByRole('link', { name: 'Backups', exact: true }).click();
    await expect(app.page.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();
    await app.page.goBack();
    await expect(app.page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    const popup = await app.context.newPage();
    await popup.goto(`chrome-extension://${app.extensionId}/popup.html`);
    await expect(popup.locator('html')).toHaveAttribute('data-color-mode', 'dark');
    const opened = app.context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = await opened;
    await expect(settings.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(settings.locator('.settings-storage')).toContainText('automatic backup');
    await settings.getByLabel('Color theme').selectOption('light');
    await expect(popup.locator('html')).toHaveAttribute('data-color-mode', 'light');
    await expect(app.page.getByLabel('Color theme')).toHaveValue('light');
    await app.page.screenshot({ path: testInfo.outputPath('settings-light.png') });
    await popup.setViewportSize({ width: 380, height: 380 });
    await popup.screenshot({ path: testInfo.outputPath('popup-settings.png') });
    await settings.emulateMedia({ colorScheme: 'dark' });
    await settings.getByLabel('Color theme').selectOption('system');
    await expect(settings.locator('html')).toHaveAttribute('data-color-mode', 'dark');
    await settings.emulateMedia({ colorScheme: 'light' });
    await expect(settings.locator('html')).toHaveAttribute('data-color-mode', 'light');
  } finally { await app.context.close(); }
});
