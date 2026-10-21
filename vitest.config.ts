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
    },
  },
});
