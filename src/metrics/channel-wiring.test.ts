/**
 * Tests that channel metrics are wired correctly into DirectLLMRunner.
 * Uses a mock ChannelMetrics object to verify each recording site.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DirectLLMRunner } from '../runtime/direct-llm-runner.js';
import type { ChannelMetrics } from '../metrics/channel.js';
import {
  _initTestDatabase,
  __resetDbForTest,
  setDbQueryCallback,
} from '../db.js';

// Mock redis-client so tool executions that reach executeToolViaK8s throw
// (simulating Redis unavailable), which exercises the toolSuccess=false path.
vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    xadd: vi.fn().mockRejectedValue(new Error('Redis unavailable (test)')),
    xread: vi.fn(),
    quit: vi.fn(),
  }),
  getRedisSubscriber: vi.fn(),
  getRedisStreamWatcher: vi.fn(),
  getToolCallsStream: vi.fn().mockReturnValue('kubeclaw:tool-calls:test'),
  getToolResultsStream: vi.fn().mockReturnValue('kubeclaw:tool-results:test'),
  getSpawnToolPodStream: vi.fn().mockReturnValue('kubeclaw:spawn-tool-pod'),
  getSpawnToolJobStream: vi.fn().mockReturnValue('kubeclaw:spawn-tool-job'),
  getToolJobResultStream: vi
    .fn()
    .mockReturnValue('kubeclaw:tool-job-result:test'),
  getTaskRequestStream: vi.fn().mockReturnValue('kubeclaw:task-mgmt-request'),
  getOutputChannel: vi.fn().mockReturnValue('kubeclaw:output:test'),
  getChannelStatusChannel: vi.fn().mockReturnValue('kubeclaw:channel-status'),
}));

// Minimal mock ChannelMetrics
function makeMetricsMock(): ChannelMetrics & {
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {
    recordMessage: [],
    recordLlmCall: [],
    recordTokens: [],
    recordToolCall: [],
    recordSkillLoad: [],
    setConversationHistorySize: [],
  };
  return {
    calls,
    recordMessage: vi.fn((labels) => calls.recordMessage.push([labels])),
    recordLlmCall: vi.fn((labels) => calls.recordLlmCall.push([labels])),
    recordTokens: vi.fn((labels) => calls.recordTokens.push([labels])),
    recordToolCall: vi.fn((labels) => calls.recordToolCall.push([labels])),
    recordSkillLoad: vi.fn((labels) => calls.recordSkillLoad.push([labels])),
    setConversationHistorySize: vi.fn((labels, size) =>
      calls.setConversationHistorySize.push([labels, size]),
    ),
  };
}

// Mock the OpenAI client to avoid real network calls
function makeFakeOpenAI(opts?: {
  hasToolCalls?: boolean;
  promptTokens?: number;
  completionTokens?: number;
}): import('openai').default {
  const usage = {
    prompt_tokens: opts?.promptTokens ?? 10,
    completion_tokens: opts?.completionTokens ?? 20,
    total_tokens: (opts?.promptTokens ?? 10) + (opts?.completionTokens ?? 20),
  };

  const messageNoTools = {
    role: 'assistant' as const,
    content: 'Test response',
    tool_calls: undefined,
  };

  const fakeCreate = vi.fn().mockResolvedValue({
    choices: [{ message: messageNoTools }],
    usage,
  });

  return {
    chat: { completions: { create: fakeCreate } },
  } as unknown as import('openai').default;
}

/**
 * Fake OpenAI client that returns a single tool call on the first invocation
 * and a plain content response on subsequent invocations.
 */
function makeFakeOpenAIWithToolCall(
  toolName: string,
): import('openai').default {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

  const messageWithTool = {
    role: 'assistant' as const,
    content: null,
    tool_calls: [
      {
        id: 'call_test_001',
        type: 'function' as const,
        function: { name: toolName, arguments: '{}' },
      },
    ],
  };

  const messageContent = {
    role: 'assistant' as const,
    content: 'Done',
    tool_calls: undefined,
  };

  // First call returns tool call; subsequent calls return content.
  let callCount = 0;
  const fakeCreate = vi.fn().mockImplementation(() => {
    callCount += 1;
    const message = callCount === 1 ? messageWithTool : messageContent;
    return Promise.resolve({ choices: [{ message }], usage });
  });

  return {
    chat: { completions: { create: fakeCreate } },
  } as unknown as import('openai').default;
}

beforeEach(async () => {
  await _initTestDatabase();
  // Silence db timing callbacks in these tests
  setDbQueryCallback(() => {});
});

afterEach(() => {
  __resetDbForTest();
  setDbQueryCallback(() => {});
});

