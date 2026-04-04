import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockRedisClient,
  mockRedisSubscriber,
  mockXadd,
  mockXread,
  mockSubscribe,
  mockUnsubscribe,
  mockQuit,
  subscriberOnRef,
} = vi.hoisted(() => {
  const mockXadd = vi.fn().mockResolvedValue('mock-id');
  const mockXread = vi.fn().mockResolvedValue(null);
  const mockSubscribe = vi.fn().mockResolvedValue(undefined);
  const mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
  const mockQuit = vi.fn().mockResolvedValue('OK');

  // ref to capture the 'message' event handler registered by startIpcWatcher
  const subscriberOnRef: { messageHandler: ((ch: string, msg: string) => void) | null } = {
    messageHandler: null,
  };

  const createMockRedis = () => ({
    xadd: mockXadd,
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    quit: mockQuit,
    on: vi.fn((event: string, cb: unknown) => {
      if (event === 'message') subscriberOnRef.messageHandler = cb as (ch: string, msg: string) => void;
    }),
  });

  return {
    mockXadd,
    mockXread,
    mockSubscribe,
    mockUnsubscribe,
    mockQuit,
    subscriberOnRef,
    mockRedisClient: createMockRedis(),
    mockRedisSubscriber: createMockRedis(),
  };
});

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => {
    return {
      xadd: mockXadd,
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      quit: mockQuit,
      on: vi.fn(),
    };
  }),
}));

vi.mock('../config.js', () => ({
  SIDECAR_FILE_POLL_INTERVAL: 1000,
  TIMEZONE: 'UTC',
  CONTAINER_TIMEOUT: 1800000,
  IDLE_TIMEOUT: 1800000,
  ASSISTANT_NAME: 'TestBot',
}));

vi.mock('./job-runner.js', () => ({
  jobRunner: {
    createToolPodJob: vi.fn().mockResolvedValue('nc-test-pod-abc123'),
    createSidecarToolPodJob: vi.fn().mockResolvedValue('kubeclaw-stool-abc-tool'),
    stopJob: vi.fn().mockResolvedValue(undefined),
    runAgentJob: vi.fn().mockResolvedValue({ status: 'success', result: 'ok' }),
    applyYamlToK8s: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  getTasksForGroup: vi.fn().mockReturnValue([]),
  getAllRegisteredGroups: vi.fn().mockReturnValue({}),
  updateTask: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../group-folder.js', () => ({
  isValidGroupFolder: vi.fn().mockReturnValue(true),
}));

vi.mock('./redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({
    xadd: mockXadd,
    xread: mockXread,
    xrevrange: vi.fn().mockResolvedValue([]),
  })),
  getRedisSubscriber: vi.fn(() => ({
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    quit: mockQuit,
    on: vi.fn((event: string, cb: unknown) => {
      if (event === 'message') subscriberOnRef.messageHandler = cb as (ch: string, msg: string) => void;
    }),
  })),
  getOutputChannel: vi.fn((folder: string) => `kubeclaw:messages:${folder}`),
  getTaskChannel: vi.fn((folder: string) => `kubeclaw:tasks:${folder}`),
  getInputStream: vi.fn((jobId: string) => `kubeclaw:input:${jobId}`),
  getSpawnToolPodStream: vi.fn(() => 'kubeclaw:spawn-tool-pod'),
  getSpawnAgentJobStream: vi.fn(() => 'kubeclaw:spawn-agent-job'),
  getAgentJobResultStream: vi.fn((id: string) => `kubeclaw:agent-job-result:${id}`),
}));

vi.mock('cron-parser', () => ({
  CronExpressionParser: {
    parse: vi.fn().mockReturnValue({
      next: vi.fn().mockReturnValue({
        toISOString: vi.fn().mockReturnValue('2025-01-01T00:00:00.000Z'),
      }),
    }),
  },
}));

