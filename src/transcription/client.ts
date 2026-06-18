/**
 * Config-driven transcription client.
 *
 * Constructed from a discovery entry's endpoint + TranscriptionProviderConfig
 * (no process.env reads, mirroring the RAG provider style). Reads an audio file
 * by absolute path and POSTs it as multipart/form-data to a Whisper-class /
 * OpenAI-compatible audio endpoint, returning the transcript text.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { logger } from '../logger.js';
import { DEFAULT_TRANSCRIPTION_CONFIG } from '../capabilities/transcription-config.js';
import type { TranscriptionProviderConfig } from '../capabilities/types.js';

export interface TranscriptionClientOpts {
  endpoint: string;
  provider: TranscriptionProviderConfig;
}

export class TranscriptionClient {
  private readonly baseUrl: string;
  private readonly provider: TranscriptionProviderConfig;

  constructor(opts: TranscriptionClientOpts) {
    this.baseUrl = opts.endpoint.replace(/\/$/, '');
    this.provider = opts.provider;
  }

  /** Read the file at absPath and POST it; returns the transcript string. */
  async transcribeFile(absPath: string): Promise<string> {
    const bytes = await readFile(absPath);
    const path =
      this.provider.transcribePath ??
      DEFAULT_TRANSCRIPTION_CONFIG.transcribePath;
    const responseField =
      this.provider.responseField ?? DEFAULT_TRANSCRIPTION_CONFIG.responseField;
    const timeoutMs =
      this.provider.timeoutMs ?? DEFAULT_TRANSCRIPTION_CONFIG.timeoutMs;

    const form = new FormData();
    form.append('file', new Blob([bytes]), basename(absPath));
    if (this.provider.model) form.append('model', this.provider.model);

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Transcription POST ${path} → ${res.status}: ${body}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    const value = json[responseField];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `Transcription response missing string field '${responseField}'`,
      );
    }
    logger.debug({ path, chars: value.length }, 'Transcription succeeded');
    return value;
  }
}
