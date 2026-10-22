import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], setupFiles: ['tests/support/integration.ts'] } },
      { test: { name: 'package', include: ['tests/package/**/*.test.ts'] } },
    ],
    // coverage measures Vitest execution across maintained extension sources
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'entrypoints/**/*.ts'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      // fail if coverage drops, the UI is measured by the browser tests
      thresholds: {
        'src/*.ts': { statements: 95, branches: 93, functions: 95, lines: 97 },
        'entrypoints/background.ts': { statements: 80, branches: 60, functions: 80, lines: 80 },
      },
    },
  },
});
