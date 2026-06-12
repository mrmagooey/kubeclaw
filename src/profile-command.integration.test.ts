/**
 * Integration test: update_profile local tool + SQLite round-trip.
 *
 * Uses real sql.js in-memory database. No Kubernetes, Redis, or LLM required.
 * Mocks the K8s / Redis transitive dependencies that channel-runner pulls in.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'test';
});

vi.mock('./k8s/job-runner.js', () => ({
  jobRunner: {
    applyYamlToK8s: vi.fn(),
    deleteDeployment: vi.fn(),
    deleteService: vi.fn(),
    deletePersistentVolumeClaim: vi.fn(),
    createJob: vi.fn(),
    deleteJob: vi.fn(),
    getPodLogs: vi.fn(),
  },
  buildJobName: vi.fn().mockReturnValue('mock-job'),
  JobRunner: vi.fn(),
}));
vi.mock('./k8s/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({ publish: vi.fn() }),
  getChannelStatusChannel: vi.fn().mockReturnValue('ch'),
  getTaskRequestStream: vi.fn().mockReturnValue('ts'),
  getSpawnToolPodStream: vi.fn().mockReturnValue('sp'),
  getSpawnToolJobStream: vi.fn().mockReturnValue('sp'),
  getToolJobResultStream: vi.fn().mockReturnValue('tjr'),
  getToolCallsStream: vi.fn().mockReturnValue('tcs'),
  getToolResultsStream: vi.fn().mockReturnValue('trs'),
}));
vi.mock('./k8s/ipc-redis.js', () => ({
  startIpcWatcher: vi.fn(),
  startControlChannelWatcher: vi.fn(),
}));
vi.mock('./k8s/acl-manager.js', () => ({
  getACLManager: vi.fn().mockReturnValue({}),
  RedisACLManager: vi.fn(),
}));
vi.mock('./runtime/index.js', () => ({
  getDirectLLMRunner: vi.fn().mockReturnValue({
    configureMcp: vi.fn(),
    configureGroupMcpTemplates: vi.fn(),
    registerLocalTool: vi.fn(),
    setChannelMetrics: vi.fn(),
    writeTasksSnapshot: vi.fn(),
    writeGroupsSnapshot: vi.fn(),
    runAgent: vi.fn().mockResolvedValue({ status: 'success' }),
  }),
  shutdownAllRunners: vi.fn(),
}));

import {
  _initTestDatabase,
  __resetDbForTest,
  getGroupProfile,
  upsertGroupProfile,
} from './db.js';
import { registerProfileTool } from './channel-runner.js';

beforeAll(async () => {
  await _initTestDatabase();
});

beforeEach(() => {
  __resetDbForTest();
});

describe('registerProfileTool integration', () => {
  it('update_profile handler upserts a profile row in SQLite', async () => {
    const groupFolder = 'integration-test-group';

    // Capture the registered handler
    let capturedHandler:
      | ((
          args: Record<string, unknown>,
          input: { groupFolder: string },
        ) => Promise<string>)
      | null = null;
    const mockRunner = {
      registerLocalTool: vi.fn(
        (_name: string, tool: { handler: typeof capturedHandler }) => {
          capturedHandler = tool.handler;
        },
      ),
    };

    registerProfileTool(
      mockRunner as unknown as ReturnType<
        typeof import('./runtime/index.js').getDirectLLMRunner
      >,
    );

    expect(capturedHandler).not.toBeNull();

    // Call the handler as the LLM would
    const result = await capturedHandler!(
      {
        timezone: 'America/Chicago',
        location: 'Austin, TX',
        cuisine_likes: 'BBQ, Tex-Mex',
        budget_tier: 'mid-range',
      },
      { groupFolder },
    );

    expect(result).toBe('Profile updated.');

    // Verify the SQLite row was written
    const profile = getGroupProfile(groupFolder);
    expect(profile).not.toBeNull();
    expect(profile!.timezone).toBe('America/Chicago');
    expect(profile!.location).toBe('Austin, TX');
    expect(profile!.cuisineLikes).toBe('BBQ, Tex-Mex');
    expect(profile!.budgetTier).toBe('mid-range');
  });

  it('partial update_profile call preserves existing fields', async () => {
    const groupFolder = 'partial-update-group';

    // Seed an existing profile
    upsertGroupProfile({
      groupFolder,
      timezone: 'Pacific/Auckland',
      location: 'Auckland, NZ',
      updatedAt: '2026-05-28T08:00:00.000Z',
    });

    let capturedHandler:
      | ((
          args: Record<string, unknown>,
          input: { groupFolder: string },
        ) => Promise<string>)
      | null = null;
    const mockRunner = {
      registerLocalTool: vi.fn(
        (_name: string, tool: { handler: typeof capturedHandler }) => {
          capturedHandler = tool.handler;
        },
      ),
    };
    registerProfileTool(
      mockRunner as unknown as ReturnType<
        typeof import('./runtime/index.js').getDirectLLMRunner
      >,
    );

    // Only update budgetTier
    await capturedHandler!({ budget_tier: 'splurge' }, { groupFolder });

    const profile = getGroupProfile(groupFolder);
    // Pre-existing fields must survive
    expect(profile!.timezone).toBe('Pacific/Auckland');
    expect(profile!.location).toBe('Auckland, NZ');
    // New field must be present
    expect(profile!.budgetTier).toBe('splurge');
  });
});
