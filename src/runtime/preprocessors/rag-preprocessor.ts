/**
 * RAG as the first prompt augmenter.
 *
 * A thin adapter over the unchanged augmentPrompt (src/rag/provider.ts). It
 * prefixes <retrieved_context> onto the LLM-facing prompt and NEVER sets
 * persistedContent — so stored/indexed history stays the canonical user text,
 * preserving the SP2 contract byte-for-byte. Non-fatal: any failure returns the
 * input prompt unchanged.
 */
import { logger } from '../../logger.js';
import { augmentPrompt } from '../../rag/provider.js';
import type {
  InboundPreprocessor,
  PreprocessorInput,
  PreprocessorResult,
} from './types.js';

export class RagPreprocessor implements InboundPreprocessor {
  readonly name = 'rag';
  readonly effect = 'augment' as const;

  async apply({
    groupFolder,
    prompt,
  }: PreprocessorInput): Promise<PreprocessorResult> {
    try {
      return { prompt: await augmentPrompt(groupFolder, prompt) };
    } catch (err) {
      logger.warn(
        { err, groupFolder },
        'RAG augment failed; continuing without context',
      );
      return { prompt };
    }
  }
}
