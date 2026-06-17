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

  // ref to capture the 'message'/'pmessage' event handlers registered by the watchers
  const subscriberOnRef: {
    messageHandler: ((ch: string, msg: string) => void) | null;
    pmessageHandler:
      | ((pattern: string, ch: string, msg: string) => void)
      | null;
  } = {
    messageHandler: null,
    pmessageHandler: null,
  };

  const createMockRedis = () => ({
    xadd: mockXadd,
    subscribe: mockSubscribe,
    psubscribe: vi.fn((_pattern: string, cb?: (err: unknown) => void) => {
      cb?.(null);
    }),
    unsubscribe: mockUnsubscribe,
    quit: mockQuit,
    on: vi.fn((event: string, cb: unknown) => {
      if (event === 'message')
        subscriberOnRef.messageHandler = cb as (
          ch: string,
          msg: string,
        ) => void;
      if (event === 'pmessage')
        subscriberOnRef.pmessageHandler = cb as (
          pattern: string,
          ch: string,
          msg: string,
        ) => void;
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
  TIMEZONE: 'UTC',
  CONTAINER_TIMEOUT: 1800000,
  IDLE_TIMEOUT: 1800000,
  ASSISTANT_NAME: 'TestBot',
}));

vi.mock('./job-runner.js', () => ({
  jobRunner: {
    createSidecarToolPodJob: vi
      .fn()
      .mockResolvedValue('kubeclaw-stool-abc-tool'),
    stopJob: vi.fn().mockResolvedValue(undefined),
    runToolJob: vi.fn().mockResolvedValue({ status: 'success', result: 'ok' }),
    applyYamlToK8s: vi.fn().mockResolvedValue(undefined),
    getJobLogs: vi.fn().mockResolvedValue('log output'),
  },
}));

vi.mock('../db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  getTasksForGroup: vi.fn().mockReturnValue([]),
  getAllRegisteredGroups: vi.fn().mockReturnValue({}),
  updateTask: vi.fn(),
  getToolJobByIdForGroup: vi.fn().mockReturnValue(null),
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
    psubscribe: vi.fn((_pattern: string, cb?: (err: unknown) => void) => {
      cb?.(null);
    }),
    unsubscribe: mockUnsubscribe,
    quit: mockQuit,
    on: vi.fn((event: string, cb: unknown) => {
      if (event === 'message')
        subscriberOnRef.messageHandler = cb as (
          ch: string,
          msg: string,
        ) => void;
      if (event === 'pmessage')
        subscriberOnRef.pmessageHandler = cb as (
          pattern: string,
          ch: string,
          msg: string,
        ) => void;
    }),
  })),
  // Dedicated stream-watcher connection — same mock shape as the shared client.
  getRedisStreamWatcher: vi.fn(() => ({
    xadd: mockXadd,
    xread: mockXread,
    xrevrange: vi.fn().mockResolvedValue([]),
  })),
  // Each blocking-XREAD watcher gets its own fresh connection via this factory.
  createStreamWatcherClient: vi.fn(() => ({
    xadd: mockXadd,
    xread: mockXread,
    xrevrange: vi.fn().mockResolvedValue([]),
  })),
  getOutputChannel: vi.fn((folder: string) => `kubeclaw:messages:${folder}`),
  getTaskChannel: vi.fn((folder: string) => `kubeclaw:tasks:${folder}`),
  getInputStream: vi.fn((jobId: string) => `kubeclaw:input:${jobId}`),
  getSpawnToolPodStream: vi.fn(() => 'kubeclaw:spawn-tool-pod'),
  getSpawnToolJobStream: vi.fn(() => 'kubeclaw:spawn-agent-job'),
  getTaskRequestStream: vi.fn(() => 'kubeclaw:task-requests'),
  getToolJobResultStream: vi.fn(
    (id: string) => `kubeclaw:agent-job-result:${id}`,
  ),
  getControlChannel: vi.fn(
    (name: string) => `kubeclaw:control:${name}`,
  ),
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

vi.mock('../capabilities/index.js', () => ({
  installCapability: vi.fn().mockResolvedValue(undefined),
  removeCapability: vi.fn().mockResolvedValue(undefined),
  listCapabilities: vi.fn().mockReturnValue([]),
}));