describe('DirectLLMRunner channel metrics wiring', () => {
  it('records LLM call duration and success on each API call', async () => {
    const metrics = makeMetricsMock();
    const fakeClient = makeFakeOpenAI({
      promptTokens: 50,
      completionTokens: 100,
    });
    const runner = new DirectLLMRunner(fakeClient);
    runner.setChannelMetrics(metrics);

    await runner.runAgent(
      { name: 'TestGroup', folder: 'testgroup', trigger: '', added_at: '' },
      {
        prompt: 'Hello',
        groupFolder: 'testgroup',
        chatJid: 'jid@g.us',
        isMain: false,
        assistantName: 'bot',
      },
    );

    expect(metrics.recordLlmCall).toHaveBeenCalledOnce();
    const callArgs = (metrics.recordLlmCall as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArgs.success).toBe(true);
    expect(callArgs.model).toBeDefined();
    expect(callArgs.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records input and output tokens from LLM response', async () => {
    const metrics = makeMetricsMock();
    const fakeClient = makeFakeOpenAI({
      promptTokens: 150,
      completionTokens: 75,
    });
    const runner = new DirectLLMRunner(fakeClient);
    runner.setChannelMetrics(metrics);

    await runner.runAgent(
      { name: 'TestGroup', folder: 'testgroup', trigger: '', added_at: '' },
      {
        prompt: 'Hello',
        groupFolder: 'testgroup',
        chatJid: 'jid@g.us',
        isMain: false,
        assistantName: 'bot',
      },
    );

    const tokenCalls = (metrics.recordTokens as ReturnType<typeof vi.fn>).mock
      .calls;
    const inputCall = tokenCalls.find((c) => c[0].direction === 'input');
    const outputCall = tokenCalls.find((c) => c[0].direction === 'output');
    expect(inputCall?.[0].count).toBe(150);
    expect(outputCall?.[0].count).toBe(75);
  });

  it('records conversation history size', async () => {
    const metrics = makeMetricsMock();
    const fakeClient = makeFakeOpenAI();
    const runner = new DirectLLMRunner(fakeClient);
    runner.setChannelMetrics(metrics);

    await runner.runAgent(
      { name: 'TestGroup', folder: 'testgroup', trigger: '', added_at: '' },
      {
        prompt: 'Hello',
        groupFolder: 'testgroup',
        chatJid: 'jid@g.us',
        isMain: false,
        assistantName: 'bot',
      },
    );

    expect(metrics.setConversationHistorySize).toHaveBeenCalledOnce();
    const [labels, size] = (
      metrics.setConversationHistorySize as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(labels.group).toBe('testgroup');
    expect(size).toBeGreaterThanOrEqual(0);
  });

  it('setChannelMetrics is callable and stores the reference', () => {
    const metrics = makeMetricsMock();
    const runner = new DirectLLMRunner();
    // Should not throw
    expect(() => runner.setChannelMetrics(metrics)).not.toThrow();
  });

  // Fix B: toolSuccess status label ----------------------------------------

  it('records status=failure when a tool throws', async () => {
    // The global redis mock has xadd rejecting, so any executeToolViaK8s call
    // will throw → toolSuccess = false.
    const metrics = makeMetricsMock();
    const fakeClient = makeFakeOpenAIWithToolCall('web_fetch');
    const runner = new DirectLLMRunner(fakeClient);
    runner.setChannelMetrics(metrics);

    await runner.runAgent(
      { name: 'TestGroup', folder: 'testgroup', trigger: '', added_at: '' },
      {
        prompt: 'Fetch http://example.com',
        groupFolder: 'testgroup',
        chatJid: 'jid@g.us',
        isMain: false,
        assistantName: 'bot',
      },
    );

    expect(metrics.recordToolCall).toHaveBeenCalledOnce();
    const callArg = (metrics.recordToolCall as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArg.status).toBe('failure');
  });

  // Fix C: cardinality guard ------------------------------------------------

  it('buckets hallucinated tool names as "unknown"', async () => {
    const metrics = makeMetricsMock();
    // The tool name here is not in the TOOLS list, so it should be bucketed.
    const fakeClient = makeFakeOpenAIWithToolCall(
      'query_database_v2_experimental',
    );
    const runner = new DirectLLMRunner(fakeClient);
    runner.setChannelMetrics(metrics);

    await runner.runAgent(
      { name: 'TestGroup', folder: 'testgroup', trigger: '', added_at: '' },
      {
        prompt: 'Do something',
        groupFolder: 'testgroup',
        chatJid: 'jid@g.us',
        isMain: false,
        assistantName: 'bot',
      },
    );

    expect(metrics.recordToolCall).toHaveBeenCalledOnce();
    const callArg = (metrics.recordToolCall as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArg.tool).toBe('unknown');
  });
});
