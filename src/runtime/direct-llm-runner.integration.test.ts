/**
 * Integration tests for DirectLLMRunner — real filesystem, real skill-loader.
 * No mock of skill-loader.js so wiring bugs (e.g. swapped arg order) surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock everything that makes network/k8s calls or needs a real Redis, but
// do NOT mock skill-loader.js — that is the module under integration test.

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

vi.mock('../db.js', () => ({
  getConversationHistory: vi.fn().mockReturnValue([]),
  appendConversationMessage: vi.fn(),
  recordSkillLoad: vi.fn(),
  getSkillLoadStats: vi.fn().mockReturnValue([]),
  _initTestDatabase: vi.fn().mockResolvedValue(undefined),
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

// ---- Integration test block (real skill-loader) ----------------------------

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