import { CronExpressionParser } from 'cron-parser';
import {
  createTask,
  deleteTask,
  getAllRegisteredGroups,
  getTaskById,
  updateTask,
} from '../db.js';
import { isValidGroupFolder } from '../group-folder.js';
import {
  installCapability,
  removeCapability,
  listCapabilities,
} from '../capabilities/index.js';
import {
  startIpcWatcher,
  stopIpcWatcher,
  sendMessageToAgent,
  sendCloseSignal,
  processTaskIpc,
  cleanupToolPods,
  startToolPodSpawnWatcher,
  startToolJobSpawnWatcher,
  startTaskRequestWatcher,
  startBootstrapTaskWatcher,
  currentStepByJob,
  pendingBootstrapQuestionByJob,
  registerBootstrapSsePublisher,
  startControlChannelWatcher,
} from './ipc-redis.js';
import { getToolJobByIdForGroup } from '../db.js';
import { jobRunner } from './job-runner.js';
import { logger } from '../logger.js';
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
        {
          type: 'deploy_channel',
          yaml: 'apiVersion: apps/v1\nkind: Deployment\n',
        },
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
        {
          type: 'deploy_channel',
          yaml: 'apiVersion: apps/v1\nkind: Deployment\n',
        },
        'some-group',
        false,
        deps,
      );

      expect(jobRunner.applyYamlToK8s).not.toHaveBeenCalled();
    });

    it('does nothing when yaml is missing', async () => {
      const { jobRunner } = await import('./job-runner.js');
      const deps = createMockDeps();

      await processTaskIpc({ type: 'deploy_channel' }, 'main', true, deps);

      expect(jobRunner.applyYamlToK8s).not.toHaveBeenCalled();
    });

    it('logs error when applyYamlToK8s throws', async () => {
      const { jobRunner } = await import('./job-runner.js');
      vi.mocked(jobRunner.applyYamlToK8s).mockRejectedValueOnce(
        new Error('K8s error'),
      );
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

  describe('install_capability', () => {
    it('calls installCapability when authorized', async () => {
      const spec = {
        name: 'my-mcp',
        kind: 'mcp',
        image: 'ghcr.io/example/mcp:latest',
      };
      const deps = createMockDeps();

      await processTaskIpc(
        { type: 'install_capability', spec: JSON.stringify(spec) },
        'main',
        true,
        deps,
      );

      expect(installCapability).toHaveBeenCalledWith(spec);
    });

    it('blocks install_capability from non-main group', async () => {
      const spec = { name: 'my-mcp', kind: 'mcp', image: 'img:latest' };
      const deps = createMockDeps();

      await processTaskIpc(
        { type: 'install_capability', spec: JSON.stringify(spec) },
        'other-group',
        false,
        deps,
      );

      expect(installCapability).not.toHaveBeenCalled();
    });

    it('logs error when installCapability throws', async () => {
      vi.mocked(installCapability).mockRejectedValueOnce(
        new Error('install error'),
      );
      const { logger } = await import('../logger.js');
      const spec = { name: 'bad', kind: 'mcp', image: 'img:latest' };
      const deps = createMockDeps();

      await processTaskIpc(
        { type: 'install_capability', spec: JSON.stringify(spec) },
        'main',
        true,
        deps,
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Failed to install capability',
      );
    });
  });

  describe('remove_capability', () => {
    it('calls removeCapability when authorized', async () => {
      const deps = createMockDeps();

      await processTaskIpc(
        { type: 'remove_capability', name: 'my-mcp' },
        'main',
        true,
        deps,
      );

      expect(removeCapability).toHaveBeenCalledWith('my-mcp');
    });

    it('blocks remove_capability from non-main group', async () => {
      const deps = createMockDeps();

      await processTaskIpc(
        { type: 'remove_capability', name: 'my-mcp' },
        'other-group',
        false,
        deps,
      );

      expect(removeCapability).not.toHaveBeenCalled();
    });

    it('does nothing when name is missing', async () => {
      const deps = createMockDeps();

      await processTaskIpc({ type: 'remove_capability' }, 'main', true, deps);

      expect(removeCapability).not.toHaveBeenCalled();
    });
  });

  describe('list_capabilities', () => {
    it('writes capabilities to resultStream when provided', async () => {
      const caps = [{ name: 'my-mcp', kind: 'mcp' }];
      vi.mocked(listCapabilities).mockReturnValueOnce(caps as any);
      const deps = createMockDeps();

      await processTaskIpc(
        { type: 'list_capabilities', resultStream: 'kubeclaw:result:abc' },
        'main',
        true,
        deps,
      );

      expect(listCapabilities).toHaveBeenCalled();
      expect(mockXadd).toHaveBeenCalledWith(
        'kubeclaw:result:abc',
        '*',
        'result',
        JSON.stringify(caps),
        'status',
        'success',
      );
    });

    it('does not write to stream when resultStream is absent', async () => {
      mockXadd.mockClear();
      const deps = createMockDeps();

      await processTaskIpc({ type: 'list_capabilities' }, 'main', true, deps);

      expect(listCapabilities).toHaveBeenCalled();
      expect(mockXadd).not.toHaveBeenCalled();
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
        createMockTask({
          group_folder: 'main',
          schedule_type: 'interval',
          schedule_value: '60000',
        }),
      );
      // Reset to default cron parser mock
      vi.mocked(CronExpressionParser.parse).mockReturnValue({
        next: vi.fn().mockReturnValue({
          toISOString: vi.fn().mockReturnValue('2025-06-01T00:00:00.000Z'),
        }),
      } as any);

      await processTaskIpc(
        {
          type: 'update_task',
          taskId: 'task-1',
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
        },
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
        {
          type: 'update_task',
          taskId: 'task-1',
          schedule_type: 'cron',
          schedule_value: 'INVALID',
        },
        'main',
        true,
        deps,
      );

      expect(updateTask).not.toHaveBeenCalled();
    });
  });

  describe('tool_pod_request', () => {
    it('is now ignored (message type retired — no tool pod created, no ack sent)', async () => {
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

      expect(mockXadd).not.toHaveBeenCalledWith(
        'kubeclaw:input:agent-job-1',
        '*',
        'type',
        'tool_pod_ack',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
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
      'jid@g.us': {
        name: 'Main',
        folder: 'main',
        isMain: true,
        trigger: '',
        added_at: '',
      },
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
      'jid@g.us': {
        name: 'Main',
        folder: 'main',
        isMain: true,
        trigger: '',
        added_at: '',
      },
    });
    startIpcWatcher(deps);

    expect(subscriberOnRef.messageHandler).not.toBeNull();

    // Simulate an inbound Redis pub/sub message
    subscriberOnRef.messageHandler!(
      'kubeclaw:messages:main',
      JSON.stringify({
        type: 'message',
        chatJid: 'jid@g.us',
        text: 'hello from agent',
      }),
    );
    await Promise.resolve(); // let async processMessage run

    expect(mockSendMessage).toHaveBeenCalledWith(
      'jid@g.us',
      'hello from agent',
    );
  });

  it('blocks unauthorized message from non-main group targeting another group', async () => {
    const deps = createMockDeps();
    mockRegisteredGroups.mockReturnValue({
      'jid@g.us': {
        name: 'Main',
        folder: 'main',
        isMain: false,
        trigger: '',
        added_at: '',
      },
      'other@g.us': {
        name: 'Other',
        folder: 'other',
        isMain: false,
        trigger: '',
        added_at: '',
      },
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

  // ── Story 37 AC4: persist interruption notices ────────────────────────────

  it('AC4: calls storeBotMessage when message has persist:true and noticeId', async () => {
    const mockStoreBotMessage = vi.fn();
    const deps = {
      ...createMockDeps(),
      storeBotMessage: mockStoreBotMessage,
    };
    mockRegisteredGroups.mockReturnValue({
      'http:alice': {
        name: 'Alice',
        folder: 'alice',
        isMain: true,
        trigger: '',
        added_at: '',
      },
    });
    startIpcWatcher(deps);

    subscriberOnRef.messageHandler!(
      'kubeclaw:messages:alice',
      JSON.stringify({
        type: 'message',
        chatJid: 'http:alice',
        text: 'Tool job interrupted: ...',
        persist: true,
        noticeId: 'orphan-notice-job123',
      }),
    );
    await Promise.resolve();

    // storeBotMessage must be called BEFORE sendMessage (AC4)
    expect(mockStoreBotMessage).toHaveBeenCalledWith(
      'http:alice',
      'Tool job interrupted: ...',
      'orphan-notice-job123',
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      'http:alice',
      'Tool job interrupted: ...',
    );
  });

  it('AC4: does NOT call storeBotMessage for regular messages (persist not set)', async () => {
    const mockStoreBotMessage = vi.fn();
    const deps = {
      ...createMockDeps(),
      storeBotMessage: mockStoreBotMessage,
    };
    mockRegisteredGroups.mockReturnValue({
      'http:alice': {
        name: 'Alice',
        folder: 'alice',
        isMain: true,
        trigger: '',
        added_at: '',
      },
    });
    startIpcWatcher(deps);

    subscriberOnRef.messageHandler!(
      'kubeclaw:messages:alice',
      JSON.stringify({
        type: 'message',
        chatJid: 'http:alice',
        text: 'Regular bot response',
      }),
    );
    await Promise.resolve();

    expect(mockStoreBotMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalled();
  });

  it('AC4: delivers to SSE even when storeBotMessage throws', async () => {
    const mockStoreBotMessage = vi.fn().mockImplementation(() => {
      throw new Error('DB write failed');
    });
    const deps = {
      ...createMockDeps(),
      storeBotMessage: mockStoreBotMessage,
    };
    mockRegisteredGroups.mockReturnValue({
      'http:alice': {
        name: 'Alice',
        folder: 'alice',
        isMain: true,
        trigger: '',
        added_at: '',
      },
    });
    startIpcWatcher(deps);

    subscriberOnRef.messageHandler!(
      'kubeclaw:messages:alice',
      JSON.stringify({
        type: 'message',
        chatJid: 'http:alice',
        text: 'Tool job interrupted: ...',
        persist: true,
        noticeId: 'orphan-notice-job-fail',
      }),
    );
    await Promise.resolve();

    // sendMessage must still be called even though storeBotMessage threw
    expect(mockSendMessage).toHaveBeenCalledWith(
      'http:alice',
      'Tool job interrupted: ...',
    );
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

  it('routes places category to catalog path (createSidecarToolPodJob), not builtin', async () => {
    const { jobRunner } = await import('./job-runner.js');
    startIpcWatcher(createMockDeps());

    const toolSpec = {
      name: 'places_search',
      description: 'Search for places',
      parameters: { type: 'object', properties: {} },
      image: 'kubeclaw-places:latest',
      pattern: 'file' as const,
    };
    const resolveTool = vi.fn().mockReturnValue(toolSpec);

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-tool-pod',
            [
              [
                '1-0',
                [
                  'agentJobId',
                  'j-places',
                  'groupFolder',
                  'g',
                  'category',
                  'places',
                  'timeout',
                  '60000',
                  'channel',
                  'telegram',
                ],
              ],
            ],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startToolPodSpawnWatcher(resolveTool);

    expect(resolveTool).toHaveBeenCalledWith('places');
    expect(jobRunner.createSidecarToolPodJob).toHaveBeenCalledWith(
      expect.objectContaining({
        agentJobId: 'j-places',
        toolName: 'places',
        toolSpec: expect.objectContaining({ image: 'kubeclaw-places:latest' }),
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
    expect(jobRunner.createSidecarToolPodJob).not.toHaveBeenCalled();
  });

  it('exits immediately when ipcWatcherRunning is false', async () => {
    // ipcWatcherRunning is false after stopIpcWatcher (called in beforeEach)
    await startToolPodSpawnWatcher();
    expect(mockXread).not.toHaveBeenCalled();
  });

  it('resolves a catalog tool by name and spawns a sidecar pod', async () => {
    const { jobRunner } = await import('./job-runner.js');
    startIpcWatcher(createMockDeps());

    const toolSpec = {
      name: 'home_control',
      description: 'Control smart home devices',
      parameters: { type: 'object', properties: {} },
      image: 'my-ha:latest',
      pattern: 'http' as const,
      port: 8080,
    };
    const resolveTool = vi.fn().mockReturnValue(toolSpec);

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-tool-pod',
            [
              [
                '1-0',
                [
                  'agentJobId',
                  'j-sidecar',
                  'groupFolder',
                  'my-group',
                  'category',
                  'home_control',
                  'timeout',
                  '60000',
                  'channel',
                  'telegram',
                ],
              ],
            ],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startToolPodSpawnWatcher(resolveTool);

    expect(resolveTool).toHaveBeenCalledWith('home_control');
    expect(jobRunner.createSidecarToolPodJob).toHaveBeenCalledWith(
      expect.objectContaining({
        agentJobId: 'j-sidecar',
        groupFolder: 'my-group',
        toolName: 'home_control',
        toolSpec: expect.objectContaining({
          image: 'my-ha:latest',
          pattern: 'http',
        }),
        timeout: 60000,
      }),
    );
    // No error written
    expect(mockXadd).not.toHaveBeenCalledWith(
      expect.stringContaining('toolresults'),
      '*',
      'error',
      expect.any(String),
    );
  });

  it('rejects a tool not scoped to the requesting channel', async () => {
    const { jobRunner } = await import('./job-runner.js');
    startIpcWatcher(createMockDeps());

    // Spec with channels: ['other'] — not 'telegram'
    const toolSpec = {
      name: 'home_control',
      description: 'Control smart home',
      parameters: {},
      image: 'my-ha:latest',
      pattern: 'http' as const,
      channels: ['other'],
    };
    const resolveTool = vi.fn().mockReturnValue(toolSpec);

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-tool-pod',
            [
              [
                '1-0',
                [
                  'agentJobId',
                  'j-acl',
                  'groupFolder',
                  'g',
                  'category',
                  'home_control',
                  'timeout',
                  '60000',
                  'channel',
                  'telegram',
                ],
              ],
            ],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startToolPodSpawnWatcher(resolveTool);

    expect(jobRunner.createSidecarToolPodJob).not.toHaveBeenCalled();
    // An error result must be written to the tool-results stream
    expect(mockXadd).toHaveBeenCalledWith(
      'kubeclaw:toolresults:j-acl:home_control',
      '*',
      'error',
      'Tool home_control is not available on this channel',
    );
  });

  it('spawns a catalog tool with channels: [] on any channel (allow-all path)', async () => {
    // A tool spec with channels: [] (or no channels field) must be available on
    // every channel. The ACL check is `!spec.channels?.length` — an empty array
    // is falsy for `.length`, so the guard is skipped and the pod IS spawned.
    const { jobRunner } = await import('./job-runner.js');
    startIpcWatcher(createMockDeps());

    const toolSpec = {
      name: 'any_channel_tool',
      description: 'Available on all channels',
      parameters: { type: 'object', properties: {} },
      image: 'my-tool:latest',
      pattern: 'http' as const,
      port: 9000,
      channels: [], // empty array → allow-all
    };
    const resolveTool = vi.fn().mockReturnValue(toolSpec);

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-tool-pod',
            [
              [
                '1-0',
                [
                  'agentJobId',
                  'j-empty-channels',
                  'groupFolder',
                  'my-group',
                  'category',
                  'any_channel_tool',
                  'timeout',
                  '60000',
                  'channel',
                  'some-channel',
                ],
              ],
            ],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startToolPodSpawnWatcher(resolveTool);

    // Pod must be spawned
    expect(jobRunner.createSidecarToolPodJob).toHaveBeenCalledWith(
      expect.objectContaining({
        agentJobId: 'j-empty-channels',
        toolName: 'any_channel_tool',
      }),
    );
    // No error must be written
    expect(mockXadd).not.toHaveBeenCalledWith(
      expect.stringContaining('toolresults'),
      '*',
      'error',
      expect.any(String),
    );
  });

  it('writes an error result when the tool name is unknown', async () => {
    const { jobRunner } = await import('./job-runner.js');
    startIpcWatcher(createMockDeps());

    const resolveTool = vi.fn().mockReturnValue(undefined);

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-tool-pod',
            [
              [
                '1-0',
                [
                  'agentJobId',
                  'j-unknown',
                  'groupFolder',
                  'g',
                  'category',
                  'nonexistent_tool',
                  'timeout',
                  '60000',
                  'channel',
                  'telegram',
                ],
              ],
            ],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startToolPodSpawnWatcher(resolveTool);

    expect(jobRunner.createSidecarToolPodJob).not.toHaveBeenCalled();
    // An error result must be written to the tool-results stream
    expect(mockXadd).toHaveBeenCalledWith(
      'kubeclaw:toolresults:j-unknown:nonexistent_tool',
      '*',
      'error',
      'Unknown tool: nonexistent_tool',
    );
  });

  it('execution category is no longer builtin and is routed as unknown catalog tool', async () => {
    const { jobRunner } = await import('./job-runner.js');
    startIpcWatcher(createMockDeps());

    const resolveTool = vi.fn().mockReturnValue(undefined); // execution is not in catalog

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-tool-pod',
            [
              [
                '1-0',
                [
                  'agentJobId',
                  'j-exec',
                  'groupFolder',
                  'g',
                  'category',
                  'execution',
                  'timeout',
                  '60000',
                  'channel',
                  'http',
                ],
              ],
            ],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startToolPodSpawnWatcher(resolveTool);

    // execution is not a BUILTIN_CATEGORY anymore, so resolveTool is called
    expect(resolveTool).toHaveBeenCalledWith('execution');
    // resolveTool returns undefined → writeToolError is called, no pod is created
    expect(jobRunner.createSidecarToolPodJob).not.toHaveBeenCalled();
    expect(mockXadd).toHaveBeenCalledWith(
      'kubeclaw:toolresults:j-exec:execution',
      '*',
      'error',
      'Unknown tool: execution',
    );
  });

});

describe('startToolJobSpawnWatcher', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await stopIpcWatcher();
    mockRegisteredGroups.mockReturnValue({});
    // Re-establish mock implementations that clearAllMocks may have cleared
    mockXadd.mockResolvedValue('mock-id');
    mockXread.mockResolvedValue(null);
    const { jobRunner } = await import('./job-runner.js');
    vi.mocked(jobRunner.runToolJob).mockResolvedValue({
      status: 'success',
      result: 'ok',
    });
  });

  afterEach(async () => {
    await stopIpcWatcher();
  });

  it('processes a spawn-tool-job message and writes result to stream', async () => {
    startIpcWatcher(createMockDeps()); // sets ipcWatcherRunning = true

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-agent-job',
            [
              [
                '2-0',
                [
                  'agentJobId',
                  'aj1',
                  'groupFolder',
                  'gf',
                  'chatJid',
                  'jid@g.us',
                  'prompt',
                  'do stuff',
                  'channel',
                  'discord',
                ],
              ],
            ],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    const { jobRunner: jrImported } = await import('./job-runner.js');

    await startToolJobSpawnWatcher();

    // Give fire-and-forget .then() time to settle
    await new Promise((r) => setTimeout(r, 20));

    expect(jrImported.runToolJob).toHaveBeenCalled();
    // The .then() handler writes the result to the result stream
    expect(mockXadd).toHaveBeenCalledWith(
      'kubeclaw:agent-job-result:aj1',
      '*',
      'result',
      'ok',
      'status',
      'success',
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

    await startToolJobSpawnWatcher();
    expect(jobRunner.runToolJob).not.toHaveBeenCalled();
  });

  it('exits immediately when ipcWatcherRunning is false', async () => {
    await startToolJobSpawnWatcher();
    expect(mockXread).not.toHaveBeenCalled();
  });

  it('sends an end-of-input signal to kubeclaw:input:{jobName} via onProcess so the agent pod exits', async () => {
    // Regression test: startToolJobSpawnWatcher must pass an onProcess callback
    // to runToolJob. The callback writes type=eoi to kubeclaw:input:{jobName}
    // so the agent pod exits its follow-up wait loop after completing its work
    // (without aborting in-flight tool rounds). The K8s Job then reaches
    // Succeeded. Without this, waitForJobCompletion never resolves and the
    // result stream is never written.
    startIpcWatcher(createMockDeps());

    const capturedOnProcess: Array<(jobName: string) => void> = [];
    const { jobRunner: jrImported } = await import('./job-runner.js');
    vi.mocked(jrImported.runToolJob).mockImplementation(
      async (_group, _input, onProcess) => {
        if (onProcess) capturedOnProcess.push(onProcess);
        // Simulate the K8s Job creation firing onProcess immediately
        onProcess?.('nc-test-group-abc123');
        return { status: 'success', result: 'done' };
      },
    );

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:spawn-agent-job',
            [
              [
                '3-0',
                [
                  'agentJobId',
                  'close-test-aj',
                  'groupFolder',
                  'test-group',
                  'chatJid',
                  'test@g.us',
                  'prompt',
                  'say hi',
                  'channel',
                  'http',
                ],
              ],
            ],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startToolJobSpawnWatcher();
    // Allow the fire-and-forget callbacks to settle
    await new Promise((r) => setTimeout(r, 20));

    // Verify onProcess was registered and fired
    expect(capturedOnProcess).toHaveLength(1);

    // Verify the end-of-input signal was written to the correct input stream key
    expect(mockXadd).toHaveBeenCalledWith(
      'kubeclaw:input:nc-test-group-abc123',
      '*',
      'type',
      'eoi',
    );
  });
});

describe('startTaskRequestWatcher: group auto-registration', () => {
  // Regression test for: "Group not found for task" when the scheduler fires
  // a task created via the task-request stream for a group that was
  // auto-registered only in the channel pod's SQLite (never in the
  // orchestrator's registered_groups table).
  //
  // Fix: startTaskRequestWatcher calls deps.registerGroup when it processes
  // a schedule_task for a group folder not yet present in getAllRegisteredGroups().

  beforeEach(async () => {
    vi.clearAllMocks();
    await stopIpcWatcher();
    mockRegisteredGroups.mockReturnValue({});
    // Re-establish mock implementations that clearAllMocks may have cleared.
    mockXadd.mockResolvedValue('mock-id');
    mockXread.mockResolvedValue(null);
    // isValidGroupFolder may have been set to false by register_group tests;
    // reset it to true so group-folder validation passes in our tests.
    vi.mocked(isValidGroupFolder).mockReturnValue(true);
  });

  it('calls registerGroup for an unknown groupFolder on schedule_task', async () => {
    startIpcWatcher(createMockDeps());

    // getAllRegisteredGroups returns empty — group is unknown to the orchestrator
    (getAllRegisteredGroups as ReturnType<typeof vi.fn>).mockReturnValue({});

    const registerGroup = vi.fn();
    let callCount = 0;

    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:task-requests',
            [
              [
                '3-0',
                [
                  'type',
                  'schedule_task',
                  'groupFolder',
                  'http-http-alice',
                  'chatJid',
                  'http:alice',
                  'prompt',
                  'say hello',
                  'schedule_type',
                  'interval',
                  'schedule_value',
                  '60000',
                  'context_mode',
                  'isolated',
                ],
              ],
            ],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startTaskRequestWatcher({ registerGroup });

    expect(registerGroup).toHaveBeenCalledWith(
      'http:alice',
      expect.objectContaining({
        folder: 'http-http-alice',
        containerConfig: expect.objectContaining({ direct: true }),
      }),
    );
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ group_folder: 'http-http-alice' }),
    );
  });

  it('does not call registerGroup when groupFolder is already known', async () => {
    startIpcWatcher(createMockDeps());

    // getAllRegisteredGroups returns the group as already known
    (getAllRegisteredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
      'http:alice': {
        name: 'alice',
        folder: 'http-http-alice',
        trigger: '',
        added_at: '2026-01-01T00:00:00.000Z',
        containerConfig: { direct: true },
      },
    });

    const registerGroup = vi.fn();
    let callCount = 0;

    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return [
          [
            'kubeclaw:task-requests',
            [
              [
                '4-0',
                [
                  'type',
                  'schedule_task',
                  'groupFolder',
                  'http-http-alice',
                  'chatJid',
                  'http:alice',
                  'prompt',
                  'say hello again',
                  'schedule_type',
                  'interval',
                  'schedule_value',
                  '60000',
                  'context_mode',
                  'isolated',
                ],
              ],
            ],
          ],
        ];
      }
      await stopIpcWatcher();
      return null;
    });

    await startTaskRequestWatcher({ registerGroup });

    expect(registerGroup).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ group_folder: 'http-http-alice' }),
    );
  });
});