import { CronExpressionParser } from 'cron-parser';
import { createTask, deleteTask, getTaskById, updateTask } from '../db.js';
import { isValidGroupFolder } from '../group-folder.js';
import {
  startIpcWatcher,
  stopIpcWatcher,
  sendMessageToAgent,
  sendCloseSignal,
  processTaskIpc,
  cleanupToolPods,
  startToolPodSpawnWatcher,
  startAgentJobSpawnWatcher,
} from './ipc-redis.js';
import type { RegisteredGroup } from '../types.js';

const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockRegisteredGroups = vi.fn();
const mockRegisterGroup = vi.fn();
const mockSyncGroups = vi.fn().mockResolvedValue(undefined);
const mockGetAvailableGroups = vi.fn();
const mockWriteGroupsSnapshot = vi.fn();

const createMockDeps = () => ({
  sendMessage: mockSendMessage,
  registeredGroups: mockRegisteredGroups,
  registerGroup: mockRegisterGroup,
  syncGroups: mockSyncGroups,
  getAvailableGroups: mockGetAvailableGroups,
  writeGroupsSnapshot: mockWriteGroupsSnapshot,
});

interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused';
  created_at: string;
}

const createMockTask = (
  overrides: Partial<ScheduledTask> = {},
): ScheduledTask => ({
  id: 'task-1',
  group_folder: 'main',
  chat_jid: 'group@g.us',
  prompt: 'Test',
  schedule_type: 'cron',
  schedule_value: '0 * * * *',
  context_mode: 'isolated',
  next_run: '2025-01-01T00:00:00.000Z',
  last_run: null,
  last_result: null,
  status: 'active',
  created_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

describe('processTaskIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegisteredGroups.mockReturnValue({});
  });

  describe('schedule_task', () => {
    it('creates a task with cron schedule', async () => {
      const deps = createMockDeps();
      mockRegisteredGroups.mockReturnValue({
        'main-group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '/',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });

      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'Test prompt',
          schedule_type: 'cron',
          schedule_value: '0 * * * *',
          targetJid: 'main-group@g.us',
        },
        'main',
        true,
        deps,
      );

      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Test prompt',
          schedule_type: 'cron',
          schedule_value: '0 * * * *',
          status: 'active',
        }),
      );
    });

    it('creates a task with interval schedule', async () => {
      const deps = createMockDeps();
      mockRegisteredGroups.mockReturnValue({
        'main-group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '/',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });

      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'Test prompt',
          schedule_type: 'interval',
          schedule_value: '60000',
          targetJid: 'main-group@g.us',
        },
        'main',
        true,
        deps,
      );

      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          schedule_type: 'interval',
          schedule_value: '60000',
        }),
      );
    });

    it('creates a task with once schedule', async () => {
      const deps = createMockDeps();
      mockRegisteredGroups.mockReturnValue({
        'main-group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '/',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });

      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'Test prompt',
          schedule_type: 'once',
          schedule_value: '2025-01-01T00:00:00.000Z',
          targetJid: 'main-group@g.us',
        },
        'main',
        true,
        deps,
      );

      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          schedule_type: 'once',
          schedule_value: '2025-01-01T00:00:00.000Z',
        }),
      );
    });

    it('blocks unauthorized schedule_task from non-main group', async () => {
      const deps = createMockDeps();
      mockRegisteredGroups.mockReturnValue({
        'main-group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '/',
          added_at: '2024-01-01T00:00:00.000Z',
        },
        'other-group@g.us': {
          name: 'Other',
          folder: 'other',
          trigger: '/',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });

      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'Test prompt',
          schedule_type: 'cron',
          schedule_value: '0 * * * *',
          targetJid: 'main-group@g.us',
        },
        'other',
        false,
        deps,
      );

      expect(createTask).not.toHaveBeenCalled();
    });

    it('rejects invalid cron expression', async () => {
      const deps = createMockDeps();
      mockRegisteredGroups.mockReturnValue({
        'main-group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '/',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });
      vi.mocked(CronExpressionParser.parse).mockImplementation(() => {
        throw new Error('Invalid cron');
      });

      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'Test prompt',
          schedule_type: 'cron',
          schedule_value: 'invalid',
          targetJid: 'main-group@g.us',
        },
        'main',
        true,
        deps,
      );

      expect(createTask).not.toHaveBeenCalled();
    });

    it('rejects invalid interval value', async () => {
      const deps = createMockDeps();
      mockRegisteredGroups.mockReturnValue({
        'main-group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '/',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });

      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'Test prompt',
          schedule_type: 'interval',
          schedule_value: 'invalid',
          targetJid: 'main-group@g.us',
        },
        'main',
        true,
        deps,
      );

      expect(createTask).not.toHaveBeenCalled();
    });

    it('rejects invalid once timestamp', async () => {
      const deps = createMockDeps();
      mockRegisteredGroups.mockReturnValue({
        'main-group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '/',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });

      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'Test prompt',
          schedule_type: 'once',
          schedule_value: 'invalid',
          targetJid: 'main-group@g.us',
        },
        'main',
        true,
        deps,
      );

      expect(createTask).not.toHaveBeenCalled();
    });

    it('warns when target group not registered', async () => {
      const deps = createMockDeps();
      mockRegisteredGroups.mockReturnValue({});

      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'Test prompt',
          schedule_type: 'cron',
          schedule_value: '0 * * * *',
          targetJid: 'unknown@g.us',
        },
        'main',
        true,
        deps,
      );

      expect(createTask).not.toHaveBeenCalled();
    });
  });

  describe('pause_task', () => {
    it('pauses a task when authorized', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(
        createMockTask({ group_folder: 'main' }),
      );

      await processTaskIpc(
        { type: 'pause_task', taskId: 'task-1' },
        'main',
        false,
        deps,
      );

      expect(updateTask).toHaveBeenCalledWith('task-1', { status: 'paused' });
    });

    it('blocks unauthorized pause from non-main group', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(
        createMockTask({ group_folder: 'main' }),
      );

      await processTaskIpc(
        { type: 'pause_task', taskId: 'task-1' },
        'other',
        false,
        deps,
      );

      expect(updateTask).not.toHaveBeenCalled();
    });

    it('main group can pause any task', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(
        createMockTask({ group_folder: 'other' }),
      );

      await processTaskIpc(
        { type: 'pause_task', taskId: 'task-1' },
        'main',
        true,
        deps,
      );

      expect(updateTask).toHaveBeenCalledWith('task-1', { status: 'paused' });
    });
  });

  describe('resume_task', () => {
    it('resumes a task when authorized', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(
        createMockTask({ group_folder: 'main', status: 'paused' }),
      );

      await processTaskIpc(
        { type: 'resume_task', taskId: 'task-1' },
        'main',
        false,
        deps,
      );

      expect(updateTask).toHaveBeenCalledWith('task-1', { status: 'active' });
    });

    it('blocks unauthorized resume from non-main group', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(
        createMockTask({ group_folder: 'main', status: 'paused' }),
      );

      await processTaskIpc(
        { type: 'resume_task', taskId: 'task-1' },
        'other',
        false,
        deps,
      );

      expect(updateTask).not.toHaveBeenCalled();
    });
  });

  describe('cancel_task', () => {
    it('cancels a task when authorized', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(
        createMockTask({ group_folder: 'main' }),
      );

      await processTaskIpc(
        { type: 'cancel_task', taskId: 'task-1' },
        'main',
        false,
        deps,
      );

      expect(deleteTask).toHaveBeenCalledWith('task-1');
    });

    it('blocks unauthorized cancel from non-main group', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(
        createMockTask({ group_folder: 'main' }),
      );

      await processTaskIpc(
        { type: 'cancel_task', taskId: 'task-1' },
        'other',
        false,
        deps,
      );

      expect(deleteTask).not.toHaveBeenCalled();
    });
  });

  describe('update_task', () => {
    it('updates task when authorized', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(
        createMockTask({ group_folder: 'main', prompt: 'Old prompt' }),
      );

      await processTaskIpc(
        {
          type: 'update_task',
          taskId: 'task-1',
          prompt: 'New prompt',
        },
        'main',
        false,
        deps,
      );

      expect(updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ prompt: 'New prompt' }),
      );
    });

    it('updates schedule and recomputes next_run', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(createMockTask());

      await processTaskIpc(
        {
          type: 'update_task',
          taskId: 'task-1',
          schedule_type: 'interval',
          schedule_value: '3600000',
        },
        'main',
        true,
        deps,
      );

      expect(updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          schedule_type: 'interval',
          schedule_value: '3600000',
        }),
      );
    });

    it('blocks unauthorized update from non-main group', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(
        createMockTask({ group_folder: 'main' }),
      );

      await processTaskIpc(
        {
          type: 'update_task',
          taskId: 'task-1',
          prompt: 'New prompt',
        },
        'other',
        false,
        deps,
      );

      expect(updateTask).not.toHaveBeenCalled();
    });

    it('warns when task not found', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(undefined);

      await processTaskIpc(
        {
          type: 'update_task',
          taskId: 'nonexistent',
          prompt: 'New prompt',
        },
        'main',
        true,
        deps,
      );

      expect(updateTask).not.toHaveBeenCalled();
    });
  });

  describe('refresh_groups', () => {
    it('refreshes groups when called by main group', async () => {
      const deps = createMockDeps();
      mockGetAvailableGroups.mockReturnValue([]);

      await processTaskIpc({ type: 'refresh_groups' }, 'main', true, deps);

      expect(mockSyncGroups).toHaveBeenCalledWith(true);
      expect(mockWriteGroupsSnapshot).toHaveBeenCalled();
    });

    it('blocks refresh_groups from non-main group', async () => {
      const deps = createMockDeps();

      await processTaskIpc({ type: 'refresh_groups' }, 'other', false, deps);

      expect(mockSyncGroups).not.toHaveBeenCalled();
    });
  });

  describe('register_group', () => {
    it('registers a group when called by main group', async () => {
      const deps = createMockDeps();

      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'new-group@g.us',
          name: 'New Group',
          folder: 'new-group',
          trigger: '/',
        },
        'main',
        true,
        deps,
      );

      expect(mockRegisterGroup).toHaveBeenCalledWith('new-group@g.us', {
        name: 'New Group',
        folder: 'new-group',
        trigger: '/',
        added_at: expect.any(String),
        containerConfig: undefined,
        requiresTrigger: undefined,
      });
    });

    it('blocks register_group from non-main group', async () => {
      const deps = createMockDeps();

      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'new-group@g.us',
          name: 'New Group',
          folder: 'new-group',
          trigger: '/',
        },
        'other',
        false,
        deps,
      );

      expect(mockRegisterGroup).not.toHaveBeenCalled();
    });

    it('rejects invalid folder names', async () => {
      const deps = createMockDeps();
      vi.mocked(isValidGroupFolder).mockReturnValue(false);

      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'new-group@g.us',
          name: 'New Group',
          folder: '../etc',
          trigger: '/',
        },
        'main',
        true,
        deps,
      );

      expect(mockRegisterGroup).not.toHaveBeenCalled();
    });

    it('rejects missing required fields', async () => {
      const deps = createMockDeps();

      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'new-group@g.us',
          name: 'New Group',
        },
        'main',
        true,
        deps,
      );

      expect(mockRegisterGroup).not.toHaveBeenCalled();
    });
  });

  describe('deploy_channel', () => {
    it('calls applyYamlToK8s when called by main group', async () => {
      const { jobRunner } = await import('./job-runner.js');
      const deps = createMockDeps();

      await processTaskIpc(
        { type: 'deploy_channel', yaml: 'apiVersion: apps/v1\nkind: Deployment\n' },
        'main',
        true,
        deps,
      );

      expect(jobRunner.applyYamlToK8s).toHaveBeenCalledWith(
        'apiVersion: apps/v1\nkind: Deployment\n',
      );
    });

    it('blocks deploy_channel from non-main group', async () => {
      const { jobRunner } = await import('./job-runner.js');
      const deps = createMockDeps();

      await processTaskIpc(
        { type: 'deploy_channel', yaml: 'apiVersion: apps/v1\nkind: Deployment\n' },
        'some-group',
        false,
        deps,
      );

      expect(jobRunner.applyYamlToK8s).not.toHaveBeenCalled();
    });

    it('does nothing when yaml is missing', async () => {
      const { jobRunner } = await import('./job-runner.js');
      const deps = createMockDeps();

      await processTaskIpc(
        { type: 'deploy_channel' },
        'main',
        true,
        deps,
      );

      expect(jobRunner.applyYamlToK8s).not.toHaveBeenCalled();
    });

    it('logs error when applyYamlToK8s throws', async () => {
      const { jobRunner } = await import('./job-runner.js');
      vi.mocked(jobRunner.applyYamlToK8s).mockRejectedValueOnce(new Error('K8s error'));
      const { logger } = await import('../logger.js');
      const deps = createMockDeps();

      await processTaskIpc(
        { type: 'deploy_channel', yaml: 'kind: Deployment' },
        'main',
        true,
        deps,
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Failed to apply channel deployment',
      );
    });
  });

  describe('unknown type', () => {
    it('logs warning for unknown IPC type', async () => {
      const deps = createMockDeps();

      await processTaskIpc({ type: 'unknown_type' as any }, 'main', true, deps);

      expect(createTask).not.toHaveBeenCalled();
    });
  });

  describe('update_task — cron recompute', () => {
    it('recomputes next_run when schedule changes to cron', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(
        createMockTask({ group_folder: 'main', schedule_type: 'interval', schedule_value: '60000' }),
      );
      // Reset to default cron parser mock
      vi.mocked(CronExpressionParser.parse).mockReturnValue({
        next: vi.fn().mockReturnValue({ toISOString: vi.fn().mockReturnValue('2025-06-01T00:00:00.000Z') }),
      } as any);

      await processTaskIpc(
        { type: 'update_task', taskId: 'task-1', schedule_type: 'cron', schedule_value: '0 9 * * *' },
        'main',
        true,
        deps,
      );

      expect(updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ next_run: '2025-06-01T00:00:00.000Z' }),
      );
    });

    it('aborts update when new cron expression is invalid', async () => {
      const deps = createMockDeps();
      vi.mocked(getTaskById).mockReturnValue(createMockTask());
      vi.mocked(CronExpressionParser.parse).mockImplementationOnce(() => {
        throw new Error('bad cron');
      });

      await processTaskIpc(
        { type: 'update_task', taskId: 'task-1', schedule_type: 'cron', schedule_value: 'INVALID' },
        'main',
        true,
        deps,
      );

      expect(updateTask).not.toHaveBeenCalled();
    });
  });

  describe('tool_pod_request', () => {
    it('creates a tool pod and sends ack', async () => {
      const { jobRunner } = await import('./job-runner.js');
      const deps = createMockDeps();

      await processTaskIpc(
        {
          type: 'tool_pod_request',
          agentJobId: 'agent-job-1',
          category: 'execution',
          groupFolder: 'my-group',
        },
        'main',
        true,
        deps,
      );

      expect(jobRunner.createToolPodJob).toHaveBeenCalledWith(
        expect.objectContaining({ agentJobId: 'agent-job-1', category: 'execution' }),
      );
      expect(mockXadd).toHaveBeenCalledWith(
        'kubeclaw:input:agent-job-1',
        '*',
        'type', 'tool_pod_ack',
        'category', 'execution',
        'podJobId', 'nc-test-pod-abc123',
      );
    });

    it('skips when required fields are missing', async () => {
      const { jobRunner } = await import('./job-runner.js');
      const deps = createMockDeps();

      await processTaskIpc(
        { type: 'tool_pod_request', agentJobId: 'agent-job-1' },
        'main',
        true,
        deps,
      );

      expect(jobRunner.createToolPodJob).not.toHaveBeenCalled();
    });
  });
});

