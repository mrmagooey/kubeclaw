/**
 * Retrieval: embed a query, search Qdrant, format results as prompt context.
 *
 * The formatted context block is prepended to the agent prompt so the agent
 * has relevant memory without needing to call a search tool explicitly.
 */

import { embed, RAG_ENABLED } from '../runtime/embedding-client.js';
import { search } from './store.js';
import { logger } from '../logger.js';

const TOP_K = parseInt(process.env.RAG_TOP_K ?? '5', 10);
const SCORE_THRESHOLD = parseFloat(process.env.RAG_SCORE_THRESHOLD ?? '0.5');

/**
 * Retrieve relevant context for a query and format it as a prompt prefix.
 *
 * Returns an empty string if RAG is disabled, Qdrant is unreachable, or
 * no sufficiently similar chunks are found.
 */
export async function retrieveContext(
  groupFolder: string,
  query: string,
): Promise<string> {
  if (!RAG_ENABLED) return '';

  try {
    const [queryVector] = await embed([query]);
    const results = await search(
      groupFolder,
      queryVector,
      TOP_K,
      SCORE_THRESHOLD,
    );

    if (results.length === 0) return '';

    const chunks = results
      .map(
        (r, i) =>
          `[${i + 1}] (${r.source}, relevance ${r.score.toFixed(2)})\n${r.text}`,
      )
      .join('\n\n');

    return `<retrieved_context>\nThe following excerpts from past conversations and documents may be relevant:\n\n${chunks}\n</retrieved_context>\n\n`;
  } catch (err) {
    // Non-fatal — if Qdrant is down, the agent runs without context
    logger.warn(
      { err, groupFolder },
      'RAG retrieval failed, continuing without context',
    );
    return '';
  }
}

/**
 * Prepend retrieved context to a prompt. Returns the original prompt unchanged
 * if RAG is disabled or retrieval returns nothing.
 */
export async function augmentPrompt(
  groupFolder: string,
  prompt: string,
): Promise<string> {
  const context = await retrieveContext(groupFolder, prompt);
  return context ? context + prompt : prompt;
}