// ── Secret / catalog IPC handler tests ─────────────────────────────────────

import { registerSecretDeps, _testSetActiveAgentJob } from './ipc-redis.js';

/** Build a single-message XREAD response for the task-request stream. */
function makeTaskStreamMsg(
  id: string,
  fields: Record<string, string>,
): [string, [string, string[]]][] {
  const flatFields = Object.entries(fields).flat();
  return [['kubeclaw:task-requests', [[id, flatFields]]]];
}

describe('secret/catalog IPC handlers via startTaskRequestWatcher', () => {
  // Mock SecretManager and CatalogInformer
  const mockSetGroupSecret = vi.fn().mockResolvedValue(undefined);
  const mockDeleteGroupSecret = vi.fn().mockResolvedValue(undefined);
  const mockListGroupSecrets = vi
    .fn()
    .mockResolvedValue([
      { catalogId: 'replicate', registeredAt: '2026-05-16T00:00:00.000Z' },
    ]);
  const mockGetCatalog = vi.fn().mockReturnValue([
    {
      id: 'replicate',
      host: 'api.replicate.com',
      credentialFields: [{ name: 'token', envVar: 'REPLICATE_API_TOKEN' }],
    },
  ]);

  const fakeSecretManager = {
    setGroupSecret: mockSetGroupSecret,
    deleteGroupSecret: mockDeleteGroupSecret,
    listGroupSecrets: mockListGroupSecrets,
  } as any;

  const fakeCatalogInformer = {
    getCatalog: mockGetCatalog,
    getEntry: vi.fn(),
    sync: vi.fn(),
    start: vi.fn(),
  } as any;

  beforeEach(async () => {
    vi.clearAllMocks();
    await stopIpcWatcher();
    mockRegisteredGroups.mockReturnValue({});
    mockXadd.mockResolvedValue('mock-id');
    mockXread.mockResolvedValue(null);
    vi.mocked(isValidGroupFolder).mockReturnValue(true);

    // Register the mocked deps before each test
    registerSecretDeps(fakeSecretManager, fakeCatalogInformer);
  });

  afterEach(async () => {
    await stopIpcWatcher();
  });

  it('secret.add handler invokes SecretManager.setGroupSecret and returns { ok: true }', async () => {
    startIpcWatcher(createMockDeps());

    const resultStream = 'kubeclaw:secret-result:test-add';
    const fields = { token: 'r8_supersecret' };

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return makeTaskStreamMsg('10-0', {
          type: 'secret.add',
          groupFolder: 'family',
          group: 'family',
          catalogId: 'replicate',
          fields: JSON.stringify(fields),
          resultStream,
        });
      }
      await stopIpcWatcher();
      return null;
    });

    await startTaskRequestWatcher();

    expect(mockSetGroupSecret).toHaveBeenCalledWith(
      'family',
      'replicate',
      fields,
    );
    expect(mockXadd).toHaveBeenCalledWith(
      resultStream,
      '*',
      'result',
      JSON.stringify({ ok: true }),
    );
  });

  it('secret.add with unknown catalogId surfaces { ok: false, error }', async () => {
    startIpcWatcher(createMockDeps());

    mockSetGroupSecret.mockRejectedValueOnce(
      new Error('unknown_catalog_entry'),
    );

    const resultStream = 'kubeclaw:secret-result:test-add-fail';

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return makeTaskStreamMsg('11-0', {
          type: 'secret.add',
          groupFolder: 'family',
          group: 'family',
          catalogId: 'no-such-entry',
          fields: JSON.stringify({ token: 'abc' }),
          resultStream,
        });
      }
      await stopIpcWatcher();
      return null;
    });

    await startTaskRequestWatcher();

    expect(mockXadd).toHaveBeenCalledWith(
      resultStream,
      '*',
      'result',
      JSON.stringify({ ok: false, error: 'unknown_catalog_entry' }),
    );
  });

  it('secret.list handler returns metadata only (no values in payload)', async () => {
    startIpcWatcher(createMockDeps());

    const resultStream = 'kubeclaw:secret-result:test-list';

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return makeTaskStreamMsg('12-0', {
          type: 'secret.list',
          groupFolder: 'family',
          group: 'family',
          resultStream,
        });
      }
      await stopIpcWatcher();
      return null;
    });

    await startTaskRequestWatcher();

    expect(mockListGroupSecrets).toHaveBeenCalledWith('family');
    const expectedResult = [
      { catalogId: 'replicate', registeredAt: '2026-05-16T00:00:00.000Z' },
    ];
    expect(mockXadd).toHaveBeenCalledWith(
      resultStream,
      '*',
      'result',
      JSON.stringify({ ok: true, result: expectedResult }),
    );
    // Verify no 'value' or 'fields' property in the result payload
    const xaddCall = vi
      .mocked(mockXadd)
      .mock.calls.find((c) => c[0] === resultStream);
    const payload = JSON.parse(xaddCall![3] as string) as {
      ok: boolean;
      result: Array<Record<string, unknown>>;
    };
    expect(payload.ok).toBe(true);
    for (const entry of payload.result) {
      expect(entry).not.toHaveProperty('value');
      expect(entry).not.toHaveProperty('fields');
    }
  });

  it('catalog.list handler returns catalog entries', async () => {
    startIpcWatcher(createMockDeps());

    const resultStream = 'kubeclaw:secret-result:test-catalog';

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return makeTaskStreamMsg('13-0', {
          type: 'catalog.list',
          groupFolder: 'family',
          resultStream,
        });
      }
      await stopIpcWatcher();
      return null;
    });

    await startTaskRequestWatcher();

    expect(mockGetCatalog).toHaveBeenCalled();
    const expectedCatalog = [
      {
        id: 'replicate',
        host: 'api.replicate.com',
        credentialFields: [{ name: 'token', envVar: 'REPLICATE_API_TOKEN' }],
      },
    ];
    expect(mockXadd).toHaveBeenCalledWith(
      resultStream,
      '*',
      'result',
      JSON.stringify({ ok: true, result: expectedCatalog }),
    );
  });

  it('secret.remove handler invokes SecretManager.deleteGroupSecret and returns { ok: true }', async () => {
    startIpcWatcher(createMockDeps());

    const resultStream = 'kubeclaw:secret-result:test-remove';

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return makeTaskStreamMsg('14-0', {
          type: 'secret.remove',
          groupFolder: 'family',
          group: 'family',
          catalogId: 'replicate',
          resultStream,
        });
      }
      await stopIpcWatcher();
      return null;
    });

    await startTaskRequestWatcher();

    expect(mockDeleteGroupSecret).toHaveBeenCalledWith('family', 'replicate');
    expect(mockXadd).toHaveBeenCalledWith(
      resultStream,
      '*',
      'result',
      JSON.stringify({ ok: true }),
    );
  });
});

