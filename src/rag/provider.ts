/**
 * RAG provider interface.
 *
 * Channels program against this interface. The concrete backend (VectorStore,
 * Remote, or none) is selected at startup based on capability discovery.
 *
 * VectorStoreProvider and RemoteProvider are constructed from the discovery
 * entry's `kindMetadata.provider` config — no process.env reads for endpoint
 * or adapter config.
 */

import { logger } from '../logger.js';
import { getRagEntry } from '../capabilities/client.js';
import {
  DEFAULT_VECTOR_STORE_CONFIG,
  DEFAULT_REMOTE_CONFIG,
} from '../capabilities/rag-config.js';
import { resolveEmbeddingDefaults } from '../runtime/embedding-client.js';
import type {
  VectorStoreProviderConfig,
  RemoteProviderConfig,
} from '../capabilities/types.js';

export interface RagProvider {
  /** Human-readable name for logging */
  readonly name: string;

  /**
   * Index a conversation turn so it can be retrieved later.
   * Non-fatal — implementations must catch and log errors internally.
   */
  indexConversationTurn(
    groupFolder: string,
    userMessage: string,
    agentResponse: string,
  ): Promise<void>;

  /**
   * Retrieve relevant context for a query. Returns a formatted prompt
   * prefix string, or empty string if nothing is found or RAG is unavailable.
   * Non-fatal — implementations must catch and log errors internally.
   */
  retrieveContext(groupFolder: string, query: string): Promise<string>;
}

/**
 * No-op provider used when RAG is not configured.
 */
class NullRagProvider implements RagProvider {
  readonly name = 'none';

  async indexConversationTurn(): Promise<void> {}
  async retrieveContext(): Promise<string> {
    return '';
  }
}

/**
 * Qdrant-backed RAG provider.
 * Built from the discovery entry's VectorStoreProviderConfig.
 */
class VectorStoreProvider implements RagProvider {
  readonly name = 'vector-store';
  private readonly endpoint: string;
  private readonly cfg: VectorStoreProviderConfig;
  private readonly dim: number;

  constructor(endpoint: string, cfg: VectorStoreProviderConfig) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.cfg = cfg;
    this.dim = resolveEmbeddingDefaults(cfg.embedding).dim;
  }

  private indexerConfig() {
    return {
      endpoint: this.endpoint,
      embedding: this.cfg.embedding,
      dim: this.dim,
      chunkSize: this.cfg.chunkSize ?? DEFAULT_VECTOR_STORE_CONFIG.chunkSize,
      chunkOverlap: this.cfg.chunkOverlap ?? DEFAULT_VECTOR_STORE_CONFIG.chunkOverlap,
    };
  }

  private retrieverConfig() {
    return {
      endpoint: this.endpoint,
      embedding: this.cfg.embedding,
      dim: this.dim,
      topK: this.cfg.topK ?? DEFAULT_VECTOR_STORE_CONFIG.topK,
      scoreThreshold: this.cfg.scoreThreshold ?? DEFAULT_VECTOR_STORE_CONFIG.scoreThreshold,
    };
  }

  async indexConversationTurn(
    groupFolder: string,
    userMessage: string,
    agentResponse: string,
  ): Promise<void> {
    try {
      const { indexConversationTurn } = await import('./indexer.js');
      await indexConversationTurn(this.indexerConfig(), groupFolder, userMessage, agentResponse);
    } catch (err) {
      logger.warn({ err, groupFolder }, 'vector-store RAG indexing failed');
    }
  }

  async retrieveContext(groupFolder: string, query: string): Promise<string> {
    try {
      const { retrieveContext } = await import('./retriever.js');
      return await retrieveContext(this.retrieverConfig(), groupFolder, query);
    } catch (err) {
      logger.warn({ err, groupFolder }, 'vector-store RAG retrieval failed');
      return '';
    }
  }
}

/**
 * Remote (LightRAG-style) HTTP provider.
 * Built from the discovery entry's RemoteProviderConfig.
 */
