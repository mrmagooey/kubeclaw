/**
 * Tests for index.ts - Integration tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateEnv, sendOutput, log } from './index.js';
import { RedisIPCClient } from './redis-ipc.js';
import { ContainerOutput, writeMarkedOutput } from './protocol.js';
import { MockRedisClient } from './test-utils/redis-mock.js';

// Mock modules
vi.mock('redis', () => ({
  createClient: vi.fn(),
}));

vi.mock('./protocol.js', async () => {
  const actual = await vi.importActual('./protocol.js');
  return {
    ...actual,
    writeMarkedOutput: vi.fn(),
  };
});

describe('validateEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear the specific env vars we're testing
    delete process.env.REDIS_URL;
    delete process.env.REDIS_USERNAME;
    delete process.env.REDIS_PASSWORD;
    delete process.env.KUBECLAW_JOB_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return empty array when all vars are present', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.REDIS_USERNAME = 'user';
    process.env.REDIS_PASSWORD = 'pass';
    process.env.KUBECLAW_JOB_ID = 'job-123';

    const result = validateEnv();

    expect(result).toEqual([]);
  });

  it('should return missing vars when REDIS_URL is missing', () => {
    process.env.REDIS_USERNAME = 'user';
    process.env.REDIS_PASSWORD = 'pass';
    process.env.KUBECLAW_JOB_ID = 'job-123';

    const result = validateEnv();

    expect(result).toContain('REDIS_URL');
    expect(result).not.toContain('REDIS_USERNAME');
  });

  it('should return missing vars when REDIS_USERNAME is missing', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.REDIS_PASSWORD = 'pass';
    process.env.KUBECLAW_JOB_ID = 'job-123';

    const result = validateEnv();

    expect(result).toContain('REDIS_USERNAME');
  });

  it('should return missing vars when REDIS_PASSWORD is missing', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.REDIS_USERNAME = 'user';
    process.env.KUBECLAW_JOB_ID = 'job-123';

    const result = validateEnv();

    expect(result).toContain('REDIS_PASSWORD');
  });

  it('should return missing vars when KUBECLAW_JOB_ID is missing', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.REDIS_USERNAME = 'user';
    process.env.REDIS_PASSWORD = 'pass';

    const result = validateEnv();

    expect(result).toContain('KUBECLAW_JOB_ID');
  });

  it('should return all missing vars when none are set', () => {
    const result = validateEnv();

    expect(result).toHaveLength(4);
    expect(result).toContain('REDIS_URL');
    expect(result).toContain('REDIS_USERNAME');
    expect(result).toContain('REDIS_PASSWORD');
    expect(result).toContain('KUBECLAW_JOB_ID');
  });
});

describe('sendOutput', () => {
  let mockRedisClient: MockRedisClient;
  let redisClient: RedisIPCClient;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockRedisClient = new MockRedisClient();
    const redis = await import('redis');
    vi.mocked(redis.createClient).mockReturnValue(mockRedisClient as any);
    redisClient = new RedisIPCClient({
      url: 'redis://localhost',
      username: 'user',
      password: 'pass',
      jobId: 'job-123',
    });
    await redisClient.connect();

    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await redisClient.disconnect();
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('should send output via Redis when connection works', async () => {
    const output: ContainerOutput = {
      status: 'success',
      result: 'test result',
    };

    await sendOutput(redisClient, output);

    // Should not throw and client should be connected
    expect(redisClient.isConnected()).toBe(true);
  });

  it('should fall back to stdout when Redis fails', async () => {
    mockRedisClient.publish = vi
      .fn()
      .mockRejectedValue(new Error('Redis error'));

    const output: ContainerOutput = {
      status: 'success',
      result: 'test result',
    };

    await sendOutput(redisClient, output);

    expect(writeMarkedOutput).toHaveBeenCalledWith(output);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to send output via Redis'),
    );
  });
});

describe('log', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should log to stderr with prefix', () => {
    log('test message');

    expect(consoleSpy).toHaveBeenCalledWith('[http-adapter] test message');
  });
});
