import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const result = spawnSync(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve('.test-browsers') },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
