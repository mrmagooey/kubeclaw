import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    // Force playwright-core to resolve from the project root so that vi.mock
    // interceptions applied by tests (which run in the root context) work for
    // code imported from container/agent-runner/src/ (which would otherwise
    // resolve to its own local node_modules copy).
    alias: {
      'playwright-core': path.resolve('./node_modules/playwright-core'),
    },
  },
  test: {
    // Default forks pool is uncapped (≈ core count). Each fork carries libuv's
    // threadpool + V8 background threads (~8-12 kernel tasks), and on Linux
    // threads count against the cgroup pids limit (2048 in our sandbox/CI,
    // shared with everything else in the session). Isolation also churns a
    // fresh fork per file across ~770 files, so spawn rate spikes the task
    // count. Cap concurrency to keep the footprint well under the limit.
    // ponytail: maxForks=2 trades some speed for headroom; drop to
    // singleFork:true if a runner's pids.max is tighter still.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'skills-engine/**/*.test.ts',
      'container/agent-runner/**/*.test.ts',
      'e2e/helm-chart-template.test.ts',
    ],
    globals: true,
  },
});
