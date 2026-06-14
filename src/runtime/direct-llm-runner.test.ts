/**
 * Tests for DirectLLMRunner — in-process LLM runner
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatMessages } from '../router.js';

// ---- Shared mock state (hoisted so vi.mock factories can reference it) ----

const mockRedisInstance = vi.hoisted(() => ({
  xadd: vi.fn().mockResolvedValue('1-0'),
  xread: vi.fn().mockResolvedValue(null),
  quit: vi.fn().mockResolvedValue(undefined),
}));

const mockCreate = vi.hoisted(() => vi.fn());

const mockLoadSkills = vi.hoisted(() =>
  vi.fn().mockReturnValue({ promptSuffix: '', loadedSkills: [] }),
);

// ---- Mocks ----------------------------------------------------------------

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
  getRedisClient: vi.fn(() => mockRedisInstance),
  getToolCallsStream: vi.fn(
    (id: string, cat: string) => `tool-calls:${id}:${cat}`,
  ),
  getToolResultsStream: vi.fn(
    (id: string, cat: string) => `tool-results:${id}:${cat}`,
  ),
  getSpawnToolPodStream: vi.fn(() => 'spawn-tool-pod'),
  getSpawnToolJobStream: vi.fn(() => 'spawn-agent-job'),
  getToolJobResultStream: vi.fn((id: string) => `agent-job-result:${id}`),
}));

vi.mock('../db.js', () => ({
  getConversationHistory: vi.fn().mockReturnValue([]),
  appendConversationMessage: vi.fn(),
  appendConversationHistory: vi.fn(),
  getLatestSummary: vi.fn().mockReturnValue(null),
  insertSummary: vi.fn().mockReturnValue('test-summary-id'),
  deleteMessagesByIds: vi.fn().mockReturnValue(0),
  getGroupProfile: vi.fn().mockReturnValue(null),
}));

vi.mock('./compression/token-estimate.js', () => ({
  estimateMessagesTokens: vi.fn().mockReturnValue(0),
}));

vi.mock('./compression/summarizer.js', () => ({
  summarize: vi
    .fn()
    .mockResolvedValue({ text: 'Summary text.', tokenCount: 10 }),
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
  loadSkills: mockLoadSkills,
}));

vi.mock('./tools/propose-skill.js', () => ({
  proposeSkill: vi.fn().mockResolvedValue({
    kind: 'staged',
    candidateId: 'c1',
    preview: 'preview',
  }),
}));

const mockResolveToolByName = vi.hoisted(() => vi.fn());

vi.mock('../tools/reconciler.js', () => ({
  resolveToolByName: mockResolveToolByName,
  mergeCatalog: vi.fn().mockReturnValue([]),
  renderCatalog: vi.fn().mockReturnValue(''),
  loadBaselineFromDisk: vi.fn().mockReturnValue([]),
  ToolReconciler: class {},
}));

// ---- Tests ----------------------------------------------------------------

import { buildCatalogToolDefs } from './direct-llm-runner.js';

it('maps ToolSpecs to function tool defs', () => {
  const defs = buildCatalogToolDefs([
    {
      name: 'weather',
      description: 'd',
      parameters: { type: 'object' },
      image: 'i:1',
      pattern: 'http',
    },
  ]);
  expect(defs[0]).toEqual({
    type: 'function',
    function: {
      name: 'weather',
      description: 'd',
      parameters: { type: 'object' },
    },
  });
});

describe('shouldCompress', () => {
  it('returns false when message count is below threshold', async () => {
    const { shouldCompress } = await import('./direct-llm-runner.js');
    expect(shouldCompress(10, 1000, 50, 32000)).toBe(false);
  });

  it('returns true when message count exceeds threshold', async () => {
    const { shouldCompress } = await import('./direct-llm-runner.js');
    expect(shouldCompress(51, 1000, 50, 32000)).toBe(true);
  });

  it('returns true when token count exceeds threshold even if messages are below', async () => {
    const { shouldCompress } = await import('./direct-llm-runner.js');
    expect(shouldCompress(10, 33000, 50, 32000)).toBe(true);
  });

  it('returns false when both are at exactly the threshold (not exceeded)', async () => {
    const { shouldCompress } = await import('./direct-llm-runner.js');
    expect(shouldCompress(50, 32000, 50, 32000)).toBe(false);
  });

  it('returns false when both thresholds are 0 (disabled)', async () => {
    const { shouldCompress } = await import('./direct-llm-runner.js');
    expect(shouldCompress(1000, 100000, 0, 0)).toBe(false);
  });

  it('returns true when only token threshold is active and exceeded', async () => {
    const { shouldCompress } = await import('./direct-llm-runner.js');
    expect(shouldCompress(1000, 100000, 0, 50000)).toBe(true);
  });

  it('returns true when only message threshold is active and exceeded', async () => {
    const { shouldCompress } = await import('./direct-llm-runner.js');
    expect(shouldCompress(1000, 100000, 500, 0)).toBe(true);
  });
});

describe('DirectLLMRunner', () => {
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
    prompt: 'Hello!',
    sessionId: undefined,
    assistantName: 'TestBot',
    secrets: undefined,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: xread returns null (no result)
    mockRedisInstance.xread.mockResolvedValue(null);
  });

  it('constructs without error', async () => {
    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    expect(() => new DirectLLMRunner()).not.toThrow();
  });

  it('writeTasksSnapshot is a no-op (does not throw)', async () => {
    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    expect(() => runner.writeTasksSnapshot('folder', true, [])).not.toThrow();
  });

  it('writeGroupsSnapshot is a no-op (does not throw)', async () => {
    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    expect(() =>
      runner.writeGroupsSnapshot('folder', true, [], new Set()),
    ).not.toThrow();
  });

  it('shutdown resolves without error', async () => {
    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    await expect(runner.shutdown()).resolves.toBeUndefined();
  });

  it('runAgent returns success when LLM responds with no tool calls', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Hello, how can I help?',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const result = await runner.runAgent(baseGroup, baseInput);

    expect(result.status).toBe('success');
    expect(result.result).toBe('Hello, how can I help?');
  });

  it('runAgent returns error when LLM API throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'));

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const result = await runner.runAgent(baseGroup, baseInput);

    expect(result.status).toBe('error');
    expect(result.error).toContain('API rate limit exceeded');
  });

  it('runAgent calls onOutput callback with the result', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Done!',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const onOutput = vi.fn().mockResolvedValue(undefined);
    const result = await runner.runAgent(
      baseGroup,
      baseInput,
      undefined,
      onOutput,
    );

    expect(onOutput).toHaveBeenCalledOnce();
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', result: 'Done!' }),
    );
    expect(result.status).toBe('success');
  });

  it('runAgent uses custom model from group llmProvider when not claude/openrouter', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Custom model response',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const groupWithModel = { ...baseGroup, llmProvider: 'gpt-4o' };
    const result = await runner.runAgent(groupWithModel, baseInput);

    expect(result.status).toBe('success');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o' }),
    );
  });

  it('runAgent uses DEFAULT_DIRECT_MODEL when llmProvider is claude', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Response via claude',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const groupWithClaude = { ...baseGroup, llmProvider: 'claude' };
    const result = await runner.runAgent(groupWithClaude, baseInput);

    expect(result.status).toBe('success');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-3-5-haiku-20241022' }),
    );
  });

  it('runAgent handles execute_agent tool call using xread result', async () => {
    // First LLM response: request execute_agent
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-agent-1',
                type: 'function',
                function: {
                  name: 'execute_agent',
                  arguments: '{"task":"Write some code"}',
                },
              },
            ],
          },
        },
      ],
    });
    // Second LLM response: final answer
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Code written successfully.',
            tool_calls: [],
          },
        },
      ],
    });

    // Mock xread to return tool job result immediately (no requestId check for tool jobs)
    mockRedisInstance.xread.mockResolvedValue([
      [
        'agent-result-stream',
        [['1-0', ['result', 'Agent completed the task', 'status', 'success']]],
      ],
    ]);

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const result = await runner.runAgent(baseGroup, baseInput);

    expect(result.status).toBe('success');
    expect(result.result).toBe('Code written successfully.');
    // Two LLM calls: first for tool selection, second for final answer
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('runAgent includes catalog tools from setToolCatalog in LLM call', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        { message: { role: 'assistant', content: 'OK', tool_calls: [] } },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    runner.setToolCatalog({
      getForChannel: () => [
        {
          name: 'home_control',
          description: 'Control smart home devices',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
          image: 'my-ha:latest',
          pattern: 'http' as const,
          port: 8080,
        },
      ],
    });

    await runner.runAgent(baseGroup, baseInput);

    const callArgs = mockCreate.mock.calls[0][0];
    const toolNames = callArgs.tools.map((t: any) => t.function.name);
    expect(toolNames).toContain('home_control');
    // Built-in tools still included (places_search remains a static built-in)
    expect(toolNames).toContain('places_search');
  });

  it('runAgent uses reasoning_content as fallback when content is null (thinking models)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            // Non-standard field used by some models (e.g. Gemma with thinking)
            reasoning_content: 'The answer is forty-two.',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const result = await runner.runAgent(baseGroup, baseInput);

    expect(result.status).toBe('success');
    expect(result.result).toBe('The answer is forty-two.');
  });

  it('runAgent uses reasoning_content as fallback when content is empty string (thinking models)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'Response from thinking model.',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const result = await runner.runAgent(baseGroup, baseInput);

    expect(result.status).toBe('success');
    expect(result.result).toBe('Response from thinking model.');
  });

  it('runAgent uses supplied sessionKey for history lookup (not group.folder)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Specialist response',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const { getConversationHistory, appendConversationHistory } =
      await import('../db.js');
    const runner = new DirectLLMRunner();

    await runner.runAgent(baseGroup, baseInput, undefined, undefined, {
      sessionKey: 'specialist-abc',
    });

    // Should query by the specialist session key, not group folder
    expect(getConversationHistory).toHaveBeenCalledWith({
      sessionKey: 'specialist-abc',
    });
    // Should write back using appendConversationHistory with the specialist key
    expect(appendConversationHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: 'specialist-abc', role: 'user' }),
    );
    expect(appendConversationHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'specialist-abc',
        role: 'assistant',
      }),
    );
  });

  it('runAgent uses supplied llmProvider override (not group.llmProvider)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Provider override response',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    // group has no llmProvider (would fall back to DEFAULT_DIRECT_MODEL)
    await runner.runAgent(baseGroup, baseInput, undefined, undefined, {
      llmProvider: 'gpt-4-turbo',
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4-turbo' }),
    );
  });

  it('runAgent filters tool list to toolFilter allowlist when provided', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Filtered tools response',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();

    await runner.runAgent(baseGroup, baseInput, undefined, undefined, {
      toolFilter: new Set(['places_search']),
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const toolNames = callArgs.tools.map((t: any) => t.function.name);
    // Only the allowlisted tool is advertised
    expect(toolNames).toEqual(['places_search']);
    // Other built-in tools are not included
    expect(toolNames).not.toContain('browser');
    expect(toolNames).not.toContain('execute_agent');
  });

  it('runAgent handles execute_agent with invalid JSON arguments gracefully', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-bad',
                type: 'function',
                function: {
                  name: 'execute_agent',
                  arguments: 'not-valid-json',
                },
              },
            ],
          },
        },
      ],
    });
    // Final answer after tool result
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Done despite bad args.',
            tool_calls: [],
          },
        },
      ],
    });

    // Return agent result immediately
    mockRedisInstance.xread.mockResolvedValue([
      ['stream', [['1-0', ['result', 'done']]]],
    ]);

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const result = await runner.runAgent(baseGroup, baseInput);

    // Bad JSON args should be handled gracefully (empty args)
    expect(result.status).toBe('success');
  });

  it('runAgent passes current_time in the user turn sent to the LLM', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'The current time is in the context.',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    // Pre-format the prompt via formatMessages, matching how production
    // (channel-runner.ts) prepares input.prompt before calling runAgent.
    const formattedPrompt = formatMessages(
      [
        {
          id: '1',
          chat_jid: 'user@test',
          sender: 'user',
          sender_name: 'user',
          content: 'what time is it?',
          timestamp: new Date().toISOString(),
        },
      ],
      'UTC',
    );
    await runner.runAgent(baseGroup, { ...baseInput, prompt: formattedPrompt });

    // The messages array passed to the LLM should contain current_time=
    const callArgs = mockCreate.mock.calls[0][0];
    const userMessages: { role: string; content: string }[] =
      callArgs.messages.filter(
        (m: { role: string; content: string }) => m.role === 'user',
      );
    expect(userMessages.length).toBeGreaterThan(0);
    const userContent = userMessages[userMessages.length - 1].content;
    expect(userContent).toContain('current_time=');
  });

  it('runAgent does not persist current_time in conversation_history rows', async () => {
    // This test mirrors the production dispatch path: channel-runner.ts calls
    // formatMessages(messages, TIMEZONE) which emits a `<context current_time="…" />`
    // header, then passes that string as input.prompt to runAgent.
    // The invariant: that header must NOT be written into conversation_history.
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Stored response.',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const { appendConversationMessage } = await import('../db.js');
    const runner = new DirectLLMRunner();

    // Build a realistic production-style prompt via formatMessages so that
    // the input.prompt actually contains current_time= (non-trivial assertion).
    const formattedPrompt = formatMessages(
      [
        {
          id: '1',
          chat_jid: 'user@test',
          sender: 'user',
          sender_name: 'user',
          content: 'what is the time?',
          timestamp: new Date().toISOString(),
        },
      ],
      'UTC',
    );
    // Sanity-check: the formatted prompt genuinely contains current_time= before we pass it.
    expect(formattedPrompt).toContain('current_time=');

    await runner.runAgent(baseGroup, { ...baseInput, prompt: formattedPrompt });

    // Every call to appendConversationMessage must NOT contain current_time
    const calls = (appendConversationMessage as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // appendConversationMessage(groupFolder, role, content)
      const content = call[2] as string;
      expect(content).not.toContain('current_time=');
    }
  });
});

describe('stripContextHeader', () => {
  it('removes the <context … /> header produced by formatMessages', async () => {
    const { stripContextHeader } = await import('./direct-llm-runner.js');
    const prompt = formatMessages(
      [
        {
          id: '1',
          chat_jid: 'x@test',
          sender: 'user',
          sender_name: 'user',
          content: 'hello',
          timestamp: new Date().toISOString(),
        },
      ],
      'UTC',
    );
    expect(prompt).toContain('current_time=');
    const stripped = stripContextHeader(prompt);
    expect(stripped).not.toContain('current_time=');
    expect(stripped).not.toContain('<context');
    expect(stripped).toContain('hello');
  });

  it('leaves plain text unchanged', async () => {
    const { stripContextHeader } = await import('./direct-llm-runner.js');
    const plain = 'just a plain message';
    expect(stripContextHeader(plain)).toBe(plain);
  });
});

describe('loadSystemPrompt — skill composition', () => {
  let tmpGroupsDir: string;

  beforeEach(() => {
    tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-skills-'));
    fs.mkdirSync(path.join(tmpGroupsDir, 'g1'), { recursive: true });
    fs.writeFileSync(path.join(tmpGroupsDir, 'g1', 'CLAUDE.md'), 'BASE PROMPT');
    // Reset skill-loader mock to default (no suffix)
    mockLoadSkills.mockReturnValue({ promptSuffix: '', loadedSkills: [] });
  });

  afterEach(() => {
    fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  });

  it('returns CLAUDE.md unchanged when no skills are loaded', async () => {
    const { __testing__ } = await import('./direct-llm-runner.js');
    const out = __testing__.loadSystemPromptForTest('g1', tmpGroupsDir);
    expect(out).toContain('BASE PROMPT');
    expect(out).not.toContain('Learned skills');
  });

  it('appends skill bodies under Learned skills when skill-loader returns a suffix', async () => {
    mockLoadSkills.mockReturnValue({
      promptSuffix: '\n\n## Learned skills\n\nALPHA BODY\n',
      loadedSkills: ['alpha'],
    });
    const { __testing__ } = await import('./direct-llm-runner.js');
    const out = __testing__.loadSystemPromptForTest('g1', tmpGroupsDir);
    expect(out).toContain('BASE PROMPT');
    expect(out).toContain('## Learned skills');
    expect(out).toContain('ALPHA BODY');
  });

  it('falls back to base prompt when skill-loader throws', async () => {
    mockLoadSkills.mockImplementation(() => {
      throw new Error('skill-loader exploded');
    });
    const { __testing__ } = await import('./direct-llm-runner.js');
    const out = __testing__.loadSystemPromptForTest('g1', tmpGroupsDir);
    // The recommendation contract is appended to `base` BEFORE the
    // skill-loader is invoked (loadSystemPrompt unconditionally adds it
    // unless the prompt opts out). When skill-loader throws, the catch
    // arm keeps `prompt = base`, which already includes the contract.
    // The behavioural assertion is: no skill suffix made it in.
    expect(out).toContain('BASE PROMPT');
    expect(out).not.toContain('Learned skills');
  });
});

describe('TOOLS — propose_skill registration', () => {
  it('includes propose_skill in the built-in tool list', async () => {
    const { __testing__ } = await import('./direct-llm-runner.js');
    const names = __testing__.toolsForTest().map((t: any) => t.function.name);
    expect(names).toContain('propose_skill');
  });
});

describe('loadSystemPrompt profile injection', () => {
  let tmpDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockGetGroupProfile: any;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-profile-test-'));
    const db = await import('../db.js');
    mockGetGroupProfile = vi.mocked(db.getGroupProfile);
    mockGetGroupProfile.mockReturnValue(null);
  });

  it('returns base prompt with no profile when getGroupProfile returns null', async () => {
    mockGetGroupProfile.mockReturnValue(null);
    const { _loadSystemPromptForTest } = await import('./direct-llm-runner.js');
    const result = _loadSystemPromptForTest('some-group', tmpDir);
    expect(result).not.toContain('## Your profile');
  });

  it('appends a profile section when getGroupProfile returns a full profile', async () => {
    mockGetGroupProfile.mockReturnValue({
      groupFolder: 'test-group',
      timezone: 'America/New_York',
      location: 'Brooklyn, NY',
      cuisineLikes: 'Japanese, Thai',
      cuisineDislikes: 'Liver',
      dietaryRestrictions: 'no shellfish',
      budgetTier: 'mid-range',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });
    const { _loadSystemPromptForTest } = await import('./direct-llm-runner.js');
    const result = _loadSystemPromptForTest('test-group', tmpDir);
    expect(result).toContain('## Your profile');
    expect(result).toContain('America/New_York');
    expect(result).toContain('Brooklyn, NY');
    expect(result).toContain('Japanese, Thai');
    expect(result).toContain('Liver');
    expect(result).toContain('no shellfish');
    expect(result).toContain('mid-range');
  });

  it('omits profile fields that are undefined', async () => {
    mockGetGroupProfile.mockReturnValue({
      groupFolder: 'sparse-group',
      timezone: 'UTC',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });
    const { _loadSystemPromptForTest } = await import('./direct-llm-runner.js');
    const result = _loadSystemPromptForTest('sparse-group', tmpDir);
    expect(result).toContain('## Your profile');
    expect(result).toContain('UTC');
    // Fields not set should not appear as "undefined" literally
    expect(result).not.toContain('undefined');
  });

  it('omits the profile header when all optional fields are undefined', async () => {
    mockGetGroupProfile.mockReturnValue({
      groupFolder: 'empty-group',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });
    const { _loadSystemPromptForTest } = await import('./direct-llm-runner.js');
    const result = _loadSystemPromptForTest('empty-group', tmpDir);
    expect(result).not.toContain('## Your profile');
  });

  it('profile section appears after the skills suffix', async () => {
    // Create a fake CLAUDE.md so the skills path can run
    const groupDir = path.join(tmpDir, 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), 'Custom base prompt.');
    mockGetGroupProfile.mockReturnValue({
      groupFolder: 'test-group',
      timezone: 'Europe/London',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });
    const { _loadSystemPromptForTest } = await import('./direct-llm-runner.js');
    const result = _loadSystemPromptForTest('test-group', tmpDir);
    const profileIdx = result.indexOf('## Your profile');
    const baseIdx = result.indexOf('Custom base prompt.');
    expect(profileIdx).toBeGreaterThan(baseIdx);
  });
});

describe('DirectLLMRunner — tool-round budget', () => {
  const baseGroup = {
    name: 'budget-group',
    folder: 'budget-group',
    trigger: '',
    added_at: new Date().toISOString(),
  };
  const baseInput = {
    groupFolder: 'budget-group',
    chatJid: 'user@test',
    isMain: true,
    prompt: 'Loop forever',
    sessionId: undefined,
    assistantName: 'TestBot',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Make xread return a fake tool result immediately so tool rounds complete fast.
    let capturedRequestId: string | undefined;
    mockRedisInstance.xadd.mockImplementation((...args: unknown[]) => {
      const fields = args.slice(2) as string[];
      const idx = fields.indexOf('requestId');
      if (idx >= 0) capturedRequestId = fields[idx + 1];
      return Promise.resolve('1-0');
    });
    mockRedisInstance.xread.mockImplementation(async () => {
      if (!capturedRequestId) return null;
      return [
        [
          'stream',
          [['1-0', ['requestId', capturedRequestId, 'result', '"fetched"']]],
        ],
      ];
    });
  });

  it('stops after overrides.maxToolRounds rounds when set below default', async () => {
    // LLM always returns a tool call — should be capped at maxToolRounds=2
    mockCreate.mockImplementation(async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'web_fetch',
                  arguments: '{"url":"http://x.com"}',
                },
              },
            ],
          },
        },
      ],
    }));

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    await runner.runAgent(baseGroup, baseInput, undefined, undefined, {
      maxToolRounds: 2,
    });

    // Each round makes one LLM call, plus a final call after the loop exits.
    // With maxToolRounds=2 the loop runs at most 2 rounds → ≤3 LLM calls total.
    expect(mockCreate.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('uses default MAX_TOOL_ROUNDS (10) when override is absent', async () => {
    // LLM always returns a tool call — should be capped at default 10
    mockCreate.mockImplementation(async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'web_fetch',
                  arguments: '{"url":"http://x.com"}',
                },
              },
            ],
          },
        },
      ],
    }));

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    await runner.runAgent(baseGroup, baseInput);

    // Default is 10 rounds → at most 11 LLM calls
    expect(mockCreate.mock.calls.length).toBeLessThanOrEqual(11);
    expect(mockCreate.mock.calls.length).toBeGreaterThan(3);
  });
});

describe('DirectLLMRunner tool registration', () => {
  it('registers set_reminder as a local tool by default', async () => {
    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    expect(runner.getLocalToolNames()).toContain('set_reminder');
  });
});

describe('tool definitions — schedule_task and DEFAULT_SYSTEM_PROMPT', () => {
  it('schedule_task description warns against relative schedule_value', async () => {
    // Import the TOOLS array via the __testing__ export or by inspecting
    // the effective tools that reach the LLM call.
    // We use a mockCreate spy that captures the tools argument.
    const captured: unknown[] = [];
    mockCreate.mockImplementationOnce(async (req: { tools?: unknown[] }) => {
      if (req.tools) captured.push(...req.tools);
      return {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
              tool_calls: undefined,
            },
            finish_reason: 'stop',
          },
        ],
      };
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    await runner.runAgent(
      {
        name: 'g1',
        folder: 'g1',
        trigger: '',
        added_at: new Date().toISOString(),
      },
      {
        prompt: 'hello',
        groupFolder: 'g1',
        chatJid: 'u@t',
        isMain: false,
        assistantName: 'Bot',
      },
    );

    const schedTool = (
      captured as Array<{
        function: {
          name: string;
          description: string;
          parameters: {
            properties: { schedule_value: { description: string } };
          };
        };
      }>
    ).find((t) => t.function.name === 'schedule_task');
    expect(schedTool).toBeDefined();
    // Description must mention ISO 8601 and warn against relative phrases
    expect(schedTool!.function.description).toMatch(/ISO 8601/i);
    expect(
      schedTool!.function.parameters.properties.schedule_value.description,
    ).toMatch(/absolute.*ISO|ISO.*absolute/i);
  });

  it('DEFAULT_SYSTEM_PROMPT mentions set_reminder for reminders', async () => {
    const captured: string[] = [];
    mockCreate.mockImplementationOnce(
      async (req: { messages: Array<{ role: string; content: string }> }) => {
        const sys = req.messages.find((m) => m.role === 'system');
        if (sys) captured.push(sys.content);
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
                tool_calls: undefined,
              },
              finish_reason: 'stop',
            },
          ],
        };
      },
    );

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    await runner.runAgent(
      {
        name: 'g1',
        folder: 'g1',
        trigger: '',
        added_at: new Date().toISOString(),
      },
      {
        prompt: 'hello',
        groupFolder: 'g1',
        chatJid: 'u@t',
        isMain: false,
        assistantName: 'Bot',
      },
    );

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toMatch(/set_reminder/);
    expect(captured[0]).toMatch(/remind/i);
  });
});

describe('loadSystemPrompt — RECOMMENDATION_CONTRACT injection', () => {
  let tmpGroupsDir: string;

  beforeEach(() => {
    tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-rec-'));
    fs.mkdirSync(path.join(tmpGroupsDir, 'g1'), { recursive: true });
    fs.writeFileSync(path.join(tmpGroupsDir, 'g1', 'CLAUDE.md'), 'BASE PROMPT');
    mockLoadSkills.mockReturnValue({ promptSuffix: '', loadedSkills: [] });
  });

  afterEach(() => {
    fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  });

  it('appends RECOMMENDATION_CONTRACT when CLAUDE.md does not contain opt-out marker', async () => {
    const { __testing__ } = await import('./direct-llm-runner.js');
    const out = __testing__.loadSystemPromptForTest('g1', tmpGroupsDir);
    expect(out).toContain('## Recommendation guidelines');
    expect(out).toContain('read_user_profile');
    expect(out).toContain('places_search');
  });

  it('does NOT append RECOMMENDATION_CONTRACT when CLAUDE.md contains opt-out marker', async () => {
    fs.writeFileSync(
      path.join(tmpGroupsDir, 'g1', 'CLAUDE.md'),
      'CUSTOM PROMPT\n<!-- no-recommendation-contract -->',
    );
    const { __testing__ } = await import('./direct-llm-runner.js');
    const out = __testing__.loadSystemPromptForTest('g1', tmpGroupsDir);
    expect(out).not.toContain('## Recommendation guidelines');
    expect(out).toContain('CUSTOM PROMPT');
  });

  it('appends RECOMMENDATION_CONTRACT when CLAUDE.md is absent (default system prompt)', async () => {
    fs.mkdirSync(path.join(tmpGroupsDir, 'g2'), { recursive: true });
    const { __testing__ } = await import('./direct-llm-runner.js');
    const out = __testing__.loadSystemPromptForTest('g2', tmpGroupsDir);
    expect(out).toContain('## Recommendation guidelines');
  });
});

describe('TOOLS — places_search registration', () => {
  it('includes places_search in the built-in tool list', async () => {
    const { __testing__ } = await import('./direct-llm-runner.js');
    const names = __testing__.toolsForTest().map((t: any) => t.function.name);
    expect(names).toContain('places_search');
  });

  it('places_search tool definition has required query and location parameters', async () => {
    const { __testing__ } = await import('./direct-llm-runner.js');
    const tool = __testing__
      .toolsForTest()
      .find((t: any) => t.function.name === 'places_search');
    expect(tool).toBeDefined();
    const props = tool!.function.parameters.properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('query');
    expect(props).toHaveProperty('location');
    expect(tool!.function.parameters.required).toContain('query');
  });

  it('places_search is mapped to places category in TOOL_CATEGORY', async () => {
    const { __testing__ } = await import('./direct-llm-runner.js');
    expect(__testing__.toolCategoryForTest('places_search')).toBe('places');
  });

  it('places_search is mapped to placesSearch in TOOL_SERVER_NAME', async () => {
    const { __testing__ } = await import('./direct-llm-runner.js');
    expect(__testing__.toolServerNameForTest('places_search')).toBe(
      'placesSearch',
    );
  });
});

describe('recommendation pattern — integration', () => {
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
    prompt: 'Hello!',
    sessionId: undefined,
    assistantName: 'TestBot',
    secrets: undefined,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisInstance.xread.mockResolvedValue(null);
  });

  it('read_user_profile local tool is dispatched in-process (no K8s job spawned)', async () => {
    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-rup-1',
                  type: 'function',
                  function: { name: 'read_user_profile', arguments: '{}' },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Here are my top Italian picks for you.',
              tool_calls: [],
            },
          },
        ],
      });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const { READ_USER_PROFILE_TOOL } =
      await import('./tools/read-user-profile.js');
    const { jobRunner } = await import('../k8s/job-runner.js');

    const runner = new DirectLLMRunner();
    runner.registerLocalTool('read_user_profile', READ_USER_PROFILE_TOOL);

    const result = await runner.runAgent(baseGroup, baseInput);

    expect(result.status).toBe('success');
    expect(result.result).toBe('Here are my top Italian picks for you.');
    expect(jobRunner.runToolJob).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('places_search tool call routes via K8s places pod (TOOL_CATEGORY=places)', async () => {
    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-ps-1',
                  type: 'function',
                  function: {
                    name: 'places_search',
                    arguments: JSON.stringify({
                      query: 'Italian restaurants',
                      location: 'Brooklyn, NY',
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Top 3 Italian spots in Brooklyn.',
              tool_calls: [],
            },
          },
        ],
      });

    let capturedRequestId: string | undefined;
    mockRedisInstance.xadd.mockImplementation((...args: unknown[]) => {
      const fields = args.slice(2) as string[];
      const idx = fields.indexOf('requestId');
      if (idx >= 0) capturedRequestId = fields[idx + 1];
      return Promise.resolve('1-0');
    });
    mockRedisInstance.xread.mockImplementation(async () => {
      if (!capturedRequestId) return null;
      return [
        [
          'stream',
          [
            [
              '1-0',
              [
                'requestId',
                capturedRequestId,
                'result',
                JSON.stringify([
                  {
                    name: 'Lucali',
                    address: '575 Henry St',
                    rating: 4.8,
                    price: '$$',
                  },
                ]),
              ],
            ],
          ],
        ],
      ];
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const { jobRunner } = await import('../k8s/job-runner.js');

    const runner = new DirectLLMRunner();
    const result = await runner.runAgent(baseGroup, baseInput);

    expect(result.status).toBe('success');
    expect(jobRunner.createToolPodJob).toHaveBeenCalled();
    const podJobCall = (jobRunner.createToolPodJob as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(podJobCall.category).toBe('places');
  });

  it('second runAgent call on same groupFolder receives recommendation contract in system prompt', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        { message: { role: 'assistant', content: 'ok', tool_calls: [] } },
      ],
    });

    const { getConversationHistory } = await import('../db.js');
    (getConversationHistory as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: 'user', content: 'good Italian restaurants near me' },
      { role: 'assistant', content: 'Top 3 Italian spots: Lucali...' },
    ]);

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();

    await runner.runAgent(baseGroup, {
      ...baseInput,
      prompt: 'cheaper options please',
    });

    const firstCall = mockCreate.mock.calls[0][0];
    const systemMsg = firstCall.messages.find((m: any) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain('## Recommendation guidelines');
    expect(systemMsg.content).toContain('read_user_profile');
    const userMsgs = firstCall.messages.filter((m: any) => m.role === 'user');
    expect(
      userMsgs.some((m: any) => m.content?.includes('cheaper options')),
    ).toBe(true);
  });
});

describe('DirectLLMRunner — direct-mode custom-tool dispatch (Fix 1 + Fix 2)', () => {
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
    prompt: 'Hello!',
    sessionId: undefined,
    assistantName: 'TestBot',
    secrets: undefined,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: xread returns null (no result), xadd succeeds
    mockRedisInstance.xread.mockResolvedValue(null);
    mockRedisInstance.xadd.mockResolvedValue('1-0');
    // Default: resolveToolByName returns undefined (unknown tool)
    mockResolveToolByName.mockReturnValue(undefined);
  });

  it('unknown custom tool in direct mode returns error string without writing to the calls stream', async () => {
    // LLM returns a call to an unknown catalog tool
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-unknown-1',
                type: 'function',
                function: {
                  name: 'nonexistent_tool',
                  arguments: '{}',
                },
              },
            ],
          },
        },
      ],
    });
    // Final answer after tool result is fed back
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Sorry, that tool is not available.',
            tool_calls: [],
          },
        },
      ],
    });

    // resolveToolByName returns undefined — unknown tool
    mockResolveToolByName.mockReturnValue(undefined);

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const { jobRunner } = await import('../k8s/job-runner.js');

    const runner = new DirectLLMRunner();
    // Register the tool so the LLM can call it (catalog tool not in TOOL_CATEGORY)
    const result = await runner.runAgent(baseGroup, baseInput);

    // Run should still complete (error fed back as tool result)
    expect(result.status).toBe('success');

    // Neither spawn method should have been called
    expect(jobRunner.createSidecarToolPodJob).not.toHaveBeenCalled();
    expect(jobRunner.createToolPodJob).not.toHaveBeenCalled();

    // The calls stream xadd must NOT have been called for the tool call (Fix 1)
    // xadd may be called for other streams (e.g. spawn), but not for tool-calls:*
    const xaddCalls = mockRedisInstance.xadd.mock.calls as unknown[][];
    const toolCallsStreamWrites = xaddCalls.filter(
      (c) =>
        typeof c[0] === 'string' && (c[0] as string).startsWith('tool-calls:'),
    );
    expect(toolCallsStreamWrites).toHaveLength(0);
  });

  it('resolved custom tool in direct mode calls createSidecarToolPodJob (not createToolPodJob)', async () => {
    const fakeSpec = {
      name: 'home_control',
      description: 'Control smart home devices',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      image: 'home-control:latest',
      pattern: 'http' as const,
      port: 8080,
    };

    // resolveToolByName returns our spec
    mockResolveToolByName.mockReturnValue(fakeSpec);

    // LLM calls the custom tool
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-custom-1',
                type: 'function',
                function: {
                  name: 'home_control',
                  arguments: '{"command":"turn_on_lights"}',
                },
              },
            ],
          },
        },
      ],
    });
    // Final answer after tool result
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Lights turned on.',
            tool_calls: [],
          },
        },
      ],
    });

    // Capture requestId so xread can return a matching result
    let capturedRequestId: string | undefined;
    mockRedisInstance.xadd.mockImplementation((...args: unknown[]) => {
      const fields = args.slice(2) as string[];
      const idx = fields.indexOf('requestId');
      if (idx >= 0) capturedRequestId = fields[idx + 1];
      return Promise.resolve('1-0');
    });
    mockRedisInstance.xread.mockImplementation(async () => {
      if (!capturedRequestId) return null;
      return [
        [
          'stream',
          [['1-0', ['requestId', capturedRequestId, 'result', '"done"']]],
        ],
      ];
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const { jobRunner } = await import('../k8s/job-runner.js');

    const runner = new DirectLLMRunner();
    const result = await runner.runAgent(baseGroup, baseInput);

    expect(result.status).toBe('success');

    // Sidecar pod should have been spawned for the custom tool
    expect(jobRunner.createSidecarToolPodJob).toHaveBeenCalledOnce();
    const sidecarCall = (
      jobRunner.createSidecarToolPodJob as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(sidecarCall.toolName).toBe('home_control');
    expect(sidecarCall.toolSpec).toEqual(fakeSpec);

    // Generic tool pod must NOT have been spawned
    expect(jobRunner.createToolPodJob).not.toHaveBeenCalled();
  });
});
