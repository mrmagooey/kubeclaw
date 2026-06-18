/**
 * Text chunking + embedding + Qdrant upsert pipeline.
 *
 * Chunks text with a sliding window, embeds each chunk, and upserts into
 * the group's Qdrant collection.
 *
 * All config (endpoint, embedding, chunkSize, chunkOverlap, dim) is passed
 * explicitly via IndexerConfig — no process.env reads.
 */

import crypto from 'crypto';
import { embed } from '../runtime/embedding-client.js';
import { upsertPoints, QdrantPoint } from './store.js';
import { logger } from '../logger.js';
import type { RagMetrics } from '../metrics/rag.js';
import type { EmbeddingConfig } from '../capabilities/types.js';

export interface IndexerConfig {
  endpoint: string;
  embedding: EmbeddingConfig;
  dim: number;
  chunkSize: number;
  chunkOverlap: number;
}

/**
 * Split text into overlapping chunks.
 */
function chunk(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const slice = text.slice(start, end).trim();
    if (slice.length > 50) chunks.push(slice); // skip tiny trailing fragments
    if (end >= text.length) break;
    start = end - chunkOverlap;
  }
  return chunks;
}

/**
 * Derive a stable UUID-like ID from content so re-indexing is idempotent.
 */
function chunkId(groupFolder: string, text: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(groupFolder + text)
    .digest('hex');
  // Format as UUID v4 shape for Qdrant (expects UUID or uint64)
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

/**
 * Index a piece of text into the group's Qdrant collection.
 * Idempotent — re-indexing the same text overwrites the existing point.
 *
 * @param config      - indexer config (endpoint, embedding, dim, chunkSize, chunkOverlap)
 * @param groupFolder - the group this content belongs to
 * @param text        - raw text to chunk and embed
 * @param source      - label for provenance (e.g. "conversation", "document")
 */
export async function indexText(
  config: IndexerConfig,
  groupFolder: string,
  text: string,
  source: string,
  metrics?: RagMetrics,
): Promise<void> {
  const chunks = chunk(text, config.chunkSize, config.chunkOverlap);
  if (chunks.length === 0) return;

  const start = Date.now();
  const vectors = await embed(chunks, config.embedding);
  const now = Date.now();

  const points: QdrantPoint[] = chunks.map((c, i) => ({
    id: chunkId(groupFolder, c),
    vector: vectors[i],
    payload: { text: c, source, timestamp: now, groupFolder },
  }));

  await upsertPoints(
    { endpoint: config.endpoint, dim: config.dim },
    groupFolder,
    points,
  );
  metrics?.recordIndex({
    group: groupFolder,
    chunks: chunks.length,
    durationMs: Date.now() - start,
  });
  logger.debug(
    { groupFolder, source, chunks: chunks.length },
    'Indexed text chunks',
  );
}

/**
 * Index the final agent response for a conversation turn so it can be
 * retrieved in future sessions.
 */
export async function indexConversationTurn(
  config: IndexerConfig,
  groupFolder: string,
  userMessage: string,
  agentResponse: string,
): Promise<void> {
  const turn = `User: ${userMessage}\nAssistant: ${agentResponse}`;
  await indexText(config, groupFolder, turn, 'conversation').catch((err) => {
    // Non-fatal — log and continue; don't break the conversation flow
    logger.warn({ err, groupFolder }, 'Failed to index conversation turn');
  });
}
