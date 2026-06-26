import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestGroupCapability } from './discovery-client.js';

const mockXadd = vi.fn();
const mockGet = vi.fn();

vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: () => ({
    xadd: (...args: unknown[]) => mockXadd(...args),
    get: (...args: unknown[]) => mockGet(...args),
  }),
  getDiscoveryRequestStream: () => 'kubeclaw:discovery:request',
  getDiscoveryResponseKey: (id: string) => `kubeclaw:discovery:response:${id}`,
}));

beforeEach(() => {
  mockXadd.mockReset();
  mockGet.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('requestGroupCapability', () => {
  it('publishes a discovery request and resolves to endpoint on success', async () => {
    mockXadd.mockResolvedValue('1-0');
    mockGet.mockResolvedValueOnce(null).mockResolvedValueOnce(
      JSON.stringify([
        {
          kind: 'mcp',
          name: 'echo',
          endpoint: 'http://mcp-echo-h1.kubeclaw.svc:3000',
          kindMetadata: { path: '/mcp' },
          state: 'ready',
        },
      ]),
    );
    const res = await requestGroupCapability('echo', 'Family', 1000);
    expect(res).toEqual({ endpoint: 'http://mcp-echo-h1.kubeclaw.svc:3000', token: undefined });
    expect(mockXadd).toHaveBeenCalledTimes(1);
    const [stream, ...fields] = mockXadd.mock.calls[0];
    expect(stream).toBe('kubeclaw:discovery:request');
    expect(fields).toContain('capability');
    expect(fields).toContain('echo');
    expect(fields).toContain('group');
    expect(fields).toContain('Family');
  });

  it('passes through the token when present in the discovery response', async () => {
    mockXadd.mockResolvedValue('1-0');
    mockGet.mockResolvedValueOnce(
      JSON.stringify([
        {
          kind: 'mcp',
          name: 'database',
          endpoint: 'http://mcp-database-h2.kubeclaw.svc:3000',
          kindMetadata: { path: '/mcp' },
          state: 'ready',
          token: 'abc123def456',
        },
      ]),
    );
    const res = await requestGroupCapability('database', 'alice', 1000);
    expect(res).toEqual({
      endpoint: 'http://mcp-database-h2.kubeclaw.svc:3000',
      token: 'abc123def456',
    });
  });

  it('returns error when response carries state: failed', async () => {
    mockXadd.mockResolvedValue('1-0');
    mockGet.mockResolvedValueOnce(
      JSON.stringify([
        {
          kind: 'mcp',
          name: 'echo',
          endpoint: '',
          kindMetadata: { path: '/mcp' },
          state: 'failed',
          error: 'pod did not become ready',
        },
      ]),
    );
    const res = await requestGroupCapability('echo', 'Family', 1000);
    expect(res).toEqual({ error: 'pod did not become ready' });
  });

  it('returns error when timeout exceeded with no response', async () => {
    mockXadd.mockResolvedValue('1-0');
    mockGet.mockResolvedValue(null);
    const res = await requestGroupCapability('echo', 'Family', 50);
    expect(res).toHaveProperty('error');
    if ('error' in res) expect(res.error).toMatch(/timeout/i);
  });

  it('returns error when response array is empty', async () => {
    mockXadd.mockResolvedValue('1-0');
    mockGet.mockResolvedValueOnce('[]');
    const res = await requestGroupCapability('echo', 'Family', 1000);
    expect(res).toHaveProperty('error');
  });
});
