import { beforeAll, afterAll, beforeEach, afterEach, test } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import {
  startMockLLMServer,
  stopMockLLMServer,
} from './lib/mock-llm-server.js';
import { _initTestDatabase } from '../src/db.js';

const NAMESPACE = process.env.NAMESPACE || 'kubeclaw';

function getRedisUrl(): string {
  // Prefer the kubeclaw-specific Redis URL set by global-setup's port-forward.
  // This ensures host-side subscribers use the same Redis as in-cluster adapters.
  if (process.env.KUBECLAW_REDIS_URL) {
    return process.env.KUBECLAW_REDIS_URL;
  }

  if (process.env.REDIS_URL) {
    return process.env.REDIS_URL;
  }

  return 'redis://localhost:6379';
}

let sharedRedis: import('ioredis').Redis | null = null;
let testNamespace: string = '';
let mockLlmPort: number | null = null;

export function getSharedRedis(): import('ioredis').Redis | null {
  return sharedRedis;
}

export function getTestNamespace(): string {
  return testNamespace;
}

export function getNamespace(): string {
  return NAMESPACE;
}

export function getRedisUrlForTests(): string {
  return getRedisUrl();
}

export function getMockLlmPort(): number | null {
  return mockLlmPort;
}

beforeAll(async () => {
  console.log('\n🚀 Starting Mock LLM Server...');
  mockLlmPort = await startMockLLMServer({});
  console.log(`   Mock LLM running on port ${mockLlmPort}\n`);

  // Always initialize the test database — it uses an in-memory SQLite DB
  // and does not depend on Redis.
  console.log('🗄️ Initializing test database...');
  await _initTestDatabase();
  console.log('✅ Test database initialized\n');

  const redisUrl = getRedisUrl();
  console.log(`\n🔌 Connecting to Redis: ${redisUrl}`);

  const { default: Redis } = await import('ioredis');

  // Retry Redis connection with backoff — when many test forks start simultaneously,
  // the kubectl port-forward may briefly refuse connections under load.
  for (let attempt = 1; attempt <= 5; attempt++) {
    sharedRedis = new Redis(redisUrl, {
      connectTimeout: 10000,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    try {
      await sharedRedis.connect();
      await sharedRedis.ping();
      console.log('✅ Redis connected successfully\n');
      break;
    } catch (error) {
      await sharedRedis.quit().catch(() => {});
      sharedRedis = null;
      if (attempt < 5) {
        console.warn(`   Redis connection attempt ${attempt}/5 failed, retrying in 2s...`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        console.warn(`⚠️  Redis not available at ${redisUrl} — tests that require Redis will be skipped\n`);
      }
    }
  }

  testNamespace = `test-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}, 60000);

afterAll(async () => {
  if (mockLlmPort) {
    console.log('\n🧹 Stopping Mock LLM Server...');
    await stopMockLLMServer();
    mockLlmPort = null;
  }

  if (sharedRedis) {
    console.log('\n🧹 Cleaning up test data...');

    try {
      const deleted = await scanDel(sharedRedis, `${NAMESPACE}:test-*`);
      if (deleted > 0) {
        console.log(`   Deleted ${deleted} test keys`);
      }
    } catch (error) {
      console.warn('   Warning: Failed to clean up test keys:', error);
    }

    await sharedRedis.quit();
    console.log('✅ Redis connection closed\n');
  }
}, 10000);

beforeEach(async () => {
  if (sharedRedis && sharedRedis.status === 'ready') {
    await scanDel(sharedRedis, `${NAMESPACE}:test-*`);
  }
}, 10000);

/**
 * Delete all keys matching a pattern using SCAN so we never block Redis
 * with a single O(N) KEYS call.
 */
async function scanDel(
  redis: import('ioredis').Redis,
  pattern: string,
): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      100,
    );
    cursor = next;
    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== '0');
  return deleted;
}

export async function flushTestKeys(
  redis: import('ioredis').Redis,
  prefix: string = 'test-*',
): Promise<number> {
  return scanDel(redis, `${NAMESPACE}:${prefix}`);
}

/**
 * Poll until `condition` returns true or the timeout expires.
 * Throws if the timeout is reached, making the calling test fail with a
 * meaningful message rather than a confusing assertion on stale state.
 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 3000,
  intervalMs: number = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

export function createTestNamespace(): string {
  return `test-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Helper function to check if running in Kubernetes environment
 */
export function isKubernetesAvailable(): boolean {
  try {
    execSync('kubectl cluster-info', { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Helper function to check if kubeclaw is fully deployed (helm install complete).
 * Checks for the Redis service rather than just the namespace, since the namespace
 * is pre-created before helm runs and would give a false positive.
 */
export function isKubeclawDeployed(): boolean {
  const result = spawnSync(
    'kubectl',
    ['get', 'service', 'kubeclaw-redis', '-n', 'kubeclaw'],
    { stdio: 'pipe', timeout: 5000 },
  );
  return result.status === 0;
}

/**
 * Helper function to check if Redis is available
 */
export async function isRedisAvailable(): Promise<boolean> {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(getRedisUrl(), {
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
  });

  try {
    await redis.ping();
    await redis.quit();
    return true;
  } catch {
    return false;
  }
}

/**
 * Helper that throws an error if Kubernetes is not available
 * This causes tests to fail rather than skip, ensuring infrastructure requirements are met
 */
export function requireKubernetes(): void {
  if (!isKubernetesAvailable()) {
    throw new Error(
      'Kubernetes is required for this test but is not available.\n\n' +
        'To fix this issue:\n' +
        '1. Ensure minikube is installed: https://minikube.sigs.k8s.io/docs/start/\n' +
        '2. Start minikube: minikube start --driver=docker --memory=4096 --cpus=2\n' +
        '3. Or run: make setup-minikube\n\n' +
        'The global setup should have attempted to start minikube automatically. ' +
        'If it failed, please start minikube manually and try again.',
    );
  }
}

/**
 * Helper to skip test if Kubernetes is not available (legacy - prefer requireKubernetes)
 * This is kept for backward compatibility with tests that specifically check error handling
 */
export function skipIfNoKubernetes() {
  if (!isKubernetesAvailable()) {
    return test.skip;
  }
  return test;
}

/**
 * Helper to skip test if Redis is not available
 */
export async function skipIfNoRedis() {
  if (!(await isRedisAvailable())) {
    return test.skip;
  }
  return test;
}