describe('startBootstrapTaskWatcher — bootstrap topic messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriberOnRef.pmessageHandler = null;
    currentStepByJob.clear();
    pendingBootstrapQuestionByJob.clear();
  });

  it('records a step label on a { type: "step" } message', () => {
    startBootstrapTaskWatcher();
    expect(subscriberOnRef.pmessageHandler).not.toBeNull();

    subscriberOnRef.pmessageHandler!(
      'kubeclaw:bootstrap:*',
      'kubeclaw:bootstrap:job-abc',
      JSON.stringify({ type: 'step', label: 'Installing packages' }),
    );

    expect(currentStepByJob.get('job-abc')?.label).toBe('Installing packages');
    expect(pendingBootstrapQuestionByJob.has('job-abc')).toBe(false);
  });

  it('records an unanswered question on a { type: "question" } message', () => {
    startBootstrapTaskWatcher();

    subscriberOnRef.pmessageHandler!(
      'kubeclaw:bootstrap:*',
      'kubeclaw:bootstrap:job-xyz',
      JSON.stringify({
        type: 'question',
        text: 'Which TCP port should the channel listen on? (1024-65535)',
      }),
    );

    expect(pendingBootstrapQuestionByJob.get('job-xyz')?.text).toBe(
      'Which TCP port should the channel listen on? (1024-65535)',
    );
    expect(currentStepByJob.has('job-xyz')).toBe(false);
  });

  it('ignores agent/progress messages that are neither step nor question', () => {
    startBootstrapTaskWatcher();

    subscriberOnRef.pmessageHandler!(
      'kubeclaw:bootstrap:*',
      'kubeclaw:bootstrap:job-1',
      JSON.stringify({ type: 'agent', text: 'Bootstrap started' }),
    );

    expect(currentStepByJob.has('job-1')).toBe(false);
    expect(pendingBootstrapQuestionByJob.has('job-1')).toBe(false);
  });
});

