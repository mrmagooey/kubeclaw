import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Redis } from 'ioredis';

vi.mock('ioredis', () => {
  class MockRedis {
    on = vi.fn();
    quit = vi.fn().mockResolvedValue('OK');
  }
  return { Redis: MockRedis };
});

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  getRedisConfig,
  createRedisClient,
  getRedisClient,
  getRedisSubscriber,
  closeRedisConnections,
  getOutputChannel,
  getTaskChannel,
  getInputStream,
  getJobStatusKey,
  getJobOutputKey,
  getConcurrencyKey,
  getQueueKey,
  getSessionKey,
} from './redis-client.js';

describe('getRedisConfig', () => {
  it('returns default config when REDIS_URL is not set', () => {
    delete process.env.REDIS_URL;
    const config = getRedisConfig();
    expect(config.url).toBe('redis://nanoclaw-redis:6379');
    expect(config.maxRetriesPerRequest).toBe(3);
    expect(config.enableReadyCheck).toBe(true);
  });

  it('uses REDIS_URL from environment', () => {
    process.env.REDIS_URL = 'redis://custom:6380';
    const config = getRedisConfig();
    expect(config.url).toBe('redis://custom:6380');
    delete process.env.REDIS_URL;
  });
});

describe('createRedisClient', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const module = await import('./redis-client.js');
    await module.closeRedisConnections();
  });

  it('creates a Redis client that is a valid instance', async () => {
    const { createRedisClient } = await import('./redis-client.js');
    const client = createRedisClient();
    expect(client).toBeDefined();
    expect(typeof client.on).toBe('function');
    expect(typeof client.quit).toBe('function');
  });
});

describe('getRedisClient', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const module = await import('./redis-client.js');
    await module.closeRedisConnections();
  });

  it('returns singleton Redis client', async () => {
    const { getRedisClient } = await import('./redis-client.js');
    const client1 = getRedisClient();
    const client2 = getRedisClient();
    expect(client1).toBe(client2);
  });
});

describe('getRedisSubscriber', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const module = await import('./redis-client.js');
    await module.closeRedisConnections();
  });

  it('returns singleton Redis subscriber', async () => {
    const { getRedisSubscriber } = await import('./redis-client.js');
    const sub1 = getRedisSubscriber();
    const sub2 = getRedisSubscriber();
    expect(sub1).toBe(sub2);
  });

  it('returns different instance from getRedisClient', async () => {
    const { getRedisClient, getRedisSubscriber } =
      await import('./redis-client.js');
    const client = getRedisClient();
    const subscriber = getRedisSubscriber();
    expect(client).not.toBe(subscriber);
  });
});

describe('closeRedisConnections', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const module = await import('./redis-client.js');
    await module.closeRedisConnections();
  });

  it('closes both client and subscriber connections', async () => {
    const { getRedisClient, getRedisSubscriber, closeRedisConnections } =
      await import('./redis-client.js');
    const client = getRedisClient();
    const subscriber = getRedisSubscriber();

    await closeRedisConnections();

    expect(client.quit).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it('handles closing when clients are null', async () => {
    await closeRedisConnections();
    await closeRedisConnections();
  });
});

describe('Channel key generators', () => {
  describe('getOutputChannel', () => {
    it('generates correct output channel key', () => {
      expect(getOutputChannel('my-group')).toBe('nanoclaw:messages:my-group');
    });
  });

  describe('getTaskChannel', () => {
    it('generates correct task channel key', () => {
      expect(getTaskChannel('my-group')).toBe('nanoclaw:tasks:my-group');
    });
  });

  describe('getInputStream', () => {
    it('generates correct input stream key', () => {
      expect(getInputStream('job-123')).toBe('nanoclaw:input:job-123');
    });
  });

  describe('getJobStatusKey', () => {
    it('generates correct job status key', () => {
      expect(getJobStatusKey('job-456')).toBe('nanoclaw:job:job-456:status');
    });
  });

  describe('getJobOutputKey', () => {
    it('generates correct job output key', () => {
      expect(getJobOutputKey('job-789')).toBe('nanoclaw:job:job-789:output');
    });
  });

  describe('getConcurrencyKey', () => {
    it('returns static concurrency key', () => {
      expect(getConcurrencyKey()).toBe('nanoclaw:concurrency');
    });
  });

  describe('getQueueKey', () => {
    it('returns static queue key', () => {
      expect(getQueueKey()).toBe('nanoclaw:job-queue');
    });
  });

  describe('getSessionKey', () => {
    it('generates correct session key', () => {
      expect(getSessionKey('my-group')).toBe('nanoclaw:sessions:my-group');
    });
  });
});
