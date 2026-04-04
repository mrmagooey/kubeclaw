/**
 * Text chunking + embedding + Qdrant upsert pipeline.
 *
 * Chunks text with a sliding window, embeds each chunk, and upserts into
 * the group's Qdrant collection.
 */

import crypto from 'crypto';
import { embed } from '../runtime/embedding-client.js';
import { upsertPoints, QdrantPoint } from './store.js';
import { logger } from '../logger.js';

const CHUNK_SIZE = 1800; // characters (~450 tokens for English text)
const CHUNK_OVERLAP = 200; // characters of overlap between consecutive chunks

/**
 * Split text into overlapping chunks.
 */
function chunk(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    const slice = text.slice(start, end).trim();
    if (slice.length > 50) chunks.push(slice); // skip tiny trailing fragments
    if (end >= text.length) break;
    start = end - CHUNK_OVERLAP;
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
 * @param groupFolder - the group this content belongs to
 * @param text        - raw text to chunk and embed
 * @param source      - label for provenance (e.g. "conversation", "document")
 */
export async function indexText(
  groupFolder: string,
  text: string,
  source: string,
): Promise<void> {
  const chunks = chunk(text);
  if (chunks.length === 0) return;

  const vectors = await embed(chunks);
  const now = Date.now();

  const points: QdrantPoint[] = chunks.map((c, i) => ({
    id: chunkId(groupFolder, c),
    vector: vectors[i],
    payload: { text: c, source, timestamp: now, groupFolder },
  }));

  await upsertPoints(groupFolder, points);
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
  groupFolder: string,
  userMessage: string,
  agentResponse: string,
): Promise<void> {
  const turn = `User: ${userMessage}\nAssistant: ${agentResponse}`;
  await indexText(groupFolder, turn, 'conversation').catch((err) => {
    // Non-fatal — log and continue; don't break the conversation flow
    logger.warn({ err, groupFolder }, 'Failed to index conversation turn');
  });
}
