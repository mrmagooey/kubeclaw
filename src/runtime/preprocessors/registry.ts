/**
 * Default inbound-preprocessor chain for a channel pod.
 *
 * Registration order: transcription (transform) then RAG (augment). The chain
 * runs all transforms before all augmenters regardless, so transcription always
 * precedes RAG; this order also pins the within-phase order.
 */
import { TranscriptionPreprocessor } from './transcription-preprocessor.js';
import { RagPreprocessor } from './rag-preprocessor.js';
import type { InboundPreprocessor } from './types.js';

export function buildDefaultPreprocessors(): InboundPreprocessor[] {
  return [new TranscriptionPreprocessor(), new RagPreprocessor()];
}
