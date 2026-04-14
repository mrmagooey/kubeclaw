/**
 * RAG provider interface.
 *
 * Channels program against this interface. The concrete backend (Qdrant,
 * LightRAG, or none) is selected at startup based on environment variables
 * or capability discovery.
 */

import { logger } from '../logger.js';

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
 * Uses the existing src/rag/store.ts + src/runtime/embedding-client.ts.
 */
class QdrantRagProvider implements RagProvider {
  readonly name = 'qdrant';

  async indexConversationTurn(
    groupFolder: string,
    userMessage: string,
    agentResponse: string,
  ): Promise<void> {
    try {
      const { indexConversationTurn } = await import('./indexer.js');
      await indexConversationTurn(groupFolder, userMessage, agentResponse);
    } catch (err) {
      logger.warn({ err, groupFolder }, 'Qdrant RAG indexing failed');
    }
  }

  async retrieveContext(
    groupFolder: string,
    query: string,
  ): Promise<string> {
    try {
      const { retrieveContext } = await import('./retriever.js');
      return await retrieveContext(groupFolder, query);
    } catch (err) {
      logger.warn({ err, groupFolder }, 'Qdrant RAG retrieval failed');
      return '';
    }
  }
}

/**
 * LightRAG-backed provider.
 * Calls the LightRAG REST API (no local embedding — LightRAG handles it).
 */
class LightRagProvider implements RagProvider {
  readonly name = 'lightrag';
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async indexConversationTurn(
    groupFolder: string,
    userMessage: string,
    agentResponse: string,
  ): Promise<void> {
    const text = `[Group: ${groupFolder}]\nUser: ${userMessage}\nAssistant: ${agentResponse}`;
    try {
      const res = await fetch(`${this.baseUrl}/documents/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.warn(
          { status: res.status, body, groupFolder },
          'LightRAG indexing failed',
        );
      }
    } catch (err) {
      logger.warn({ err, groupFolder }, 'LightRAG indexing failed');
    }
  }

  async retrieveContext(
    groupFolder: string,
    query: string,
  ): Promise<string> {
    try {
      const res = await fetch(`${this.baseUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, mode: 'hybrid' }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        logger.debug({ status: res.status, groupFolder }, 'LightRAG query failed');
        return '';
      }
      const json = (await res.json()) as { response?: string };
      const response = json.response?.trim();
      if (!response) return '';

      return `<retrieved_context>\n${response}\n</retrieved_context>\n\n`;
    } catch (err) {
      logger.warn({ err, groupFolder }, 'LightRAG retrieval failed');
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
 *   1. LIGHTRAG_URL env var → LightRagProvider
 *   2. QDRANT_URL env var  → QdrantRagProvider
 *   3. Neither             → NullRagProvider (no-op)
 */
export function getRagProvider(): RagProvider {
  if (!_provider) {
    const lightragUrl = process.env.LIGHTRAG_URL;
    const qdrantUrl = process.env.QDRANT_URL;

    if (lightragUrl) {
      _provider = new LightRagProvider(lightragUrl);
      logger.info({ url: lightragUrl }, 'RAG provider: LightRAG');
    } else if (qdrantUrl && process.env.EMBEDDING_PROVIDER !== 'none') {
      _provider = new QdrantRagProvider();
      logger.info({ url: qdrantUrl }, 'RAG provider: Qdrant');
    } else {
      _provider = new NullRagProvider();
      logger.info('RAG provider: none (disabled)');
    }
  }
  return _provider;
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
