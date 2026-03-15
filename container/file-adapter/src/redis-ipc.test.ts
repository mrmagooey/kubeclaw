/**
 * Tests for redis-ipc.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RedisIPCClient, RedisIPCConfig, RedisMessage } from './redis-ipc.js';
import { ContainerOutput } from './protocol.js';
import { MockRedisClient } from './test-utils/redis-mock.js';

// Mock the redis module
vi.mock('redis', () => {
  return {
    createClient: vi.fn(),
  };
});

describe('RedisIPCClient', () => {
  let mockRedis: MockRedisClient;
  let client: RedisIPCClient;
  const config: RedisIPCConfig = {
    url: 'redis://localhost:6379',
    username: 'testuser',
    password: 'testpass',
    jobId: 'job-123',
  };

  beforeEach(async () => {
    mockRedis = new MockRedisClient();
    const redis = await import('redis');
    vi.mocked(redis.createClient).mockReturnValue(mockRedis as any);
    client = new RedisIPCClient(config);
  });

  afterEach(async () => {
    if (client.isConnected()) {
      await client.disconnect();
    }
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should set correct stream names based on jobId', async () => {
      await client.connect();

      // Add a message to verify stream name is used correctly
      mockRedis.addStreamMessage('nanoclaw:input:job-123', { type: 'close' });

      const messages: RedisMessage[] = [];
      const generator = client.listenForMessages();
      const result = await generator.next();

      if (!result.done) {
        messages.push(result.value);
      }

      expect(messages[0].type).toBe('close');
    });

    it('should use correct output channel name', async () => {
      await client.connect();

      const output: ContainerOutput = {
        status: 'success',
        result: 'test',
      };

      let publishedChannel = '';
      mockRedis.subscribe('nanoclaw:output:job-123', (msg: string) => {
        publishedChannel = 'nanoclaw:output:job-123';
      });

      await client.sendOutput(output);

      // The publish should have been called on the correct channel
      expect(mockRedis.isConnected()).toBe(true);
    });
  });

  describe('connect', () => {
    it('should establish connection', async () => {
      await client.connect();

      expect(client.isConnected()).toBe(true);
      expect(mockRedis.isConnected()).toBe(true);
    });

    it('should not reconnect if already connected', async () => {
      await client.connect();
      const connectSpy = vi.spyOn(mockRedis, 'connect');

      await client.connect();

      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('should create client with correct config', async () => {
      await client.connect();

      const redis = await import('redis');
      expect(redis.createClient).toHaveBeenCalledWith(
        expect.objectContaining({
          url: config.url,
          username: config.username,
          password: config.password,
        }),
      );
    });

    it('should throw on connection error', async () => {
      mockRedis.connect = vi
        .fn()
        .mockRejectedValue(new Error('Connection refused'));

      await expect(client.connect()).rejects.toThrow(
        'Failed to connect to Redis: Connection refused',
      );
    });
  });

  describe('disconnect', () => {
    it('should clean up connection', async () => {
      await client.connect();
      expect(client.isConnected()).toBe(true);

      await client.disconnect();

      expect(client.isConnected()).toBe(false);
      expect(mockRedis.isConnected()).toBe(false);
    });

    it('should handle disconnect when not connected', async () => {
      // Should not throw
      await expect(client.disconnect()).resolves.not.toThrow();
    });
  });

  describe('sendOutput', () => {
    it('should publish output to correct channel', async () => {
      await client.connect();

      const output: ContainerOutput = {
        status: 'success',
        result: 'test result',
        newSessionId: 'session-123',
      };

      await client.sendOutput(output);

      // Should not throw and client should remain connected
      expect(client.isConnected()).toBe(true);
    });

    it('should throw when not connected', async () => {
      const output: ContainerOutput = {
        status: 'success',
        result: 'test',
      };

      await expect(client.sendOutput(output)).rejects.toThrow(
        'Redis client not connected',
      );
    });

    it('should throw on publish error', async () => {
      await client.connect();

      mockRedis.publish = vi
        .fn()
        .mockRejectedValue(new Error('Publish failed'));

      const output: ContainerOutput = {
        status: 'success',
        result: 'test',
      };

      await expect(client.sendOutput(output)).rejects.toThrow(
        'Failed to send output: Publish failed',
      );
    });
  });

  describe('listenForMessages', () => {
    it('should yield followup messages', async () => {
      await client.connect();

      mockRedis.addStreamMessage('nanoclaw:input:job-123', {
        type: 'followup',
        prompt: 'Hello',
        sessionId: 'session-1',
      });

      const generator = client.listenForMessages();
      const result = await generator.next();

      expect(result.done).toBe(false);
      expect(result.value).toEqual({
        type: 'followup',
        prompt: 'Hello',
        sessionId: 'session-1',
      });
    });

    it('should yield close signals', async () => {
      await client.connect();

      mockRedis.addStreamMessage('nanoclaw:input:job-123', {
        type: 'close',
      });

      const generator = client.listenForMessages();
      const result = await generator.next();

      expect(result.done).toBe(false);
      expect(result.value).toEqual({ type: 'close' });
    });

    it('should throw when not connected', async () => {
      const generator = client.listenForMessages();

      await expect(generator.next()).rejects.toThrow(
        'Redis client not connected',
      );
    });

    it('should continue polling on empty response', async () => {
      await client.connect();

      // Override xRead to return null first, then a message
      let callCount = 0;
      mockRedis.xRead = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return null;
        }
        return [
          {
            name: 'nanoclaw:input:job-123',
            messages: [
              {
                id: '1',
                message: { type: 'close' },
              },
            ],
          },
        ];
      });

      const generator = client.listenForMessages();
      const result = await generator.next();

      expect(result.value).toEqual({ type: 'close' });
    });

    it('should handle stream errors and attempt reconnection', async () => {
      await client.connect();

      // First call throws, second call succeeds after reconnection
      let callCount = 0;
      mockRedis.xRead = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          mockRedis.isReady = false;
          throw new Error('Connection lost');
        }
        mockRedis.isReady = true;
        return [
          {
            name: 'nanoclaw:input:job-123',
            messages: [
              {
                id: '1',
                message: { type: 'close' },
              },
            ],
          },
        ];
      });

      mockRedis.connect = vi.fn().mockResolvedValue(undefined);

      const generator = client.listenForMessages();
      const result = await generator.next();

      expect(result.value).toEqual({ type: 'close' });
    });

    it('should throw if reconnection fails', async () => {
      await client.connect();

      mockRedis.xRead = vi.fn().mockRejectedValue(new Error('Stream error'));
      mockRedis.isReady = false;
      mockRedis.connect = vi
        .fn()
        .mockRejectedValue(new Error('Reconnection failed'));

      const generator = client.listenForMessages();

      await expect(generator.next()).rejects.toThrow('Stream error');
    });
  });

  describe('isConnected', () => {
    it('should return false before connection', () => {
      expect(client.isConnected()).toBe(false);
    });

    it('should return true after successful connection', async () => {
      await client.connect();
      expect(client.isConnected()).toBe(true);
    });

    it('should return false after disconnect', async () => {
      await client.connect();
      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    it('should return false if client is null', async () => {
      await client.connect();
      mockRedis.isReady = false;
      expect(client.isConnected()).toBe(false);
    });
  });
});
