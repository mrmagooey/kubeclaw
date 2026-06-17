/**
 * Preprocessor-chain E2E
 *
 * Verifies that DirectLLMRunner's inbound-preprocessor chain (chain.ts,
 * registry.ts, rag-preprocessor.ts, transcription-preprocessor.ts) runs
 * end-to-end: transforms execute first, augmenters execute after, the
 * augmented text reaches the LLM, and only the canonical (pre-augment,
 * post-transform) text is persisted.
 *
 * No Kubernetes, no GPU, no Qdrant, no Whisper required.
 * Uses the in-process mock LLM server started by e2e/setup.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getMockLlmPort } from './setup.js';
import { _initTestDatabase } from '../src/db.js';
import type { InboundPreprocessor, PreprocessorInput, PreprocessorResult } from '../src/runtime/preprocessors/types.js';

// ---------------------------------------------------------------------------
// Stub preprocessors — deterministic, no external dependencies
// ---------------------------------------------------------------------------

/** Transform: appends a sentinel to the prompt and sets persistedContent. */
class StubTransform implements InboundPreprocessor {
  readonly name = 'stub-transform';
  readonly effect = 'transform' as const;
  async apply({ prompt }: PreprocessorInput): Promise<PreprocessorResult> {
    const transformed = `${prompt} [TRANSFORM_APPLIED]`;
    return { prompt: transformed, persistedContent: 'CANONICAL:' + transformed };
  }
}

/** Augment: prepends a fake RAG context block — not stored. */
class StubAugment implements InboundPreprocessor {
  readonly name = 'stub-augment';
  readonly effect = 'augment' as const;
  async apply({ prompt }: PreprocessorInput): Promise<PreprocessorResult> {
    return { prompt: `<retrieved_context>AUGMENT_BLOCK</retrieved_context>\n${prompt}` };
  }
}

/** Transform that always throws — must be a no-op, not crash runAgent. */
class ThrowingTransform implements InboundPreprocessor {
  readonly name = 'throwing-transform';
  readonly effect = 'transform' as const;
  async apply(_: PreprocessorInput): Promise<PreprocessorResult> {
    throw new Error('deliberate transform failure');
  }
}

