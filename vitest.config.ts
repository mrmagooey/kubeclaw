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
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'skills-engine/**/*.test.ts',
      'container/agent-runner/**/*.test.ts',
    ],
  },
});
