/**
 * Qdrant vector store operations.
 *
 * Uses Qdrant's REST API via native fetch. No extra SDK dependency.
 *
 * All config (endpoint, dim) is passed explicitly via VectorStoreOpts —
 * no process.env reads.
 *
 * Collections are named kubeclaw-{groupFolder}, one per group.
 * Points carry a payload of { text, source, timestamp }.
 */

import { logger } from '../logger.js';

export interface VectorStoreOpts {
  endpoint: string;
  dim: number;
}

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
  opts: VectorStoreOpts,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const url = `${opts.endpoint.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Qdrant ${init.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Ensure the collection for a group exists with the correct vector dimension.
 * Idempotent — safe to call before every upsert.
 */
export async function ensureCollection(opts: VectorStoreOpts, groupFolder: string): Promise<void> {
  const name = collectionName(groupFolder);
  try {
    await qdrantFetch(opts, `/collections/${name}`);
    return; // already exists
  } catch {
    // 404 — create it
  }
  await qdrantFetch(opts, `/collections/${name}`, {
    method: 'PUT',
    body: JSON.stringify({ vectors: { size: opts.dim, distance: 'Cosine' } }),
  });
  logger.info({ collection: name }, 'Qdrant collection created');
}

/**
 * Upsert a batch of points. Creates the collection if it doesn't exist.
 *
 * Uses `?wait=true` so Qdrant validates and applies the upsert synchronously.
 */
export async function upsertPoints(
  opts: VectorStoreOpts,
  groupFolder: string,
  points: QdrantPoint[],
): Promise<void> {
  if (points.length === 0) return;
  await ensureCollection(opts, groupFolder);
  await qdrantFetch(opts, `/collections/${collectionName(groupFolder)}/points?wait=true`, {
    method: 'PUT',
    body: JSON.stringify({ points }),
  });
}

/**
 * Search for the top-k most similar chunks to queryVector.
 */
export async function search(
  opts: VectorStoreOpts,
  groupFolder: string,
  queryVector: number[],
  topK = 5,
  scoreThreshold = 0.5,
): Promise<SearchResult[]> {
  const name = collectionName(groupFolder);
  let raw: unknown;
  try {
    raw = await qdrantFetch(opts, `/collections/${name}/points/search`, {
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
export async function deleteGroup(opts: VectorStoreOpts, groupFolder: string): Promise<void> {
  const name = collectionName(groupFolder);
  try {
    await qdrantFetch(opts, `/collections/${name}`, { method: 'DELETE' });
    logger.info({ collection: name }, 'Qdrant collection deleted');
  } catch {
    // ignore — collection may not exist
  }
}