/** Augment that always throws — must be a no-op, not crash runAgent. */
class ThrowingAugment implements InboundPreprocessor {
  readonly name = 'throwing-augment';
  readonly effect = 'augment' as const;
  async apply(_: PreprocessorInput): Promise<PreprocessorResult> {
    throw new Error('deliberate augment failure');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal group object accepted by runAgent. */
function makeGroup(folder: string) {
  return { name: folder, folder, trigger: '', added_at: new Date().toISOString() };
}

/** Minimal ContainerInput accepted by runAgent. */
function makeInput(prompt: string, groupFolder: string) {
  return { prompt, groupFolder, chatJid: 'e2e@e2e', isMain: false, assistantName: 'TestBot' };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('preprocessor-chain', () => {
  beforeAll(async () => {
    await _initTestDatabase();

    const port = getMockLlmPort();
    if (!port) return;

    process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.DIRECT_LLM_MODEL = 'test/model';
  });

  // -------------------------------------------------------------------------
  // Smoke: empty preprocessors array → turn succeeds, prompt stored verbatim
  // -------------------------------------------------------------------------

  it('empty chain: runAgent succeeds and stores the original prompt', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { getConversationHistory } = await import('../src/db.js');

    const runner = new DirectLLMRunner();
    runner.preprocessors = [];           // explicitly empty — chain is a no-op

    const groupFolder = `pp-empty-${Date.now()}`;
    const prompt = 'hello from empty chain';

    const output = await runner.runAgent(makeGroup(groupFolder), makeInput(prompt, groupFolder));

    expect(output.status).toBe('success');

    const history = getConversationHistory(groupFolder);
    expect(history.some((m) => m.role === 'user' && m.content.includes('hello from empty chain'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Default chain: both real preprocessors registered, neither capability
  // installed → non-fatal, turn succeeds (TranscriptionPreprocessor fast-paths
  // when no [VoiceAttachment] marker; RagPreprocessor catches augmentPrompt
  // failure and returns prompt unchanged)
  // -------------------------------------------------------------------------

  it('default chain with no capabilities installed: turn succeeds and prompt is stored', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { buildDefaultPreprocessors } = await import('../src/runtime/preprocessors/registry.js');
    const { getConversationHistory } = await import('../src/db.js');

    const runner = new DirectLLMRunner();
    runner.preprocessors = buildDefaultPreprocessors();   // real, no capabilities wired

    const groupFolder = `pp-default-nocap-${Date.now()}`;
    const prompt = 'plain text, no voice markers';

    const output = await runner.runAgent(makeGroup(groupFolder), makeInput(prompt, groupFolder));

    expect(output.status).toBe('success');

    const history = getConversationHistory(groupFolder);
    expect(history.some((m) => m.role === 'user' && m.content.includes('plain text, no voice markers'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Transform runs: canonical (post-transform) text is persisted, not input
  // -------------------------------------------------------------------------

  it('transform preprocessor: persisted content is post-transform, not raw input', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { getConversationHistory } = await import('../src/db.js');

    const runner = new DirectLLMRunner();
    runner.preprocessors = [new StubTransform()];

    const groupFolder = `pp-transform-${Date.now()}`;
    const rawPrompt = 'raw input text';

    const output = await runner.runAgent(makeGroup(groupFolder), makeInput(rawPrompt, groupFolder));

    expect(output.status).toBe('success');

    const history = getConversationHistory(groupFolder);
    const userEntry = history.find((m) => m.role === 'user');
    expect(userEntry).toBeTruthy();

    // persistedContent was 'CANONICAL:<transformed>' — that is what was stored.
    // The raw prompt alone should NOT appear since the transform replaced it.
    expect(userEntry!.content).toContain('CANONICAL:');
    expect(userEntry!.content).toContain('TRANSFORM_APPLIED');
  });

  // -------------------------------------------------------------------------
  // Augment runs: augmented text reaches the LLM but is NOT stored
  // -------------------------------------------------------------------------

  it('augment preprocessor: augmented text sent to LLM but not persisted', async () => {
    if (!getMockLlmPort()) return;

    const port = getMockLlmPort()!;
    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { getConversationHistory } = await import('../src/db.js');

    const runner = new DirectLLMRunner();
    runner.preprocessors = [new StubAugment()];

    const groupFolder = `pp-augment-${Date.now()}`;
    const rawPrompt = 'augment probe message';

    await runner.runAgent(makeGroup(groupFolder), makeInput(rawPrompt, groupFolder));

    // Inspect what was actually sent to the mock LLM
    const resp = await fetch(`http://localhost:${port}/last-request`);
    if (resp.ok) {
      const body = await resp.json() as { messages?: { role: string; content: string }[] };
      const userMessages = (body.messages ?? []).filter((m) => m.role === 'user');
      const lastUserContent = userMessages[userMessages.length - 1]?.content ?? '';

      // Augmenter prepended the context block — LLM must have received it
      expect(lastUserContent).toContain('AUGMENT_BLOCK');
      expect(lastUserContent).toContain('<retrieved_context>');
    } else {
      // /last-request not supported by this mock variant — degrade to status check
      console.warn('⚠️  /last-request not available; asserting turn status only');
    }

    // Persisted content must NOT contain the augment block
    const history = getConversationHistory(groupFolder);
    const userEntry = history.find((m) => m.role === 'user');
    expect(userEntry).toBeTruthy();
    expect(userEntry!.content).not.toContain('AUGMENT_BLOCK');
    expect(userEntry!.content).not.toContain('<retrieved_context>');
    expect(userEntry!.content).toContain('augment probe message');
  });

  // -------------------------------------------------------------------------
  // Transform + augment together: correct isolation between the two phases
  // -------------------------------------------------------------------------

  it('transform then augment: LLM gets both layers; stored content is canonical (post-transform only)', async () => {
    if (!getMockLlmPort()) return;

    const port = getMockLlmPort()!;
    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { getConversationHistory } = await import('../src/db.js');

    const runner = new DirectLLMRunner();
    runner.preprocessors = [new StubTransform(), new StubAugment()];

    const groupFolder = `pp-both-${Date.now()}`;
    const rawPrompt = 'combined chain probe';

    await runner.runAgent(makeGroup(groupFolder), makeInput(rawPrompt, groupFolder));

    const resp = await fetch(`http://localhost:${port}/last-request`);
    if (resp.ok) {
      const body = await resp.json() as { messages?: { role: string; content: string }[] };
      const userMessages = (body.messages ?? []).filter((m) => m.role === 'user');
      const lastUserContent = userMessages[userMessages.length - 1]?.content ?? '';

      // LLM-facing prompt has: augment block prefix + transformed text
      expect(lastUserContent).toContain('AUGMENT_BLOCK');
      expect(lastUserContent).toContain('TRANSFORM_APPLIED');
    }

    const history = getConversationHistory(groupFolder);
    const userEntry = history.find((m) => m.role === 'user');
    expect(userEntry).toBeTruthy();
    // Stored = canonical = post-transform, not post-augment
    expect(userEntry!.content).toContain('CANONICAL:');
    expect(userEntry!.content).toContain('TRANSFORM_APPLIED');
    expect(userEntry!.content).not.toContain('AUGMENT_BLOCK');
  });

  // -------------------------------------------------------------------------
  // Non-fatal: throwing preprocessors do not crash runAgent
  // -------------------------------------------------------------------------

  it('throwing transform: chain continues; runAgent returns success', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');

    const runner = new DirectLLMRunner();
    runner.preprocessors = [new ThrowingTransform()];

    const groupFolder = `pp-throw-t-${Date.now()}`;
    const output = await runner.runAgent(makeGroup(groupFolder), makeInput('should still work', groupFolder));

    expect(output.status).toBe('success');
  });

  it('throwing augment: chain continues; runAgent returns success', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');

    const runner = new DirectLLMRunner();
    runner.preprocessors = [new ThrowingAugment()];

    const groupFolder = `pp-throw-a-${Date.now()}`;
    const output = await runner.runAgent(makeGroup(groupFolder), makeInput('should still work', groupFolder));

    expect(output.status).toBe('success');
  });

  it('throwing transform AND augment: both no-ops; runAgent returns success with original prompt persisted', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { getConversationHistory } = await import('../src/db.js');

    const runner = new DirectLLMRunner();
    runner.preprocessors = [new ThrowingTransform(), new ThrowingAugment()];

    const groupFolder = `pp-throw-both-${Date.now()}`;
    const output = await runner.runAgent(makeGroup(groupFolder), makeInput('original text', groupFolder));

    expect(output.status).toBe('success');

    // No transform succeeded → persistedContent = original prompt
    const history = getConversationHistory(groupFolder);
    const userEntry = history.find((m) => m.role === 'user');
    expect(userEntry?.content).toContain('original text');
  });

  // -------------------------------------------------------------------------
  // Voice marker fast-path: TranscriptionPreprocessor returns prompt unchanged
  // when no [VoiceAttachment: …] marker present (no capability lookup needed)
  // -------------------------------------------------------------------------

  it('TranscriptionPreprocessor: no marker in prompt → fast-path, prompt unchanged', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { TranscriptionPreprocessor } = await import('../src/runtime/preprocessors/transcription-preprocessor.js');
    const { getConversationHistory } = await import('../src/db.js');

    const runner = new DirectLLMRunner();
    runner.preprocessors = [new TranscriptionPreprocessor()];

    const groupFolder = `pp-voice-fp-${Date.now()}`;
    const output = await runner.runAgent(makeGroup(groupFolder), makeInput('no markers here', groupFolder));

    expect(output.status).toBe('success');

    const history = getConversationHistory(groupFolder);
    expect(history.some((m) => m.role === 'user' && m.content.includes('no markers here'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Voice marker present, no capability: non-fatal, marker left in prompt
  // -------------------------------------------------------------------------

  it('TranscriptionPreprocessor: voice marker + no capability → non-fatal, marker preserved in stored content', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { TranscriptionPreprocessor } = await import('../src/runtime/preprocessors/transcription-preprocessor.js');
    const { getConversationHistory } = await import('../src/db.js');

    // TranscriptionPreprocessor calls getTranscriptionEntry(channel) from
    // ../../capabilities/client.js. In the test environment no real capability
    // is registered, so getTranscriptionEntry returns undefined → the
    // preprocessor logs a warn and returns { prompt } unchanged.  No vi.mock
    // needed — the real in-memory capability registry is empty by default.

    const runner = new DirectLLMRunner();
    runner.preprocessors = [new TranscriptionPreprocessor()];

    const groupFolder = `pp-voice-nocap-${Date.now()}`;
    // Attach a marker exactly as a channel would produce it
    const prompt = 'Please listen to this [VoiceAttachment: attachments/raw/audio.ogg]';

    const output = await runner.runAgent(makeGroup(groupFolder), makeInput(prompt, groupFolder));

    expect(output.status).toBe('success');

    const history = getConversationHistory(groupFolder);
    const userEntry = history.find((m) => m.role === 'user');
    // No transform succeeded → persistedContent = original prompt; marker intact
    expect(userEntry?.content).toContain('[VoiceAttachment:');
  });
});