describe('startBootstrapTaskWatcher — bootstrap topic messages → SSE forwarding', () => {
  let capturedSseEvents: Array<{ type: string; text: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    subscriberOnRef.pmessageHandler = null;
    currentStepByJob.clear();
    pendingBootstrapQuestionByJob.clear();
    capturedSseEvents = [];
    registerBootstrapSsePublisher((type, text) => {
      capturedSseEvents.push({ type, text });
    });
  });

  afterEach(() => {
    // Reset to a no-op so the publisher does not bleed across test suites.
    registerBootstrapSsePublisher(() => {});
  });

  it('forwards a { type: "timeout" } message to the SSE publisher', () => {
    startBootstrapTaskWatcher();
    subscriberOnRef.pmessageHandler!(
      'kubeclaw:bootstrap:*',
      'kubeclaw:bootstrap:job-timeout-1',
      JSON.stringify({
        type: 'timeout',
        text: 'Bootstrap job-timeout-1 timed out; nothing was installed.',
      }),
    );

    expect(capturedSseEvents).toHaveLength(1);
    expect(capturedSseEvents[0].type).toBe('bootstrap');
    expect(capturedSseEvents[0].text).toContain('timed out; nothing was installed');
  });

  it('forwards a { type: "step" } message to the SSE publisher', () => {
    startBootstrapTaskWatcher();
    subscriberOnRef.pmessageHandler!(
      'kubeclaw:bootstrap:*',
      'kubeclaw:bootstrap:job-step-2',
      JSON.stringify({ type: 'step', label: 'Installing packages' }),
    );

    expect(capturedSseEvents).toHaveLength(1);
    expect(capturedSseEvents[0].type).toBe('bootstrap');
    expect(capturedSseEvents[0].text).toBe('Installing packages');
  });

  it('forwards a { type: "question" } message to the SSE publisher', () => {
    startBootstrapTaskWatcher();
    subscriberOnRef.pmessageHandler!(
      'kubeclaw:bootstrap:*',
      'kubeclaw:bootstrap:job-q-3',
      JSON.stringify({
        type: 'question',
        text: 'Which port should the channel listen on?',
      }),
    );

    expect(capturedSseEvents).toHaveLength(1);
    expect(capturedSseEvents[0].type).toBe('bootstrap');
    expect(capturedSseEvents[0].text).toBe('Which port should the channel listen on?');
  });

  it('does NOT forward messages of unknown type to the SSE publisher', () => {
    startBootstrapTaskWatcher();
    subscriberOnRef.pmessageHandler!(
      'kubeclaw:bootstrap:*',
      'kubeclaw:bootstrap:job-unk',
      JSON.stringify({ type: 'commit_ack', text: 'done' }),
    );

    expect(capturedSseEvents).toHaveLength(0);
  });
});

