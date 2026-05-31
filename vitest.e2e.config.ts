import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'e2e',
    globals: true,
    environment: 'node',
    include: ['e2e/**/*.test.ts', 'e2e/**/*.spec.ts'],
    exclude: [
      'node_modules',
      'dist',
      'e2e/ci',
      'e2e/results',
      'e2e/.pre-merge-backup/**',
      'e2e/minikube-live*.test.ts',
    ],
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
    env: {
      KUBECLAW_NAMESPACE: process.env.NAMESPACE || 'kubeclaw',
      // channel-runner.ts has a top-level `process.exit(1)` if this env
      // var is unset. Any test importing channel-runner (directly or
      // transitively) crashes without it. The value is only consumed
      // inside function bodies, so a placeholder is harmless.
      KUBECLAW_CHANNEL: process.env.KUBECLAW_CHANNEL || 'mock',
      // Per-test-cluster tests deploy a real Helm release inside minikube
      // but cannot route traffic from in-cluster pods to the host-side mock
      // LLM server.  Tests that require a real LLM (tool dispatch, OOMKill
      // reaction) guard themselves with KUBECLAW_NO_LLM and are skipped here.
      // Override with KUBECLAW_NO_LLM=false to run them against a live provider.
      KUBECLAW_NO_LLM: process.env.KUBECLAW_NO_LLM ?? 'true',
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
    // Auto-retry transient failures. The e2e suite shares an in-process
    // mock LLM server + a host-side kubectl port-forward + an external
    // minikube docker daemon; concurrent test files contend for ports
    // and IO and produce sporadic `fetch failed`, `ECONNRESET`, and
    // pod-not-ready blips that pass on the next try. Cap at 2 retries
    // (3 attempts total) so persistent bugs still surface.
    retry: process.env.CI === 'true' ? 2 : 2,
  },
});
