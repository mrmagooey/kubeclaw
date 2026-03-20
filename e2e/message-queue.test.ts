import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from 'vitest';
import {
  isRedisAvailable,
  getSharedRedis,
  getNamespace,
  createTestNamespace,
  flushTestKeys,
  waitFor,
} from './setup.js';

const NAMESPACE = getNamespace();
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

interface TestMessage {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

describe('Message Queue Integration', () => {
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

  describe('Redis Queue Publishing', () => {
    it('should publish messages to kubeclaw:tasks queue', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const message = {
        id: 'msg-001',
        type: 'task',
        payload: { action: 'process' },
        timestamp: Date.now(),
      };

      await redis.rpush(queueKey, JSON.stringify(message));

      const length = await redis.llen(queueKey);
      expect(length).toBe(1);

      const popped = await redis.lpop(queueKey);
      expect(popped).not.toBeNull();
      expect(JSON.parse(popped!)).toEqual(message);
    });

    it('should publish messages to kubeclaw:messages queue', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:messages:${testGroup}`;

      const message = {
        id: 'msg-002',
        type: 'message',
        payload: { content: 'Hello world' },
        timestamp: Date.now(),
      };

      await redis.rpush(queueKey, JSON.stringify(message));

      const length = await redis.llen(queueKey);
      expect(length).toBe(1);
    });

    it('should handle multiple messages in queue', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const messages = [
        { id: 'msg-001', type: 'task', payload: { n: 1 } },
        { id: 'msg-002', type: 'task', payload: { n: 2 } },
        { id: 'msg-003', type: 'task', payload: { n: 3 } },
      ];

      for (const msg of messages) {
        await redis.rpush(queueKey, JSON.stringify(msg));
      }

      const length = await redis.llen(queueKey);
      expect(length).toBe(3);
    });
  });

  describe('JSON Serialization/Deserialization', () => {
    it('should serialize and deserialize messages correctly', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }

      const original: TestMessage = {
        id: 'test-id',
        type: 'test-type',
        payload: { key: 'value' },
        timestamp: 1234567890,
      };

      const serialized = JSON.stringify(original);
      const deserialized = JSON.parse(serialized);

      expect(deserialized).toEqual(original);
    });

    it('should handle special characters in JSON', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }

      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;
      const message = {
        id: 'special-chars',
        type: 'test',
        payload: {
          quotes: '"test"',
          backslash: 'path\\to\\file',
          newline: 'line1\nline2',
          unicode: 'hello world',
        },
        timestamp: Date.now(),
      };

      await redis.rpush(queueKey, JSON.stringify(message));

      const result = await redis.lpop(queueKey);
      expect(result).not.toBeNull();

      const parsed = JSON.parse(result!);
      expect(parsed.payload).toEqual(message.payload);
    });

    it('should preserve data integrity through round-trip', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const original = { id: 'round-trip', data: { nested: { value: 42 } } };
      await redis.rpush(queueKey, JSON.stringify(original));

      const retrieved = await redis.lpop(queueKey);
      const parsed = JSON.parse(retrieved!);

      expect(parsed).toEqual(original);
      expect(parsed.data.nested.value).toBe(42);
    });
  });

  describe('Queue Consumer Pattern Simulation', () => {
    it('should implement FIFO queue behavior', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:fifo:${testGroup}`;

      await redis.rpush(queueKey, 'first', 'second', 'third');

      const first = await redis.lpop(queueKey);
      const second = await redis.lpop(queueKey);
      const third = await redis.lpop(queueKey);

      expect(first).toBe('first');
      expect(second).toBe('second');
      expect(third).toBe('third');
    });

    it('should support blocking pop for consumer pattern', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:blocking:${testGroup}`;

      const result = await redis.blpop(queueKey, 1);
      expect(result).toBeNull();
    });

    it('should handle producer-consumer with multiple items', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const producer = async () => {
        for (let i = 0; i < 5; i++) {
          await redis.rpush(queueKey, JSON.stringify({ item: i }));
        }
      };

      const consumer = async (count: number) => {
        const items: object[] = [];
        for (let i = 0; i < count; i++) {
          const result = await redis.lpop(queueKey);
          if (result) {
            items.push(JSON.parse(result));
          }
        }
        return items;
      };

      await producer();
      const consumed = await consumer(5);

      expect(consumed).toHaveLength(5);
      expect(consumed[0]).toEqual({ item: 0 });
      expect(consumed[4]).toEqual({ item: 4 });
    }, 10000);

    it('should handle pub/sub for real-time messaging', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const channel = `${NAMESPACE}:realtime:${testGroup}`;
      const received: string[] = [];

      const { default: Redis } = await import('ioredis');

      // Use dedicated clients to avoid shared-state issues from preceding tests
      const subRedis = new Redis(REDIS_URL, { connectTimeout: 10000 });
      const pubRedis = new Redis(REDIS_URL, { connectTimeout: 10000 });

      try {
        // Wait for both connections to be ready
        await Promise.all([
          new Promise<void>((resolve) => subRedis.once('ready', resolve)),
          new Promise<void>((resolve) => pubRedis.once('ready', resolve)),
        ]);

        subRedis.on('message', (ch: string, msg: string) => {
          if (ch === channel) received.push(msg);
        });

        await subRedis.subscribe(channel);

        // Give subscription time to register server-side
        await new Promise((r) => setTimeout(r, 100));

        await pubRedis.publish(channel, 'message-1');
        await pubRedis.publish(channel, 'message-2');

        await waitFor(() => received.length >= 1, 5000);

        expect(received.length).toBeGreaterThanOrEqual(1);
      } finally {
        await subRedis.quit();
        await pubRedis.quit();
      }
    }, 15000);
  });

  describe('Error Handling', () => {
    it('should handle invalid JSON gracefully', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      await redis.rpush(queueKey, 'not-valid-json');

      const result = await redis.lpop(queueKey);
      expect(() => JSON.parse(result!)).toThrow();
    }, 10000);

    it('should handle empty queue', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:empty:${testGroup}`;

      const result = await redis.lpop(queueKey);
      expect(result).toBeNull();
    });

    it('should handle large messages', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const queueKey = `${NAMESPACE}:tasks:${testGroup}`;

      const largeMessage = {
        id: 'large',
        data: 'x'.repeat(10000),
      };

      await redis.rpush(queueKey, JSON.stringify(largeMessage));

      const result = await redis.lpop(queueKey);
      expect(result).not.toBeNull();

      const parsed = JSON.parse(result!);
      expect(parsed.data.length).toBe(10000);
    });
  });
});
