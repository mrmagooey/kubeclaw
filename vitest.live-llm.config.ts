import { defineConfig } from 'vitest/config';

/**
 * Live-LLM suite — drives the full HTTPChannel → DirectLLMRunner pathway
 * against a real OpenAI-compatible provider. Does NOT spin up minikube/helm
 * the way vitest.e2e.config.ts does; instead the suite owns its own setup
 * (in-memory SQLite, provider probe, env wiring).
 *
 * Run: npm run test:live-llm
 *      LIVE_LLM_BASE_URL=http://host:port/v1 npm run test:live-llm
 */
export default defineConfig({
  test: {
    name: 'live-llm',
    globals: true,
    environment: 'node',
    include: ['e2e/live-llm.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    reporters: ['verbose'],
    pool: 'forks',
    sequence: { hooks: 'list' },
  },
});
