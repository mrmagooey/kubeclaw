import { defineConfig } from 'vitest/config';
import { existsSync, readFileSync } from 'fs';

/**
 * Live-LLM suite — drives the full HTTPChannel → DirectLLMRunner pathway
 * against a real OpenAI-compatible provider. Does NOT spin up minikube/helm
 * the way vitest.e2e.config.ts does; instead the suite owns its own setup
 * (in-memory SQLite, provider probe, env wiring).
 *
 * Auto-loads `.env.test.local` (gitignored) so LIVE_LLM_API_KEY etc. can live
 * alongside the repo without sourcing manually each run. Pre-existing
 * environment variables take precedence over values in the file.
 *
 * Run: npm run test:live-llm
 *      LIVE_LLM_BASE_URL=http://host:port/v1 npm run test:live-llm
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
