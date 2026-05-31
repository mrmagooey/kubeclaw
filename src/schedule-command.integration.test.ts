/**
 * Integration test for the /schedule slash command.
 *
 * Uses real sql.js in-memory database (via _initTestDatabase) to exercise
 * the full path through handleScheduleCommand → createTask / getTasksForGroup
 * / deleteTaskForGroup, including per-group isolation.
 *
 * No Kubernetes, Redis, or LLM required.
 * The k8s/job-runner module is mocked to prevent the KubeConfig singleton
 * from being instantiated in a test environment without a cluster.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// channel-runner.ts has a module-level `if (!KUBECLAW_CHANNEL) process.exit(1)` guard.
// Hoist the env stub above the import so the guard passes.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'test';
});

// Mock transitive kubernetes dependency before any module loads.
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
}));
vi.mock('./k8s/ipc-redis.js', () => ({
  startIpcWatcher: vi.fn(),
  startControlChannelWatcher: vi.fn(),
}));
vi.mock('./k8s/file-sidecar-runner.js', () => ({
  FileSidecarJobRunner: vi.fn(),
  fileSidecarRunner: {
    createJob: vi.fn(),
    deleteJob: vi.fn(),
  },
}));
vi.mock('./k8s/http-sidecar-runner.js', () => ({
  HttpSidecarJobRunner: vi.fn(),
  httpSidecarRunner: {
    createJob: vi.fn(),
    deleteJob: vi.fn(),
  },
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
import { _initTestDatabase, __resetDbForTest } from './db.js';
import { handleScheduleCommand, isScheduleCommand } from './channel-runner.js';

// Initialise once; share across all tests (reset per-test below).
beforeAll(async () => {
  await _initTestDatabase();
});

describe('/schedule integration — create / list / remove (AC1–AC3)', () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it('AC1: add returns confirmation with UUID id', async () => {
    const reply = await handleScheduleCommand(
      'integ-group-alice',
      'http:alice',
      '/schedule add interval 60000 "ping"',
    );

    expect(reply).toMatch(/Scheduled task created/i);
    // Must contain a UUID
    expect(reply).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
    expect(reply).toContain('interval');
    expect(reply).toContain('60000');
  });

  it('AC2: list returns "No scheduled tasks" when none exist', async () => {
    const reply = await handleScheduleCommand(
      'integ-group-alice',
      'http:alice',
      '/schedule list',
    );
    expect(reply).toMatch(/no scheduled tasks/i);
  });

  it('AC2: list returns tasks with required fields after add', async () => {
    // Add a task first
    await handleScheduleCommand(
      'integ-group-alice',
      'http:alice',
      '/schedule add interval 60000 "ping"',
    );

    const reply = await handleScheduleCommand(
      'integ-group-alice',
      'http:alice',
      '/schedule list',
    );

    expect(reply).toMatch(/Scheduled tasks/i);
    expect(reply).toContain('interval');
    expect(reply).toContain('60000');
    expect(reply).toContain('active');
    // next_run should be present
    expect(reply).toMatch(/next_run:/);
    // id field should be present
    expect(reply).toMatch(/id:/);
  });

  it('AC3: remove returns "Removed"; subsequent list excludes id', async () => {
    // Add a task
    const addReply = await handleScheduleCommand(
      'integ-group-alice',
      'http:alice',
      '/schedule add once 2026-12-25T00:00:00Z "happy holidays"',
    );
    // Extract the uuid from the add reply
    const match = addReply.match(
      /id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    );
    expect(match).not.toBeNull();
    const taskId = match![1];

    // Remove it
    const removeReply = await handleScheduleCommand(
      'integ-group-alice',
      'http:alice',
      `/schedule remove ${taskId}`,
    );
    expect(removeReply).toMatch(/Removed/i);

    // List should now say no tasks
    const listReply = await handleScheduleCommand(
      'integ-group-alice',
      'http:alice',
      '/schedule list',
    );
    expect(listReply).toMatch(/no scheduled tasks/i);
    expect(listReply).not.toContain(taskId);
  });

  it('AC4: remove with unknown id returns "not found"', async () => {
    const reply = await handleScheduleCommand(
      'integ-group-alice',
      'http:alice',
      '/schedule remove 00000000-0000-0000-0000-000000000000',
    );
    expect(reply).toMatch(/not found/i);
    // Must not expose a stack trace
    expect(reply).not.toMatch(/Error:|at \w/);
  });
});

describe('/schedule integration — per-group isolation (AC5)', () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("alice's tasks are not visible to bob", async () => {
    // Alice adds a task
    const addReply = await handleScheduleCommand(
      'integ-group-alice',
      'http:alice',
      '/schedule add interval 60000 "alice task"',
    );
    const match = addReply.match(
      /id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    );
    const aliceTaskId = match![1];

    // Bob lists — should see no tasks
    const bobList = await handleScheduleCommand(
      'integ-group-bob',
      'http:bob',
      '/schedule list',
    );
    expect(bobList).toMatch(/no scheduled tasks/i);
    expect(bobList).not.toContain(aliceTaskId);
  });

  it("bob cannot remove alice's task", async () => {
    // Alice adds a task
    const addReply = await handleScheduleCommand(
      'integ-group-alice',
      'http:alice',
      '/schedule add interval 60000 "alice task"',
    );
    const match = addReply.match(
      /id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    );
    const aliceTaskId = match![1];

    // Bob tries to remove Alice's task — must get "not found"
    const bobRemove = await handleScheduleCommand(
      'integ-group-bob',
      'http:bob',
      `/schedule remove ${aliceTaskId}`,
    );
    expect(bobRemove).toMatch(/not found/i);

    // Alice's task should still be listed
    const aliceList = await handleScheduleCommand(
      'integ-group-alice',
      'http:alice',
      '/schedule list',
    );
    expect(aliceList).toContain(aliceTaskId);
  });
});

describe('/schedule integration — isScheduleCommand guard', () => {
  it('correctly identifies /schedule commands', () => {
    expect(isScheduleCommand('/schedule add interval 60000 ping')).toBe(true);
    expect(isScheduleCommand('/schedule list')).toBe(true);
    expect(isScheduleCommand('/schedule remove abc')).toBe(true);
    expect(isScheduleCommand('/secret list')).toBe(false);
    expect(isScheduleCommand('hello world')).toBe(false);
  });
});
