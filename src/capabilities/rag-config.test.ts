import { describe, it, expect } from 'vitest';
import { normalizeRagSpec } from './rag-config.js';
import type { RagCapabilitySpec } from './types.js';

describe('normalizeRagSpec', () => {
  it('maps a legacy qdrant spec to a vector-store adapter with openai defaults', () => {
    const legacy = {
      kind: 'rag',
      backend: 'qdrant',
      name: 'main-rag',
      image: 'qdrant/qdrant:latest',
    } as RagCapabilitySpec;
    const out = normalizeRagSpec(legacy);
    expect(out.provider.adapter).toBe('vector-store');
    if (out.provider.adapter !== 'vector-store') throw new Error('unreachable');
    expect(out.provider.embedding.provider).toBe('openai');
    // Defaults are NOT eagerly inlined onto the spec — model/dim resolved later.
    expect(out.backend).toBe('qdrant');
  });

  it('maps a legacy lightrag spec to a remote adapter', () => {
    const legacy = {
      kind: 'rag',
      backend: 'lightrag',
      name: 'lr',
      image: 'lightrag:latest',
    } as RagCapabilitySpec;
    const out = normalizeRagSpec(legacy);
    expect(out.provider.adapter).toBe('remote');
  });

  it('honours EMBEDDING_PROVIDER env when normalizing a legacy qdrant spec', () => {
    const prev = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = 'voyage';
    try {
      const out = normalizeRagSpec({
        kind: 'rag', backend: 'qdrant', name: 'q', image: 'qdrant/qdrant',
      } as RagCapabilitySpec);
      if (out.provider.adapter !== 'vector-store') throw new Error('unreachable');
      expect(out.provider.embedding.provider).toBe('voyage');
    } finally {
      if (prev === undefined) delete process.env.EMBEDDING_PROVIDER;
      else process.env.EMBEDDING_PROVIDER = prev;
    }
  });

  it('passes through a spec that already has a provider unchanged', () => {
    const modern = {
      kind: 'rag', backend: 'weaviate', name: 'w', image: 'weaviate:1',
      provider: {
        adapter: 'vector-store',
        embedding: { provider: 'voyage', model: 'voyage-3', dim: 1024 },
        topK: 8,
      },
    } as RagCapabilitySpec;
    const out = normalizeRagSpec(modern);
    expect(out.provider).toBe(modern.provider);
  });

  it('defaults an unknown legacy backend to vector-store', () => {
    const out = normalizeRagSpec({
      kind: 'rag', backend: 'mystery', name: 'm', image: 'x',
    } as RagCapabilitySpec);
    expect(out.provider.adapter).toBe('vector-store');
  });
});
