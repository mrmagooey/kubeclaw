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
    // Intentionally omit xRead: main()'s xRead call throws TypeError, which its
    // catch block absorbs with a 1s sleep; assertions complete before this matters.
    xAdd: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  };
  return { createClient: vi.fn(() => mockRedis) };
});

import {
  reconnectStrategy,
  fetchWithRetry,
  waitForToolReady,
  ToolClientError,
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

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the response on first success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"result":"ok"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('http://localhost:9999/invoke', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast on 4xx without retrying', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRetry('http://localhost:9999/invoke', { method: 'POST' }),
    ).rejects.toBeInstanceOf(ToolClientError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx and succeeds on a later attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(new Response('{"result":"ok"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('http://localhost:9999/invoke', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries network errors and throws after 3 attempts', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRetry('http://localhost:9999/invoke', { method: 'POST' }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws the last 5xx error after exhausting all attempts', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response('down', { status: 503 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRetry('http://localhost:9999/invoke', { method: 'POST' }),
    ).rejects.toThrow('Tool HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('waitForToolReady', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves as soon as the user container answers (any status)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nf', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitForToolReady()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('polls through connection errors until the container is up', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitForToolReady()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws when the deadline passes with no response', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitForToolReady()).rejects.toThrow(/not ready after/);
  });
});
