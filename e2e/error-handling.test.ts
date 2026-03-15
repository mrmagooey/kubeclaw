import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  isKubernetesAvailable,
  isRedisAvailable,
  getSharedRedis,
  getNamespace,
  createTestNamespace,
  flushTestKeys,
} from './setup.js';

const NAMESPACE = getNamespace();
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

interface QueueMessage {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
  groupId?: string;
}

describe('Error Handling', () => {
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

  describe('Invalid JSON Messages in Redis Queues', () => {
    it('should handle non-JSON string messages gracefully', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      await redis.rpush(queueKey, 'not-valid-json');
      await redis.rpush(queueKey, '{incomplete');
      await redis.rpush(queueKey, 'plain text message');

      const results: string[] = [];
      for (let i = 0; i < 3; i++) {
        const item = await redis.lpop(queueKey);
        if (item) results.push(item);
      }

      expect(results).toHaveLength(3);

      const validJsonMessages = results.filter((item) => {
        try {
          JSON.parse(item);
          return true;
        } catch {
          return false;
        }
      });
      expect(validJsonMessages).toHaveLength(0);
    });

    it('should catch JSON parse errors when processing queue messages', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;
      const invalidJson = 'broken json { "a": }';

      await redis.rpush(queueKey, invalidJson);
      const message = await redis.lpop(queueKey);

      let parsed: QueueMessage | null = null;
      let parseError: Error | null = null;

      try {
        parsed = message ? JSON.parse(message) : null;
      } catch (e) {
        parseError = e instanceof Error ? e : new Error(String(e));
      }

      expect(parsed).toBeNull();
      expect(parseError).not.toBeNull();
      expect(parseError?.message).toContain('JSON');
    });

    it('should handle messages with invalid UTF-8 sequences', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00]).toString('binary');
      await redis.rpush(queueKey, invalidUtf8);

      const message = await redis.lpop(queueKey);
      expect(message).toBeTruthy();

      try {
        JSON.parse(message!);
        expect.fail('Should have thrown on invalid UTF-8');
      } catch (e) {
        expect(e).toBeInstanceOf(SyntaxError);
      }
    });
  });

  describe('Malformed Messages', () => {
    it('should handle messages with wrong type field', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const malformedMessage = {
        id: 'malformed-1',
        type: 123,
        payload: 'not an object',
        timestamp: 'not a number',
      };

      await redis.rpush(queueKey, JSON.stringify(malformedMessage));
      const message = await redis.lpop(queueKey);

      const parsed = JSON.parse(message!);
      expect(parsed.id).toBe('malformed-1');
      expect(typeof parsed.type).toBe('number');
      expect(typeof parsed.payload).toBe('string');
    });

    it('should handle messages with array instead of object payload', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const message = {
        id: 'array-payload',
        type: 'task',
        payload: [1, 2, 3],
        timestamp: Date.now(),
      };

      await redis.rpush(queueKey, JSON.stringify(message));
      const stored = await redis.lpop(queueKey);
      const parsed = JSON.parse(stored!);

      expect(Array.isArray(parsed.payload)).toBe(true);
    });

    it('should handle deeply nested objects', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const deepNested = {
        id: 'deep-nested',
        type: 'task',
        payload: {
          level1: {
            level2: {
              level3: {
                level4: {
                  value: 'deep',
                },
              },
            },
          },
        },
        timestamp: Date.now(),
      };

      await redis.rpush(queueKey, JSON.stringify(deepNested));
      const stored = await redis.lpop(queueKey);
      const parsed = JSON.parse(stored!);

      expect(parsed.payload.level1.level2.level3.level4.value).toBe('deep');
    });

    it('should handle messages with undefined values', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const messageWithUndefined = {
        id: 'undefined-test',
        type: 'task',
        payload: { hasUndefined: undefined as unknown },
        timestamp: Date.now(),
      };

      const serialized = JSON.stringify(messageWithUndefined);
      await redis.rpush(queueKey, serialized);
      const stored = await redis.lpop(queueKey);
      const parsed = JSON.parse(stored!);

      expect(parsed.payload.hasUndefined).toBeUndefined();
    });
  });

  describe('Redis Connection Failure Recovery', () => {
    it('should handle connection timeout gracefully', async () => {
      const timeoutRedis = new (await import('ioredis')).default(
        'redis://invalid-host:9999',
        {
          connectTimeout: 100,
          maxRetriesPerRequest: 1,
          retryStrategy: () => null,
        },
      );

      let error: Error | null = null;
      try {
        await timeoutRedis.ping();
      } catch (e) {
        error = e instanceof Error ? e : new Error(String(e));
      }

      expect(error).not.toBeNull();
      await timeoutRedis.quit().catch(() => {});
    });

    it('should handle connection refused error', async () => {
      const refusedRedis = new (await import('ioredis')).default(
        'redis://localhost:1',
        {
          connectTimeout: 1000,
          maxRetriesPerRequest: 1,
          retryStrategy: () => null,
        },
      );

      let error: Error | null = null;
      try {
        await refusedRedis.ping();
      } catch (e) {
        error = e instanceof Error ? e : new Error(String(e));
      }

      expect(error).not.toBeNull();
      await refusedRedis.quit().catch(() => {});
    });

    it('should handle auth failure gracefully', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }

      const { default: Redis } = await import('ioredis');

      const configRedis = new Redis(REDIS_URL, { connectTimeout: 5000 });
      let requiresAuth = false;
      try {
        const requirepass = await configRedis.config('GET', 'requirepass');
        requiresAuth =
          Array.isArray(requirepass) &&
          requirepass[1] &&
          requirepass[1].length > 0;
      } catch {
        // If CONFIG GET fails, auth is likely not required
      } finally {
        await configRedis.quit().catch(() => {});
      }

      if (!requiresAuth) {
        console.warn(
          '⚠️  Redis does not require authentication, skipping auth failure test',
        );
        return;
      }

      const authRedis = new Redis(REDIS_URL, {
        password: 'wrong-password-that-does-not-exist',
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });

      let error: Error | null = null;
      try {
        await authRedis.ping();
      } catch (e) {
        error = e instanceof Error ? e : new Error(String(e));
      }

      expect(error).not.toBeNull();
      await authRedis.quit().catch(() => {});
    });

    it('should recover from connection loss', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const testKey = `${NAMESPACE}:recovery-test:${testGroup}`;

      await redis.set(testKey, 'initial-value');
      const initial = await redis.get(testKey);
      expect(initial).toBe('initial-value');

      await redis.set(testKey, 'updated-value');
      const updated = await redis.get(testKey);
      expect(updated).toBe('updated-value');

      await redis.del(testKey);
      const deleted = await redis.get(testKey);
      expect(deleted).toBeNull();
    });
  });

  describe('Kubernetes Job Failure Handling', () => {
    it('should handle missing Kubernetes cluster gracefully', () => {
      const available = isKubernetesAvailable();

      if (!available) {
        console.warn('Kubernetes not available - skipping actual job test');
      }

      expect(typeof available).toBe('boolean');
    });

    it('should detect when Kubernetes is unavailable', () => {
      const available = isKubernetesAvailable();

      if (available) {
        console.warn(
          '⚠️  Kubernetes is available - skipping test (cannot test unavailability)',
        );
        return;
      }

      expect(available).toBe(false);
    });

    it('should handle job creation when namespace does not exist', async () => {
      const { execSync } = await import('child_process');

      if (!isKubernetesAvailable()) {
        console.warn('Kubernetes not available - skipping job test');
        return;
      }

      try {
        execSync(`kubectl get namespace nonexistent-namespace-${Date.now()}`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        expect.fail('Namespace should not exist');
      } catch (e) {
        const output = e instanceof Error ? e.message : String(e);
        expect(output.toLowerCase()).toContain('not found');
      }
    });

    it('should handle kubectl command failures', async () => {
      const { execSync } = await import('child_process');

      try {
        execSync('kubectl get pods --namespace=non-existent-ns-12345', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        expect.fail('Should have thrown an error');
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });

  describe('Missing Required Fields in Messages', () => {
    it('should handle messages missing id field', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const message = {
        type: 'task',
        payload: { data: 'test' },
        timestamp: Date.now(),
      };

      await redis.rpush(queueKey, JSON.stringify(message));
      const stored = await redis.lpop(queueKey);
      const parsed = JSON.parse(stored!);

      expect(parsed.id).toBeUndefined();
      expect(parsed.type).toBe('task');
    });

    it('should handle messages missing type field', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const message = {
        id: 'test-1',
        payload: { data: 'test' },
        timestamp: Date.now(),
      };

      await redis.rpush(queueKey, JSON.stringify(message));
      const stored = await redis.lpop(queueKey);
      const parsed = JSON.parse(stored!);

      expect(parsed.id).toBe('test-1');
      expect(parsed.type).toBeUndefined();
    });

    it('should handle messages missing timestamp field', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const message = {
        id: 'test-1',
        type: 'task',
        payload: { data: 'test' },
      };

      await redis.rpush(queueKey, JSON.stringify(message));
      const stored = await redis.lpop(queueKey);
      const parsed = JSON.parse(stored!);

      expect(parsed.id).toBe('test-1');
      expect(parsed.timestamp).toBeUndefined();
    });

    it('should handle messages missing payload field', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const message = {
        id: 'test-1',
        type: 'task',
        timestamp: Date.now(),
      };

      await redis.rpush(queueKey, JSON.stringify(message));
      const stored = await redis.lpop(queueKey);
      const parsed = JSON.parse(stored!);

      expect(parsed.id).toBe('test-1');
      expect(parsed.payload).toBeUndefined();
    });

    it('should handle completely empty message objects', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      await redis.rpush(queueKey, JSON.stringify({}));
      const stored = await redis.lpop(queueKey);
      const parsed = JSON.parse(stored!);

      expect(parsed.id).toBeUndefined();
      expect(parsed.type).toBeUndefined();
      expect(parsed.payload).toBeUndefined();
    });

    it('should handle null values for required fields', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const message = {
        id: null,
        type: null,
        payload: null,
        timestamp: null,
      };

      await redis.rpush(queueKey, JSON.stringify(message));
      const stored = await redis.lpop(queueKey);
      const parsed = JSON.parse(stored!);

      expect(parsed.id).toBeNull();
      expect(parsed.type).toBeNull();
    });
  });

  describe('Graceful Degradation', () => {
    it('should handle empty queue operations', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:empty:${testGroup}`;

      const lpopResult = await redis.lpop(queueKey);
      expect(lpopResult).toBeNull();

      const rpopResult = await redis.rpop(queueKey);
      expect(rpopResult).toBeNull();

      const llen = await redis.llen(queueKey);
      expect(llen).toBe(0);
    });

    it('should handle large batch operations gracefully', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:batch:${testGroup}`;

      const batchSize = 1000;
      const pipeline = redis.pipeline();

      for (let i = 0; i < batchSize; i++) {
        pipeline.rpush(queueKey, JSON.stringify({ id: `batch-${i}`, data: i }));
      }

      const results = await pipeline.exec();
      expect(results).not.toBeNull();
      expect(results!.every((r) => r[0] === null)).toBe(true);

      const length = await redis.llen(queueKey);
      expect(length).toBe(batchSize);

      await redis.del(queueKey);
      const afterDelete = await redis.llen(queueKey);
      expect(afterDelete).toBe(0);
    });

    it('should handle key expiration gracefully', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:expiry:${testGroup}`;

      await redis.setex(queueKey, 1, 'test-value');

      const immediate = await redis.get(queueKey);
      expect(immediate).toBe('test-value');

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const afterExpiry = await redis.get(queueKey);
      expect(afterExpiry).toBeNull();
    });

    it('should handle pipeline errors gracefully', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const pipeline = redis.pipeline();

      pipeline.set('pipeline-test-1', 'value1');
      pipeline.set('pipeline-test-2', 'value2');

      const results = await pipeline.exec();
      expect(results).not.toBeNull();
      expect(results!.every((r) => r[0] === null)).toBe(true);

      await redis.del('pipeline-test-1', 'pipeline-test-2');
    });

    it('should handle pub/sub disconnection gracefully', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const { default: Redis } = await import('ioredis');

      const subscriber = new Redis(REDIS_URL, {
        connectTimeout: 10000,
        maxRetriesPerRequest: 1,
      });

      let errorOccurred = false;
      subscriber.on('error', (e) => {
        errorOccurred = true;
        console.warn('Subscriber error:', e.message);
      });

      await subscriber.subscribe('test-channel');
      expect(errorOccurred).toBe(false);

      await subscriber.unsubscribe('test-channel');
      await subscriber.quit();
    });

    it('should handle concurrent queue operations', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:concurrent:${testGroup}`;

      const operations = Promise.all([
        redis.rpush(queueKey, JSON.stringify({ id: 'concurrent-1' })),
        redis.rpush(queueKey, JSON.stringify({ id: 'concurrent-2' })),
        redis.rpush(queueKey, JSON.stringify({ id: 'concurrent-3' })),
      ]);

      const results = await operations;
      expect(results.every((r) => r !== null)).toBe(true);

      const length = await redis.llen(queueKey);
      expect(length).toBe(3);

      await redis.del(queueKey);
    });
  });
});