describe('cleanupToolPods', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when no pods are tracked for the job', async () => {
    const { jobRunner } = await import('./job-runner.js');
    await cleanupToolPods('nonexistent-job');
    expect(jobRunner.stopJob).not.toHaveBeenCalled();
  });

  it('stops all tracked tool pods and removes them from the map', async () => {
    const { jobRunner } = await import('./job-runner.js');
    const deps = createMockDeps();

    // Create a tool pod via processTaskIpc so it gets tracked
    await processTaskIpc(
      {
        type: 'tool_pod_request',
        agentJobId: 'tracked-job',
        category: 'browser',
        groupFolder: 'g',
      },
      'main',
      true,
      deps,
    );

    await cleanupToolPods('tracked-job');
    expect(jobRunner.stopJob).toHaveBeenCalledWith('nc-test-pod-abc123');

    // Second cleanup should be a no-op (already deleted from map)
    vi.mocked(jobRunner.stopJob).mockClear();
    await cleanupToolPods('tracked-job');
    expect(jobRunner.stopJob).not.toHaveBeenCalled();
  });
});

describe('startIpcWatcher', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    subscriberOnRef.messageHandler = null;
    await stopIpcWatcher(); // reset ipcWatcherRunning to false
  });

  afterEach(async () => {
    await stopIpcWatcher();
    vi.restoreAllMocks();
  });

  it('does nothing if already running (second call is a no-op)', () => {
    const deps = createMockDeps();
    mockRegisteredGroups.mockReturnValue({});
    startIpcWatcher(deps);
    startIpcWatcher(deps); // second call — no crash
  });

  it('subscribes to channels for existing registered groups', () => {
    mockRegisteredGroups.mockReturnValue({
      'jid@g.us': { name: 'Main', folder: 'main', isMain: true, trigger: '', added_at: '' },
    });
    startIpcWatcher(createMockDeps());
    expect(mockSubscribe).toHaveBeenCalledWith(
      'kubeclaw:messages:main',
      'kubeclaw:tasks:main',
      expect.any(Function),
    );
  });

  it('delivers message to the correct JID via sendMessage', async () => {
    const deps = createMockDeps();
    mockRegisteredGroups.mockReturnValue({
      'jid@g.us': { name: 'Main', folder: 'main', isMain: true, trigger: '', added_at: '' },
    });
    startIpcWatcher(deps);

    expect(subscriberOnRef.messageHandler).not.toBeNull();

    // Simulate an inbound Redis pub/sub message
    subscriberOnRef.messageHandler!(
      'kubeclaw:messages:main',
      JSON.stringify({ type: 'message', chatJid: 'jid@g.us', text: 'hello from agent' }),
    );
    await Promise.resolve(); // let async processMessage run

    expect(mockSendMessage).toHaveBeenCalledWith('jid@g.us', 'hello from agent');
  });

  it('blocks unauthorized message from non-main group targeting another group', async () => {
    const deps = createMockDeps();
    mockRegisteredGroups.mockReturnValue({
      'jid@g.us': { name: 'Main', folder: 'main', isMain: false, trigger: '', added_at: '' },
      'other@g.us': { name: 'Other', folder: 'other', isMain: false, trigger: '', added_at: '' },
    });
    startIpcWatcher(deps);

    subscriberOnRef.messageHandler!(
      'kubeclaw:messages:other',
      JSON.stringify({ type: 'message', chatJid: 'jid@g.us', text: 'sneaky' }),
    );
    await Promise.resolve();

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('handles unknown channel pattern gracefully', () => {
    mockRegisteredGroups.mockReturnValue({});
    startIpcWatcher(createMockDeps());
    // Send message on unknown channel — should not crash
    subscriberOnRef.messageHandler?.('unknown:channel:foo', 'data');
  });

  it('handles malformed JSON in message without crashing', async () => {
    mockRegisteredGroups.mockReturnValue({
      'jid@g.us': { name: 'G', folder: 'g', trigger: '', added_at: '' },
    });
    startIpcWatcher(createMockDeps());
    subscriberOnRef.messageHandler!('kubeclaw:messages:g', 'not-json{{{');
    await Promise.resolve(); // should not throw
  });
});

