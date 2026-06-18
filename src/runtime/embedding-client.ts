/**
 * Provider-agnostic embedding client.
 *
 * Preferred API: embed(texts, config) where config is an EmbeddingConfig from a
 * RAG capability spec. The model/dim/apiKeyEnv defaults come from
 * resolveEmbeddingDefaults() — a pure function of the config. The raw key is
 * read from process.env[apiKeyEnv] at embed time only; it never lives in a spec.
 *
 * A back-compat embed(texts) form (no config) derives the config from the
 * EMBEDDING_PROVIDER/EMBEDDING_MODEL/OPENAI_BASE_URL env vars for callers not
 * yet migrated.
 */
import OpenAI from 'openai';
import { logger } from '../logger.js';
import { DEFAULT_EMBEDDING_BY_PROVIDER } from '../capabilities/rag-config.js';
import type { EmbeddingConfig } from '../capabilities/types.js';

export type EmbeddingProvider = 'openai' | 'voyage';

export interface ResolvedEmbedding {
  provider: EmbeddingProvider;
  model: string;
  dim: number;
  baseUrl?: string;
  apiKey: string;
  /** The env-var name that the apiKey was read from. */
  apiKeyEnv: string;
}

/** Pure: fill model/dim/baseUrl/apiKey from config + provider defaults + env key. */
export function resolveEmbeddingDefaults(
  config: EmbeddingConfig,
): ResolvedEmbedding {
  const defaults = DEFAULT_EMBEDDING_BY_PROVIDER[config.provider];
  const apiKeyEnv = config.apiKeyEnv ?? defaults.apiKeyEnv;
  return {
    provider: config.provider,
    model: config.model || defaults.model,
    dim: config.dim ?? defaults.dim,
    baseUrl: config.baseUrl,
    apiKey: process.env[apiKeyEnv] || '',
    apiKeyEnv,
  };
}

/** Derive an EmbeddingConfig from env (back-compat path for callers without a config). */
function envEmbeddingConfig(): EmbeddingConfig {
  const provider = (process.env.EMBEDDING_PROVIDER ||
    'openai') as EmbeddingProvider;
  return {
    provider,
    model: process.env.EMBEDDING_MODEL || undefined,
    dim: process.env.EMBEDDING_DIM
      ? parseInt(process.env.EMBEDDING_DIM, 10)
      : undefined,
    baseUrl:
      provider === 'openai'
        ? process.env.EMBEDDING_BASE_URL ||
          process.env.OPENAI_BASE_URL ||
          undefined
        : process.env.VOYAGE_BASE_URL || undefined,
  };
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

async function embedOpenAI(
  texts: string[],
  resolved: ResolvedEmbedding,
): Promise<number[][]> {
  const client = new OpenAI({
    apiKey: resolved.apiKey || 'no-key',
    ...(resolved.baseUrl ? { baseURL: resolved.baseUrl } : {}),
  });
  // Force float encoding — see history; the SDK defaults to base64 and self-hosted
  // servers that return plain floats get mis-decoded otherwise.
  const response = await client.embeddings.create({
    model: resolved.model,
    input: texts,
    encoding_format: 'float',
  });
  return response.data.map((d) => d.embedding);
}

// ── Voyage AI ─────────────────────────────────────────────────────────────────

async function embedVoyage(
  texts: string[],
  resolved: ResolvedEmbedding,
): Promise<number[][]> {
  if (!resolved.apiKey) {
    throw new Error(`${resolved.apiKeyEnv} is required for Voyage embeddings`);
  }
  const base = resolved.baseUrl ?? 'https://api.voyageai.com';
  const response = await fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: resolved.model, input: texts }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Voyage API error ${response.status}: ${err}`);
  }
  const json = (await response.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed a batch of texts. Pass the RAG spec's EmbeddingConfig; if omitted the
 * config is derived from env (back-compat). Returns one vector per input.
 */
export async function embed(
  texts: string[],
  config?: EmbeddingConfig,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const resolved = resolveEmbeddingDefaults(config ?? envEmbeddingConfig());
  try {
    switch (resolved.provider) {
      case 'openai':
        return await embedOpenAI(texts, resolved);
      case 'voyage':
        return await embedVoyage(texts, resolved);
      default:
        throw new Error(`Unknown embedding provider: ${resolved.provider}`);
    }
  } catch (err) {
    logger.error(
      { err, provider: resolved.provider, count: texts.length },
      'Embedding failed',
    );
    throw err;
  }
}
