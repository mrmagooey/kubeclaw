/**
 * NanoClaw HTTP Adapter - HTTP Client
 *
 * Makes HTTP calls to the tool container with exponential backoff retry.
 * Uses Node.js native fetch (Node 22+) — no axios dependency needed.
 */

import { AgentTaskRequest, AgentTaskResponse } from './protocol.js';
import { log } from './index.js';

export interface HttpClientOptions {
  baseUrl: string;
  requestTimeout: number; // ms
  maxRetries: number;
  retryDelay: number; // initial delay in ms, doubles each retry
}

/**
 * Error thrown when the agent returns an HTTP 4xx status (no retry).
 */
export class ClientError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: string,
  ) {
    super(`Agent rejected request (HTTP ${statusCode}): ${body}`);
    this.name = 'ClientError';
  }
}

/**
 * Error thrown when retries are exhausted after HTTP 5xx or network errors.
 */
export class RetryExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: string,
  ) {
    super(`Agent error after ${attempts} retries: ${lastError}`);
    this.name = 'RetryExhaustedError';
  }
}

/**
 * Send a task to the agent with retry logic.
 *
 * - HTTP 2xx: return response
 * - HTTP 4xx: fail immediately (ClientError)
 * - HTTP 5xx or network error: retry with exponential backoff
 */
export async function sendTask(
  request: AgentTaskRequest,
  options: HttpClientOptions,
): Promise<AgentTaskResponse> {
  const url = `${options.baseUrl}/agent/task`;
  let lastError = '';

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = options.retryDelay * Math.pow(2, attempt - 1);
      log(`Retry ${attempt}/${options.maxRetries} after ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(options.requestTimeout),
      });

      // Read body once
      const body = await response.text();

      // HTTP 2xx — success
      if (response.ok) {
        try {
          return JSON.parse(body) as AgentTaskResponse;
        } catch {
          // Agent returned non-JSON 2xx — wrap as success
          return { status: 'success', result: body };
        }
      }

      // HTTP 4xx — client error, don't retry
      if (response.status >= 400 && response.status < 500) {
        throw new ClientError(response.status, body);
      }

      // HTTP 5xx — server error, retry
      lastError = `HTTP ${response.status}: ${body.slice(0, 500)}`;
      log(`Server error: ${lastError}`);
    } catch (err) {
      // ClientError should not be retried
      if (err instanceof ClientError) {
        throw err;
      }

      lastError = err instanceof Error ? err.message : String(err);
      log(`Request failed: ${lastError}`);
    }
  }

  throw new RetryExhaustedError(options.maxRetries, lastError);
}
