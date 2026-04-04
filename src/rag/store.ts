/**
 * Qdrant vector store operations.
 *
 * Uses Qdrant's REST API via native fetch. No extra SDK dependency.
 *
 * Environment variables:
 *   QDRANT_URL — e.g. http://kubeclaw-qdrant:6333 (required for RAG)
 *
 * Collections are named kubeclaw-{groupFolder}, one per group.
 * Points carry a payload of { text, source, timestamp }.
 */

import { EMBEDDING_DIM } from '../runtime/embedding-client.js';
import { logger } from '../logger.js';

const QDRANT_URL = () =>
  process.env.QDRANT_URL ?? 'http://kubeclaw-qdrant:6333';

export interface QdrantPoint {
  id: string; // deterministic UUID derived from content hash
  vector: number[];
  payload: {
    text: string;
    source: string; // e.g. "conversation", "document", "session"
    timestamp: number;
    groupFolder: string;
  };
}

export interface SearchResult {
  text: string;
  source: string;
  score: number;
}

function collectionName(groupFolder: string): string {
  return `kubeclaw-${groupFolder}`;
}

async function qdrantFetch(
  path: string,
  opts: RequestInit = {},
): Promise<unknown> {
  const url = `${QDRANT_URL()}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Qdrant ${opts.method ?? 'GET'} ${path} → ${res.status}: ${body}`,
    );
  }
  return res.json();
}

/**
 * Ensure the collection for a group exists with the correct vector dimension.
 * Idempotent — safe to call before every upsert.
 */
export async function ensureCollection(groupFolder: string): Promise<void> {
  const name = collectionName(groupFolder);
  try {
    await qdrantFetch(`/collections/${name}`);
    return; // already exists
  } catch {
    // 404 — create it
  }
  await qdrantFetch(`/collections/${name}`, {
    method: 'PUT',
    body: JSON.stringify({
      vectors: { size: EMBEDDING_DIM, distance: 'Cosine' },
    }),
  });
  logger.info({ collection: name }, 'Qdrant collection created');
}

/**
 * Upsert a batch of points. Creates the collection if it doesn't exist.
 */
export async function upsertPoints(
  groupFolder: string,
  points: QdrantPoint[],
): Promise<void> {
  if (points.length === 0) return;
  await ensureCollection(groupFolder);
  await qdrantFetch(`/collections/${collectionName(groupFolder)}/points`, {
    method: 'PUT',
    body: JSON.stringify({ points }),
  });
}

/**
 * Search for the top-k most similar chunks to queryVector.
 */
export async function search(
  groupFolder: string,
  queryVector: number[],
  topK = 5,
  scoreThreshold = 0.5,
): Promise<SearchResult[]> {
  const name = collectionName(groupFolder);
  let raw: unknown;
  try {
    raw = await qdrantFetch(`/collections/${name}/points/search`, {
      method: 'POST',
      body: JSON.stringify({
        vector: queryVector,
        limit: topK,
        score_threshold: scoreThreshold,
        with_payload: true,
      }),
    });
  } catch (err) {
    // Collection may not exist yet (no content indexed) — return empty
    logger.debug({ groupFolder, err }, 'Qdrant search returned no results');
    return [];
  }

  const result = raw as {
    result: { payload: { text: string; source: string }; score: number }[];
  };
  return (result.result ?? []).map((r) => ({
    text: r.payload.text,
    source: r.payload.source,
    score: r.score,
  }));
}

/**
 * Delete all points for a group (e.g. when a group is removed).
 */
export async function deleteGroup(groupFolder: string): Promise<void> {
  const name = collectionName(groupFolder);
  try {
    await qdrantFetch(`/collections/${name}`, { method: 'DELETE' });
    logger.info({ collection: name }, 'Qdrant collection deleted');
  } catch {
    // ignore — collection may not exist
  }
}
