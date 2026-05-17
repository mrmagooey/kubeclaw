/**
 * Integration tests for DirectLLMRunner.
 *
 * Suite 1: real filesystem, real skill-loader.
 *   No mock of skill-loader.js so wiring bugs (e.g. swapped arg order) surface.
 *   Uses a mocked db (loadSystemPromptForTest does not touch the DB).
 *
 * Suite 2: real in-memory SQLite database (via _initTestDatabase) + stubbed
 *   OpenAI client. Tests context compression end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock infrastructure that makes network/k8s calls or needs a real Redis.
// db.js is NOT mocked here — both suites need the real implementation
// (suite 1 doesn't call into the DB, suite 2 uses _initTestDatabase).

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: vi.fn() } },
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
  getTaskRequestStream: vi.fn(() => 'task-request'),
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
    chat: { completions: { create: vi.fn() } },
  })),
  DEFAULT_DIRECT_MODEL: 'claude-3-5-haiku-20241022',
}));

vi.mock('./tools/propose-skill.js', () => ({
  proposeSkill: vi.fn().mockResolvedValue({ kind: 'staged', candidateId: 'c1', preview: 'preview' }),
}));

vi.mock('../rag/provider.js', () => ({
  getRagProvider: vi.fn(() => ({
    indexConversationTurn: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./mcp-manager.js', () => ({
  McpManager: class {
    initialize = vi.fn().mockResolvedValue(undefined);
    reconfigure = vi.fn().mockResolvedValue(undefined);
    getTools = vi.fn().mockReturnValue([]);
    hasTool = vi.fn().mockReturnValue(false);
    callTool = vi.fn().mockResolvedValue('');
    shutdown = vi.fn().mockResolvedValue(undefined);
  },
}));

// Initialise the real in-memory SQLite DB once for this module.
beforeAll(async () => {
  const { _initTestDatabase } = await import('../db.js');
  await _initTestDatabase();
});

// ---- Suite 1: real skill-loader integration ----------------------------

describe('loadSystemPrompt — real skill-loader integration', () => {
  let tmpGroupsDir: string;

  beforeEach(() => {
    tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-integ-'));
    fs.mkdirSync(path.join(tmpGroupsDir, 'g1', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(tmpGroupsDir, 'g1', 'CLAUDE.md'), 'BASE PROMPT');
    fs.writeFileSync(
      path.join(tmpGroupsDir, 'g1', 'skills', 'alpha.md'),
      '---\nname: alpha\ndescription: alpha skill\ncreated: 2026-05-16\nsource: manual\n---\n\nALPHA BODY\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  });

  it('appends real skill body when a real skill file is present', async () => {
    const mod = await import('./direct-llm-runner.js');
    const out = mod.__testing__.loadSystemPromptForTest('g1', tmpGroupsDir);
    expect(out).toContain('BASE PROMPT');
    expect(out).toContain('## Learned skills');
    expect(out).toContain('ALPHA BODY');
  });

  it('returns only base prompt when skills dir is empty', async () => {
    // Remove the skill file
    fs.rmSync(path.join(tmpGroupsDir, 'g1', 'skills', 'alpha.md'));
    const mod = await import('./direct-llm-runner.js');
    const out = mod.__testing__.loadSystemPromptForTest('g1', tmpGroupsDir);
    expect(out).toBe('BASE PROMPT');
    expect(out).not.toContain('Learned skills');
  });

  it('would fail if loadSkills args were swapped (groupsDir vs groupFolder)', async () => {
    // When args are swapped, skill-loader looks in tmpGroupsDir/g1/g1/skills which
    // does not exist, so no skills are loaded and the suffix is absent.
    // This test documents the correct arg order and guards against regression.
    const mod = await import('./direct-llm-runner.js');
    // Correct order — skills present:
    const correct = mod.__testing__.loadSystemPromptForTest('g1', tmpGroupsDir);
    expect(correct).toContain('ALPHA BODY');
  });
});

// ---- Suite 2: context compression integration (real SQLite) ----------------

function makeCompressionStub() {
  const client = {
    chat: {
      completions: {
        create: vi.fn(async (req: { messages: { role: string; content: string }[]; model: string }) => {
          // Summarization call: check if system prompt contains our archiver marker
          const isSummarizationCall = req.messages.some(
            (m) => m.role === 'system' && m.content.includes('conversation archiver'),
          );
          if (isSummarizationCall) {
            return {
              choices: [{ message: { content: 'Dense summary of prior messages.', tool_calls: [] } }],
              usage: { total_tokens: 30 },
            };
          }
          return {
            choices: [{ message: { content: 'Assistant reply.', tool_calls: [] } }],
            usage: { total_tokens: 10 },
          };
        }),
      },
    },
  };
  return client;
}

describe('DirectLLMRunner compression integration', () => {
  const groupFolder = 'compression-test-group';

  beforeEach(async () => {
    vi.clearAllMocks();
    const { _initTestDatabase, clearConversationHistory } = await import('../db.js');
    await _initTestDatabase();
    clearConversationHistory(groupFolder);
  });

  it('creates a summary row after exceeding KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES', async () => {
    process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES = '5';
    process.env.MAX_CONVERSATION_HISTORY = '2';

    try {
      const { appendConversationMessage, getLatestSummary, clearConversationHistory } = await import('../db.js');
      clearConversationHistory(groupFolder);

      // Seed 6 messages (>5 threshold)
      for (let i = 0; i < 6; i++) {
        appendConversationMessage(groupFolder, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`);
      }

      const client = makeCompressionStub() as any;
      const { DirectLLMRunner } = await import('./direct-llm-runner.js');
      const runner = new DirectLLMRunner(client);

      const group = {
        name: groupFolder, folder: groupFolder, trigger: '', added_at: '',
      } as any;

      await runner.runAgent(group, {
        groupFolder, chatJid: groupFolder, prompt: 'New message', isMain: false,
      });

      const summary = getLatestSummary(groupFolder);
      expect(summary).not.toBeNull();
      expect(summary!.summaryText).toBe('Dense summary of prior messages.');
    } finally {
      delete process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES;
      delete process.env.MAX_CONVERSATION_HISTORY;
    }
  });

  it('includes the summary marker in the LLM call after compression', async () => {
    process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES = '3';
    process.env.MAX_CONVERSATION_HISTORY = '1';

    try {
      const { appendConversationMessage, clearConversationHistory } = await import('../db.js');
      clearConversationHistory(groupFolder);

      // Seed 4 messages (>3 threshold)
      for (let i = 0; i < 4; i++) {
        appendConversationMessage(groupFolder, i % 2 === 0 ? 'user' : 'assistant', `seed ${i}`);
      }

      const client = makeCompressionStub() as any;
      const { DirectLLMRunner } = await import('./direct-llm-runner.js');
      const runner = new DirectLLMRunner(client);

      const group = {
        name: groupFolder, folder: groupFolder, trigger: '', added_at: '',
      } as any;

      await runner.runAgent(group, {
        groupFolder, chatJid: groupFolder, prompt: 'Follow-up', isMain: false,
      });

      // The main LLM call should have a system message starting with [summary_id=
      const createCalls = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls;
      const mainCall = createCalls.find((c: any[]) =>
        !c[0].messages.some((m: { role: string; content: string }) =>
          m.role === 'system' && m.content.includes('conversation archiver'),
        ),
      );
      expect(mainCall).toBeDefined();
      const hasMarker = mainCall[0].messages.some(
        (m: { role: string; content: string }) =>
          m.role === 'system' && m.content.startsWith('[summary_id='),
      );
      expect(hasMarker).toBe(true);
    } finally {
      delete process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES;
      delete process.env.MAX_CONVERSATION_HISTORY;
    }
  });

  it('deletes compressed messages after summarization (no repeat billing)', async () => {
    process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES = '5';
    process.env.MAX_CONVERSATION_HISTORY = '2';

    try {
      const { appendConversationMessage, getConversationHistory, getLatestSummary, clearConversationHistory } = await import('../db.js');
      clearConversationHistory(groupFolder);

      // Seed 6 messages (>5 threshold)
      for (let i = 0; i < 6; i++) {
        appendConversationMessage(groupFolder, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`);
      }

      const client = makeCompressionStub() as any;
      const { DirectLLMRunner } = await import('./direct-llm-runner.js');
      const runner = new DirectLLMRunner(client);
      const group = {
        name: groupFolder, folder: groupFolder, trigger: '', added_at: '',
      } as any;

      await runner.runAgent(group, {
        groupFolder, chatJid: groupFolder, prompt: 'Turn 1', isMain: false,
      });

      // After first runAgent: keep-window=2 + 1 new (user) + 1 new (assistant) = 4 rows total
      // (the 4 compressed rows should be deleted)
      const histAfterFirst = getConversationHistory(groupFolder, 0);
      // Should have at most keepWindow(2) + 2 (new turn) rows — not 6+2
      expect(histAfterFirst.length).toBeLessThanOrEqual(4);

      const summaryAfterFirst = getLatestSummary(groupFolder);
      expect(summaryAfterFirst).not.toBeNull();

      const callCountAfterFirst = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls.length;

      // Second runAgent — threshold should NOT fire again
      await runner.runAgent(group, {
        groupFolder, chatJid: groupFolder, prompt: 'Turn 2', isMain: false,
      });

      const callCountAfterSecond = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls.length;
      // Only 1 main LLM call for turn 2 (no summarization call)
      expect(callCountAfterSecond - callCountAfterFirst).toBe(1);

      // Summary count should still be 1 (no new summary created)
      const summaryAfterSecond = getLatestSummary(groupFolder);
      expect(summaryAfterSecond!.id).toBe(summaryAfterFirst!.id);
    } finally {
      delete process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES;
      delete process.env.MAX_CONVERSATION_HISTORY;
    }
  });

  it('clearConversationHistory purges both history and summaries', async () => {
    const { insertSummary, getLatestSummary, clearConversationHistory } = await import('../db.js');
    insertSummary({
      groupFolder, sessionKey: groupFolder, parentSummaryId: null,
      messageStartId: 'a', messageEndId: 'b',
      summaryText: 'old summary', modelUsed: 'gpt-4o', tokenCount: 5,
    });
    clearConversationHistory(groupFolder);
    expect(getLatestSummary(groupFolder)).toBeNull();
  });
});
