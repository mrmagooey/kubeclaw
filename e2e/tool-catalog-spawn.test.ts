/**
 * Tool Catalog Spawn — Integration Test (real Redis round-trip, jobRunner mocked)
 *
 * Tests the orchestrator's startToolPodSpawnWatcher() catalog-resolution path:
 *   1. Resolve + spawn: catalog tool name → spec resolved → sidecar pod spawned
 *   2. Channel-scope rejection: tool not scoped to requesting channel → error result
 *   3. Unknown name: resolver returns undefined → error result
 *
 * Unit-level equivalents (mocked Redis) live in src/k8s/ipc-redis.test.ts (Task 8).
 * This file adds a REAL Redis round-trip: the spawn stream is seeded via ioredis,
 * the watcher reads it over a live TCP connection, and error results are read back
 * from the same Redis instance. jobRunner is mocked; no Kubernetes required.
 *
 * Skip condition: if Redis is unavailable (getSharedRedis() returns null after
 * setup.ts's beforeAll), all tests in this file are skipped with a console.warn.
 *
 * Ordering discipline: each test deletes the spawn stream BEFORE starting the
 * watcher, then adds the test message AFTER the watcher is running. This ensures
 * resolveStreamTip() returns '0-0' (empty stream → lastId = '0-0'), so the
 * watcher picks up the newly-added message on its first XREAD iteration.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { getSharedRedis, getRedisUrlForTests, redisAvailable } from './setup.js';

// ── Hoisted refs: real Redis connections injected before module load ──────────
// vi.hoisted runs before vi.mock factories, so the refs are populated by the
// time the mock factory for redis-client is called during module resolution.
const redisClientHolder = vi.hoisted(() => ({ client: null as Redis | null }));
const streamWatcherHolder = vi.hoisted(() => ({ client: null as Redis | null }));

// A stub subscriber used by startIpcWatcher. It must NOT be our real `redis`
// connection because stopIpcWatcher calls .unsubscribe() + .quit() on it,
// which would close the connection we need for the rest of the tests.
const stubSubscriber = vi.hoisted(() => ({
  subscribe: vi.fn().mockResolvedValue(undefined),
  psubscribe: vi.fn((_pattern: string, cb?: (err: unknown) => void) => {
    cb?.(null);
  }),
  unsubscribe: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue('OK'),
  on: vi.fn(),
}));

// ── Mock: job runner (no Kubernetes) ─────────────────────────────────────────
vi.mock('../src/k8s/job-runner.js', () => ({
  jobRunner: {
    createToolPodJob: vi.fn().mockResolvedValue('mock-tool-pod'),
    createSidecarToolPodJob: vi.fn().mockResolvedValue('mock-sidecar-pod'),
    stopJob: vi.fn().mockResolvedValue(undefined),
    runToolJob: vi.fn().mockResolvedValue({ status: 'success', result: 'ok' }),
    applyYamlToK8s: vi.fn().mockResolvedValue(undefined),
  },
}));

// ── Mock: Redis client — real connections, injected via hoisted holder ────────
// The spawn-watcher uses createStreamWatcherClient() for XREAD and
// getRedisClient() for writing error results (writeToolError). Both are backed
// by the same shared test Redis, which lets us seed + read from a single client.
vi.mock('../src/k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => redisClientHolder.client!),
  createStreamWatcherClient: vi.fn(() => streamWatcherHolder.client!),
  // Use the stub subscriber — stopIpcWatcher() calls .quit() on it, which
  // must NOT close our real `redis` connection.
  getRedisSubscriber: vi.fn(() => stubSubscriber),
  getRedisStreamWatcher: vi.fn(() => redisClientHolder.client!),
  getSpawnToolPodStream: vi.fn(() => 'kubeclaw:spawn-tool-pod'),
  getSpawnToolJobStream: vi.fn(() => 'kubeclaw:spawn-agent-job'),
  getTaskRequestStream: vi.fn(() => 'kubeclaw:task-requests'),
  getToolJobResultStream: vi.fn((id: string) => `kubeclaw:agent-job-result:${id}`),
  getOutputChannel: vi.fn((folder: string) => `kubeclaw:messages:${folder}`),
  getTaskChannel: vi.fn((folder: string) => `kubeclaw:tasks:${folder}`),
  getInputStream: vi.fn((jobId: string) => `kubeclaw:input:${jobId}`),
  getControlChannel: vi.fn((ch: string) => `kubeclaw:control:${ch}`),
  getChannelStatusChannel: vi.fn((ch: string) => `kubeclaw:channel-status:${ch}`),
  getDiscoveryRequestStream: vi.fn(() => 'kubeclaw:discovery:request'),
  getDiscoveryResponseKey: vi.fn((id: string) => `kubeclaw:discovery:response:${id}`),
  getJobStatusKey: vi.fn((id: string) => `kubeclaw:job:${id}:status`),
  getJobOutputKey: vi.fn((id: string) => `kubeclaw:job:${id}:output`),
  getConcurrencyKey: vi.fn(() => 'kubeclaw:concurrency'),
  getQueueKey: vi.fn(() => 'kubeclaw:job-queue'),
  getSessionKey: vi.fn((folder: string) => `kubeclaw:sessions:${folder}`),
  getToolCallsStream: vi.fn(
    (id: string, cat: string) => `kubeclaw:toolcalls:${id}:${cat}`,
  ),
  getToolResultsStream: vi.fn(
    (id: string, cat: string) => `kubeclaw:toolresults:${id}:${cat}`,
  ),
  closeRedisConnections: vi.fn().mockResolvedValue(undefined),
  createRedisClient: vi.fn(),
}));

// ── Mock: heavy dependencies not under test ───────────────────────────────────
vi.mock('../src/config.js', () => ({
  TIMEZONE: 'UTC',
  CONTAINER_TIMEOUT: 1800000,
  IDLE_TIMEOUT: 1800000,
  ASSISTANT_NAME: 'TestBot',
  REDIS_ADMIN_PASSWORD: '',
  REDIS_USERNAME: '',
}));

vi.mock('../src/db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  getTasksForGroup: vi.fn().mockReturnValue([]),
  getAllRegisteredGroups: vi.fn().mockReturnValue({}),
  updateTask: vi.fn(),
  recordToolJob: vi.fn(),
  resolveToolJob: vi.fn(),
  getToolJobByIdForGroup: vi.fn(),
  _initTestDatabase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/group-folder.js', () => ({
  isValidGroupFolder: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/capabilities/index.js', () => ({
  installCapability: vi.fn().mockResolvedValue(undefined),
  removeCapability: vi.fn().mockResolvedValue(undefined),
  listCapabilities: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/per-group-capabilities/index.js', () => ({
  provisionCapability: vi.fn().mockResolvedValue({ ok: true }),
  listGroupCapabilities: vi.fn().mockReturnValue([]),
  removeCapabilityInstance: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../src/k8s/ipc-redis-bootstrap.js', () => ({
  processCommitChannelConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('cron-parser', () => ({
  CronExpressionParser: {
    parse: vi.fn().mockReturnValue({
      next: vi.fn().mockReturnValue({
        toISOString: vi.fn().mockReturnValue('2025-01-01T00:00:00.000Z'),
      }),
    }),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read all entries from a Redis stream from the beginning.
 * Returns the field objects for each entry.
 */
