import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, launchAutomaticBackups } from '../fixtures/extension';
import { seed, send, settledBackup } from '../fixtures/session';

// axe checks for WCAG 2.1 A and AA
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const archive = readFileSync(resolve('tests/fixtures/released/archive-v1.json'));

// known issues, remove an entry once fixed
// buttons inside the expandable session row
// preview controls use action labels instead of their visible addresses
// dimmed descriptions and units in inactive settings rows have low contrast
const sessionRows = ['.backup-row > details > summary.backup-summary'];
const known: Record<string, Record<string, string[]>> = {
  'Backups view': { 'nested-interactive': sessionRows },
  'session preview': {
    'nested-interactive': sessionRows,
    'label-content-name-mismatch': [
      '.snapshot-preview a.tab-open[aria-label="Open in new tab"]',
      '.snapshot-preview button.tab-open:disabled[aria-label="This URL cannot be opened from a saved session"]',
    ],
  },
  'Settings view': { 'color-contrast': [
    '.automatic-setting-row.is-inactive #automatic-frequency-description',
    '.restore-setting-row.is-inactive #unload-threshold-description',
    '.restore-setting-row.is-inactive .settings-number-field > .settings-number-unit',
    '.storage-setting-row.is-inactive #maximum-backups-description',
    '.storage-setting-row.is-inactive .setting-label:has(> label[for="maximum-backups"]) > .badge',
    '.storage-setting-row.is-inactive .settings-number-field:has(> #maximum-backups:disabled) > .settings-number-unit',
    '.storage-setting-row.is-inactive #retention-days-description',
    '.storage-setting-row.is-inactive .setting-label:has(> label[for="retention-days"]) > .badge',
    '.storage-setting-row.is-inactive .settings-number-field:has(> #retention-days:disabled) > .settings-number-unit',
  ] },
};

async function expectAccessible(page: Page, name: string): Promise<void>
{
  const { violations } = await new AxeBuilder({ page }).withTags(tags).analyze();
  const unexpected: typeof violations = [];
  for (const item of violations) {
    const selectors = known[name]?.[item.id] ?? [];
    // match individual elements so a rule can contain known and new failures
    const accepted = selectors.length ? await page.evaluate(({ targets, selectors }) => targets.map(target => {
      const [selector] = target;
      if (target.length !== 1 || typeof selector !== 'string') return false;
      const element = document.querySelector(selector);
      return element !== null && selectors.some(known => element.matches(known));
    }), { targets: item.nodes.map(node => node.target), selectors }) : [];
    const count = accepted.filter(Boolean).length;
    if (count) test.info().annotations.push({ type: 'known accessibility issue', description: `${name}: ${item.id} on ${count} elements` });
    const nodes = item.nodes.filter((_, index) => !accepted[index]);
    if (nodes.length) unexpected.push({ ...item, nodes });
  }
  // show rule, impact and the first elements of new violations
  expect(unexpected.map(item => ({ rule: item.id, impact: item.impact, help: item.help, targets: item.nodes.slice(0, 5).map(node => node.target.join(' ')) })), name).toEqual([]);
}

test('reports new contrast failures beside a known inactive restore description', async ({ extensionContext }) =>
{
  const context = await extensionContext();
  const page = context.pages()[0] ?? await context.newPage();
  await page.setContent(`<!doctype html><html lang="en"><head><title>Accessibility check</title></head>
    <body style="background: #fff; color: #000"><main><h1>Accessibility check</h1>
    <div class="storage-setting-row restore-setting-row is-inactive"><div class="setting-description">
      <p id="unload-threshold-description" class="muted" style="color: #aaa">Known inactive restore description</p>
    </div></div></main></body></html>`);
  await expectAccessible(page, 'Settings view');
  await page.locator('h1').evaluate(element => { element.style.color = '#aaa'; });
  await expect(expectAccessible(page, 'Settings view')).rejects.toThrow('color-contrast');
});

for (const appearance of ['light', 'dark'] as const) {
  test(`extension pages pass automated accessibility checks in ${appearance} mode`, async ({ testServer: baseUrl }) =>
  {
    const app = await launchAutomaticBackups();
    try {
      // theme applies to every page opened afterwards
      await app.page.evaluate(value => { localStorage.setItem('tabblackbox.appearance', value); }, appearance);
      await app.page.reload();
      await expect(app.page.locator('html')).toHaveAttribute('data-color-mode', appearance);
      await seed(app.page, baseUrl);
      const backup = await settledBackup(app.page, 5);
      await send(app.page, { kind: 'keep', id: backup.id, name: 'Accessibility check', details: { tags: ['audit'] } });
      await app.page.locator('input[type="file"]').setInputFiles({ name: 'sessions.json', mimeType: 'application/json', buffer: archive });
      await expect(app.page.getByText(/\d+ sessions? imported/)).toBeVisible();

      for (const [link, heading] of [['Backups', 'Backups'], ['Statistics', 'Statistics'], ['Settings', 'Settings']] as const) {
        await app.page.getByRole('link', { name: link, exact: true }).click();
        await expect(app.page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
        await expectAccessible(app.page, `${link} view`);
      }

      // expanded session preview
      await app.page.getByRole('link', { name: 'Backups', exact: true }).click();
      await app.page.locator('main:not([hidden]) .backup-row .backup-title').first().click();
      await expect(app.page.locator('.snapshot-preview').first()).toBeVisible();
      await expectAccessible(app.page, 'session preview');

      const popup = await app.context.newPage();
      await popup.goto(`chrome-extension://${app.extensionId}/popup.html`);
      await expect(popup.locator('body')).not.toBeEmpty();
      await expectAccessible(popup, 'popup');

      // placeholders only stay unloaded in background tabs
      const opened = app.context.waitForEvent('page');
      await app.page.evaluate(async url => { await chrome.tabs.create({ url, active: false }); }, `chrome-extension://${app.extensionId}/restore.html#${new URLSearchParams({ url: `${baseUrl}/later`, title: 'Later' })}`);
      const placeholder = await opened;
      await expect(placeholder.getByRole('heading')).toHaveText('Later');
      await expectAccessible(placeholder, 'placeholder page');
    } finally { await app.context.close(); }
  });
}
