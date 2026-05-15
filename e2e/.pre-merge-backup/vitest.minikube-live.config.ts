import { defineConfig } from 'vitest/config';

/**
 * Minikube-live suite — exercises a real helm-deployed kubeclaw in minikube
 * against a real LLM provider. Has its own globalSetup that installs into a
 * dedicated namespace (kubeclaw-live), so it does not interfere with the
 * regular e2e suite or any existing user install.
 *
 * Run: npm run test:minikube-live
 */
export default defineConfig({
  test: {
    name: 'minikube-live',
    globals: true,
    environment: 'node',
    include: ['e2e/minikube-live*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 600_000, // helm install + image build can take a while
    teardownTimeout: 120_000,
    reporters: ['verbose'],
    pool: 'forks',
    // Run both test files in the SAME worker process. Running them in
    // parallel forks overwhelms `kubectl port-forward` (it briefly drops
    // ingress when many concurrent requests pile up on the same socket).
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    sequence: { hooks: 'list' },
    globalSetup: './e2e/minikube-live-setup.ts',
  },
});