async function readStreamEntries(
  redis: Redis,
  stream: string,
  count = 20,
): Promise<Record<string, string>[]> {
  const resp = (await redis.xrange(stream, '-', '+', 'COUNT', count)) as [
    string,
    string[],
  ][];
  if (!resp || resp.length === 0) return [];
  return resp.map(([, fields]) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    return obj;
  });
}

/**
 * Poll `fn` until it returns (or resolves to) a truthy value or `timeoutMs` elapses.
 * Returns the truthy value, or null on timeout (never throws).
 */
async function pollUntil<T>(
  fn: () => T | Promise<T> | null | undefined | false,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result as T;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// ── Test suite ────────────────────────────────────────────────────────────────

// Evaluated at module-load time (after global setup.ts beforeAll has run).
// When false, describe.skipIf reports all tests as SKIPPED, not passed.
const redisIsUp = redisAvailable();

describe.skipIf(!redisIsUp)('tool-catalog-spawn (real Redis integration)', () => {
  // Own Redis connections (not the shared setup.ts one — we need to control
  // their lifecycle independently from the global setup).
  let redis: Redis;
  let streamWatcher: Redis;

  // Track the watcher promise so afterEach can always stop and await it.
  let activeWatcherPromise: Promise<void> | null = null;

  beforeAll(async () => {
    // Redis is guaranteed available (describe.skipIf ensures this).
    const { default: Redis } = await import('ioredis');
    const url = getRedisUrlForTests();

    redis = new Redis(url, {
      connectTimeout: 10000,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    await redis.connect();

    // The watcher needs its own connection for blocking XREAD.
    // It must NOT be the same instance as `redis`, or each blocking call
    // will queue behind the other and stall for the full BLOCK timeout.
    streamWatcher = new Redis(url, {
      connectTimeout: 10000,
      maxRetriesPerRequest: null, // matches real watcher: infinite retries on transient blips
      lazyConnect: true,
    });
    await streamWatcher.connect();

    // Inject into hoisted holders — the vi.mock factory returns these.
    redisClientHolder.client = redis;
    streamWatcherHolder.client = streamWatcher;
  });

  afterAll(async () => {
    if (redis) await redis.quit().catch(() => {});
    if (streamWatcher) await streamWatcher.quit().catch(() => {});
  });

  afterEach(async () => {
    // Always stop the watcher after each test (including on assertion failures)
    // to prevent leftover running loops from bleeding into the next test.
    if (activeWatcherPromise) {
      const { stopIpcWatcher } = await import('../src/k8s/ipc-redis.js');
      await stopIpcWatcher();
      await activeWatcherPromise.catch(() => {});
      activeWatcherPromise = null;
    }
  });

  // Helper: start the IPC watcher (which sets ipcWatcherRunning = true)
  async function startWatcher(
    resolveTool: (name: string) => unknown,
  ): Promise<void> {
    const { startIpcWatcher, startToolPodSpawnWatcher } = await import(
      '../src/k8s/ipc-redis.js'
    );

    startIpcWatcher({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      registeredGroups: vi.fn().mockReturnValue({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn().mockResolvedValue(undefined),
      getAvailableGroups: vi.fn().mockReturnValue([]),
      writeGroupsSnapshot: vi.fn(),
    });

    activeWatcherPromise = startToolPodSpawnWatcher(
      resolveTool as (name: string) => ReturnType<typeof resolveTool>,
    );
  }

  // ── Case 1: Resolve + spawn ─────────────────────────────────────────────────

  it(
    'resolves a catalog tool by name and calls createSidecarToolPodJob (real Redis round-trip)',
    async () => {

      const { jobRunner } = await import('../src/k8s/job-runner.js');
      vi.mocked(jobRunner.createSidecarToolPodJob).mockClear();
      vi.mocked(jobRunner.createToolPodJob).mockClear();

      const agentJobId = `cat-spawn-resolve-${Date.now()}`;
      const toolName = 'weather_lookup';
      const spawnStream = 'kubeclaw:spawn-tool-pod';
      const errorStream = `kubeclaw:toolresults:${agentJobId}:${toolName}`;

      // Step 1: Flush the spawn stream so resolveStreamTip returns '0-0'.
      //         With lastId = '0-0', the watcher will pick up the message we
      //         add in step 3.
      await redis.del(spawnStream, errorStream);

      const toolSpec = {
        name: toolName,
        description: 'Look up weather for a location',
        parameters: { type: 'object', properties: {} },
        image: 'ghcr.io/example/weather:1',
        pattern: 'http' as const,
        port: 8080,
      };
      const resolveTool = vi.fn().mockReturnValue(toolSpec);

      // Step 2: Start the watcher (resolveStreamTip will see empty stream → '0-0')
      await startWatcher(resolveTool);

      // Brief pause to let the watcher enter its first XREAD BLOCK call.
      // This is not a timing hack — XREAD BLOCK with a non-'$' lastId will
      // immediately return any messages already in the stream, so the window
      // is very small. A small sleep ensures the watcher is blocked before we
      // add the message, making the test deterministic.
      await new Promise((r) => setTimeout(r, 200));

      // Step 3: Add the spawn message — the watcher's blocked XREAD will
      //         return it immediately.
      await redis.xadd(
        spawnStream,
        '*',
        'agentJobId', agentJobId,
        'groupFolder', 'my-group',
        'category', toolName,
        'timeout', '60000',
        'channel', 'telegram',
      );

      // Step 4: Wait for createSidecarToolPodJob to be called (up to 8s)
      const spawned = await pollUntil(
        () => vi.mocked(jobRunner.createSidecarToolPodJob).mock.calls.length > 0,
        8000,
      );

      expect(spawned).toBe(true);
      expect(resolveTool).toHaveBeenCalledWith(toolName);
      expect(jobRunner.createSidecarToolPodJob).toHaveBeenCalledWith(
        expect.objectContaining({
          agentJobId,
          groupFolder: 'my-group',
          toolName,
          toolSpec: expect.objectContaining({
            image: 'ghcr.io/example/weather:1',
            pattern: 'http',
          }),
          timeout: 60000,
        }),
      );
      expect(jobRunner.createToolPodJob).not.toHaveBeenCalled();

      // No error written to the results stream
      const errors = await readStreamEntries(redis, errorStream);
      expect(errors.filter((e) => e.error != null)).toHaveLength(0);

      await redis.del(spawnStream, errorStream);
    },
    20000,
  );

  // ── Case 2: Channel-scope rejection ────────────────────────────────────────

  it(
    'rejects a catalog tool not scoped to the requesting channel and writes an error result',
    async () => {

      const { jobRunner } = await import('../src/k8s/job-runner.js');
      vi.mocked(jobRunner.createSidecarToolPodJob).mockClear();
      vi.mocked(jobRunner.createToolPodJob).mockClear();

      const agentJobId = `cat-spawn-acl-${Date.now()}`;
      const toolName = 'slack_notifier';
      const spawnStream = 'kubeclaw:spawn-tool-pod';
      const errorStream = `kubeclaw:toolresults:${agentJobId}:${toolName}`;

      await redis.del(spawnStream, errorStream);

      // Tool spec restricted to 'slack' only — telegram is excluded
      const toolSpec = {
        name: toolName,
        description: 'Send a Slack notification',
        parameters: {},
        image: 'ghcr.io/example/slack-notifier:1',
        pattern: 'http' as const,
        channels: ['slack'],
      };
      const resolveTool = vi.fn().mockReturnValue(toolSpec);

      await startWatcher(resolveTool);
      await new Promise((r) => setTimeout(r, 200));

      // Seed a spawn message requesting 'telegram' channel — excluded by ACL
      await redis.xadd(
        spawnStream,
        '*',
        'agentJobId', agentJobId,
        'groupFolder', 'my-group',
        'category', toolName,
        'timeout', '60000',
        'channel', 'telegram',
      );

      // Wait for the error entry to appear in the results stream (up to 8s)
      let errorEntries: Record<string, string>[] = [];
      const found = await pollUntil(async () => {
        errorEntries = (await readStreamEntries(redis, errorStream)).filter(
          (e) => e.error != null,
        );
        return errorEntries.length > 0;
      }, 8000);

      expect(found).toBe(true);
      expect(jobRunner.createSidecarToolPodJob).not.toHaveBeenCalled();
      expect(jobRunner.createToolPodJob).not.toHaveBeenCalled();
      expect(errorEntries[0].error).toContain(
        `Tool ${toolName} is not available on this channel`,
      );

      await redis.del(spawnStream, errorStream);
    },
    20000,
  );

  // ── Case 3: Unknown tool name ───────────────────────────────────────────────

  it(
    'writes an error result when the catalog tool name is unknown',
    async () => {

      const { jobRunner } = await import('../src/k8s/job-runner.js');
      vi.mocked(jobRunner.createSidecarToolPodJob).mockClear();
      vi.mocked(jobRunner.createToolPodJob).mockClear();

      const agentJobId = `cat-spawn-unknown-${Date.now()}`;
      const toolName = 'nonexistent_tool';
      const spawnStream = 'kubeclaw:spawn-tool-pod';
      const errorStream = `kubeclaw:toolresults:${agentJobId}:${toolName}`;

      await redis.del(spawnStream, errorStream);

      // Resolver returns undefined — unknown tool
      const resolveTool = vi.fn().mockReturnValue(undefined);

      await startWatcher(resolveTool);
      await new Promise((r) => setTimeout(r, 200));

      await redis.xadd(
        spawnStream,
        '*',
        'agentJobId', agentJobId,
        'groupFolder', 'my-group',
        'category', toolName,
        'timeout', '60000',
        'channel', 'telegram',
      );

      // Wait for the error entry to appear
      let errorEntries: Record<string, string>[] = [];
      const found = await pollUntil(async () => {
        errorEntries = (await readStreamEntries(redis, errorStream)).filter(
          (e) => e.error != null,
        );
        return errorEntries.length > 0;
      }, 8000);

      expect(found).toBe(true);
      expect(jobRunner.createSidecarToolPodJob).not.toHaveBeenCalled();
      expect(jobRunner.createToolPodJob).not.toHaveBeenCalled();
      expect(errorEntries[0].error).toContain(`Unknown tool: ${toolName}`);

      await redis.del(spawnStream, errorStream);
    },
    20000,
  );
});
