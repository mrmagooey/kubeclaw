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
 *   EMBEDDING_BASE_URL — optional separate endpoint for embeddings (OpenAI
 *                        provider only). Useful when the chat endpoint
 *                        doesn't serve embeddings (e.g. self-hosted LLM).
 *                        Defaults to OPENAI_BASE_URL if unset.
 *   OPENAI_API_KEY     — reused for OpenAI embeddings
 *   VOYAGE_API_KEY     — required when EMBEDDING_PROVIDER=voyage
 *   VOYAGE_BASE_URL    — optional base URL for Voyage AI (bare host, no
 *                        trailing slash). Defaults to https://api.voyageai.com.
 *                        Set by the credential broker to route traffic through
 *                        the Envoy proxy.
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
export const EMBEDDING_DIM = process.env.EMBEDDING_DIM
  ? parseInt(process.env.EMBEDDING_DIM, 10)
  : DEFAULT_DIMS[PROVIDER];
export const RAG_ENABLED = !!(
  process.env.QDRANT_URL && process.env.EMBEDDING_PROVIDER !== 'none'
);

// ── OpenAI ────────────────────────────────────────────────────────────────────

let _openaiClient: OpenAI | undefined;
function getOpenAIClient(): OpenAI {
  if (!_openaiClient) {
    // Prefer a dedicated embedding endpoint if configured, so a self-hosted
    // chat LLM that doesn't serve embeddings can still be paired with a
    // separate OpenAI-compatible embedding server.
    const baseURL =
      process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL;
    _openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || 'no-key',
      ...(baseURL ? { baseURL } : {}),
    });
  }
  return _openaiClient;
}

async function embedOpenAI(texts: string[]): Promise<number[][]> {
  const client = getOpenAIClient();
  // Force `encoding_format: 'float'` because the OpenAI SDK defaults to
  // 'base64' in recent versions for wire efficiency, then decodes on the
  // client. Self-hosted OpenAI-compatible servers that don't implement
  // base64 will return a plain float array; the SDK's auto-decode then
  // mis-interprets the floats as packed bytes, yielding a smaller and
  // garbage vector. Asking for floats explicitly avoids that whole path.
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    encoding_format: 'float',
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

  const base =
    process.env.VOYAGE_BASE_URL ?? 'https://api.voyageai.com';
  const response = await fetch(`${base}/v1/embeddings`, {
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
