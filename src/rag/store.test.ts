import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// EMBEDDING_DIM drives collection creation — mock the client module so tests
// don't depend on which provider env vars are set.
vi.mock('../runtime/embedding-client.js', () => ({
  EMBEDDING_DIM: 3,
  RAG_ENABLED: true,
}));

// ── Fetch stub helpers ─────────────────────────────────────────────────────

type FetchResponse = {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

function stubFetch(handler: (url: string, opts: RequestInit) => FetchResponse) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, opts: RequestInit = {}) =>
      Promise.resolve({
        text: async () => '',
        json: async () => ({}),
        ...handler(url, opts),
      }),
    ),
  );
}

function qdrantOk(body: unknown = {}): FetchResponse {
  return { ok: true, json: async () => body, text: async () => '' };
}

function qdrantNotFound(): FetchResponse {
  return {
    ok: false,
    status: 404,
    text: async () => 'Not found',
    json: async () => ({}),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('rag/store', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.QDRANT_URL = 'http://qdrant-test:6333';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.QDRANT_URL;
  });

  // ── ensureCollection ────────────────────────────────────────────────────

  describe('ensureCollection', () => {
    it('skips creation if collection already exists', async () => {
      stubFetch(() => qdrantOk());
      const { ensureCollection } = await import('./store.js');
      await ensureCollection('mygroup');

      const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
      // Only the GET check — no PUT
      expect(calls).toHaveLength(1);
      expect(calls[0][1]?.method).toBeUndefined(); // default GET
    });

    it('creates collection when it does not exist', async () => {
      let callCount = 0;
      stubFetch(() => {
        callCount++;
        return callCount === 1 ? qdrantNotFound() : qdrantOk();
      });

      const { ensureCollection } = await import('./store.js');
      await ensureCollection('newgroup');

      const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[1][0]).toContain('/collections/kubeclaw-newgroup');
      expect(calls[1][1]?.method).toBe('PUT');
    });

    it('sends correct vector config on creation', async () => {
      let created = false;
      stubFetch((_url, opts) => {
        if (opts?.method === 'PUT') {
          created = true;
          return qdrantOk();
        }
        return qdrantNotFound();
      });

      const { ensureCollection } = await import('./store.js');
      await ensureCollection('g');

      expect(created).toBe(true);
      const putBody = JSON.parse(
        (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
          ([, o]: [string, RequestInit]) => o?.method === 'PUT',
        )[1].body as string,
      );
      expect(putBody.vectors.size).toBe(3); // mocked EMBEDDING_DIM
      expect(putBody.vectors.distance).toBe('Cosine');
    });
  });

  // ── upsertPoints ────────────────────────────────────────────────────────

  describe('upsertPoints', () => {
    it('does nothing for empty points array', async () => {
      stubFetch(() => qdrantOk());
      const { upsertPoints } = await import('./store.js');
      await upsertPoints('g', []);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('calls PUT /collections/{name}/points', async () => {
      stubFetch(() => qdrantOk());
      const { upsertPoints } = await import('./store.js');

      await upsertPoints('mygroup', [
        {
          id: 'abc',
          vector: [0.1, 0.2, 0.3],
          payload: {
            text: 'hello',
            source: 'doc',
            timestamp: 1,
            groupFolder: 'mygroup',
          },
        },
      ]);

      const putCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([url, opts]: [string, RequestInit]) =>
          url.includes('/points') && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body as string);
      expect(body.points).toHaveLength(1);
      expect(body.points[0].id).toBe('abc');
    });
  });

  // ── search ──────────────────────────────────────────────────────────────

  describe('search', () => {
    it('returns mapped results from Qdrant', async () => {
      stubFetch(() =>
        qdrantOk({
          result: [
            {
              payload: { text: 'chunk A', source: 'conversation' },
              score: 0.9,
            },
            { payload: { text: 'chunk B', source: 'document' }, score: 0.7 },
          ],
        }),
      );

      const { search } = await import('./store.js');
      const results = await search('g', [0.1, 0.2, 0.3], 5, 0.5);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        text: 'chunk A',
        source: 'conversation',
        score: 0.9,
      });
      expect(results[1]).toEqual({
        text: 'chunk B',
        source: 'document',
        score: 0.7,
      });
    });

    it('returns empty array when collection does not exist (graceful)', async () => {
      stubFetch(() => qdrantNotFound());
      const { search } = await import('./store.js');
      const results = await search('g', [0.1, 0.2, 0.3]);
      expect(results).toEqual([]);
    });

    it('sends correct search payload', async () => {
      stubFetch(() => qdrantOk({ result: [] }));
      const { search } = await import('./store.js');
      await search('mygroup', [0.1, 0.2, 0.3], 3, 0.6);

      const body = JSON.parse(
        (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
      );
      expect(body.limit).toBe(3);
      expect(body.score_threshold).toBe(0.6);
      expect(body.vector).toEqual([0.1, 0.2, 0.3]);
      expect(body.with_payload).toBe(true);
    });

    it('uses collection name kubeclaw-{groupFolder}', async () => {
      stubFetch(() => qdrantOk({ result: [] }));
      const { search } = await import('./store.js');
      await search('family', [0.1]);

      const url = (fetch as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(url).toContain('/collections/kubeclaw-family/');
    });
  });

  // ── deleteGroup ─────────────────────────────────────────────────────────

  describe('deleteGroup', () => {
    it('sends DELETE request for the collection', async () => {
      stubFetch(() => qdrantOk());
      const { deleteGroup } = await import('./store.js');
      await deleteGroup('oldgroup');

      const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toContain('/collections/kubeclaw-oldgroup');
      expect(call[1]?.method).toBe('DELETE');
    });

    it('ignores errors (collection may not exist)', async () => {
      stubFetch(() => qdrantNotFound());
      const { deleteGroup } = await import('./store.js');
      await expect(deleteGroup('ghost')).resolves.not.toThrow();
    });
  });
});
