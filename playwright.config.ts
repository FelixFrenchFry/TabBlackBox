import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.test-browsers');

export default defineConfig({
  testDir: './tests/browser',
  projects: [
    { name: 'ui', testMatch: 'ui/**/*.spec.ts' },
    { name: 'e2e', testMatch: 'e2e/**/*.spec.ts' },
  ],
  forbidOnly: !!process.env.CI,
  // CI keeps output of failed tests only so uploaded reports stay small, local runs keep everything for review
  preserveOutput: process.env.CI ? 'failures-only' : 'always',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { channel: 'chromium', trace: 'retain-on-failure' },
});