// ─── A1: job.cancel error path (stopJob throws) ──────────────────────────────

describe('job.cancel: stopJob throws → error response', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await stopIpcWatcher();
    mockRegisteredGroups.mockReturnValue({});
    mockXadd.mockResolvedValue('mock-id');
    mockXread.mockResolvedValue(null);
    vi.mocked(isValidGroupFolder).mockReturnValue(true);
  });

  afterEach(async () => {
    await stopIpcWatcher();
  });

  it('clears map entry and xadds { ok: false } when stopJob throws', async () => {
    startIpcWatcher(createMockDeps());

    // Seed the active job so the handler finds it
    _testSetActiveAgentJob('mygroup', 'job-xyz');

    // Make stopJob throw
    vi.mocked(jobRunner.stopJob).mockRejectedValueOnce(
      new Error('pod not found'),
    );

    const cancelResultStream = 'kubeclaw:result:xyz';

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        // The handler reads `obj.resultStream` (not `obj.cancelResultStream`)
        // and `obj.jobId` (not `obj.jobName`). The jobName in the legacy path
        // comes from activeAgentJobsByGroup.get(groupFolder), not the message.
        return makeTaskStreamMsg('20-0', {
          type: 'job.cancel',
          groupFolder: 'mygroup',
          resultStream: cancelResultStream,
          // No jobId → legacy path (Story 49), which uses activeAgentJobsByGroup
        });
      }
      await stopIpcWatcher();
      return null;
    });

    await startTaskRequestWatcher();

    // Map entry must be cleared even on error
    // (we can't inspect the private map directly, but we verify the xadd response)
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'mygroup', jobName: 'job-xyz' }),
      'job.cancel: failed to stop job',
    );
    expect(mockXadd).toHaveBeenCalledWith(
      cancelResultStream,
      '*',
      'result',
      JSON.stringify({ ok: false, error: 'pod not found' }),
    );
  });
});

