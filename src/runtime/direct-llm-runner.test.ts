/**
 * Tests for DirectLLMRunner — in-process LLM runner
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

// ---- Tests ----------------------------------------------------------------

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

  it('runAgent includes custom tools from group containerConfig in LLM call', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        { message: { role: 'assistant', content: 'OK', tool_calls: [] } },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const groupWithTools = {
      ...baseGroup,
      containerConfig: {
        tools: [
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
      },
    };

    await runner.runAgent(groupWithTools, baseInput);

    const callArgs = mockCreate.mock.calls[0][0];
    const toolNames = callArgs.tools.map((t: any) => t.function.name);
    expect(toolNames).toContain('home_control');
    // Built-in tools still included
    expect(toolNames).toContain('bash');
    expect(toolNames).toContain('web_fetch');
  });

  it('runAgent spawns createSidecarToolPodJob when custom tool is called (standalone mode)', async () => {
    // First response: call custom tool
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-custom',
                type: 'function',
                function: {
                  name: 'home_control',
                  arguments: '{"command":"turn on lights"}',
                },
              },
            ],
          },
        },
      ],
    });
    // Second response: final answer
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: { role: 'assistant', content: 'Lights on.', tool_calls: [] },
        },
      ],
    });

    // Capture the requestId from xadd so xread can return a matching result
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
              ['requestId', capturedRequestId, 'result', '"Lights turned on"'],
            ],
          ],
        ],
      ];
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const { jobRunner } = await import('../k8s/job-runner.js');
    const runner = new DirectLLMRunner();
    const groupWithTools = {
      ...baseGroup,
      containerConfig: {
        tools: [
          {
            name: 'home_control',
            description: 'Control',
            parameters: {},
            image: 'my-ha:latest',
            pattern: 'http' as const,
            port: 8080,
          },
        ],
      },
    };

    await runner.runAgent(groupWithTools, baseInput);

    expect(jobRunner.createSidecarToolPodJob).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'home_control',
        toolSpec: expect.objectContaining({
          image: 'my-ha:latest',
          pattern: 'http',
        }),
      }),
    );
    expect(jobRunner.createToolPodJob).not.toHaveBeenCalled();
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
      toolFilter: new Set(['web_search']),
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const toolNames = callArgs.tools.map((t: any) => t.function.name);
    // Only the allowlisted tool is advertised
    expect(toolNames).toEqual(['web_search']);
    // Other built-in tools are not included
    expect(toolNames).not.toContain('bash');
    expect(toolNames).not.toContain('web_fetch');
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

  it('falls back to base prompt (with contract) when skill-loader throws', async () => {
    mockLoadSkills.mockImplementation(() => {
      throw new Error('skill-loader exploded');
    });
    const { __testing__ } = await import('./direct-llm-runner.js');
    const out = __testing__.loadSystemPromptForTest('g1', tmpGroupsDir);
    expect(out).toContain('BASE PROMPT');
    expect(out).toContain('## Recommendation guidelines');
    expect(out).not.toContain('Learned skills');
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
    // CLAUDE.md written in beforeEach as 'BASE PROMPT' — no opt-out marker
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
    // Use a group folder that has no CLAUDE.md
    fs.mkdirSync(path.join(tmpGroupsDir, 'g2'), { recursive: true });
    const { __testing__ } = await import('./direct-llm-runner.js');
    const out = __testing__.loadSystemPromptForTest('g2', tmpGroupsDir);
    expect(out).toContain('## Recommendation guidelines');
  });
});

describe('TOOLS — propose_skill registration', () => {
  it('includes propose_skill in the built-in tool list', async () => {
    const { __testing__ } = await import('./direct-llm-runner.js');
    const names = __testing__.toolsForTest().map((t: any) => t.function.name);
    expect(names).toContain('propose_skill');
  });
});
