/**
 * Retrieval: embed a query, search Qdrant, format results as prompt context.
 *
 * The formatted context block is prepended to the agent prompt so the agent
 * has relevant memory without needing to call a search tool explicitly.
 *
 * All config (endpoint, embedding, dim, topK, scoreThreshold) is passed
 * explicitly via RetrieverConfig — no process.env reads.
 */

import { embed } from '../runtime/embedding-client.js';
import { search } from './store.js';
import { logger } from '../logger.js';
import type { RagMetrics } from '../metrics/rag.js';
import type { EmbeddingConfig } from '../capabilities/types.js';

export interface RetrieverConfig {
  endpoint: string;
  embedding: EmbeddingConfig;
  dim: number;
  topK: number;
  scoreThreshold: number;
}

/**
 * Retrieve relevant context for a query and format it as a prompt prefix.
 *
 * Returns an empty string if Qdrant is unreachable or no sufficiently
 * similar chunks are found. Non-fatal — catches and logs errors internally.
 */
export async function retrieveContext(
  config: RetrieverConfig,
  groupFolder: string,
  query: string,
  metrics?: RagMetrics,
): Promise<string> {
  const start = Date.now();
  try {
    const [queryVector] = await embed([query], config.embedding);
    const results = await search(
      { endpoint: config.endpoint, dim: config.dim },
      groupFolder,
      queryVector,
      config.topK,
      config.scoreThreshold,
    );

    const hit = results.length > 0;
    metrics?.recordQuery({
      group: groupFolder,
      hit,
      durationMs: Date.now() - start,
    });

    if (!hit) return '';

    const chunks = results
      .map(
        (r, i) =>
          `[${i + 1}] (${r.source}, relevance ${r.score.toFixed(2)})\n${r.text}`,
      )
      .join('\n\n');

    return `<retrieved_context>\nThe following excerpts from past conversations and documents may be relevant:\n\n${chunks}\n</retrieved_context>\n\n`;
  } catch (err) {
    // Non-fatal — if Qdrant is down, the agent runs without context
    metrics?.recordBackendError({ backend: 'qdrant' });
    logger.warn(
      { err, groupFolder },
      'RAG retrieval failed, continuing without context',
    );
    return '';
  }
}

/**
 * Prepend retrieved context to a prompt. Returns the original prompt unchanged
 * if retrieval returns nothing.
 */
export async function augmentPrompt(
  config: RetrieverConfig,
  groupFolder: string,
  prompt: string,
): Promise<string> {
  const context = await retrieveContext(config, groupFolder, prompt);
  return context ? context + prompt : prompt;
}
