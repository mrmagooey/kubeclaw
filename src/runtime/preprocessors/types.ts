/**
 * Inbound-preprocessor framework types (channel-side).
 *
 * An inbound preprocessor runs on a user turn immediately before the LLM call.
 * Two effect types:
 *   - 'transform' rewrites the canonical user content (e.g. voice → text). It
 *     sets BOTH `prompt` (handed to the next stage / LLM) and `persistedContent`
 *     (the new text to store + index). Transforms run first.
 *   - 'augment'  only prefixes the LLM-facing prompt (e.g. RAG <retrieved_context>).
 *     It sets `prompt` only; its `persistedContent` is ignored by the chain.
 */

export type PreprocessorEffect = 'transform' | 'augment';

export interface PreprocessorInput {
  groupFolder: string;
  /** Current prompt (already transformed by earlier transforms in the chain). */
  prompt: string;
}

export interface PreprocessorResult {
  /** Prompt handed to the next stage / the LLM. */
  prompt: string;
  /**
   * Set ONLY by `transform` preprocessors: the new canonical user content to
   * persist + index (replaces the marker text). Omitted by augmenters.
   */
  persistedContent?: string;
}

export interface InboundPreprocessor {
  readonly name: string;
  readonly effect: PreprocessorEffect;
  /** MUST be non-throwing in practice — but the chain also guards every call. */
  apply(input: PreprocessorInput): Promise<PreprocessorResult>;
}