// ─── A2: job.logs handler ─────────────────────────────────────────────────────

describe('job.logs handler via startTaskRequestWatcher', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await stopIpcWatcher();
    mockRegisteredGroups.mockReturnValue({});
    mockXadd.mockResolvedValue('mock-id');
    mockXread.mockResolvedValue(null);
    vi.mocked(isValidGroupFolder).mockReturnValue(true);
    // Default: getJobLogs returns 'log output'
    vi.mocked(jobRunner.getJobLogs).mockResolvedValue('log output');
  });

  afterEach(async () => {
    await stopIpcWatcher();
  });

  it('ownership check fails (cross-group) → xadd { ok: false, error: not_found }', async () => {
    startIpcWatcher(createMockDeps());

    // getToolJobByIdForGroup returns null → not found / not owned
    vi.mocked(getToolJobByIdForGroup).mockReturnValue(null);

    const resultStream = 'kubeclaw:logs-result:cross';

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return makeTaskStreamMsg('30-0', {
          type: 'job.logs',
          groupFolder: 'group-a',
          jobId: 'tool-job-123',
          resultStream,
        });
      }
      await stopIpcWatcher();
      return null;
    });

    await startTaskRequestWatcher();

    expect(getToolJobByIdForGroup).toHaveBeenCalledWith('tool-job-123', 'group-a');
    expect(jobRunner.getJobLogs).not.toHaveBeenCalled();
    expect(mockXadd).toHaveBeenCalledWith(
      resultStream,
      '*',
      'result',
      JSON.stringify({ ok: false, error: 'not_found' }),
    );
  });

  it('success: owned job → xadd { ok: true, result: logs }', async () => {
    startIpcWatcher(createMockDeps());

    // Simulate an owned row returned
    vi.mocked(getToolJobByIdForGroup).mockReturnValue({
      id: 'tool-job-123',
      group_folder: 'group-b',
    } as any);
    vi.mocked(jobRunner.getJobLogs).mockResolvedValue('pod logs here');

    const resultStream = 'kubeclaw:logs-result:success';

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return makeTaskStreamMsg('31-0', {
          type: 'job.logs',
          groupFolder: 'group-b',
          jobId: 'tool-job-123',
          resultStream,
        });
      }
      await stopIpcWatcher();
      return null;
    });

    await startTaskRequestWatcher();

    expect(jobRunner.getJobLogs).toHaveBeenCalledWith('tool-job-123');
    expect(mockXadd).toHaveBeenCalledWith(
      resultStream,
      '*',
      'result',
      JSON.stringify({ ok: true, result: 'pod logs here' }),
    );
  });

  it('getJobLogs throws → xadd { ok: false, error: <message> }', async () => {
    startIpcWatcher(createMockDeps());

    vi.mocked(getToolJobByIdForGroup).mockReturnValue({
      id: 'tool-job-456',
      group_folder: 'group-c',
    } as any);
    vi.mocked(jobRunner.getJobLogs).mockRejectedValueOnce(
      new Error('k8s unavailable'),
    );

    const resultStream = 'kubeclaw:logs-result:error';

    let callCount = 0;
    mockXread.mockImplementation(async () => {
      if (callCount++ === 0) {
        return makeTaskStreamMsg('32-0', {
          type: 'job.logs',
          groupFolder: 'group-c',
          jobId: 'tool-job-456',
          resultStream,
        });
      }
      await stopIpcWatcher();
      return null;
    });

    await startTaskRequestWatcher();

    expect(mockXadd).toHaveBeenCalledWith(
      resultStream,
      '*',
      'result',
      JSON.stringify({ ok: false, error: 'k8s unavailable' }),
    );
  });
});