describe('sendMessageToAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a message to agent via Redis stream', async () => {
    await sendMessageToAgent('job-123', 'Hello agent');

    expect(mockXadd).toHaveBeenCalledWith(
      'kubeclaw:input:job-123',
      '*',
      'type',
      'message',
      'text',
      'Hello agent',
    );
  });

  it('throws error when xadd fails', async () => {
    mockXadd.mockRejectedValueOnce(new Error('Redis error'));

    await expect(sendMessageToAgent('job-123', 'Hello')).rejects.toThrow(
      'Redis error',
    );
  });
});

describe('sendCloseSignal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends close signal to agent via Redis stream', async () => {
    await sendCloseSignal('job-123');

    expect(mockXadd).toHaveBeenCalledWith(
      'kubeclaw:input:job-123',
      '*',
      'type',
      'close',
    );
  });

  it('throws error when xadd fails', async () => {
    mockXadd.mockRejectedValueOnce(new Error('Redis error'));

    await expect(sendCloseSignal('job-123')).rejects.toThrow('Redis error');
  });
});

describe('stopIpcWatcher', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await stopIpcWatcher(); // ensure clean state
  });

  it('cleans up subscribers registered by startIpcWatcher', async () => {
    mockRegisteredGroups.mockReturnValue({});
    startIpcWatcher(createMockDeps()); // registers a subscriber
    await stopIpcWatcher();
    expect(mockUnsubscribe).toHaveBeenCalled();
    expect(mockQuit).toHaveBeenCalled();
  });

  it('handles errors during subscriber cleanup without throwing', async () => {
    mockRegisteredGroups.mockReturnValue({});
    startIpcWatcher(createMockDeps());
    mockUnsubscribe.mockRejectedValueOnce(new Error('unsub error'));
    await expect(stopIpcWatcher()).resolves.toBeUndefined();
  });
});

