/**
 * Redis client singleton for Kubernetes runtime
 * Manages connections for pub/sub and stream operations
 */
import { Redis } from 'ioredis';
import { REDIS_ADMIN_PASSWORD, REDIS_USERNAME } from '../config.js';
import { logger } from '../logger.js';
import { RedisConfig } from './types.js';

let redisClient: Redis | null = null;
let redisSubscriber: Redis | null = null;
// Dedicated connections for long-lived stream watchers that use XREAD BLOCK.
// Keeping them separate from the shared client prevents blocking I/O
// (e.g. XREAD BLOCK 5000) from queueing pub/sub or other commands on the
// same single-connection client, which would cause multi-second delays.
let redisStreamWatcher: Redis | null = null;

export function getRedisConfig(): RedisConfig {
  return {
    url: process.env.REDIS_URL || 'redis://kubeclaw-redis:6379',
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  };
}

export function createRedisClient(overrides: Partial<RedisConfig> = {}): Redis {
  const config = { ...getRedisConfig(), ...overrides };

  const client = new Redis(config.url, {
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    enableReadyCheck: config.enableReadyCheck,
    ...(REDIS_USERNAME ? { username: REDIS_USERNAME } : {}),
    ...(REDIS_ADMIN_PASSWORD ? { password: REDIS_ADMIN_PASSWORD } : {}),
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      logger.debug({ attempt: times, delay }, 'Redis retry');
      return delay;
    },
    reconnectOnError: (err) => {
      logger.warn({ error: err.message }, 'Redis error, reconnecting');
      return true;
    },
  });

  client.on('connect', () => {
    logger.info('Redis client connected');
  });

  client.on('ready', () => {
    logger.debug('Redis client ready');
  });

  client.on('error', (err) => {
    logger.error({ error: err }, 'Redis client error');
  });

  client.on('close', () => {
    logger.warn('Redis client connection closed');
  });

  return client;
}

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient();
  }
  return redisClient;
}

export function getRedisSubscriber(): Redis {
  if (!redisSubscriber) {
    redisSubscriber = createRedisClient();
  }
  return redisSubscriber;
}

/**
 * Returns the shared Redis stream-watcher singleton.
 *
 * @deprecated Multiple concurrent XREAD BLOCK callers must each call
 * `createStreamWatcherClient()` to get their own dedicated connection.
 * Sharing this singleton causes blocking contention — only one XREAD
 * can be active per TCP connection at a time.
 *
 * maxRetriesPerRequest is null (infinite) so that transient DNS or network
 * blips — common in minikube and during pod restarts — do not permanently
 * crash the stream watchers. ioredis will keep retrying the XREAD command
 * until the connection is restored, instead of throwing MaxRetriesPerRequestError
 * after just 3 attempts.
 */
export function getRedisStreamWatcher(): Redis {
  if (!redisStreamWatcher) {
    redisStreamWatcher = createRedisClient({ maxRetriesPerRequest: null });
  }
  return redisStreamWatcher;
}

/**
 * Creates a **new, independent** Redis connection suitable for a single
 * long-lived XREAD BLOCK watcher loop. Unlike `getRedisStreamWatcher()`,
 * this is NOT a singleton — every call returns a fresh connection.
 *
 * Each blocking XREAD loop must own its own connection. Sharing a single
 * connection across multiple concurrent XREAD BLOCK calls causes only one
 * command to be active at a time, leaving the other watchers stalled until
 * the active XREAD unblocks (up to BLOCK ms later).
 *
 * maxRetriesPerRequest is null (infinite) so transient DNS blips do not
 * throw MaxRetriesPerRequestError and crash the watcher permanently.
 * The caller is responsible for calling `.quit()` when it is done.
 */
export function createStreamWatcherClient(): Redis {
  return createRedisClient({ maxRetriesPerRequest: null });
}

export async function closeRedisConnections(): Promise<void> {
  if (redisSubscriber) {
    await redisSubscriber.quit();
    redisSubscriber = null;
  }
  if (redisStreamWatcher) {
    await redisStreamWatcher.quit();
    redisStreamWatcher = null;
  }
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
  logger.info('Redis connections closed');
}

// Channel name generators
export function getOutputChannel(groupFolder: string): string {
  return `kubeclaw:messages:${groupFolder}`;
}

export function getTaskChannel(groupFolder: string): string {
  return `kubeclaw:tasks:${groupFolder}`;
}

export function getInputStream(jobId: string): string {
  return `kubeclaw:input:${jobId}`;
}

export function getJobStatusKey(jobId: string): string {
  return `kubeclaw:job:${jobId}:status`;
}

export function getJobOutputKey(jobId: string): string {
  return `kubeclaw:job:${jobId}:output`;
}

export function getConcurrencyKey(): string {
  return 'kubeclaw:concurrency';
}

export function getQueueKey(): string {
  return 'kubeclaw:job-queue';
}

export function getSessionKey(groupFolder: string): string {
  return `kubeclaw:sessions:${groupFolder}`;
}

export function getToolCallsStream(
  agentJobId: string,
  category: string,
): string {
  return `kubeclaw:toolcalls:${agentJobId}:${category}`;
}

export function getToolResultsStream(
  agentJobId: string,
  category: string,
): string {
  return `kubeclaw:toolresults:${agentJobId}:${category}`;
}

export function getSpawnToolPodStream(): string {
  return 'kubeclaw:spawn-tool-pod';
}

export function getSpawnToolJobStream(): string {
  return 'kubeclaw:spawn-agent-job';
}

export function getFindToolsStream(): string {
  return 'kubeclaw:find-tools';
}

export function getFindToolsResultStream(requestId: string): string {
  return `kubeclaw:find-tools-result:${requestId}`;
}

export function getToolJobResultStream(toolJobId: string): string {
  return `kubeclaw:agent-job-result:${toolJobId}`;
}

export function getTaskRequestStream(): string {
  return 'kubeclaw:task-requests';
}

export function getControlChannel(channelName: string): string {
  return `kubeclaw:control:${channelName}`;
}

export function getChannelStatusChannel(channelName: string): string {
  return `kubeclaw:channel-status:${channelName}`;
}

export function getDiscoveryRequestStream(): string {
  return 'kubeclaw:discovery:request';
}

export function getDiscoveryResponseKey(requestId: string): string {
  return `kubeclaw:discovery:response:${requestId}`;
}
