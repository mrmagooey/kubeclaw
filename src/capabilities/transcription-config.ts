/**
 * Transcription provider-config defaults and normalize-on-read.
 *
 * Mirrors rag-config.ts. New `transcription` specs may omit `provider`;
 * normalizeTranscriptionSpec() fills the defaults on read so the consuming
 * client always sees a complete config. There are no legacy transcription rows,
 * so back-compat is vacuous — but the read path stays uniform with RAG.
 */
import type {
  TranscriptionCapabilitySpec,
  TranscriptionProviderConfig,
} from './types.js';

export const DEFAULT_TRANSCRIPTION_CONFIG = {
  transcribePath: '/v1/audio/transcriptions',
  responseField: 'text',
  timeoutMs: 60_000,
} as const;

/** Spec guaranteed to carry a resolved provider config. */
export interface NormalizedTranscriptionSpec extends TranscriptionCapabilitySpec {
  provider: TranscriptionProviderConfig;
}

export function normalizeTranscriptionSpec(
  spec: TranscriptionCapabilitySpec,
): NormalizedTranscriptionSpec {
  const p = spec.provider ?? {};
  return {
    ...spec,
    provider: {
      transcribePath:
        p.transcribePath ?? DEFAULT_TRANSCRIPTION_CONFIG.transcribePath,
      ...(p.model !== undefined ? { model: p.model } : {}),
      responseField:
        p.responseField ?? DEFAULT_TRANSCRIPTION_CONFIG.responseField,
      timeoutMs: p.timeoutMs ?? DEFAULT_TRANSCRIPTION_CONFIG.timeoutMs,
    },
  };
}