describe('startToolPodSpawnWatcher', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await stopIpcWatcher();
    mockRegisteredGroups.mockReturnValue({});
  });

  afterEach(async () => {
    await stopIpcWatcher();
  });

  it('processes a spawn-tool-pod message and creates a tool pod', async () => {
    const { jobRunner } = await import('./job-runner.js');
    startIpcWatcher(createMockDeps()); // sets ipcWatcherRunning = true

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-tool-pod',
            [['1-0', ['agentJobId', 'j1', 'groupFolder', 'g', 'category', 'execution', 'timeout', '60000', 'channel', 'telegram']]],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startToolPodSpawnWatcher();

    expect(jobRunner.createToolPodJob).toHaveBeenCalledWith(
      expect.objectContaining({
        agentJobId: 'j1',
        category: 'execution',
        groupsPvc: 'kubeclaw-channel-telegram-groups',
        sessionsPvc: 'kubeclaw-channel-telegram-sessions',
      }),
    );
  });

  it('skips messages missing required fields', async () => {
    const { jobRunner } = await import('./job-runner.js');
    startIpcWatcher(createMockDeps());

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        // Missing agentJobId and category
        return [['kubeclaw:spawn-tool-pod', [['1-0', ['groupFolder', 'g']]]]];
      }
      await stopIpcWatcher();
      return null;
    });

    await startToolPodSpawnWatcher();
    expect(jobRunner.createToolPodJob).not.toHaveBeenCalled();
  });

  it('uses default PVC names when channel is empty', async () => {
    const { jobRunner } = await import('./job-runner.js');
    startIpcWatcher(createMockDeps());

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-tool-pod',
            [['1-0', ['agentJobId', 'j2', 'groupFolder', 'g', 'category', 'browser', 'timeout', '30000']]],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startToolPodSpawnWatcher();
    expect(jobRunner.createToolPodJob).toHaveBeenCalledWith(
      expect.objectContaining({
        groupsPvc: 'kubeclaw-groups',
        sessionsPvc: 'kubeclaw-sessions',
      }),
    );
  });

  it('exits immediately when ipcWatcherRunning is false', async () => {
    // ipcWatcherRunning is false after stopIpcWatcher (called in beforeEach)
    await startToolPodSpawnWatcher();
    expect(mockXread).not.toHaveBeenCalled();
  });

  it('routes to createSidecarToolPodJob when toolImage field is present', async () => {
    const { jobRunner } = await import('./job-runner.js');
    startIpcWatcher(createMockDeps());

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-tool-pod',
            [['1-0', [
              'agentJobId', 'j-sidecar',
              'groupFolder', 'my-group',
              'category', 'home_control',
              'timeout', '60000',
              'channel', 'telegram',
              'toolImage', 'my-ha:latest',
              'toolPattern', 'http',
              'toolPort', '8080',
            ]]],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startToolPodSpawnWatcher();

    expect(jobRunner.createSidecarToolPodJob).toHaveBeenCalledWith(
      expect.objectContaining({
        agentJobId: 'j-sidecar',
        groupFolder: 'my-group',
        toolName: 'home_control',
        toolSpec: expect.objectContaining({
          image: 'my-ha:latest',
          pattern: 'http',
          port: 8080,
        }),
        timeout: 60000,
      }),
    );
    expect(jobRunner.createToolPodJob).not.toHaveBeenCalled();
  });

  it('falls through to createToolPodJob when no toolImage field', async () => {
    const { jobRunner } = await import('./job-runner.js');
    startIpcWatcher(createMockDeps());

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-tool-pod',
            [['1-0', ['agentJobId', 'j-regular', 'groupFolder', 'g', 'category', 'execution', 'timeout', '60000']]],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startToolPodSpawnWatcher();

    expect(jobRunner.createToolPodJob).toHaveBeenCalled();
    expect(jobRunner.createSidecarToolPodJob).not.toHaveBeenCalled();
  });
});

