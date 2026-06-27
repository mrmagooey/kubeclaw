import type { FetchJson } from './search.js';

/**
 * Returns a `FetchJson` implementation that performs an HTTP GET with a
 * configurable timeout, parses the response as JSON, and throws on non-2xx
 * status codes.
 */
export function makeHttpJsonFetcher(timeoutMs = 10_000): FetchJson {
  return async (url: string): Promise<unknown> => {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return res.json() as Promise<unknown>;
  };
}
