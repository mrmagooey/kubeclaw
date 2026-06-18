import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTranscriptionEntry = vi.hoisted(() => vi.fn());
vi.mock('../../capabilities/client.js', () => ({ getTranscriptionEntry }));
vi.mock('../../config.js', () => ({ GROUPS_DIR: '/groups' }));
vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TranscriptionPreprocessor } from './transcription-preprocessor.js';

const ENTRY = {
  kind: 'transcription',
  name: 't',
  endpoint: 'http://cap:9000',
  kindMetadata: {
    provider: {
      transcribePath: '/v1/audio/transcriptions',
      responseField: 'text',
      timeoutMs: 60000,
    },
  },
};

// Build a preprocessor whose client is a fake.
function makePreprocessor(transcribe: (abs: string) => Promise<string>) {
  const p = new TranscriptionPreprocessor();
  (
    p as unknown as { makeClient: () => { transcribeFile: typeof transcribe } }
  ).makeClient = () => ({ transcribeFile: transcribe });
  return p;
}

beforeEach(() => {
  getTranscriptionEntry.mockReset();
  delete process.env.KUBECLAW_CHANNEL;
});

describe('TranscriptionPreprocessor', () => {
  it('is a transform effect named transcription', () => {
    const p = new TranscriptionPreprocessor();
    expect(p.name).toBe('transcription');
    expect(p.effect).toBe('transform');
  });

  it('fast path: no marker → identity, no entry lookup', async () => {
    const p = makePreprocessor(async () => 'NOPE');
    const out = await p.apply({ groupFolder: 'g', prompt: 'just text' });
    expect(out.prompt).toBe('just text');
    expect(out.persistedContent).toBeUndefined();
    expect(getTranscriptionEntry).not.toHaveBeenCalled();
  });

  it('no capability entry → marker left intact, non-fatal', async () => {
    getTranscriptionEntry.mockReturnValue(undefined);
    const p = makePreprocessor(async () => 'X');
    const out = await p.apply({
      groupFolder: 'g',
      prompt: '[VoiceAttachment: attachments/raw/a.ogg]',
    });
    expect(out.prompt).toBe('[VoiceAttachment: attachments/raw/a.ogg]');
    expect(out.persistedContent).toBeUndefined();
  });

  it('substitutes a transcript and sets prompt AND persistedContent', async () => {
    getTranscriptionEntry.mockReturnValue(ENTRY);
    const seen: string[] = [];
    const p = makePreprocessor(async (abs) => {
      seen.push(abs);
      return 'hello there';
    });
    const out = await p.apply({
      groupFolder: 'mygroup',
      prompt: 'before [VoiceAttachment: attachments/raw/a.ogg] after',
    });
    expect(seen).toEqual(['/groups/mygroup/attachments/raw/a.ogg']);
    expect(out.prompt).toBe('before [Voice: hello there] after');
    expect(out.persistedContent).toBe('before [Voice: hello there] after');
  });

  it('handles multiple markers', async () => {
    getTranscriptionEntry.mockReturnValue(ENTRY);
    const p = makePreprocessor(async (abs) =>
      abs.endsWith('a.ogg') ? 'first' : 'second',
    );
    const out = await p.apply({
      groupFolder: 'g',
      prompt:
        '[VoiceAttachment: attachments/raw/a.ogg] and [VoiceAttachment: attachments/raw/b.ogg]',
    });
    expect(out.prompt).toBe('[Voice: first] and [Voice: second]');
    expect(out.persistedContent).toBe('[Voice: first] and [Voice: second]');
  });

  it('preserves literal $ in the transcript (no replacement-pattern corruption)', async () => {
    getTranscriptionEntry.mockReturnValue(ENTRY);
    const p = makePreprocessor(async () => 'that costs $20 $now');
    const out = await p.apply({
      groupFolder: 'g',
      prompt: '[VoiceAttachment: attachments/raw/a.ogg]',
    });
    // The literal $ must survive verbatim — split/join never interprets $ patterns.
    expect(out.prompt).toBe('[Voice: that costs $20 $now]');
    expect(out.persistedContent).toBe('[Voice: that costs $20 $now]');
  });

  it('per-marker failure leaves that marker intact, transcribes the rest', async () => {
    getTranscriptionEntry.mockReturnValue(ENTRY);
    const p = makePreprocessor(async (abs) => {
      if (abs.endsWith('a.ogg')) throw new Error('non-2xx');
      return 'ok';
    });
    const out = await p.apply({
      groupFolder: 'g',
      prompt:
        '[VoiceAttachment: attachments/raw/a.ogg] x [VoiceAttachment: attachments/raw/b.ogg]',
    });
    expect(out.prompt).toBe(
      '[VoiceAttachment: attachments/raw/a.ogg] x [Voice: ok]',
    );
    // a transform fired (b succeeded) so persistedContent is set to the substituted text
    expect(out.persistedContent).toBe(
      '[VoiceAttachment: attachments/raw/a.ogg] x [Voice: ok]',
    );
  });

  it('reads KUBECLAW_CHANNEL when resolving the entry', async () => {
    process.env.KUBECLAW_CHANNEL = 'telegram';
    getTranscriptionEntry.mockReturnValue(undefined);
    const p = makePreprocessor(async () => 'X');
    await p.apply({
      groupFolder: 'g',
      prompt: '[VoiceAttachment: attachments/raw/a.ogg]',
    });
    expect(getTranscriptionEntry).toHaveBeenCalledWith('telegram');
  });

  it('falls back to wildcard channel when KUBECLAW_CHANNEL is unset', async () => {
    getTranscriptionEntry.mockReturnValue(undefined);
    const p = makePreprocessor(async () => 'X');
    await p.apply({
      groupFolder: 'g',
      prompt: '[VoiceAttachment: attachments/raw/a.ogg]',
    });
    expect(getTranscriptionEntry).toHaveBeenCalledWith('*');
  });

  it('path traversal marker is skipped (marker left intact, no transcribe call)', async () => {
    getTranscriptionEntry.mockReturnValue(ENTRY);
    const transcribeSpy = vi.fn().mockResolvedValue('should not be called');
    const p = makePreprocessor(transcribeSpy);
    const maliciousPrompt =
      '[VoiceAttachment: attachments/raw/../../../etc/passwd]';
    const out = await p.apply({ groupFolder: 'g', prompt: maliciousPrompt });
    expect(out.prompt).toBe(maliciousPrompt);
    expect(out.persistedContent).toBeUndefined();
    expect(transcribeSpy).not.toHaveBeenCalled();
  });

  it('empty transcript leaves marker intact and does not set persistedContent', async () => {
    getTranscriptionEntry.mockReturnValue(ENTRY);
    const transcribeSpy = vi.fn().mockResolvedValue('');
    const p = makePreprocessor(transcribeSpy);
    const prompt = '[VoiceAttachment: attachments/raw/a.ogg]';
    const out = await p.apply({ groupFolder: 'g', prompt });
    expect(out.prompt).toBe(prompt);
    expect(out.persistedContent).toBeUndefined();
    expect(transcribeSpy).toHaveBeenCalledOnce();
  });
});