describe('startAgentJobSpawnWatcher', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await stopIpcWatcher();
    mockRegisteredGroups.mockReturnValue({});
    // Re-establish mock implementations that clearAllMocks may have cleared
    mockXadd.mockResolvedValue('mock-id');
    mockXread.mockResolvedValue(null);
    const { jobRunner } = await import('./job-runner.js');
    vi.mocked(jobRunner.runAgentJob).mockResolvedValue({ status: 'success', result: 'ok' });
  });

  afterEach(async () => {
    await stopIpcWatcher();
  });

  it('processes a spawn-agent-job message and writes result to stream', async () => {
    startIpcWatcher(createMockDeps()); // sets ipcWatcherRunning = true

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-agent-job',
            [['2-0', ['agentJobId', 'aj1', 'groupFolder', 'gf', 'chatJid', 'jid@g.us', 'prompt', 'do stuff', 'channel', 'discord']]],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    const { jobRunner: jrImported } = await import('./job-runner.js');

    await startAgentJobSpawnWatcher();

    // Give fire-and-forget .then() time to settle
    await new Promise((r) => setTimeout(r, 20));

    expect(jrImported.runAgentJob).toHaveBeenCalled();
    // The .then() handler writes the result to the result stream
    expect(mockXadd).toHaveBeenCalledWith(
      'kubeclaw:agent-job-result:aj1',
      '*',
      'result', 'ok',
      'status', 'success',
    );
  });

  it('skips messages missing required fields', async () => {
    const { jobRunner } = await import('./job-runner.js');

    startIpcWatcher(createMockDeps());

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [['kubeclaw:spawn-agent-job', [['2-0', ['agentJobId', 'aj2']]]]];
      }
      await stopIpcWatcher();
      return null;
    });

    await startAgentJobSpawnWatcher();
    expect(jobRunner.runAgentJob).not.toHaveBeenCalled();
  });

  it('exits immediately when ipcWatcherRunning is false', async () => {
    await startAgentJobSpawnWatcher();
    expect(mockXread).not.toHaveBeenCalled();
  });
});
