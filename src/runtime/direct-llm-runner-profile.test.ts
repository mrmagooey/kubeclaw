// src/runtime/direct-llm-runner-profile.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Mock db so the test does not need a real SQLite file.
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>();
  return {
    ...actual,
    getGroupProfile: vi.fn().mockReturnValue(null),
  };
});

// Mock dependencies that direct-llm-runner.ts pulls in
vi.mock('../k8s/job-runner.js', () => ({
  jobRunner: {
    createJob: vi.fn(),
    deleteJob: vi.fn(),
    getPodLogs: vi.fn(),
  },
  buildJobName: vi.fn().mockReturnValue('mock-job'),
}));

vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({ xadd: vi.fn(), xread: vi.fn() }),
  getToolJobResultStream: vi.fn().mockReturnValue('stream'),
  getSpawnToolJobStream: vi.fn().mockReturnValue('stream'),
  getSpawnToolPodStream: vi.fn().mockReturnValue('stream'),
  getTaskRequestStream: vi.fn().mockReturnValue('stream'),
  getToolCallsStream: vi.fn().mockReturnValue('stream'),
  getToolResultsStream: vi.fn().mockReturnValue('stream'),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: vi.fn() } },
  })),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../config.js', () => ({
  GROUPS_DIR: '/tmp/groups',
  KUBECLAW_CHANNEL: 'test',
  KUBECLAW_MODE: 'channel',
}));

vi.mock('./llm-client.js', () => ({
  createLLMClient: vi.fn(),
  DEFAULT_DIRECT_MODEL: 'test-model',
}));

vi.mock('./skill-loader.js', () => ({
  loadSkills: vi.fn().mockReturnValue({ promptSuffix: '', loadedSkills: [] }),
}));

vi.mock('./tools/propose-skill.js', () => ({
  proposeSkill: vi.fn(),
}));

vi.mock('./compression/token-estimate.js', () => ({
  estimateMessagesTokens: vi.fn().mockReturnValue(0),
}));

vi.mock('./compression/summarizer.js', () => ({
  summarize: vi.fn(),
}));

vi.mock('../rag/provider.js', () => ({
  getRagProvider: vi.fn().mockReturnValue(null),
}));

import { _loadSystemPromptForTest } from './direct-llm-runner.js';
import * as db from '../db.js';

describe('loadSystemPrompt profile injection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-test-'));
    vi.mocked(db.getGroupProfile).mockReturnValue(null);
  });

  it('returns base prompt with no profile when getGroupProfile returns null', () => {
    vi.mocked(db.getGroupProfile).mockReturnValue(null);
    const result = _loadSystemPromptForTest('some-group', tmpDir);
    expect(result).not.toContain('## Your profile');
  });

  it('appends a profile section when getGroupProfile returns a full profile', () => {
    vi.mocked(db.getGroupProfile).mockReturnValue({
      groupFolder: 'test-group',
      timezone: 'America/New_York',
      location: 'Brooklyn, NY',
      cuisineLikes: 'Japanese, Thai',
      cuisineDislikes: 'Liver',
      dietaryRestrictions: 'no shellfish',
      budgetTier: 'mid-range',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });
    const result = _loadSystemPromptForTest('test-group', tmpDir);
    expect(result).toContain('## Your profile');
    expect(result).toContain('America/New_York');
    expect(result).toContain('Brooklyn, NY');
    expect(result).toContain('Japanese, Thai');
    expect(result).toContain('Liver');
    expect(result).toContain('no shellfish');
    expect(result).toContain('mid-range');
  });

  it('omits profile fields that are undefined', () => {
    vi.mocked(db.getGroupProfile).mockReturnValue({
      groupFolder: 'sparse-group',
      timezone: 'UTC',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });
    const result = _loadSystemPromptForTest('sparse-group', tmpDir);
    expect(result).toContain('## Your profile');
    expect(result).toContain('UTC');
    // Fields not set should not appear as "undefined" literally
    expect(result).not.toContain('undefined');
  });

  it('profile section appears after the skills suffix', () => {
    // Create a fake CLAUDE.md so the skills path can run
    const groupDir = path.join(tmpDir, 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), 'Custom base prompt.');
    vi.mocked(db.getGroupProfile).mockReturnValue({
      groupFolder: 'test-group',
      timezone: 'Europe/London',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });
    const result = _loadSystemPromptForTest('test-group', tmpDir);
    const profileIdx = result.indexOf('## Your profile');
    const baseIdx = result.indexOf('Custom base prompt.');
    expect(profileIdx).toBeGreaterThan(baseIdx);
  });
});
