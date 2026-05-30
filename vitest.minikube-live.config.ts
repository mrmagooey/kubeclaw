import { defineConfig } from 'vitest/config';
import { existsSync, readFileSync } from 'fs';

/**
 * Minikube-live suite — exercises a real helm-deployed kubeclaw in minikube
 * against a real LLM provider. Has its own globalSetup that installs into a
 * dedicated namespace (kubeclaw-live), so it does not interfere with the
 * regular e2e suite or any existing user install.
 *
 * Auto-loads `.env.test.local` (gitignored) so LIVE_LLM_API_KEY etc. can
 * live alongside the repo without sourcing manually each run. Pre-existing
 * environment variables take precedence over values in the file.
 *
 * Run: npm run test:minikube-live
 */
const ENV_FILE = '.env.test.local';
if (existsSync(ENV_FILE)) {
  for (const raw of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
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
