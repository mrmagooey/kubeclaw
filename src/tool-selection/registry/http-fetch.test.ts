import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeHttpJsonFetcher } from './http-fetch.js';

describe('makeHttpJsonFetcher', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('parses and returns JSON from a successful GET', async () => {
    const payload = { results: [{ name: 'my-tool' }] };
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => payload,
    } as Response);

    const fetcher = makeHttpJsonFetcher();
    const result = await fetcher('https://example.com/api');

    expect(result).toEqual(payload);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe('https://example.com/api');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('throws on non-2xx status', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    const fetcher = makeHttpJsonFetcher();
    await expect(fetcher('https://example.com/missing')).rejects.toThrow(
      'HTTP 404',
    );
  });

  it('applies a timeout via AbortSignal', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);

    const fetcher = makeHttpJsonFetcher(5_000);
    await fetcher('https://example.com/api');

    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
  });

  it('uses a default timeout of 10 000 ms', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);

    const fetcher = makeHttpJsonFetcher();
    await fetcher('https://example.com/api');

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });
});
