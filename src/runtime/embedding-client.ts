/**
 * Provider-agnostic embedding client.
 *
 * Supported providers (EMBEDDING_PROVIDER env var):
 *   openai  — OpenAI text-embedding-3-small (default). Reuses OPENAI_API_KEY.
 *   voyage  — Voyage AI voyage-3. Requires VOYAGE_API_KEY.
 *
 * Environment variables:
 *   EMBEDDING_PROVIDER — "openai" | "voyage" (default: "openai")
 *   EMBEDDING_MODEL    — model name (uses provider default if empty)
 *   OPENAI_API_KEY     — reused for OpenAI embeddings
 *   VOYAGE_API_KEY     — required when EMBEDDING_PROVIDER=voyage
 */

import OpenAI from 'openai';
import { logger } from '../logger.js';

export type EmbeddingProvider = 'openai' | 'voyage';

const PROVIDER = (process.env.EMBEDDING_PROVIDER ||
  'openai') as EmbeddingProvider;

const DEFAULT_MODELS: Record<EmbeddingProvider, string> = {
  openai: 'text-embedding-3-small',
  voyage: 'voyage-3',
};

const DEFAULT_DIMS: Record<EmbeddingProvider, number> = {
  openai: 1536,
  voyage: 1024,
};

export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || DEFAULT_MODELS[PROVIDER];
export const EMBEDDING_DIM = DEFAULT_DIMS[PROVIDER];
export const RAG_ENABLED = !!(
  process.env.QDRANT_URL && process.env.EMBEDDING_PROVIDER !== 'none'
);

// ── OpenAI ────────────────────────────────────────────────────────────────────

let _openaiClient: OpenAI | undefined;
function getOpenAIClient(): OpenAI {
  if (!_openaiClient) {
    _openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || 'no-key',
      ...(process.env.OPENAI_BASE_URL
        ? { baseURL: process.env.OPENAI_BASE_URL }
        : {}),
    });
  }
  return _openaiClient;
}

async function embedOpenAI(texts: string[]): Promise<number[][]> {
  const client = getOpenAIClient();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

// ── Voyage AI ─────────────────────────────────────────────────────────────────

async function embedVoyage(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey)
    throw new Error(
      'VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage',
    );

  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
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
 * Embed a batch of texts. Returns one vector per input string.
 * Logs and rethrows on provider error.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  try {
    switch (PROVIDER) {
      case 'openai':
        return await embedOpenAI(texts);
      case 'voyage':
        return await embedVoyage(texts);
      default:
        throw new Error(`Unknown EMBEDDING_PROVIDER: ${PROVIDER}`);
    }
  } catch (err) {
    logger.error(
      { err, provider: PROVIDER, count: texts.length },
      'Embedding failed',
    );
    throw err;
  }
}
