import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Redis } from 'ioredis';

vi.mock('ioredis', () => {
  class MockRedis {
    constructorArgs: unknown[];
    on = vi.fn();
    quit = vi.fn().mockResolvedValue('OK');
    constructor(...args: unknown[]) {
      this.constructorArgs = args;
    }
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
  getRedisStreamWatcher,
  createStreamWatcherClient,
  closeRedisConnections,
  getOutputChannel,
  getTaskChannel,
  getInputStream,
  getJobStatusKey,
  getJobOutputKey,
  getConcurrencyKey,
  getQueueKey,
  getSessionKey,
  getToolCallsStream,
  getToolResultsStream,
  getSpawnToolPodStream,
  getSpawnToolJobStream,
  getToolJobResultStream,
  getTaskRequestStream,
  getControlChannel,
  getChannelStatusChannel,
  getDiscoveryRequestStream,
  getDiscoveryResponseKey,
  getFindToolsStream,
  getFindToolsResultStream,
} from './redis-client.js';
import { logger } from '../logger.js';

describe('getRedisConfig', () => {
  it('returns default config when REDIS_URL is not set', () => {
    delete process.env.REDIS_URL;
    const config = getRedisConfig();
    expect(config.url).toBe('redis://kubeclaw-redis:6379');
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

describe('getRedisStreamWatcher', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const module = await import('./redis-client.js');
    await module.closeRedisConnections();
  });

  it('returns singleton stream-watcher client', async () => {
    const { getRedisStreamWatcher } = await import('./redis-client.js');
    const w1 = getRedisStreamWatcher();
    const w2 = getRedisStreamWatcher();
    expect(w1).toBe(w2);
  });

  it('is distinct from the shared client and the subscriber', async () => {
    const { getRedisClient, getRedisSubscriber, getRedisStreamWatcher } =
      await import('./redis-client.js');
    const client = getRedisClient();
    const subscriber = getRedisSubscriber();
    const watcher = getRedisStreamWatcher();
    expect(watcher).not.toBe(client);
    expect(watcher).not.toBe(subscriber);
  });

  it('uses maxRetriesPerRequest: null so transient DNS failures do not crash stream watchers', async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const ioredis = await import('ioredis');
    const RedisSpy = vi.spyOn(ioredis, 'Redis' as keyof typeof ioredis);

    const { getRedisStreamWatcher, closeRedisConnections } =
      await import('./redis-client.js');
    getRedisStreamWatcher();

    // The last call to Redis constructor should have maxRetriesPerRequest: null
    const calls = RedisSpy.mock.calls;
    const lastCall = calls[calls.length - 1];
    // Constructor signature: new Redis(url, options)
    const options = lastCall?.[1] as Record<string, unknown>;
    expect(options?.maxRetriesPerRequest).toBeNull();

    await closeRedisConnections();
  });
});

describe('createStreamWatcherClient', () => {
  it('returns a new instance on each call (not a singleton)', async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { createStreamWatcherClient, closeRedisConnections } =
      await import('./redis-client.js');
    const w1 = createStreamWatcherClient();
    const w2 = createStreamWatcherClient();
    expect(w1).not.toBe(w2);
    await closeRedisConnections();
  });

  it('uses maxRetriesPerRequest: null to survive transient DNS failures', async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const ioredis = await import('ioredis');
    const RedisSpy = vi.spyOn(ioredis, 'Redis' as keyof typeof ioredis);

    const { createStreamWatcherClient, closeRedisConnections } =
      await import('./redis-client.js');
    createStreamWatcherClient();

    const calls = RedisSpy.mock.calls;
    const lastCall = calls[calls.length - 1];
    const options = lastCall?.[1] as Record<string, unknown>;
    expect(options?.maxRetriesPerRequest).toBeNull();

    await closeRedisConnections();
  });
});

describe('closeRedisConnections', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const module = await import('./redis-client.js');
    await module.closeRedisConnections();
  });

  it('closes client, subscriber, and stream-watcher connections', async () => {
    const {
      getRedisClient,
      getRedisSubscriber,
      getRedisStreamWatcher,
      closeRedisConnections,
    } = await import('./redis-client.js');
    const client = getRedisClient();
    const subscriber = getRedisSubscriber();
    const watcher = getRedisStreamWatcher();

    await closeRedisConnections();

    expect(client.quit).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
    expect(watcher.quit).toHaveBeenCalled();
  });

  it('handles closing when clients are null', async () => {
    await closeRedisConnections();
    await closeRedisConnections();
  });
});

