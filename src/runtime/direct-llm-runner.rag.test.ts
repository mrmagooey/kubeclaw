/**
 * Tests for SP2 Task 6: RAG retrieval wired into the agent loop.
 *
 * Asserts:
 * 1. augmentPrompt result (with <retrieved_context>) reaches the LLM messages.
 * 2. The ORIGINAL user content (not augmented) is what gets persisted/indexed.
 * 3. A retrieval failure (augmentPrompt throws) does not break the turn.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mock state ----

const augmentPrompt = vi.hoisted(() =>
  vi.fn(async (_g: string, p: string) => `<retrieved_context>\nMEM\n</retrieved_context>\n\n${p}`),
);
const indexConversationTurn = vi.hoisted(() => vi.fn(async () => {}));

const mockCreate = vi.hoisted(() => vi.fn());

const mockAppendConversationMessage = vi.hoisted(() => vi.fn());
const mockAppendConversationHistory = vi.hoisted(() => vi.fn());

// ---- Mocks ----

vi.mock('../rag/provider.js', () => ({
  augmentPrompt,
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

const baseGroup = {
  name: 'test-group',
  folder: 'test-group',
  trigger: '',
  added_at: new Date().toISOString(),
};

const baseInput = {
  groupFolder: 'test-group',
  chatJid: 'user@test',
  isMain: true,
  prompt: 'hello',
  sessionId: undefined,
  assistantName: 'TestBot',
  secrets: undefined,
};

function makeAssistantReply(content: string) {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: [] } }],
  };
}

// ---- Tests ----

describe('RAG retrieval wired into the agent loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default augmentPrompt: prefix with retrieved context sentinel
    augmentPrompt.mockImplementation(
      async (_g: string, p: string) =>
        `<retrieved_context>\nMEM\n</retrieved_context>\n\n${p}`,
    );
  });

  it('prefixes retrieved context onto the user message sent to the LLM', async () => {
    mockCreate.mockResolvedValueOnce(makeAssistantReply('Got it.'));

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const result = await runner.runAgent(baseGroup, baseInput);

    expect(result.status).toBe('success');

    // augmentPrompt was called with the group folder and the original prompt
    expect(augmentPrompt).toHaveBeenCalledWith('test-group', expect.stringContaining('hello'));

    // The messages array sent to the LLM must contain the augmented user message
    const callArgs = mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toContain('<retrieved_context>');
    expect(userMsg.content).toContain('hello');
  });

  it('persists the ORIGINAL user content, not the augmented prompt', async () => {
    mockCreate.mockResolvedValueOnce(makeAssistantReply('Got it.'));

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    await runner.runAgent(baseGroup, baseInput);

    // appendConversationMessage should receive the original 'hello', not the augmented version
    const userPersistCall = mockAppendConversationMessage.mock.calls.find(
      (args: any[]) => args[1] === 'user',
    );
    expect(userPersistCall).toBeDefined();
    const persistedContent: string = userPersistCall![2];
    expect(persistedContent).not.toContain('<retrieved_context>');
    expect(persistedContent).toContain('hello');
  });

  it('indexes the ORIGINAL user content, not the augmented prompt', async () => {
    mockCreate.mockResolvedValueOnce(makeAssistantReply('Indexed.'));

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    await runner.runAgent(baseGroup, baseInput);

    // indexConversationTurn should receive the original 'hello'
    expect(indexConversationTurn).toHaveBeenCalledWith(
      'test-group',
      expect.not.stringContaining('<retrieved_context>'),
      'Indexed.',
    );
    expect(indexConversationTurn).toHaveBeenCalledWith(
      'test-group',
      expect.stringContaining('hello'),
      'Indexed.',
    );
  });

  it('does not break the turn when augmentPrompt rejects', async () => {
    // Simulate a retrieval failure
    augmentPrompt.mockRejectedValueOnce(new Error('retrieval failure'));
    mockCreate.mockResolvedValueOnce(makeAssistantReply('Fallback response.'));

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const result = await runner.runAgent(baseGroup, baseInput);

    // Turn must succeed despite retrieval failure
    expect(result.status).toBe('success');
    expect(result.result).toBe('Fallback response.');

    // The user message sent to LLM must still contain the original prompt
    const callArgs = mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toContain('hello');
  });
});
