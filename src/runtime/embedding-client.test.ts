import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockEmbeddingsCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { embeddings: { create: mockEmbeddingsCreate } };
  }),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeOpenAIResponse(vectors: number[][]): object {
  return { data: vectors.map((embedding) => ({ embedding })) };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('embedding-client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.VOYAGE_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── OpenAI provider ──────────────────────────────────────────────────────

  describe('OpenAI provider (default)', () => {
    it('embeds a single text', async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce(
        makeOpenAIResponse([[0.1, 0.2, 0.3]]),
      );
      process.env.EMBEDDING_PROVIDER = 'openai';

      const { embed } = await import('./embedding-client.js');
      const result = await embed(['hello']);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual([0.1, 0.2, 0.3]);
    });

    it('embeds multiple texts in one call', async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce(
        makeOpenAIResponse([
          [0.1, 0.2],
          [0.3, 0.4],
        ]),
      );
      process.env.EMBEDDING_PROVIDER = 'openai';

      const { embed } = await import('./embedding-client.js');
      const result = await embed(['hello', 'world']);

      expect(result).toHaveLength(2);
      expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
    });

    it('uses text-embedding-3-small as default model', async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce(makeOpenAIResponse([[0.1]]));
      process.env.EMBEDDING_PROVIDER = 'openai';

      const { embed } = await import('./embedding-client.js');
      await embed(['test']);

      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'text-embedding-3-small' }),
      );
    });

    it('uses EMBEDDING_MODEL env override', async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce(makeOpenAIResponse([[0.1]]));
      process.env.EMBEDDING_PROVIDER = 'openai';
      process.env.EMBEDDING_MODEL = 'text-embedding-3-large';

      const { embed } = await import('./embedding-client.js');
      await embed(['test']);

      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'text-embedding-3-large' }),
      );
    });

    it('returns empty array for empty input', async () => {
      process.env.EMBEDDING_PROVIDER = 'openai';

      const { embed } = await import('./embedding-client.js');
      const result = await embed([]);

      expect(result).toEqual([]);
      expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
    });

    it('rethrows and logs on OpenAI API error', async () => {
      mockEmbeddingsCreate.mockRejectedValueOnce(new Error('rate_limit'));
      process.env.EMBEDDING_PROVIDER = 'openai';

      const { embed } = await import('./embedding-client.js');
      await expect(embed(['hello'])).rejects.toThrow('rate_limit');

      const { logger } = await import('../logger.js');
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // ── Voyage provider ──────────────────────────────────────────────────────

  describe('Voyage provider', () => {
    beforeEach(() => {
      process.env.EMBEDDING_PROVIDER = 'voyage';
      process.env.VOYAGE_API_KEY = 'pa-test-key';
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('calls Voyage API with correct auth header', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.5, 0.6, 0.7] }] }),
      });

      const { embed } = await import('./embedding-client.js');
      await embed(['hello']);

      expect(fetch).toHaveBeenCalledWith(
        'https://api.voyageai.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer pa-test-key',
          }),
        }),
      );
    });

    it('returns vectors from Voyage response', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
        }),
      });

      const { embed } = await import('./embedding-client.js');
      const result = await embed(['a', 'b']);

      expect(result).toEqual([
        [0.1, 0.2],
        [0.3, 0.4],
      ]);
    });

    it('uses voyage-3 as default model', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      });

      const { embed } = await import('./embedding-client.js');
      await embed(['test']);

      const body = JSON.parse(
        (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.model).toBe('voyage-3');
    });

    it('throws when VOYAGE_API_KEY is missing', async () => {
      delete process.env.VOYAGE_API_KEY;

      const { embed } = await import('./embedding-client.js');
      await expect(embed(['hello'])).rejects.toThrow('VOYAGE_API_KEY');
    });

    it('throws on non-ok Voyage response', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const { embed } = await import('./embedding-client.js');
      await expect(embed(['hello'])).rejects.toThrow('401');
    });
  });

  // ── RAG_ENABLED flag ─────────────────────────────────────────────────────

  describe('RAG_ENABLED', () => {
    it('is false when QDRANT_URL is not set', async () => {
      delete process.env.QDRANT_URL;
      const { RAG_ENABLED } = await import('./embedding-client.js');
      expect(RAG_ENABLED).toBe(false);
    });

    it('is true when QDRANT_URL is set', async () => {
      process.env.QDRANT_URL = 'http://kubeclaw-qdrant:6333';
      const { RAG_ENABLED } = await import('./embedding-client.js');
      expect(RAG_ENABLED).toBe(true);
    });

    it('is false when EMBEDDING_PROVIDER is "none"', async () => {
      process.env.QDRANT_URL = 'http://kubeclaw-qdrant:6333';
      process.env.EMBEDDING_PROVIDER = 'none';
      const { RAG_ENABLED } = await import('./embedding-client.js');
      expect(RAG_ENABLED).toBe(false);
    });
  });
});
