import { describe, it, expect } from 'vitest';
import {
  normalizeTranscriptionSpec,
  DEFAULT_TRANSCRIPTION_CONFIG,
} from './transcription-config.js';
import type { TranscriptionCapabilitySpec } from './types.js';

describe('normalizeTranscriptionSpec', () => {
  it('fills provider defaults when provider is absent', () => {
    const out = normalizeTranscriptionSpec({
      kind: 'transcription',
      name: 'whisper',
      image: 'onerahmet/openai-whisper-asr-webservice:latest',
    } as TranscriptionCapabilitySpec);
    expect(out.provider.transcribePath).toBe(
      DEFAULT_TRANSCRIPTION_CONFIG.transcribePath,
    );
    expect(out.provider.responseField).toBe(
      DEFAULT_TRANSCRIPTION_CONFIG.responseField,
    );
    expect(out.provider.timeoutMs).toBe(DEFAULT_TRANSCRIPTION_CONFIG.timeoutMs);
    expect(out.provider.model).toBeUndefined();
  });

  it('fills only the missing fields on a partial provider', () => {
    const out = normalizeTranscriptionSpec({
      kind: 'transcription',
      name: 'w',
      image: 'img',
      provider: { transcribePath: '/asr', model: 'base.en' },
    } as TranscriptionCapabilitySpec);
    expect(out.provider.transcribePath).toBe('/asr');
    expect(out.provider.model).toBe('base.en');
    expect(out.provider.responseField).toBe('text');
    expect(out.provider.timeoutMs).toBe(60000);
  });

  it('preserves an explicit responseField and timeoutMs', () => {
    const out = normalizeTranscriptionSpec({
      kind: 'transcription',
      name: 'w',
      image: 'img',
      provider: { responseField: 'transcription', timeoutMs: 120000 },
    } as TranscriptionCapabilitySpec);
    expect(out.provider.responseField).toBe('transcription');
    expect(out.provider.timeoutMs).toBe(120000);
  });
});
