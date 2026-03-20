/**
 * Tests for index.ts - Integration tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateEnv, sendOutput, processTask, log } from './index.js';
import { RedisIPCClient } from './redis-ipc.js';
import { FileIPC } from './file-ipc.js';
import {
  ContainerInput,
  ContainerOutput,
  writeMarkedOutput,
} from './protocol.js';
import { MockRedisClient } from './test-utils/redis-mock.js';
import { mockFs } from './test-utils/fs-mock.js';

// Mock modules
vi.mock('redis', () => ({
  createClient: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn((path: string, opts?: { recursive?: boolean }) =>
      mockFs.mkdirSync(path, opts),
    ),
    writeFileSync: vi.fn((path: string, data: string) =>
      mockFs.writeFileSync(path, data),
    ),
    readFileSync: vi.fn((path: string, encoding?: string) =>
      mockFs.readFileSync(path, encoding),
    ),
    existsSync: vi.fn((path: string) => mockFs.existsSync(path)),
    readdirSync: vi.fn((path: string) => mockFs.readdirSync(path)),
    unlinkSync: vi.fn((path: string) => mockFs.unlinkSync(path)),
  },
  mkdirSync: vi.fn((path: string, opts?: { recursive?: boolean }) =>
    mockFs.mkdirSync(path, opts),
  ),
  writeFileSync: vi.fn((path: string, data: string) =>
    mockFs.writeFileSync(path, data),
  ),
  readFileSync: vi.fn((path: string, encoding?: string) =>
    mockFs.readFileSync(path, encoding),
  ),
  existsSync: vi.fn((path: string) => mockFs.existsSync(path)),
  readdirSync: vi.fn((path: string) => mockFs.readdirSync(path)),
  unlinkSync: vi.fn((path: string) => mockFs.unlinkSync(path)),
}));

vi.mock('path', () => ({
  default: {
    join: vi.fn((...parts: string[]) => parts.join('/').replace(/\/+/g, '/')),
  },
  join: vi.fn((...parts: string[]) => parts.join('/').replace(/\/+/g, '/')),
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

describe('processTask', () => {
  let fileIPC: FileIPC;
  const inputDir = '/workspace/input';
  const outputDir = '/workspace/output';

  beforeEach(() => {
    mockFs.reset();
    fileIPC = new FileIPC({
      inputDir,
      outputDir,
      pollInterval: 50,
      timeout: 1000,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should write task and wait for result', async () => {
    const containerInput: ContainerInput = {
      prompt: 'test prompt',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: true,
      sessionId: 'session-123',
    };

    // Create result file after a short delay
    setTimeout(() => {
      mockFs.writeFileSync(
        `${outputDir}/result.json`,
        JSON.stringify({
          status: 'success',
          result: 'task result',
          newSessionId: 'session-456',
        }),
      );
    }, 100);

    const result = await processTask(fileIPC, containerInput, 'session-123');

    expect(result.output.status).toBe('success');
    expect(result.output.result).toBe('task result');
    expect(result.sessionId).toBe('session-456');
  });

  it('should handle timeout', async () => {
    const fileIPCWithShortTimeout = new FileIPC({
      inputDir,
      outputDir,
      pollInterval: 50,
      timeout: 100, // Very short timeout
    });

    const containerInput: ContainerInput = {
      prompt: 'test prompt',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: true,
    };

    const result = await processTask(
      fileIPCWithShortTimeout,
      containerInput,
      undefined,
    );

    expect(result.output.status).toBe('error');
    expect(result.output.error).toBe(
      'Timeout waiting for user container output',
    );
  });

  it('should preserve sessionId when not updated', async () => {
    const containerInput: ContainerInput = {
      prompt: 'test prompt',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: true,
      sessionId: 'session-123',
    };

    mockFs.writeFileSync(
      `${outputDir}/result.json`,
      JSON.stringify({
        status: 'success',
        result: 'result',
        // No newSessionId
      }),
    );

    const result = await processTask(fileIPC, containerInput, 'session-123');

    expect(result.sessionId).toBe('session-123');
  });

  it('should handle error result', async () => {
    const containerInput: ContainerInput = {
      prompt: 'test prompt',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: true,
    };

    mockFs.writeFileSync(
      `${outputDir}/result.json`,
      JSON.stringify({
        status: 'error',
        result: null,
        error: 'Task failed',
      }),
    );

    const result = await processTask(fileIPC, containerInput, undefined);

    expect(result.output.status).toBe('error');
    expect(result.output.error).toBe('Task failed');
  });

  it('should cleanup files after processing', async () => {
    const containerInput: ContainerInput = {
      prompt: 'test prompt',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: true,
    };

    mockFs.writeFileSync(
      `${outputDir}/result.json`,
      JSON.stringify({
        status: 'success',
        result: 'result',
      }),
    );

    await processTask(fileIPC, containerInput, undefined);

    expect(mockFs.existsSync(`${outputDir}/result.json`)).toBe(false);
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

    expect(consoleSpy).toHaveBeenCalledWith('[file-adapter] test message');
  });
});
