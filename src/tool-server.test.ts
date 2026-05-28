/**
 * Unit tests for toolWebSearch (Brave Search backend).
 *
 * Stubs globalThis.fetch so no real HTTP requests are made.
 * Tests run under vitest with the root vitest.config.ts (src/**\/*.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Set required env vars via vi.hoisted so they are present before the module
// is imported. tool-server.ts reads KUBECLAW_TOOL_JOB_ID and KUBECLAW_CATEGORY
// at module scope (const agentJobId = process.env.KUBECLAW_TOOL_JOB_ID!) so
// they must be in place before the import runs.
vi.hoisted(() => {
  process.env.KUBECLAW_TOOL_JOB_ID = 'test-job-id';
  process.env.KUBECLAW_CATEGORY = 'execution';
  process.env.REDIS_URL = 'redis://localhost:6379';
});

// Mock the redis module before importing tool-server, since tool-server.ts
// imports redis at the top level but toolWebSearch itself does not use it.
vi.mock('redis', () => {
  const mockRedis = {
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    xReadGroup: vi.fn().mockResolvedValue(null),
    xAck: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    xGroupCreate: vi.fn().mockResolvedValue(undefined),
  };
  return {
    createClient: vi.fn(() => mockRedis),
  };
});

// --- Re-export shim ---
// toolWebSearch is not exported by tool-server.ts today.  After Step 3 adds
// `export` to the function declaration, this import will resolve.
import { toolWebSearch } from '../container/agent-runner/src/tool-server.js';

// Brave Search API shape: web.results[]
function makeBraveResponse(overrides: Partial<{
  results: Array<{ title: string; url: string; description: string; age?: string; meta_url?: { hostname: string } }>;
  statusCode: number;
}> = {}): { statusCode: number; body: object } {
  const results = overrides.results ?? [
    {
      title: 'Kubernetes Networking',
      url: 'https://kubernetes.io/docs/concepts/cluster-administration/networking/',
      description: 'Kubernetes assumes that pods can communicate with other pods.',
      age: '2024-01-01T00:00:00Z',
      meta_url: { hostname: 'kubernetes.io' },
    },
  ];
  return {
    statusCode: overrides.statusCode ?? 200,
    body: { web: { results } },
  };
}

describe('toolWebSearch — Brave Search backend', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Clear env so tests start clean
    delete process.env.BRAVE_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BRAVE_API_KEY;
  });

  // ── (a) Happy path: returns JSON with `snippet` ───────────────────────────
  it('happy path: returns JSON array containing snippet field', async () => {
    const { statusCode, body } = makeBraveResponse();
    fetchMock.mockResolvedValueOnce({
      ok: statusCode === 200,
      status: statusCode,
      json: async () => body,
    } as Response);

    const raw = await toolWebSearch({ query: 'kubernetes networking' });
    const results = JSON.parse(raw) as Array<{ title: string; url: string; snippet: string; published?: string; source?: string }>;

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toHaveProperty('snippet');
    expect(results[0]).toHaveProperty('title');
    expect(results[0]).toHaveProperty('url');
    expect(results[0].snippet).toBe('Kubernetes assumes that pods can communicate with other pods.');
  });

  // ── (b) Non-200 response throws a descriptive error ──────────────────────
  it('non-200 response throws a descriptive error containing the status code', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Too Many Requests',
    } as unknown as Response);

    await expect(toolWebSearch({ query: 'test' })).rejects.toThrow('429');
  });

  // ── (c) Placeholder key (sidecar/istio): header NOT set ──────────────────
  it('placeholder key starting with KC_PH_ does NOT set X-Subscription-Token header', async () => {
    process.env.BRAVE_API_KEY = 'KC_PH_brave-search_api_key';
    const { statusCode, body } = makeBraveResponse();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: statusCode,
      json: async () => body,
    } as Response);

    await toolWebSearch({ query: 'test' });

    const [, initArg] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = initArg?.headers as Record<string, string> | undefined;
    expect(headers?.['X-Subscription-Token']).toBeUndefined();
  });

  it('literal injected-by-broker value does NOT set X-Subscription-Token header', async () => {
    process.env.BRAVE_API_KEY = 'injected-by-broker';
    const { statusCode, body } = makeBraveResponse();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: statusCode,
      json: async () => body,
    } as Response);

    await toolWebSearch({ query: 'test' });

    const [, initArg] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = initArg?.headers as Record<string, string> | undefined;
    expect(headers?.['X-Subscription-Token']).toBeUndefined();
  });

  // ── (d) Real key (mode: off): header IS set ───────────────────────────────
  it('real BRAVE_API_KEY sets X-Subscription-Token header', async () => {
    process.env.BRAVE_API_KEY = 'BSArealkey1234567890abcdefghijklmno';
    const { statusCode, body } = makeBraveResponse();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: statusCode,
      json: async () => body,
    } as Response);

    await toolWebSearch({ query: 'test' });

    const [, initArg] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = initArg?.headers as Record<string, string> | undefined;
    expect(headers?.['X-Subscription-Token']).toBe('BSArealkey1234567890abcdefghijklmno');
  });

  // ── (e) Empty results: returns empty JSON array ───────────────────────────
  it('empty web.results array returns empty JSON array', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [] } }),
    } as Response);

    const raw = await toolWebSearch({ query: 'xyzzy' });
    expect(JSON.parse(raw)).toEqual([]);
  });

  // ── (f) Correct API URL and query encoding ────────────────────────────────
  it('constructs the correct Brave Search API URL with encoded query', async () => {
    const { statusCode, body } = makeBraveResponse();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: statusCode,
      json: async () => body,
    } as Response);

    await toolWebSearch({ query: 'kubernetes networking' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.search.brave.com/res/v1/web/search?q=kubernetes%20networking&count=10',
    );
  });
});
