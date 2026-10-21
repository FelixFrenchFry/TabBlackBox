import { test, expect, launchAutomaticBackups } from '../fixtures/extension';
import type { Request } from '../../../src/protocol';
import { send } from '../fixtures/session';

test('history column buttons toggle sorting and remember each panel independently', async () =>
{
  const app = await launchAutomaticBackups();
  try {
    await send(app.page, { kind: 'import', archive: { format: 'tabblackbox', version: 1, sessions: [300, 100, 400, 200].map(capturedAt => ({
      capturedAt, name: String(capturedAt), source: 'manual',
      windows: [{ groups: [], tabs: [{ url: 'https://example.test', title: 'Saved tab', pinned: false, group: null }] }],
    })) } });
    await app.page.reload();
    const savedPanel = app.page.getByRole('region', { name: 'Manual backups', exact: true });
    const automaticPanel = app.page.getByRole('region', { name: 'Automatic backups', exact: true });
    const names = savedPanel.locator('.backup-title');
    const number = savedPanel.getByRole('button', { name: /^Number,/ });
    const date = savedPanel.getByRole('button', { name: /^Date,/ });
    await expect(names).toHaveText(['400', '300', '200', '100']);
    await expect(date).toHaveAttribute('aria-pressed', 'true');
    await date.click();
    await expect(names).toHaveText(['100', '200', '300', '400']);
    await number.click();
    await expect(names).toHaveText(['200', '400', '100', '300']);
    await expect(date).toHaveAttribute('aria-pressed', 'false');
    await number.focus();
    await app.page.keyboard.press('Enter');
    await expect(names).toHaveText(['300', '100', '400', '200']);
    await expect(number).toHaveAttribute('aria-label', 'Number, lowest first. Sort highest first');
    await app.page.reload();
    await expect(names).toHaveText(['300', '100', '400', '200']);
    await expect(number).toHaveAttribute('aria-pressed', 'true');
    await expect(automaticPanel.getByRole('button', { name: 'Date, newest first. Sort oldest first', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await date.click();
    await expect(names).toHaveText(['400', '300', '200', '100']);
  } finally { await app.context.close(); }
});

for (const superseded of [false, true]) {
  test(`failed history sort preserves rows and pagination${superseded ? ' after rapid selections' : ''}`, async () =>
  {
    const app = await launchAutomaticBackups();
    try {
      await send(app.page, { kind: 'import', archive: { format: 'tabblackbox', version: 1, sessions: Array.from({ length: 35 }, (_, index) => ({
        capturedAt: index + 1, name: String(index + 1), source: 'manual',
        windows: [{ groups: [], tabs: [{ url: 'https://example.test', title: 'Saved tab', pinned: false, group: null }] }],
      })) } });
      await app.page.reload();
      const panel = app.page.getByRole('region', { name: 'Manual backups', exact: true });
      const names = panel.locator('.backup-title');
      const more = panel.getByRole('button', { name: 'Load more', exact: true });
      const date = panel.getByRole('button', { name: /^Date,/ });
      await expect(names).toHaveCount(5);
      await more.click();
      await expect(names).toHaveCount(15);
      const previous = await names.allTextContents();
      const stored = await app.page.evaluate(() => localStorage.getItem('tabblackbox.history-sort.saved'));
      await app.page.evaluate(() => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        let fail = true;
        document.addEventListener('release-sort', () => { fail = false; }, { once: true });
        Object.defineProperty(chrome.runtime, 'sendMessage', { configurable: true, value: async (message: Request) => {
          if (message.kind === 'history' && message.collection === 'saved' && fail) {
            await new Promise<void>(resolve => document.addEventListener('release-sort', () => resolve(), { once: true }));
            return { ok: false, error: 'Temporary sort failure' };
          }
          return original(message);
        } });
      });
      await date.click();
      if (superseded) await panel.getByRole('button', { name: /^Number,/ }).click();
      await expect(names).toHaveText(previous);
      await expect(more).toBeDisabled();
      await app.page.evaluate(() => document.dispatchEvent(new Event('release-sort')));
      await expect(app.page.locator('main:visible').getByText('Temporary sort failure')).toBeVisible();
      await expect(names).toHaveText(previous);
      await expect(date).toHaveAttribute('aria-label', 'Date, newest first. Sort oldest first');
      await expect(more).toBeEnabled();
      expect(await app.page.evaluate(() => localStorage.getItem('tabblackbox.history-sort.saved'))).toBe(stored);
      await more.click();
      await expect(names).toHaveCount(25);
      await more.click();
      await expect(names).toHaveText(Array.from({ length: 35 }, (_, index) => String(35 - index)));
      await date.click();
      await expect(names).toHaveText(['1', '2', '3', '4', '5']);
      await app.page.reload();
      await expect(names).toHaveText(['1', '2', '3', '4', '5']);
    } finally { await app.context.close(); }
  });
}
