import { defineConfig } from 'vitest/config';

// test run for each mutant, Stryker passes the mutant in an env variable
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // tooling tests depend on files outside the mutation sandbox
    exclude: ['tests/unit/browser-coverage.test.ts', 'tests/unit/build-baseline.test.ts'],
    setupFiles: ['tests/support/integration.ts'],
    // threads start faster but cannot switch time zones
    pool: 'threads',
    env: { TABBLACKBOX_MUTATION: '1' },
  },
});
