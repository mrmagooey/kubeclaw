/**
 * Tests for SP3 Task 9: preprocessor chain wired into the agent loop.
 *
 * Asserts:
 * 1. Transcription transform fires; transcript (not marker) reaches LLM.
 * 2. RAG augment fires; <retrieved_context> reaches LLM after the transcript.
 * 3. Persist + index receive the transcript (post-transform, PRE-augment).
 * 4. REGRESSION: no voice marker → byte-identical to SP2 (augmented to LLM, original persisted).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mock state ----

const indexConversationTurn = vi.hoisted(() => vi.fn(async () => {}));

const mockCreate = vi.hoisted(() => vi.fn());

const mockAppendConversationMessage = vi.hoisted(() => vi.fn());
const mockAppendConversationHistory = vi.hoisted(() => vi.fn());

// ---- Mocks ----

// Keep augmentPrompt mocked (not used directly by runner after task 9, but
// RagPreprocessor within the default chain would call it if we didn't inject
// fakes). We inject fakes, so augmentPrompt is effectively bypassed.
vi.mock('../rag/provider.js', () => ({
  augmentPrompt: vi.fn(),
  getRagProvider: () => ({
    indexConversationTurn,
    retrieveContext: async () => '',
  }),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

vi.mock('../k8s/job-runner.js', () => ({
  jobRunner: {
    createToolPodJob: vi.fn().mockResolvedValue(undefined),
    createSidecarToolPodJob: vi.fn().mockResolvedValue(undefined),
    runToolJob: vi.fn().mockResolvedValue({ status: 'success', result: 'ok' }),
  },
  JobRunner: class {
    createToolPodJob = vi.fn().mockResolvedValue(undefined);
    createSidecarToolPodJob = vi.fn().mockResolvedValue(undefined);
    runToolJob = vi.fn().mockResolvedValue({ status: 'success', result: 'ok' });
    cleanup = vi.fn().mockResolvedValue(undefined);
  },
  buildJobName: vi.fn((folder: string) => `job-${folder}`),
}));

vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({
    xadd: vi.fn().mockResolvedValue('1-0'),
    xread: vi.fn().mockResolvedValue(null),
    quit: vi.fn().mockResolvedValue(undefined),
  })),
  getToolCallsStream: vi.fn((id: string, cat: string) => `tool-calls:${id}:${cat}`),
  getToolResultsStream: vi.fn((id: string, cat: string) => `tool-results:${id}:${cat}`),
  getSpawnToolPodStream: vi.fn(() => 'spawn-tool-pod'),
  getSpawnToolJobStream: vi.fn(() => 'spawn-agent-job'),
  getToolJobResultStream: vi.fn((id: string) => `agent-job-result:${id}`),
}));

vi.mock('../db.js', () => ({
  getConversationHistory: vi.fn().mockReturnValue([]),
  appendConversationMessage: mockAppendConversationMessage,
  appendConversationHistory: mockAppendConversationHistory,
  getLatestSummary: vi.fn().mockReturnValue(null),
  insertSummary: vi.fn().mockReturnValue('test-summary-id'),
  deleteMessagesByIds: vi.fn().mockReturnValue(0),
  getGroupProfile: vi.fn().mockReturnValue(null),
}));

vi.mock('./compression/token-estimate.js', () => ({
  estimateMessagesTokens: vi.fn().mockReturnValue(0),
}));

vi.mock('./compression/summarizer.js', () => ({
  summarize: vi.fn().mockResolvedValue({ text: 'Summary text.', tokenCount: 10 }),
}));

vi.mock('../config.js', () => ({
  GROUPS_DIR: '/tmp/test-groups',
  KUBECLAW_MODE: 'standalone',
  KUBECLAW_CHANNEL: '',
  KUBECLAW_NAMESPACE: 'kubeclaw',
  STORE_DIR: '/tmp/test-store',
  ASSISTANT_NAME: 'TestBot',
  ASSISTANT_HAS_OWN_NUMBER: false,
  POLL_INTERVAL: 2000,
  SCHEDULER_POLL_INTERVAL: 60000,
  MOUNT_ALLOWLIST_PATH: '/tmp/mount-allowlist.json',
  SENDER_ALLOWLIST_PATH: '/tmp/sender-allowlist.json',
  TIMEZONE: 'UTC',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./llm-client.js', () => ({
  createLLMClient: vi.fn(() => ({
    chat: { completions: { create: mockCreate } },
  })),
  DEFAULT_DIRECT_MODEL: 'claude-3-5-haiku-20241022',
}));

vi.mock('./skill-loader.js', () => ({
  loadSkills: vi.fn().mockReturnValue({ promptSuffix: '', loadedSkills: [] }),
}));

vi.mock('./tools/propose-skill.js', () => ({
  proposeSkill: vi.fn().mockResolvedValue({
    kind: 'staged',
    candidateId: 'c1',
    preview: 'preview',
  }),
}));

vi.mock('../tools/reconciler.js', () => ({
  resolveToolByName: vi.fn(),
  mergeCatalog: vi.fn().mockReturnValue([]),
  renderCatalog: vi.fn().mockReturnValue(''),
  loadBaselineFromDisk: vi.fn().mockReturnValue([]),
  ToolReconciler: class {},
}));

// ---- Test fixtures ----

import type { InboundPreprocessor } from './preprocessors/types.js';

// Fake transcription: transforms [VoiceAttachment: …] → [Voice: hello world]
const fakeTranscription: InboundPreprocessor = {
  name: 'transcription',
  effect: 'transform',
  async apply({ prompt }) {
    if (!prompt.includes('[VoiceAttachment:')) return { prompt };
    const out = prompt.replace(/\[VoiceAttachment:[^\]]+\]/, '[Voice: hello world]');
    return { prompt: out, persistedContent: out };
  },
};

// Fake RAG: prefixes <retrieved_context> onto the LLM prompt
const fakeRag: InboundPreprocessor = {
  name: 'rag',
  effect: 'augment',
  async apply({ prompt }) {
    return { prompt: `<retrieved_context>\nMEM\n</retrieved_context>\n\n${prompt}` };
  },
};

const baseGroup = {
  name: 'g',
  folder: 'g',
  trigger: '',
  added_at: new Date().toISOString(),
};

function baseInput(prompt: string) {
  return {
    groupFolder: 'g',
    chatJid: 'user@test',
    isMain: true,
    prompt,
    sessionId: undefined,
    assistantName: 'TestBot',
    secrets: undefined,
  };
}

function makeAssistantReply(content: string) {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: [] } }],
  };
}

// ---- Tests ----

describe('preprocessor chain wired into the agent loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('transcribes the voice marker, augments the transcript, and the LLM turn sees both', async () => {
    mockCreate.mockResolvedValueOnce(makeAssistantReply('Done.'));

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    runner.preprocessors = [fakeTranscription, fakeRag];

    const result = await runner.runAgent(baseGroup, baseInput('[VoiceAttachment: attachments/raw/a.ogg]'));
    expect(result.status).toBe('success');

    const callArgs = mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toContain('<retrieved_context>');
    expect(userMsg.content).toContain('[Voice: hello world]');
    expect(userMsg.content).not.toContain('[VoiceAttachment:');
  });

  it('persists + indexes the transcript, NOT the marker and NOT the augmented prompt', async () => {
    mockCreate.mockResolvedValueOnce(makeAssistantReply('Indexed.'));

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    runner.preprocessors = [fakeTranscription, fakeRag];

    await runner.runAgent(baseGroup, baseInput('[VoiceAttachment: attachments/raw/a.ogg]'));

    // Check what was persisted for the user turn
    const userPersistCall = mockAppendConversationMessage.mock.calls.find(
      (args: any[]) => args[1] === 'user',
    );
    expect(userPersistCall).toBeDefined();
    const persistedUser: string = userPersistCall![2];

    expect(persistedUser).toContain('[Voice: hello world]');
    expect(persistedUser).not.toContain('<retrieved_context>');
    expect(persistedUser).not.toContain('[VoiceAttachment:');

    // Check what was indexed
    expect(indexConversationTurn).toHaveBeenCalledWith('g', '[Voice: hello world]', 'Indexed.');
  });

  it('REGRESSION: no voice marker → byte-identical to SP2 (augmented prompt to LLM, original persisted)', async () => {
    mockCreate.mockResolvedValueOnce(makeAssistantReply('Replied.'));

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    runner.preprocessors = [fakeTranscription, fakeRag];

    await runner.runAgent(baseGroup, baseInput('hello'));

    // LLM sees the augmented prompt (fakeRag prefixes <retrieved_context>)
    const callArgs = mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe('<retrieved_context>\nMEM\n</retrieved_context>\n\nhello');

    // Persisted is the original 'hello' (no augment prefix)
    const userPersistCall = mockAppendConversationMessage.mock.calls.find(
      (args: any[]) => args[1] === 'user',
    );
    expect(userPersistCall).toBeDefined();
    const persistedUser: string = userPersistCall![2];
    expect(persistedUser).toBe('hello');

    // Indexed is also 'hello'
    expect(indexConversationTurn).toHaveBeenCalledWith('g', 'hello', 'Replied.');
  });
});
