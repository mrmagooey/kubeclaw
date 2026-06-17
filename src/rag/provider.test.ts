import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mocks for dynamic imports used inside VectorStoreProvider
const mockIndexConversationTurn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRetrieveContext = vi.hoisted(() => vi.fn().mockResolvedValue('retrieved'));

vi.mock('../capabilities/client.js', () => ({ getRagEntry: vi.fn() }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./indexer.js', () => ({ indexConversationTurn: mockIndexConversationTurn }));
vi.mock('./retriever.js', () => ({ retrieveContext: mockRetrieveContext }));

import { getRagProvider, resetRagProvider } from './provider.js';
import { getRagEntry } from '../capabilities/client.js';

beforeEach(() => {
  resetRagProvider();
  vi.mocked(getRagEntry).mockReset();
  mockIndexConversationTurn.mockClear();
  mockRetrieveContext.mockClear();
  delete process.env.KUBECLAW_CHANNEL;
});

describe('getRagProvider (adapter-based)', () => {
  it('returns the remote provider for a remote adapter entry', () => {
    vi.mocked(getRagEntry).mockReturnValue({
      kind: 'rag', name: 'lr', endpoint: 'http://lr',
      kindMetadata: { backend: 'lightrag', provider: { adapter: 'remote' } },
    } as never);
    expect(getRagProvider().name).toBe('remote');
  });

  it('returns the vector-store provider for a vector-store adapter entry', () => {
    vi.mocked(getRagEntry).mockReturnValue({
      kind: 'rag', name: 'q', endpoint: 'http://q',
      kindMetadata: {
        backend: 'qdrant',
        provider: { adapter: 'vector-store', embedding: { provider: 'openai' } },
      },
    } as never);
    expect(getRagProvider().name).toBe('vector-store');
  });

  it('returns NullRagProvider when nothing configured', () => {
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    expect(getRagProvider().name).toBe('none');
  });

  it('passes KUBECLAW_CHANNEL to getRagEntry', () => {
    process.env.KUBECLAW_CHANNEL = 'telegram';
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    getRagProvider();
    expect(vi.mocked(getRagEntry)).toHaveBeenCalledWith('telegram');
  });

  it('falls back to wildcard channel name when KUBECLAW_CHANNEL is unset', () => {
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    getRagProvider();
    expect(vi.mocked(getRagEntry)).toHaveBeenCalledWith('*');
  });
});

// ── VectorStoreProvider config threading ────────────────────────────────────

describe('VectorStoreProvider config threading', () => {
  function makeVsEntry(providerOverrides: Record<string, unknown> = {}) {
    return {
      kind: 'rag',
      name: 'qdrant',
      endpoint: 'http://qdrant:6333/',
      kindMetadata: {
        backend: 'qdrant',
        provider: {
          adapter: 'vector-store',
          embedding: { provider: 'openai' },
          ...providerOverrides,
        },
      },
    } as never;
  }

  it('threads explicit config fields into the indexer', async () => {
    vi.mocked(getRagEntry).mockReturnValue(
      makeVsEntry({
        chunkSize: 512,
        chunkOverlap: 64,
        embedding: { provider: 'openai', dim: 512 },
      }),
    );

    const provider = getRagProvider();
    await provider.indexConversationTurn('grp', 'hello', 'world');

    expect(mockIndexConversationTurn).toHaveBeenCalledOnce();
    const [cfg] = mockIndexConversationTurn.mock.calls[0] as [Record<string, unknown>, ...unknown[]];
    // endpoint has trailing slash stripped
    expect(cfg.endpoint).toBe('http://qdrant:6333');
    expect(cfg.chunkSize).toBe(512);
    expect(cfg.chunkOverlap).toBe(64);
    // explicit dim from embedding config
    expect(cfg.dim).toBe(512);
    expect((cfg.embedding as Record<string, unknown>).provider).toBe('openai');
  });

  it('threads explicit config fields into the retriever', async () => {
    vi.mocked(getRagEntry).mockReturnValue(
      makeVsEntry({
        topK: 10,
        scoreThreshold: 0.75,
        embedding: { provider: 'voyage', dim: 1024 },
      }),
    );

    const provider = getRagProvider();
    await provider.retrieveContext('grp', 'what is kubernetes?');

    expect(mockRetrieveContext).toHaveBeenCalledOnce();
    const [cfg] = mockRetrieveContext.mock.calls[0] as [Record<string, unknown>, ...unknown[]];
    expect(cfg.endpoint).toBe('http://qdrant:6333');
    expect(cfg.topK).toBe(10);
    expect(cfg.scoreThreshold).toBe(0.75);
    expect(cfg.dim).toBe(1024);
  });

  it('applies documented fallback defaults for indexer when config fields are omitted', async () => {
    // Minimal config: only adapter + embedding, no chunk settings
    vi.mocked(getRagEntry).mockReturnValue(makeVsEntry());

    const provider = getRagProvider();
    await provider.indexConversationTurn('grp', 'hello', 'world');

    const [cfg] = mockIndexConversationTurn.mock.calls[0] as [Record<string, unknown>, ...unknown[]];
    expect(cfg.chunkSize).toBe(1800);
    expect(cfg.chunkOverlap).toBe(200);
    // openai default dim
    expect(cfg.dim).toBe(1536);
  });

  it('applies documented fallback defaults for retriever when config fields are omitted', async () => {
    vi.mocked(getRagEntry).mockReturnValue(makeVsEntry());

    const provider = getRagProvider();
    await provider.retrieveContext('grp', 'query');

    const [cfg] = mockRetrieveContext.mock.calls[0] as [Record<string, unknown>, ...unknown[]];
    expect(cfg.topK).toBe(5);
    expect(cfg.scoreThreshold).toBe(0.5);
    expect(cfg.dim).toBe(1536);
  });
});

// ── RemoteProvider config threading ─────────────────────────────────────────

describe('RemoteProvider config threading', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockClear();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: 'ctx' }),
      text: () => Promise.resolve(''),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeRemoteEntry(providerOverrides: Record<string, unknown> = {}) {
    return {
      kind: 'rag',
      name: 'lightrag',
      endpoint: 'http://lightrag:9621/',
      kindMetadata: {
        backend: 'lightrag',
        provider: {
          adapter: 'remote',
          ...providerOverrides,
        },
      },
    } as never;
  }

  it('POSTs to the configured indexPath with a {text} body', async () => {
    vi.mocked(getRagEntry).mockReturnValue(
      makeRemoteEntry({ indexPath: '/custom/index' }),
    );

    const provider = getRagProvider();
    await provider.indexConversationTurn('grp', 'user msg', 'agent reply');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://lightrag:9621/custom/index');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toHaveProperty('text');
    expect(typeof body.text).toBe('string');
  });

  it('uses the default indexPath /documents/text when indexPath is unset', async () => {
    vi.mocked(getRagEntry).mockReturnValue(makeRemoteEntry());

    const provider = getRagProvider();
    await provider.indexConversationTurn('grp', 'user msg', 'agent reply');

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe('http://lightrag:9621/documents/text');
  });

  it('POSTs to the configured queryPath with {query, mode} body using configured queryMode', async () => {
    vi.mocked(getRagEntry).mockReturnValue(
      makeRemoteEntry({ queryPath: '/search', queryMode: 'local' }),
    );

    const provider = getRagProvider();
    await provider.retrieveContext('grp', 'my query');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://lightrag:9621/search');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.query).toBe('my query');
    expect(body.mode).toBe('local');
  });

  it('uses default queryPath /query and mode hybrid when not configured', async () => {
    vi.mocked(getRagEntry).mockReturnValue(makeRemoteEntry());

    const provider = getRagProvider();
    await provider.retrieveContext('grp', 'my query');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://lightrag:9621/query');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.mode).toBe('hybrid');
  });

  it('uses configured timeoutMs for the AbortSignal on index calls', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.mocked(getRagEntry).mockReturnValue(makeRemoteEntry({ timeoutMs: 5000 }));

    const provider = getRagProvider();
    await provider.indexConversationTurn('grp', 'u', 'a');

    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    timeoutSpy.mockRestore();
  });

  it('uses default indexTimeoutMs (30000) when timeoutMs is unset', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.mocked(getRagEntry).mockReturnValue(makeRemoteEntry());

    const provider = getRagProvider();
    await provider.indexConversationTurn('grp', 'u', 'a');

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    timeoutSpy.mockRestore();
  });

  it('uses configured timeoutMs for the AbortSignal on query calls', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.mocked(getRagEntry).mockReturnValue(makeRemoteEntry({ timeoutMs: 8000 }));

    const provider = getRagProvider();
    await provider.retrieveContext('grp', 'q');

    expect(timeoutSpy).toHaveBeenCalledWith(8000);
    timeoutSpy.mockRestore();
  });

  it('uses default queryTimeoutMs (15000) when timeoutMs is unset', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.mocked(getRagEntry).mockReturnValue(makeRemoteEntry());

    const provider = getRagProvider();
    await provider.retrieveContext('grp', 'q');

    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    timeoutSpy.mockRestore();
  });

  it('strips trailing slash from the endpoint before building URLs', async () => {
    vi.mocked(getRagEntry).mockReturnValue(makeRemoteEntry());

    const provider = getRagProvider();
    await provider.indexConversationTurn('grp', 'u', 'a');

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    // endpoint http://lightrag:9621/ should become http://lightrag:9621/documents/text
    expect(url).not.toContain('//documents');
  });
});
