/**
 * Tests for health-check.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForHealthy } from './health-check.js';

describe('waitForHealthy', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('should resolve on HTTP 200', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
    });

    await expect(
      waitForHealthy({
        url: 'http://localhost:8080/health',
        pollInterval: 10,
        timeout: 1000,
      }),
    ).resolves.not.toThrow();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/health',
      expect.objectContaining({
        method: 'GET',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('should retry on HTTP non-200', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

    await waitForHealthy({
      url: 'http://localhost:8080/health',
      pollInterval: 10,
      timeout: 1000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should retry on network errors', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

    await waitForHealthy({
      url: 'http://localhost:8080/health',
      pollInterval: 10,
      timeout: 1000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should throw after timeout', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
    });

    await expect(
      waitForHealthy({
        url: 'http://localhost:8080/health',
        pollInterval: 10,
        timeout: 50,
      }),
    ).rejects.toThrow('Agent health check failed after 50ms');
  });

  it('should use 5s per-request timeout', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
    });

    await waitForHealthy({
      url: 'http://localhost:8080/health',
      pollInterval: 10,
      timeout: 1000,
    });

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('should poll at specified interval', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const startTime = Date.now();
    await waitForHealthy({
      url: 'http://localhost:8080/health',
      pollInterval: 50,
      timeout: 1000,
    });
    const elapsed = Date.now() - startTime;

    // Should take at least 100ms (2 retries at 50ms each)
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });
});
