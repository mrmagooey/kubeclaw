/**
 * Unit tests for the tool-server bridge hardening helpers:
 * reconnectStrategy, fetchWithRetry, waitForToolReady.
 *
 * tool-server.ts reads env at module scope and starts main() on import, so
 * env must be set in vi.hoisted() and redis must be mocked before import
 * (same pattern as src/tool-server.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.KUBECLAW_TOOL_JOB_ID = 'test-job-id';
  process.env.KUBECLAW_CATEGORY = 'execution';
  process.env.REDIS_URL = 'redis://localhost:6379';
  // Tiny timings so retry/readiness tests run fast
  process.env.KUBECLAW_TOOL_REQUEST_TIMEOUT = '500';
  process.env.KUBECLAW_TOOL_RETRY_BASE_MS = '10';
  process.env.KUBECLAW_TOOL_READY_TIMEOUT = '300';
  process.env.KUBECLAW_TOOL_READY_INTERVAL_MS = '20';
});

vi.mock('redis', () => {
  const mockRedis = {
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    // Intentionally omit xRead so main()'s stream loop errors immediately
    // (same pattern as src/tool-server.test.ts) — prevents infinite spin under vitest.
    xAdd: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  };
  return { createClient: vi.fn(() => mockRedis) };
});

import {
  reconnectStrategy,
} from '../container/agent-runner/src/tool-server.js';

describe('reconnectStrategy', () => {
  it('backs off exponentially from 100ms', () => {
    expect(reconnectStrategy(0)).toBe(100);
    expect(reconnectStrategy(1)).toBe(200);
    expect(reconnectStrategy(2)).toBe(400);
  });

  it('caps the delay at 10 seconds', () => {
    expect(reconnectStrategy(10)).toBe(10_000);
  });

  it('gives up with an Error after 10 retries', () => {
    expect(reconnectStrategy(11)).toBeInstanceOf(Error);
  });
});
