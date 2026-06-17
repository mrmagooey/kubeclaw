/**
 * Inbound-preprocessor chain runner.
 *
 * Order (fixed): all `transform` preprocessors first (producing the canonical
 * user text), then all `augment` preprocessors (against that canonical text).
 * Within a phase, registration order is preserved.
 *
 * - Transforms may set `persistedContent`; the last transform's text becomes
 *   both the running prompt and the canonical `persistedContent`.
 * - Augmenters set `prompt` only; any `persistedContent` they return is ignored
 *   (logged at warn) because only transforms define canonical content.
 * - Every `apply` is wrapped: a throw/rejection is caught, logged at warn, and
 *   treated as a no-op for that stage. The chain never throws.
 */
import { logger } from '../../logger.js';
import type { InboundPreprocessor } from './types.js';

export interface ChainOutput {
  /** Prompt for the LLM turn (post-transform, post-augment). */
  prompt: string;
  /** Canonical user content for persistence + indexing (post-transform, PRE-augment). */
  persistedContent: string;
}

export async function runPreprocessorChain(
  preprocessors: InboundPreprocessor[],
  groupFolder: string,
  prompt: string,
): Promise<ChainOutput> {
  const transforms = preprocessors.filter((p) => p.effect === 'transform');
  const augmenters = preprocessors.filter((p) => p.effect === 'augment');

  let running = prompt;
  let persistedContent = prompt;

  for (const pp of transforms) {
    try {
      const result = await pp.apply({ groupFolder, prompt: running });
      running = result.prompt;
      if (result.persistedContent !== undefined) {
        persistedContent = result.persistedContent;
      }
    } catch (err) {
      logger.warn({ err, preprocessor: pp.name, groupFolder }, 'transform preprocessor failed; skipping');
    }
  }

  for (const pp of augmenters) {
    try {
      const result = await pp.apply({ groupFolder, prompt: running });
      if (result.persistedContent !== undefined) {
        logger.warn(
          { preprocessor: pp.name },
          'augmenter set persistedContent; ignoring (only transforms define canonical content)',
        );
      }
      running = result.prompt;
    } catch (err) {
      logger.warn({ err, preprocessor: pp.name, groupFolder }, 'augment preprocessor failed; skipping');
    }
  }

  return { prompt: running, persistedContent };
}
