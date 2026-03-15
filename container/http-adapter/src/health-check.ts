/**
 * NanoClaw HTTP Adapter - Health Check
 *
 * Polls GET /agent/health until the agent container is ready.
 * Uses Node.js native fetch (Node 22+).
 */

import { log } from './index.js';

export interface HealthCheckOptions {
  url: string;
  pollInterval: number; // ms between polls
  timeout: number; // total timeout in ms
}

/**
 * Poll the agent's health endpoint until it returns HTTP 200.
 * Throws if the agent doesn't become healthy within the timeout.
 */
export async function waitForHealthy(
  options: HealthCheckOptions,
): Promise<void> {
  const { url, pollInterval, timeout } = options;
  const startTime = Date.now();

  log(
    `Waiting for agent health at ${url} (timeout: ${timeout}ms, poll: ${pollInterval}ms)`,
  );

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000), // 5s per-request timeout
      });

      if (response.ok) {
        const elapsed = Date.now() - startTime;
        log(`Agent healthy after ${elapsed}ms`);
        return;
      }

      log(`Health check returned HTTP ${response.status}, retrying...`);
    } catch (err) {
      // Network error (connection refused, etc.) — expected while agent starts up
      const message = err instanceof Error ? err.message : String(err);
      log(`Health check failed: ${message}, retrying...`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Agent health check failed after ${timeout}ms`);
}
