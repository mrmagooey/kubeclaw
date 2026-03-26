import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockEmbed = vi.hoisted(() => vi.fn());
const mockUpsertPoints = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../runtime/embedding-client.js', () => ({
  embed: mockEmbed,
  EMBEDDING_DIM: 3,
  RAG_ENABLED: true,
}));

vi.mock('./store.js', () => ({
  upsertPoints: mockUpsertPoints,
  ensureCollection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Tests ──────────────────────────────────────────────────────────────────

describe('rag/indexer', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Default: one vector per chunk
    mockEmbed.mockImplementation(async (texts: string[]) =>
      texts.map((_, i) => [i * 0.1, i * 0.2, i * 0.3]),
    );
  });

  describe('indexText', () => {
    it('embeds and upserts text as a single chunk', async () => {
      const { indexText } = await import('./indexer.js');
      const text = 'Hello world! This is a test sentence that is long enough to pass the chunk minimum length filter.';
      await indexText('mygroup', text, 'conversation');

      expect(mockEmbed).toHaveBeenCalledTimes(1);
      expect(mockUpsertPoints).toHaveBeenCalledTimes(1);

      const [groupFolder, points] = mockUpsertPoints.mock.calls[0];
      expect(groupFolder).toBe('mygroup');
      expect(points).toHaveLength(1);
      expect(points[0].payload.text).toBe(text);
      expect(points[0].payload.source).toBe('conversation');
      expect(points[0].payload.groupFolder).toBe('mygroup');
    });

    it('splits long text into multiple chunks', async () => {
      // CHUNK_SIZE is 1800 chars — create text longer than that
      const longText = 'word '.repeat(500); // ~2500 chars
      const { indexText } = await import('./indexer.js');
      await indexText('g', longText, 'document');

      const [, points] = mockUpsertPoints.mock.calls[0];
      expect(points.length).toBeGreaterThan(1);
    });

    it('generates stable deterministic IDs for the same content', async () => {
      const { indexText } = await import('./indexer.js');
      const text = 'same text that is definitely long enough to be indexed by the chunker correctly';
      await indexText('g', text, 'doc');
      const id1 = mockUpsertPoints.mock.calls[0][1][0].id;

      vi.clearAllMocks();
      mockEmbed.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
      await indexText('g', text, 'doc');
      const id2 = mockUpsertPoints.mock.calls[0][1][0].id;

      expect(id1).toBe(id2);
    });

    it('generates different IDs for different groups with same text', async () => {
      const { indexText } = await import('./indexer.js');
      const text = 'same text that is definitely long enough to be indexed by the chunker correctly';
      await indexText('group-a', text, 'doc');
      const idA = mockUpsertPoints.mock.calls[0][1][0].id;

      vi.clearAllMocks();
      mockEmbed.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
      await indexText('group-b', text, 'doc');
      const idB = mockUpsertPoints.mock.calls[0][1][0].id;

      expect(idA).not.toBe(idB);
    });

    it('skips empty or whitespace-only text', async () => {
      const { indexText } = await import('./indexer.js');
      await indexText('g', '   ', 'doc');
      expect(mockEmbed).not.toHaveBeenCalled();
      expect(mockUpsertPoints).not.toHaveBeenCalled();
    });

    it('includes a timestamp in point payload', async () => {
      const before = Date.now();
      const { indexText } = await import('./indexer.js');
      await indexText('g', 'some text that is long enough for the chunk filter minimum length requirement', 'doc');
      const after = Date.now();

      const [, points] = mockUpsertPoints.mock.calls[0];
      expect(points[0].payload.timestamp).toBeGreaterThanOrEqual(before);
      expect(points[0].payload.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('indexConversationTurn', () => {
    it('combines user and assistant text into a single turn', async () => {
      const { indexConversationTurn } = await import('./indexer.js');
      await indexConversationTurn(
        'g',
        'What time is it? Please give me the current local time.',
        'It is 3pm. The current local time is 3:00 PM in your timezone.',
      );

      const [, points] = mockUpsertPoints.mock.calls[0];
      expect(points[0].payload.text).toContain('User:');
      expect(points[0].payload.text).toContain('Assistant:');
      expect(points[0].payload.source).toBe('conversation');
    });

    it('is non-fatal — swallows errors and logs a warning', async () => {
      mockUpsertPoints.mockRejectedValueOnce(new Error('qdrant down'));
      const { indexConversationTurn } = await import('./indexer.js');
      // Should not throw
      await expect(
        indexConversationTurn(
          'g',
          'What are the latest updates to the project? Please summarize all changes.',
          'Here is a detailed summary of the latest project updates and changes made this week.',
        ),
      ).resolves.not.toThrow();

      const { logger } = await import('../logger.js');
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
