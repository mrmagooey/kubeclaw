import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const { mocked: mockRedis } = vi.hoisted(() => {
  const mockIncr = vi.fn().mockResolvedValue(1);
  const mockDecr = vi.fn().mockResolvedValue(0);
  const mockGet = vi.fn().mockResolvedValue('0');
  const mockSet = vi.fn().mockResolvedValue('OK');
  const mockSetex = vi.fn().mockResolvedValue('OK');
  const mockZadd = vi.fn().mockResolvedValue(1);
  const mockZrem = vi.fn().mockResolvedValue(1);
  const mockZrange = vi.fn().mockResolvedValue([]);
  const mockXadd = vi.fn().mockResolvedValue('stream-id');
  // acquireSlot uses eval with a Lua script; return 1 = slot acquired, 0 = at limit
  const mockEval = vi.fn().mockResolvedValue(1);

  return {
    mocked: {
      incr: mockIncr,
      decr: mockDecr,
      get: mockGet,
      set: mockSet,
      setex: mockSetex,
      zadd: mockZadd,
      zrem: mockZrem,
      zrange: mockZrange,
      xadd: mockXadd,
      eval: mockEval,
      reset: () => {
        mockIncr.mockResolvedValue(1);
        mockDecr.mockResolvedValue(0);
        mockGet.mockResolvedValue('0');
        mockSet.mockResolvedValue('OK');
        mockSetex.mockResolvedValue('OK');
        mockZadd.mockResolvedValue(1);
        mockZrem.mockResolvedValue(1);
        mockZrange.mockResolvedValue([]);
        mockXadd.mockResolvedValue('stream-id');
        mockEval.mockResolvedValue(1);
      },
    },
  };
});

vi.mock('./redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({
    incr: mockRedis.incr,
    decr: mockRedis.decr,
    get: mockRedis.get,
    set: mockRedis.set,
    setex: mockRedis.setex,
    zadd: mockRedis.zadd,
    zrem: mockRedis.zrem,
    zrange: mockRedis.zrange,
    xadd: mockRedis.xadd,
    eval: mockRedis.eval,
  })),
  getQueueKey: vi.fn(() => 'kubeclaw:job-queue'),
  getConcurrencyKey: vi.fn(() => 'kubeclaw:concurrency'),
  getInputStream: vi.fn((jobId: string) => `kubeclaw:input:${jobId}`),
  getJobStatusKey: vi.fn((jobId: string) => `kubeclaw:job:${jobId}:status`),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { DistributedJobQueue } from './job-queue.js';

