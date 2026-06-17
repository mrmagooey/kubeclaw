/**
 * RAG provider-config defaults and legacy-spec normalization.
 *
 * Persisted specs may predate the `provider` field (`{kind:'rag', backend:'qdrant'}`).
 * normalizeRagSpec() maps such legacy rows to the adapter-based shape on read —
 * no DB migration. Specs that already carry `provider` pass through unchanged.
 */
import type {
  EmbeddingConfig,
  RagCapabilitySpec,
  RagProviderConfig,
  VectorStoreProviderConfig,
  RemoteProviderConfig,
} from './types.js';

export const DEFAULT_EMBEDDING_BY_PROVIDER: Record<
  EmbeddingConfig['provider'],
  { model: string; dim: number; apiKeyEnv: string }
> = {
  openai: { model: 'text-embedding-3-small', dim: 1536, apiKeyEnv: 'OPENAI_API_KEY' },
  voyage: { model: 'voyage-3', dim: 1024, apiKeyEnv: 'VOYAGE_API_KEY' },
};

export const DEFAULT_VECTOR_STORE_CONFIG = {
  chunkSize: 1800,
  chunkOverlap: 200,
  topK: 5,
  scoreThreshold: 0.5,
} as const;

export const DEFAULT_REMOTE_CONFIG = {
  indexPath: '/documents/text',
  queryPath: '/query',
  queryMode: 'hybrid',
  indexTimeoutMs: 30_000,
  queryTimeoutMs: 15_000,
} as const;

/** Spec guaranteed to carry a resolved provider config. */
export interface NormalizedRagSpec extends RagCapabilitySpec {
  provider: RagProviderConfig;
}

function legacyProviderFor(backend: string): RagProviderConfig {
  if (backend === 'lightrag') {
    const remote: RemoteProviderConfig = { adapter: 'remote' };
    return remote;
  }
  // 'qdrant' and any unknown legacy backend default to vector-store.
  const envProvider = process.env.EMBEDDING_PROVIDER;
  const provider: EmbeddingConfig['provider'] =
    envProvider === 'voyage' ? 'voyage' : 'openai';
  const vs: VectorStoreProviderConfig = {
    adapter: 'vector-store',
    embedding: { provider },
  };
  return vs;
}

/**
 * Return a spec with a guaranteed `provider`. If the spec already has one it is
 * returned as-is (same reference); otherwise a provider is derived from the
 * legacy `backend` label.
 */
export function normalizeRagSpec(spec: RagCapabilitySpec): NormalizedRagSpec {
  if (spec.provider) return spec as NormalizedRagSpec;
  return { ...spec, provider: legacyProviderFor(spec.backend) };
}