// ─── A3: startControlChannelWatcher ──────────────────────────────────────────

describe('startControlChannelWatcher', () => {
  let capturedSubscribeCb: ((err: Error | null) => void) | null = null;
  let capturedMessageHandler: ((ch: string, message: string) => void) | null =
    null;
  const onCommand = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSubscribeCb = null;
    capturedMessageHandler = null;

    // Override the subscribe mock to capture its callback
    mockSubscribe.mockImplementation(
      (_channel: string, cb: (err: Error | null) => void) => {
        capturedSubscribeCb = cb;
      },
    );

    // The subscriber.on mock already stores message handler in subscriberOnRef.
    // We reset it here so each test starts fresh.
    subscriberOnRef.messageHandler = null;
  });

  const callSubscribeCb = (err: Error | null) => {
    capturedSubscribeCb?.(err);
  };

  const fireMessage = (ch: string, msg: string) => {
    subscriberOnRef.messageHandler?.(ch, msg);
  };

  it('subscribe error callback → logger.error called with "Failed to subscribe to control channel"', () => {
    startControlChannelWatcher('my-channel', onCommand);

    const err = new Error('connection refused');
    callSubscribeCb(err);

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ err, channel: 'kubeclaw:control:my-channel' }),
      'Failed to subscribe to control channel',
    );
  });

  it('subscribe success callback → logger.info called with "Subscribed to control channel"', () => {
    startControlChannelWatcher('my-channel', onCommand);

    callSubscribeCb(null);

    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });

  it('non-matching channel → onCommand NOT called', () => {
    startControlChannelWatcher('my-channel', onCommand);

    // Fire a message on a different channel
    fireMessage('kubeclaw:control:other-channel', JSON.stringify({ command: 'reload' }));

    expect(onCommand).not.toHaveBeenCalled();
  });

  it('malformed JSON → logger.error called with "Failed to parse control channel message"', () => {
    startControlChannelWatcher('my-channel', onCommand);

    fireMessage('kubeclaw:control:my-channel', 'not-json{{{');

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to parse control channel message',
    );
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('valid message → onCommand called with parsed ControlMessage', async () => {
    startControlChannelWatcher('my-channel', onCommand);

    const msg = { command: 'reload' };
    fireMessage('kubeclaw:control:my-channel', JSON.stringify(msg));

    // Allow promise microtasks to settle
    await Promise.resolve();

    expect(onCommand).toHaveBeenCalledWith(msg);
  });
});
