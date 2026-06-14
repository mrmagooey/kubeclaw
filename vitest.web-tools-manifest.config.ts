/**
 * Minimal vitest config for the minikube-live-web-tools manifest test.
 * No global setup — the test self-gates on orchestrator readiness.
 * Run: npx vitest run --config vitest.web-tools-manifest.config.ts
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'web-tools-manifest',
    globals: true,
    environment: 'node',
    include: ['e2e/minikube-live-web-tools.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
    reporters: ['verbose'],
    pool: 'forks',
    fileParallelism: false,
    sequence: { hooks: 'list' },
  },
});