describe('Channel key generators', () => {
  describe('getOutputChannel', () => {
    it('generates correct output channel key', () => {
      expect(getOutputChannel('my-group')).toBe('kubeclaw:messages:my-group');
    });
  });

  describe('getTaskChannel', () => {
    it('generates correct task channel key', () => {
      expect(getTaskChannel('my-group')).toBe('kubeclaw:tasks:my-group');
    });
  });

  describe('getInputStream', () => {
    it('generates correct input stream key', () => {
      expect(getInputStream('job-123')).toBe('kubeclaw:input:job-123');
    });
  });

  describe('getJobStatusKey', () => {
    it('generates correct job status key', () => {
      expect(getJobStatusKey('job-456')).toBe('kubeclaw:job:job-456:status');
    });
  });

  describe('getJobOutputKey', () => {
    it('generates correct job output key', () => {
      expect(getJobOutputKey('job-789')).toBe('kubeclaw:job:job-789:output');
    });
  });

  describe('getConcurrencyKey', () => {
    it('returns static concurrency key', () => {
      expect(getConcurrencyKey()).toBe('kubeclaw:concurrency');
    });
  });

  describe('getQueueKey', () => {
    it('returns static queue key', () => {
      expect(getQueueKey()).toBe('kubeclaw:job-queue');
    });
  });

  describe('getSessionKey', () => {
    it('generates correct session key', () => {
      expect(getSessionKey('my-group')).toBe('kubeclaw:sessions:my-group');
    });
  });
});

describe('IPC key generators', () => {
  it('getToolCallsStream returns correct key', () => {
    expect(getToolCallsStream('job-abc', 'search')).toBe(
      'kubeclaw:toolcalls:job-abc:search',
    );
  });

  it('getToolResultsStream returns correct key', () => {
    expect(getToolResultsStream('job-abc', 'search')).toBe(
      'kubeclaw:toolresults:job-abc:search',
    );
  });

  it('getSpawnToolPodStream returns static key', () => {
    expect(getSpawnToolPodStream()).toBe('kubeclaw:spawn-tool-pod');
  });

  it('getSpawnToolJobStream returns static key', () => {
    expect(getSpawnToolJobStream()).toBe('kubeclaw:spawn-agent-job');
  });

  it('getToolJobResultStream returns correct key', () => {
    expect(getToolJobResultStream('tool-789')).toBe(
      'kubeclaw:agent-job-result:tool-789',
    );
  });

  it('getTaskRequestStream returns static key', () => {
    expect(getTaskRequestStream()).toBe('kubeclaw:task-requests');
  });

  it('getControlChannel returns correct key', () => {
    expect(getControlChannel('telegram')).toBe('kubeclaw:control:telegram');
  });

  it('getChannelStatusChannel returns correct key', () => {
    expect(getChannelStatusChannel('irc')).toBe('kubeclaw:channel-status:irc');
  });

  it('getDiscoveryRequestStream returns static key', () => {
    expect(getDiscoveryRequestStream()).toBe('kubeclaw:discovery:request');
  });

  it('getDiscoveryResponseKey returns correct key', () => {
    expect(getDiscoveryResponseKey('req-001')).toBe(
      'kubeclaw:discovery:response:req-001',
    );
  });
});

describe('createRedisClient event handlers (A5)', () => {
  it('ready event fires logger.debug', async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Set up a fresh mock that stores event handlers by name
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    vi.doMock('ioredis', () => {
      class MockRedisWithHandlers {
        on(event: string, cb: (...args: unknown[]) => void) {
          handlers[event] = cb;
        }
        quit = vi.fn().mockResolvedValue('OK');
      }
      return { Redis: MockRedisWithHandlers };
    });

    const { createRedisClient, closeRedisConnections } =
      await import('./redis-client.js');
    const { logger: freshLogger } = await import('../logger.js');

    createRedisClient();

    // Fire the ready event
    handlers['ready']?.();

    expect(vi.mocked(freshLogger.debug)).toHaveBeenCalled();

    await closeRedisConnections();
    vi.doUnmock('ioredis');
  });

  it('error event fires logger.error', async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const handlers: Record<string, (...args: unknown[]) => void> = {};
    vi.doMock('ioredis', () => {
      class MockRedisWithHandlers {
        on(event: string, cb: (...args: unknown[]) => void) {
          handlers[event] = cb;
        }
        quit = vi.fn().mockResolvedValue('OK');
      }
      return { Redis: MockRedisWithHandlers };
    });

    const { createRedisClient, closeRedisConnections } =
      await import('./redis-client.js');
    const { logger: freshLogger } = await import('../logger.js');

    createRedisClient();

    handlers['error']?.(new Error('connection failed'));

    expect(vi.mocked(freshLogger.error)).toHaveBeenCalled();

    await closeRedisConnections();
    vi.doUnmock('ioredis');
  });

  it('close event fires logger.warn', async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const handlers: Record<string, (...args: unknown[]) => void> = {};
    vi.doMock('ioredis', () => {
      class MockRedisWithHandlers {
        on(event: string, cb: (...args: unknown[]) => void) {
          handlers[event] = cb;
        }
        quit = vi.fn().mockResolvedValue('OK');
      }
      return { Redis: MockRedisWithHandlers };
    });

    const { createRedisClient, closeRedisConnections } =
      await import('./redis-client.js');
    const { logger: freshLogger } = await import('../logger.js');

    createRedisClient();

    handlers['close']?.();

    expect(vi.mocked(freshLogger.warn)).toHaveBeenCalled();

    await closeRedisConnections();
    vi.doUnmock('ioredis');
  });
});

describe('find-tools stream names', () => {
  it('produces the request stream name', () => {
    expect(getFindToolsStream()).toBe('kubeclaw:find-tools');
  });
  it('produces a per-request result stream name', () => {
    expect(getFindToolsResultStream('abc')).toBe(
      'kubeclaw:find-tools-result:abc',
    );
  });
});
