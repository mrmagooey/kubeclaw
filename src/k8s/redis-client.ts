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

export function getRedisConfig(): RedisConfig {
  return {
    url: process.env.REDIS_URL || 'redis://kubeclaw-redis:6379',
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  };
}

export function createRedisClient(): Redis {
  const config = getRedisConfig();

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

export async function closeRedisConnections(): Promise<void> {
  if (redisSubscriber) {
    await redisSubscriber.quit();
    redisSubscriber = null;
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

export function getSpawnAgentJobStream(): string {
  return 'kubeclaw:spawn-agent-job';
}

export function getAgentJobResultStream(agentJobId: string): string {
  return `kubeclaw:agent-job-result:${agentJobId}`;
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
