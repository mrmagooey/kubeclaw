import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockRedisClient,
  mockRedisSubscriber,
  mockXadd,
  mockSubscribe,
  mockUnsubscribe,
  mockQuit,
} = vi.hoisted(() => {
  const mockXadd = vi.fn().mockResolvedValue('mock-id');
  const mockSubscribe = vi.fn().mockResolvedValue(undefined);
  const mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
  const mockQuit = vi.fn().mockResolvedValue('OK');

  const createMockRedis = () => ({
    xadd: mockXadd,
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    quit: mockQuit,
    on: vi.fn(),
  });

  return {
    mockXadd,
    mockSubscribe,
    mockUnsubscribe,
    mockQuit,
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
  SIDECAR_POLL_INTERVAL: 1000,
  TIMEZONE: 'UTC',
  CONTAINER_TIMEOUT: 1800000,
  IDLE_TIMEOUT: 1800000,
}));

vi.mock('./job-runner.js', () => ({
  jobRunner: {
    createToolPodJob: vi.fn().mockResolvedValue('nc-test-pod-abc123'),
    stopJob: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
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
  })),
  getRedisSubscriber: vi.fn(() => ({
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    quit: vi.fn(),
    on: vi.fn(),
  })),
  getOutputChannel: vi.fn((folder: string) => `nanoclaw:messages:${folder}`),
  getTaskChannel: vi.fn((folder: string) => `nanoclaw:tasks:${folder}`),
  getInputStream: vi.fn((jobId: string) => `nanoclaw:input:${jobId}`),
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

  describe('unknown type', () => {
    it('logs warning for unknown IPC type', async () => {
      const deps = createMockDeps();

      await processTaskIpc({ type: 'unknown_type' as any }, 'main', true, deps);

      expect(createTask).not.toHaveBeenCalled();
    });
  });
});

describe('startIpcWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing if already running', () => {
    const deps = createMockDeps();
    startIpcWatcher(deps);
    startIpcWatcher(deps);
  });
});

describe('sendMessageToAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a message to agent via Redis stream', async () => {
    await sendMessageToAgent('job-123', 'Hello agent');

    expect(mockXadd).toHaveBeenCalledWith(
      'nanoclaw:input:job-123',
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
      'nanoclaw:input:job-123',
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops IPC watcher and cleans up subscribers', async () => {
    await stopIpcWatcher();
  });
});
