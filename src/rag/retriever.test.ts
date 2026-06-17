import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockEmbed = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => vi.fn());

vi.mock('../runtime/embedding-client.js', () => ({
  embed: mockEmbed,
}));

vi.mock('./store.js', () => ({
  search: mockSearch,
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Config ─────────────────────────────────────────────────────────────────

const CFG = {
  endpoint: 'http://q:6333',
  embedding: { provider: 'openai' as const },
  dim: 3,
  topK: 5,
  scoreThreshold: 0.5,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSearchResult(text: string, score = 0.8, source = 'conversation') {
  return { text, score, source };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('rag/retriever', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockEmbed.mockResolvedValue([[0.1, 0.2, 0.3]]);
    mockSearch.mockResolvedValue([]);
  });

  // ── retrieveContext ──────────────────────────────────────────────────────

  describe('retrieveContext', () => {
    it('returns empty string when no results found', async () => {
      mockSearch.mockResolvedValueOnce([]);
      const { retrieveContext } = await import('./retriever.js');
      const ctx = await retrieveContext(CFG, 'g', 'hello');
      expect(ctx).toBe('');
    });

    it('wraps results in <retrieved_context> tags', async () => {
      mockSearch.mockResolvedValueOnce([makeSearchResult('relevant chunk')]);
      const { retrieveContext } = await import('./retriever.js');
      const ctx = await retrieveContext(CFG, 'g', 'hello');

      expect(ctx).toContain('<retrieved_context>');
      expect(ctx).toContain('</retrieved_context>');
      expect(ctx).toContain('relevant chunk');
    });

    it('includes score and source metadata per chunk', async () => {
      mockSearch.mockResolvedValueOnce([
        makeSearchResult('chunk text', 0.91, 'document'),
      ]);
      const { retrieveContext } = await import('./retriever.js');
      const ctx = await retrieveContext(CFG, 'g', 'query');

      expect(ctx).toContain('document');
      expect(ctx).toContain('0.91');
    });

    it('numbers multiple chunks', async () => {
      mockSearch.mockResolvedValueOnce([
        makeSearchResult('first', 0.9),
        makeSearchResult('second', 0.8),
        makeSearchResult('third', 0.7),
      ]);
      const { retrieveContext } = await import('./retriever.js');
      const ctx = await retrieveContext(CFG, 'g', 'q');

      expect(ctx).toContain('[1]');
      expect(ctx).toContain('[2]');
      expect(ctx).toContain('[3]');
    });

    it('embeds the query with config before searching', async () => {
      const { retrieveContext } = await import('./retriever.js');
      await retrieveContext(CFG, 'mygroup', 'the user query');

      expect(mockEmbed).toHaveBeenCalledWith(['the user query'], CFG.embedding);
      expect(mockSearch).toHaveBeenCalledWith(
        { endpoint: CFG.endpoint, dim: CFG.dim },
        'mygroup',
        [0.1, 0.2, 0.3],
        5,
        0.5,
      );
    });

    it('is non-fatal — returns empty string on error and logs warning', async () => {
      mockEmbed.mockRejectedValueOnce(new Error('api down'));
      const { retrieveContext } = await import('./retriever.js');
      const ctx = await retrieveContext(CFG, 'g', 'query');

      expect(ctx).toBe('');
      const { logger } = await import('../logger.js');
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // ── augmentPrompt ────────────────────────────────────────────────────────

  describe('augmentPrompt', () => {
    it('returns original prompt when no context is retrieved', async () => {
      mockSearch.mockResolvedValueOnce([]);
      const { augmentPrompt } = await import('./retriever.js');
      const result = await augmentPrompt(CFG, 'g', 'my prompt');
      expect(result).toBe('my prompt');
    });

    it('prepends context block to the prompt', async () => {
      mockSearch.mockResolvedValueOnce([makeSearchResult('past context')]);
      const { augmentPrompt } = await import('./retriever.js');
      const result = await augmentPrompt(CFG, 'g', 'my prompt');

      expect(result).toMatch(/^<retrieved_context>/);
      expect(result).toContain('past context');
      expect(result).toContain('my prompt');
    });

    it('context appears before user prompt in output', async () => {
      mockSearch.mockResolvedValueOnce([makeSearchResult('memory')]);
      const { augmentPrompt } = await import('./retriever.js');
      const result = await augmentPrompt(CFG, 'g', 'question');

      const ctxEnd = result.indexOf('</retrieved_context>');
      const promptStart = result.indexOf('question');
      expect(ctxEnd).toBeLessThan(promptStart);
    });

    it('returns original prompt on retrieval error (non-fatal)', async () => {
      mockSearch.mockRejectedValueOnce(new Error('qdrant unreachable'));
      const { augmentPrompt } = await import('./retriever.js');
      const result = await augmentPrompt(CFG, 'g', 'my prompt');
      expect(result).toBe('my prompt');
    });
  });
});