describe('DistributedJobQueue', () => {
  let queue: DistributedJobQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    mockRedis.reset();
    queue = new DistributedJobQueue();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await queue.shutdown(0);
  });

  describe('enqueueMessageCheck', () => {
    it('acquires slot and runs when slot available', async () => {
      const processMessages = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(processMessages);

      await queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      expect(mockRedis.eval).toHaveBeenCalled();
      expect(processMessages).toHaveBeenCalledWith('group1@g.us');
    });

    it('queues locally when group already active', async () => {
      const processMessages = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
          }),
      );
      queue.setProcessMessagesFn(processMessages);

      await queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      await queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      expect(processMessages).toHaveBeenCalledTimes(1);

      processMessages.mock.results[0].value.then(() => {});
      await vi.advanceTimersByTimeAsync(100);

      expect(processMessages).toHaveBeenCalledTimes(2);
    });

    it('queues in Redis when at concurrency limit', async () => {
      mockRedis.eval.mockResolvedValue(0); // 0 = slot not acquired (at limit)
      const processMessages = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(processMessages);

      await queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      expect(mockRedis.zadd).toHaveBeenCalled();
      expect(processMessages).not.toHaveBeenCalled();
    });

    it('returns early when shutting down', async () => {
      await queue.shutdown(0);

      const processMessages = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(processMessages);

      await queue.enqueueMessageCheck('group1@g.us');

      expect(processMessages).not.toHaveBeenCalled();
    });
  });

  describe('enqueueTask', () => {
    it('runs task immediately when slot available', async () => {
      const taskFn = vi.fn().mockResolvedValue(undefined);
      queue.setProcessMessagesFn(vi.fn().mockResolvedValue(true));

      await queue.enqueueTask('group1@g.us', 'task-1', taskFn);
      await vi.advanceTimersByTimeAsync(10);

      expect(taskFn).toHaveBeenCalled();
    });

    it('skips duplicate task already running', async () => {
      let resolveTask: () => void;
      const taskFn = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveTask = resolve;
          }),
      );
      queue.setProcessMessagesFn(vi.fn().mockResolvedValue(true));

      await queue.enqueueTask('group1@g.us', 'task-1', taskFn);
      await vi.advanceTimersByTimeAsync(10);

      const taskFn2 = vi.fn().mockResolvedValue(undefined);
      await queue.enqueueTask('group1@g.us', 'task-1', taskFn2);
      await vi.advanceTimersByTimeAsync(10);

      expect(taskFn).toHaveBeenCalledTimes(1);
      expect(taskFn2).not.toHaveBeenCalled();

      resolveTask!();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('queues task locally when group active', async () => {
      const processMessages = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
          }),
      );
      queue.setProcessMessagesFn(processMessages);

      await queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      const taskFn = vi.fn().mockResolvedValue(undefined);
      await queue.enqueueTask('group1@g.us', 'task-1', taskFn);
      await vi.advanceTimersByTimeAsync(10);

      expect(taskFn).not.toHaveBeenCalled();
    });

    it('queues in Redis when at concurrency limit', async () => {
      mockRedis.eval.mockResolvedValue(0); // 0 = slot not acquired (at limit)
      const processMessages = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(processMessages);

      const taskFn = vi.fn().mockResolvedValue(undefined);
      await queue.enqueueTask('group1@g.us', 'task-1', taskFn);
      await vi.advanceTimersByTimeAsync(10);

      expect(mockRedis.zadd).toHaveBeenCalled();
      expect(taskFn).not.toHaveBeenCalled();
    });

    it('returns early when shutting down', async () => {
      await queue.shutdown(0);

      const taskFn = vi.fn().mockResolvedValue(undefined);
      queue.setProcessMessagesFn(vi.fn().mockResolvedValue(true));

      await queue.enqueueTask('group1@g.us', 'task-1', taskFn);

      expect(taskFn).not.toHaveBeenCalled();
    });
  });

  describe('startPolling / stopPolling', () => {
    it('polls queue at interval', async () => {
      const processMessages = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(processMessages);

      await queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      mockRedis.get.mockResolvedValue('0');
      mockRedis.zrange.mockResolvedValue([]);

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockRedis.zrange).toHaveBeenCalled();
    });

    it('stops polling after shutdown', async () => {
      const processMessages = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(processMessages);

      mockRedis.get.mockResolvedValue('0');
      mockRedis.zrange.mockResolvedValue([]);

      await vi.advanceTimersByTimeAsync(100);
      const zrangeCallsBeforeShutdown = mockRedis.zrange.mock.calls.length;

      await queue.shutdown(0);

      await vi.advanceTimersByTimeAsync(2000);

      expect(mockRedis.zrange.mock.calls.length).toBe(
        zrangeCallsBeforeShutdown,
      );
    });

    it('processes queued jobs when slots become available', async () => {
      const processMessages = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(processMessages);

      mockRedis.eval.mockResolvedValue(0); // 0 = slot not acquired (at limit)
      await queue.enqueueMessageCheck('group1@g.us');

      expect(mockRedis.zadd).toHaveBeenCalled();

      mockRedis.incr.mockResolvedValue(1);
      mockRedis.zrange.mockResolvedValue([]);
      mockRedis.get.mockResolvedValue('10');

      await vi.advanceTimersByTimeAsync(1000);
    });
  });

  describe('registerProcess', () => {
    it('registers group as active, sets jobId, and calls setex with Running status', async () => {
      await queue.registerProcess('group1@g.us', 'messages', '/groups/group1');

      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.stringContaining('group1@g.us'),
        3600,
        expect.stringContaining('"phase":"Running"'),
      );

      // Group should now be active — sendMessage should return true
      const result = await queue.sendMessage('group1@g.us', 'hello');
      expect(result).toBe(true);
    });

    it('second call for same group updates it', async () => {
      await queue.registerProcess('group1@g.us', 'messages', '/groups/group1');
      const firstSetexCall = mockRedis.setex.mock.calls.length;

      await queue.registerProcess(
        'group1@g.us',
        'messages-2',
        '/groups/group1',
      );

      expect(mockRedis.setex.mock.calls.length).toBeGreaterThan(firstSetexCall);
      // Group is still active after the second registration
      const result = await queue.sendMessage('group1@g.us', 'hello');
      expect(result).toBe(true);
    });
  });

  describe('notifyIdle', () => {
    it('sets idleWaiting flag without error when group is not active', async () => {
      mockRedis.xadd.mockClear();
      // group does not exist yet — should not throw
      await expect(queue.notifyIdle('group1@g.us')).resolves.toBeUndefined();
      // No xadd call should have been made (closeStdin bails out when inactive)
      expect(mockRedis.xadd).not.toHaveBeenCalled();
    });

    it('calls closeStdin when group has pending tasks', async () => {
      // Make group active
      await queue.registerProcess('group1@g.us', 'messages', '/groups/group1');

      // Enqueue a task while the group is active so it lands in pendingTasks
      const taskFn = vi.fn().mockResolvedValue(undefined);
      await queue.enqueueTask('group1@g.us', 'task-1', taskFn);

      mockRedis.xadd.mockClear();

      // notifyIdle should trigger closeStdin because pendingTasks is non-empty
      await queue.notifyIdle('group1@g.us');

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        expect.stringContaining('group1@g.us'),
        '*',
        'data',
        expect.stringContaining('"type":"close"'),
      );
    });
  });

  describe('sendMessage', () => {
    it('returns false when group is not active', async () => {
      const result = await queue.sendMessage('group1@g.us', 'hello');
      expect(result).toBe(false);
    });

    it('returns false when group is active but isTaskContainer is true', async () => {
      // enqueueTask with a slot acquired makes the group a task container
      let resolveTask: () => void;
      const taskFn = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveTask = resolve;
          }),
      );
      queue.setProcessMessagesFn(vi.fn().mockResolvedValue(true));

      await queue.enqueueTask('group1@g.us', 'task-1', taskFn);
      await vi.advanceTimersByTimeAsync(10);

      const result = await queue.sendMessage('group1@g.us', 'hello');
      expect(result).toBe(false);

      resolveTask!();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('sends message to Redis stream and returns true when active non-task container', async () => {
      await queue.registerProcess('group1@g.us', 'messages', '/groups/group1');

      mockRedis.xadd.mockClear();
      const result = await queue.sendMessage('group1@g.us', 'hello world');

      expect(result).toBe(true);
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        expect.stringContaining('group1@g.us'),
        '*',
        'data',
        expect.stringContaining('"type":"message"'),
      );
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        expect.any(String),
        '*',
        'data',
        expect.stringContaining('"text":"hello world"'),
      );
    });
  });

  describe('closeStdin', () => {
    it('does nothing when group is not active', async () => {
      mockRedis.xadd.mockClear();
      await expect(queue.closeStdin('group1@g.us')).resolves.toBeUndefined();
      expect(mockRedis.xadd).not.toHaveBeenCalled();
    });

    it('sends close signal to Redis stream when group is active', async () => {
      await queue.registerProcess('group1@g.us', 'messages', '/groups/group1');

      mockRedis.xadd.mockClear();
      await queue.closeStdin('group1@g.us');

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        expect.stringContaining('group1@g.us'),
        '*',
        'data',
        expect.stringContaining('"type":"close"'),
      );
    });
  });

  describe('scheduleRetry', () => {
    it('retries processing after BASE_RETRY_MS when processMessages returns false', async () => {
      let callCount = 0;
      const processMessages = vi.fn().mockImplementation(async () => {
        callCount++;
        return callCount > 1; // false on first call, true on second
      });
      queue.setProcessMessagesFn(processMessages);

      await queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      // First call completed and returned false — retry scheduled at BASE_RETRY_MS (5000)
      expect(processMessages).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);

      expect(processMessages).toHaveBeenCalledTimes(2);
    });
  });

  describe('drainGroup', () => {
    it('drains pending tasks after a job completes', async () => {
      let resolveFirstJob: () => void;
      let firstJobStarted = false;
      const processMessages = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            firstJobStarted = true;
            resolveFirstJob = resolve;
          }),
      );
      queue.setProcessMessagesFn(processMessages);

      // Start a message-check job to occupy the slot
      await queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);
      expect(firstJobStarted).toBe(true);

      // Enqueue a task while the group is active — goes to pendingTasks
      const taskFn = vi.fn().mockResolvedValue(undefined);
      await queue.enqueueTask('group1@g.us', 'task-drain', taskFn);
      expect(taskFn).not.toHaveBeenCalled();

      // Finish the first job — drainGroup should pick up the pending task
      resolveFirstJob!();
      await vi.advanceTimersByTimeAsync(10);

      expect(taskFn).toHaveBeenCalledTimes(1);
    });

    it('drains pending messages after a job completes', async () => {
      let resolveFirstJob: () => void;
      let callCount = 0;
      const processMessages = vi.fn().mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            callCount++;
            if (callCount === 1) {
              resolveFirstJob = () => resolve(true);
            } else {
              resolve(true);
            }
          }),
      );
      queue.setProcessMessagesFn(processMessages);

      // Start a message-check job to occupy the slot
      await queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      // Queue a pending message while the group is active
      await queue.enqueueMessageCheck('group1@g.us');

      expect(processMessages).toHaveBeenCalledTimes(1);

      // Finish the first job — drainGroup should re-run for pending messages
      resolveFirstJob!();
      await vi.advanceTimersByTimeAsync(10);

      expect(processMessages).toHaveBeenCalledTimes(2);
    });
  });

  describe('shutdown with active jobs', () => {
    it('sends close signal and marks job as Failed for active jobs', async () => {
      await queue.registerProcess('group1@g.us', 'messages', '/groups/group1');

      mockRedis.xadd.mockClear();
      mockRedis.setex.mockClear();

      await queue.shutdown(10000);

      // Should have sent a close signal via xadd
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        expect.stringContaining('group1@g.us'),
        '*',
        'data',
        expect.stringContaining('"type":"close"'),
      );

      // Should have written a Failed status via setex
      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.stringContaining('group1@g.us'),
        3600,
        expect.stringContaining('"phase":"Failed"'),
      );
    });
  });
});
