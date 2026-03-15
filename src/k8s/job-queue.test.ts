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
  getQueueKey: vi.fn(() => 'nanoclaw:job-queue'),
  getConcurrencyKey: vi.fn(() => 'nanoclaw:concurrency'),
  getInputStream: vi.fn((jobId: string) => `nanoclaw:input:${jobId}`),
  getJobStatusKey: vi.fn((jobId: string) => `nanoclaw:job:${jobId}:status`),
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
});