class RemoteProvider implements RagProvider {
  readonly name = 'remote';
  private readonly baseUrl: string;
  private readonly cfg: RemoteProviderConfig;

  constructor(endpoint: string, cfg: RemoteProviderConfig) {
    this.baseUrl = endpoint.replace(/\/$/, '');
    this.cfg = cfg;
  }

  async indexConversationTurn(
    groupFolder: string,
    userMessage: string,
    agentResponse: string,
  ): Promise<void> {
    const text = `[Group: ${groupFolder}]\nUser: ${userMessage}\nAssistant: ${agentResponse}`;
    const path = this.cfg.indexPath ?? DEFAULT_REMOTE_CONFIG.indexPath;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_REMOTE_CONFIG.indexTimeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.warn({ status: res.status, body, groupFolder }, 'remote RAG indexing failed');
      }
    } catch (err) {
      logger.warn({ err, groupFolder }, 'remote RAG indexing failed');
    }
  }

  async retrieveContext(groupFolder: string, query: string): Promise<string> {
    const path = this.cfg.queryPath ?? DEFAULT_REMOTE_CONFIG.queryPath;
    const mode = this.cfg.queryMode ?? DEFAULT_REMOTE_CONFIG.queryMode;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, mode }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_REMOTE_CONFIG.queryTimeoutMs),
      });
      if (!res.ok) {
        logger.debug({ status: res.status, groupFolder }, 'remote RAG query failed');
        return '';
      }
      const json = (await res.json()) as { response?: string };
      const response = json.response?.trim();
      if (!response) return '';
      return `<retrieved_context>\n${response}\n</retrieved_context>\n\n`;
    } catch (err) {
      logger.warn({ err, groupFolder }, 'remote RAG retrieval failed');
      return '';
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _provider: RagProvider | undefined;

/**
 * Get the active RAG provider.
 *
 * Selection order:
 *   1. Capability registry — consults getRagEntry() for the current channel
 *      pod, then selects RemoteProvider or VectorStoreProvider based on the
 *      kindMetadata.provider.adapter field.
 *   2. No capability registered → NullRagProvider (no-op)
 */
export function getRagProvider(): RagProvider {
  if (_provider) return _provider;
  try {
    const channelName = process.env.KUBECLAW_CHANNEL ?? '*';
    const entry = getRagEntry(channelName);
    if (entry) {
      const provider = entry.kindMetadata.provider;
      if (provider.adapter === 'remote') {
        _provider = new RemoteProvider(entry.endpoint, provider);
        logger.info({ url: entry.endpoint }, 'RAG provider: remote');
        return _provider;
      }
      if (provider.adapter === 'vector-store') {
        _provider = new VectorStoreProvider(entry.endpoint, provider);
        logger.info({ url: entry.endpoint }, 'RAG provider: vector-store');
        return _provider;
      }
    }
  } catch (err) {
    logger.debug({ err }, 'Capability lookup unavailable');
  }
  _provider = new NullRagProvider();
  logger.info('RAG provider: none (disabled)');
  return _provider;
}

/**
 * Drop the cached provider so the next `getRagProvider()` call re-selects from
 * the capability registry. Channel pods call this when a `capabilities_update`
 * notification arrives so a newly installed RAG capability becomes active
 * without a pod restart.
 */
export function resetRagProvider(): void {
  _provider = undefined;
}

/** @deprecated Use resetRagProvider(). Test-only alias kept for back-compat. */
export function __resetRagProviderForTest(): void {
  _provider = undefined;
}

/**
 * Convenience: augment a prompt with retrieved context.
 * Returns the original prompt unchanged if RAG is disabled or retrieval
 * returns nothing.
 */
export async function augmentPrompt(
  groupFolder: string,
  prompt: string,
): Promise<string> {
  const context = await getRagProvider().retrieveContext(groupFolder, prompt);
  return context ? context + prompt : prompt;
}
