import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../capabilities/client.js', () => ({
  getRagEntry: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getRagProvider, __resetRagProviderForTest } from './provider.js';
import { getRagEntry } from '../capabilities/client.js';

beforeEach(() => {
  __resetRagProviderForTest();
  vi.mocked(getRagEntry).mockReset();
  delete process.env.LIGHTRAG_URL;
  delete process.env.QDRANT_URL;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.CHANNEL_NAME;
});

describe('getRagProvider', () => {
  it('returns LightRAG when capability registry has lightrag', () => {
    vi.mocked(getRagEntry).mockReturnValue({
      kind: 'rag',
      name: 'lr',
      endpoint: 'http://lr',
      kindMetadata: { backend: 'lightrag' },
    } as never);
    expect(getRagProvider().name).toBe('lightrag');
  });

  it('returns Qdrant when capability registry has qdrant', () => {
    vi.mocked(getRagEntry).mockReturnValue({
      kind: 'rag',
      name: 'q',
      endpoint: 'http://q',
      kindMetadata: { backend: 'qdrant' },
    } as never);
    expect(getRagProvider().name).toBe('qdrant');
    expect(process.env.QDRANT_URL).toBe('http://q');
  });

  it('falls back to env LIGHTRAG_URL when capability registry has nothing', () => {
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    process.env.LIGHTRAG_URL = 'http://env-lr';
    expect(getRagProvider().name).toBe('lightrag');
  });

  it('falls back to env QDRANT_URL', () => {
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    process.env.QDRANT_URL = 'http://env-q';
    process.env.EMBEDDING_PROVIDER = 'openai';
    expect(getRagProvider().name).toBe('qdrant');
  });

  it('returns NullRagProvider when nothing configured', () => {
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    expect(getRagProvider().name).toBe('none');
  });
});
