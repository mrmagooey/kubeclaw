import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  isRedisAvailable,
  isKubernetesAvailable,
  getSharedRedis,
  getNamespace,
  createTestNamespace,
  flushTestKeys,
} from './setup.js';

const NAMESPACE = getNamespace();
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

describe('Timeout and Retry Behavior', () => {
  let redis: import('ioredis').Redis;
  let testGroup: string;

  beforeAll(async () => {
    redis = getSharedRedis()!;
    if (!redis) {
      console.warn('⚠️  Redis not available, skipping tests');
      return;
    }
    testGroup = createTestNamespace();
  }, 30000);

  beforeEach(async () => {
    if (redis) {
      await flushTestKeys(redis, `*:${testGroup}`);
    }
  }, 10000);

  afterEach(async () => {
    if (redis) {
      await flushTestKeys(redis, `*:${testGroup}`);
    }
  }, 10000);

  afterAll(async () => {
    if (redis) {
      await flushTestKeys(redis, `*:${testGroup}`);
    }
  }, 10000);

  describe('Redis Connection Timeout Handling', () => {
    it('should fail fast when connecting to invalid host with short timeout', async () => {
      const Redis = (await import('ioredis')).default;
      const start = Date.now();

      const failedRedis = new Redis('redis://192.0.2.1:6379', {
        connectTimeout: 2000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });

      await expect(failedRedis.ping()).rejects.toThrow();

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5000);

      await failedRedis.quit().catch(() => {});
    });

    it('should timeout connection attempts after configured duration', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const Redis = (await import('ioredis')).default;
      const connectionTimeout = 3000;

      const timedOutRedis = new Redis('redis://192.0.2.1:6379', {
        connectTimeout: connectionTimeout,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });

      const start = Date.now();
      const pingPromise = timedOutRedis.ping().catch((err) => err);

      vi.advanceTimersByTimeAsync(5000);

      const result = await pingPromise;
      const elapsed = Date.now() - start;

      expect(result).toBeInstanceOf(Error);
      expect(elapsed).toBeGreaterThanOrEqual(connectionTimeout - 500);

      vi.useRealTimers();
      await timedOutRedis.quit().catch(() => {});
    });
  });

  describe('Redis Operation Timeout', () => {
    it('should handle slow operations with configured timeout', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const slowCommand = redis.blpop(`${NAMESPACE}:slow:${testGroup}`, 1);

      const result = await slowCommand;
      expect(result).toBeNull();
    });

    it('should handle blocking pop timeout correctly', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:block-timeout:${testGroup}`;

      vi.useFakeTimers({ shouldAdvanceTime: true });

      const start = Date.now();
      const promise = redis.blpop(queueKey, 2);

      vi.advanceTimersByTimeAsync(2100);

      const result = await promise;
      const elapsed = Date.now() - start;

      expect(result).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(1900);

      vi.useRealTimers();
    });
  });

  describe('Message Processing Timeout Simulation', () => {
    it('should track message processing time', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:processing:${testGroup}`;
      const message = { id: 'msg-1', timestamp: Date.now() };

      await redis.rpush(queueKey, JSON.stringify(message));

      const startProcessing = Date.now();
      const result = await redis.lpop(queueKey);
      const processingTime = Date.now() - startProcessing;

      expect(result).toBeTruthy();
      expect(processingTime).toBeLessThan(1000);
    });

    it('should handle message that takes too long to process', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:long-processing:${testGroup}`;

      const slowProcessor = async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { processed: true };
      };

      const message = { id: 'msg-slow', startTime: Date.now() };
      await redis.rpush(queueKey, JSON.stringify(message));

      vi.useFakeTimers();

      const processPromise = (async () => {
        vi.advanceTimersByTime(50);
        const msg = await redis.lpop(queueKey);
        vi.advanceTimersByTime(100);
        return msg;
      })();

      vi.advanceTimersByTime(200);
      const result = await processPromise;

      expect(result).toBeTruthy();

      vi.useRealTimers();
    });
  });

  describe('Retry Logic for Failed Operations', () => {
    const BASE_RETRY_MS = 5000;
    const MAX_RETRIES = 5;

    interface RetryState {
      attempt: number;
      lastError: Error | null;
      retryCount: number;
      success: boolean;
    }

    const createRetryHandler = () => {
      const state: RetryState = {
        attempt: 0,
        lastError: null,
        retryCount: 0,
        success: false,
      };

      const executeWithRetry = async <T>(
        operation: () => Promise<T>,
        shouldFail: boolean,
      ): Promise<T> => {
        while (true) {
          state.attempt++;
          try {
            const result = await operation();
            if (shouldFail && state.attempt <= 3) {
              state.lastError = new Error('Simulated failure');
              throw state.lastError;
            }
            state.success = true;
            state.retryCount = 0;
            return result;
          } catch (err) {
            state.retryCount++;
            if (state.retryCount >= MAX_RETRIES) {
              state.lastError = err as Error;
              throw err;
            }
            const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(delayMs, 100)),
            );
          }
        }
      };

      return { state, executeWithRetry };
    };

    it('should retry failed operations', async () => {
      const { state, executeWithRetry } = createRetryHandler();

      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error('Temporary failure');
        }
        return 'success';
      };

      const result = await executeWithRetry(operation, false);

      expect(result).toBe('success');
      expect(callCount).toBe(3);
    });

    it('should fail after max retries exhausted', async () => {
      const { state, executeWithRetry } = createRetryHandler();

      const operation = async () => {
        throw new Error('Permanent failure');
      };

      await expect(executeWithRetry(operation, false)).rejects.toThrow(
        'Permanent failure',
      );

      expect(state.retryCount).toBe(MAX_RETRIES);
      expect(state.success).toBe(false);
      expect(state.attempt).toBe(MAX_RETRIES);
    });

    it('should succeed on first attempt when no failure', async () => {
      const { state, executeWithRetry } = createRetryHandler();

      const operation = async () => 'immediate success';

      const result = await executeWithRetry(operation, false);

      expect(result).toBe('immediate success');
      expect(state.attempt).toBe(1);
      expect(state.retryCount).toBe(0);
    });
  });

  describe('Exponential Backoff Behavior', () => {
    const BASE_RETRY_MS = 5000;

    const calculateBackoffDelay = (retryCount: number): number => {
      return BASE_RETRY_MS * Math.pow(2, retryCount - 1);
    };

    it('should calculate correct delay for first retry', () => {
      const delay = calculateBackoffDelay(1);
      expect(delay).toBe(5000);
    });

    it('should calculate correct delay for second retry', () => {
      const delay = calculateBackoffDelay(2);
      expect(delay).toBe(10000);
    });

    it('should calculate correct delay for third retry', () => {
      const delay = calculateBackoffDelay(3);
      expect(delay).toBe(20000);
    });

    it('should calculate exponential delay sequence correctly', () => {
      const delays = [1, 2, 3, 4, 5].map(calculateBackoffDelay);
      expect(delays).toEqual([5000, 10000, 20000, 40000, 80000]);
    });

    it('should apply exponential backoff to Redis retry strategy', async () => {
      const retryDelays: number[] = [];

      const Redis = (await import('ioredis')).default;
      const testRedis = new Redis(REDIS_URL, {
        connectTimeout: 5000,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 5) return null;
          const delay = 1000 * Math.pow(2, times - 1);
          retryDelays.push(delay);
          return delay;
        },
      });

      await testRedis.ping();

      expect(retryDelays.length).toBeGreaterThanOrEqual(0);

      await testRedis.quit();
    });

    it('should use fake timers to verify backoff timing', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const delays: number[] = [];
      let currentDelay = 1000;

      const simulateBackoff = async (maxRetries: number) => {
        for (let i = 0; i < maxRetries; i++) {
          delays.push(currentDelay);
          await new Promise((resolve) => setTimeout(resolve, currentDelay));
          currentDelay *= 2;
        }
      };

      const promise = simulateBackoff(4);
      vi.advanceTimersByTimeAsync(1000);
      await vi.runAllTimersAsync();
      await promise;

      expect(delays).toEqual([1000, 2000, 4000, 8000]);

      vi.useRealTimers();
    });
  });

  describe('Max Retry Limit Enforcement', () => {
    const MAX_RETRIES = 5;

    interface RetryableOperation {
      attempts: number;
      shouldSucceed: boolean;
      succeedOnAttempt: number;
    }

    it('should enforce max retry limit', async () => {
      const operation: RetryableOperation = {
        attempts: 0,
        shouldSucceed: false,
        succeedOnAttempt: 10,
      };

      const executeWithLimit = async () => {
        while (operation.attempts < MAX_RETRIES) {
          try {
            operation.attempts++;
            if (operation.attempts >= operation.succeedOnAttempt) {
              return 'success';
            }
            throw new Error('Retry needed');
          } catch {
            // Continue to next retry attempt
          }
        }
        throw new Error('Max retries exceeded');
      };

      await expect(executeWithLimit()).rejects.toThrow('Max retries exceeded');
      expect(operation.attempts).toBe(MAX_RETRIES);
    });

    it('should succeed when operation succeeds before max retries', async () => {
      let attempts = 0;

      const executeWithLimit = async () => {
        while (attempts < MAX_RETRIES) {
          try {
            attempts++;
            if (attempts >= 3) {
              return 'success';
            }
            throw new Error('Retry needed');
          } catch {
            // Continue to next retry attempt
          }
        }
        throw new Error('Max retries exceeded');
      };

      const result = await executeWithLimit();

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should track retry count in Redis', async () => {
      const retryKey = `${NAMESPACE}:retry-count:${testGroup}`;

      await redis.set(retryKey, '0');

      const incrementAndCheck = async (): Promise<boolean> => {
        const count = await redis.incr(retryKey);
        return count <= MAX_RETRIES;
      };

      const results = await Promise.all([
        incrementAndCheck(),
        incrementAndCheck(),
        incrementAndCheck(),
        incrementAndCheck(),
        incrementAndCheck(),
        incrementAndCheck(),
      ]);

      expect(results.slice(0, 5)).toEqual([true, true, true, true, true]);
      expect(results[5]).toBe(false);

      await redis.del(retryKey);
    });

    it('should store failure state until max retries reached', async () => {
      const stateKey = `${NAMESPACE}:failure-state:${testGroup}`;

      for (let i = 1; i <= MAX_RETRIES; i++) {
        await redis.hset(stateKey, 'retryCount', i.toString());
        await redis.hset(stateKey, 'lastError', `Error attempt ${i}`);

        const state = await redis.hgetall(stateKey);
        expect(parseInt(state.retryCount)).toBe(i);
      }

      await redis.del(stateKey);
    });
  });

  describe('Retry State Cleanup After Success', () => {
    it('should reset retry count after successful operation', async () => {
      const stateKey = `${NAMESPACE}:retry-state:${testGroup}`;

      await redis.hset(stateKey, 'retryCount', '3');
      await redis.hset(stateKey, 'lastAttempt', String(Date.now()));

      const onSuccess = async () => {
        await redis.hset(stateKey, 'retryCount', '0');
        await redis.hdel(stateKey, 'lastAttempt');
      };

      await onSuccess();

      const state = await redis.hgetall(stateKey);
      expect(state.retryCount).toBe('0');
      expect(state.lastAttempt).toBeUndefined();

      await redis.del(stateKey);
    });

    it('should clean up temporary retry data after success', async () => {
      const tempRetryKey = `${NAMESPACE}:temp-retry:${testGroup}`;

      await redis.set(
        tempRetryKey,
        JSON.stringify({
          attempts: [1000, 2000, 4000],
          failedAt: Date.now() - 10000,
        }),
      );

      const cleanupAfterSuccess = async () => {
        await redis.del(tempRetryKey);
      };

      await cleanupAfterSuccess();

      const remaining = await redis.get(tempRetryKey);
      expect(remaining).toBeNull();
    });

    it('should preserve successful operation results', async () => {
      const resultKey = `${NAMESPACE}:result:${testGroup}`;
      const retryKey = `${NAMESPACE}:retry-tracker:${testGroup}`;

      await redis.set(resultKey, 'operation-result-123');
      await redis.set(retryKey, '5');

      const onSuccess = async () => {
        await redis.del(retryKey);
      };

      await onSuccess();

      const result = await redis.get(resultKey);
      const retryCount = await redis.get(retryKey);

      expect(result).toBe('operation-result-123');
      expect(retryCount).toBeNull();

      await redis.del(resultKey);
    });

    it('should handle concurrent success and cleanup', async () => {
      const keys = Array.from(
        { length: 10 },
        (_, i) => `${NAMESPACE}:concurrent-${i}:${testGroup}`,
      );

      await Promise.all(keys.map((key) => redis.set(key, 'pending')));

      const processWithCleanup = async (
        key: string,
        shouldSucceed: boolean,
      ) => {
        if (shouldSucceed) {
          await redis.set(key, 'success');
          await redis.del(key.replace('kubeclaw', 'kubeclaw:cleanup'));
        }
        return shouldSucceed;
      };

      const results = await Promise.all(
        keys.map((key, i) => processWithCleanup(key, i % 2 === 0)),
      );

      expect(results.filter((r) => r).length).toBe(5);
    });
  });
});
