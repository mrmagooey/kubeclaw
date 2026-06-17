/**
 * Voice transcription as the first content transform.
 *
 * Marker-driven (D1): scans the prompt for [VoiceAttachment: attachments/raw/…]
 * markers, reads each audio file from the group PVC at
 * GROUPS_DIR/<groupFolder>/<rawPath>, POSTs it to the discovered transcription
 * capability, and replaces the marker with [Voice: <transcript>]. The
 * substituted text is returned as BOTH prompt and persistedContent (D2) so the
 * transcript — not the marker — is what is stored, indexed, and retrieved
 * against. Non-fatal (D4): no entry, or any per-marker failure, leaves that
 * marker in place and the turn continues.
 */
import { join, resolve, sep } from 'node:path';
import { logger } from '../../logger.js';
import { GROUPS_DIR } from '../../config.js';
import { VOICE_ATTACHMENT_PATTERN } from '../../attachment-markers.js';
import { getTranscriptionEntry } from '../../capabilities/client.js';
import { TranscriptionClient } from '../../transcription/client.js';
import type { CapabilityDiscoveryEntry } from '../../capabilities/types.js';
import type {
  InboundPreprocessor,
  PreprocessorInput,
  PreprocessorResult,
} from './types.js';

type TranscriptionEntry = Extract<CapabilityDiscoveryEntry, { kind: 'transcription' }>;

export class TranscriptionPreprocessor implements InboundPreprocessor {
  readonly name = 'transcription';
  readonly effect = 'transform' as const;

  /** Overridable in tests. */
  protected makeClient(entry: TranscriptionEntry): { transcribeFile(abs: string): Promise<string> } {
    return new TranscriptionClient({
      endpoint: entry.endpoint,
      provider: entry.kindMetadata.provider,
    });
  }

  async apply({ groupFolder, prompt }: PreprocessorInput): Promise<PreprocessorResult> {
    // Fast path: collect markers without consuming the global regex's lastIndex.
    const markers = [...prompt.matchAll(new RegExp(VOICE_ATTACHMENT_PATTERN.source, 'g'))];
    if (markers.length === 0) return { prompt };

    const channel = process.env.KUBECLAW_CHANNEL ?? '*';
    const entry = getTranscriptionEntry(channel);
    if (!entry) {
      logger.warn({ groupFolder, channel }, 'voice marker present but no transcription capability; leaving marker');
      return { prompt };
    }

    const client = this.makeClient(entry);
    let result = prompt;
    let anySucceeded = false;

    for (const m of markers) {
      const marker = m[0];
      const rawPath = m[1];
      const absPath = resolve(GROUPS_DIR, groupFolder, rawPath);
      const allowedBase = resolve(GROUPS_DIR, groupFolder, 'attachments');
      if (absPath !== allowedBase && !absPath.startsWith(allowedBase + sep)) {
        logger.warn({ groupFolder, rawPath }, 'voice marker path escapes attachments dir; skipping');
        continue;
      }
      try {
        const transcript = await client.transcribeFile(absPath);
        if (!transcript.trim()) {
          logger.warn({ groupFolder, rawPath }, 'transcription returned empty transcript; leaving marker in place');
          continue;
        }
        // Use split/join instead of String.prototype.replace to avoid `$`
        // sequences in the transcript (e.g. "costs $20") being interpreted as
        // replacement-pattern specials ($&, $1, $', …) and corrupting the output.
        result = result.split(marker).join(`[Voice: ${transcript}]`);
        anySucceeded = true;
      } catch (err) {
        logger.warn({ err, groupFolder, rawPath }, 'transcription failed for marker; leaving it in place');
      }
    }

    if (!anySucceeded) return { prompt };
    return { prompt: result, persistedContent: result };
  }
}
