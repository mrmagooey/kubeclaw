import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'e2e',
    globals: true,
    environment: 'node',
    include: ['e2e/**/*.test.ts', 'e2e/**/*.spec.ts'],
    exclude: ['node_modules', 'dist', 'e2e/ci', 'e2e/results'],
    testTimeout: 120000, // 2 minutes for e2e tests
    hookTimeout: 120000,
    teardownTimeout: 30000,
    reporters: ['verbose', 'json'],
    outputFile: {
      json: 'e2e/results/test-results.json',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: 'e2e/results/coverage',
      exclude: ['node_modules/', 'e2e/', '**/.*.test.ts', '**/*.d.ts'],
    },
    setupFiles: ['./e2e/setup.ts'],
    globalSetup: './e2e/global-setup.ts',
    sequence: {
      hooks: 'list',
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: process.env.CI === 'true',
      },
    },
    bail: 0,
    retry: process.env.CI === 'true' ? 2 : 0,
  },
});
