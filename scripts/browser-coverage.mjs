import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// builds with source maps and runs the browser tests with coverage
const env = { ...process.env, TABBLACKBOX_COVERAGE: '1' };
for (const command of ['npx wxt build', 'node scripts/build-baseline.mjs']) {
  // npx needs a shell on Windows
  const result = spawnSync(command, { stdio: 'inherit', shell: true, env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// run the Playwright CLI without a shell to keep arguments such as --grep patterns intact
const tests = spawnSync(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test', ...process.argv.slice(2)], { stdio: 'inherit', env });
process.exit(tests.status ?? 1);
