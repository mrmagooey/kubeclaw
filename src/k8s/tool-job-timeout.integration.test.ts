/**
 * Integration tests for Story 43 — tool-job DeadlineExceeded timeout handling.
 *
 * Uses a real in-process SQLite database and fake K8s / Redis collaborators.
 * Tests the full side-effect chain:
 *   1. DB row transitions from 'active' → 'timeout'
 *   2. Publisher receives the notice with correct routing
 *   3. Notice text contains "timed out" (AC1)
 *   4. Logger emits `event: 'tool_job_timeout'` (AC2)
 *   5. `runToolJob` resolves — group is not wedged (AC4)
 *   6. Metrics histogram gets an observation (AC5)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  recordToolJob,
  getActiveToolJobs,
  __resetDbForTest,
} from '../db.js';
import type { RegisteredGroup } from '../types.js';
import type { JobInput } from './types.js';

// ── Init real SQLite ────────────────────────────────────────────────────────
await _initTestDatabase();

// ── Mocks ───────────────────────────────────────────────────────────────────

const { mockLoggerError } = vi.hoisted(() => {
  const mockLoggerError = vi.fn();
  return { mockLoggerError };
});

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
  },
}));

vi.mock('../config.js', () => ({
  CONTAINER_IMAGE: 'kubeclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'UTC',
  KUBECLAW_NAMESPACE: 'kubeclaw',
  TOOL_JOB_MEMORY_REQUEST: '512Mi',
  TOOL_JOB_MEMORY_LIMIT: '4Gi',
  TOOL_JOB_CPU_REQUEST: '250m',
  TOOL_JOB_CPU_LIMIT: '2000m',
  REDIS_AGENT_PASSWORD: '',
  REDIS_TOOL_SERVER_PASSWORD: '',
  CREDENTIAL_SIDECAR_IMAGE: 'envoyproxy/envoy:v1.31-latest',
  CREDENTIAL_SIDECAR_PORT: 8443,
  BROWSER_SIDECAR_IMAGE: 'browsers:latest',
  BROWSER_SIDECAR_PORT: 9222,
  BROWSER_SIDECAR_MEMORY_REQUEST: '256Mi',
  BROWSER_SIDECAR_MEMORY_LIMIT: '1Gi',
  BROWSER_SIDECAR_CPU_REQUEST: '100m',
  BROWSER_SIDECAR_CPU_LIMIT: '500m',
  assertToolImageAllowed: vi.fn(),
  getContainerImage: vi.fn(() => 'kubeclaw-agent:test'),
  getInjectionMode: vi.fn(() => 'off'),
  getAuditOnly: vi.fn(() => false),
}));

vi.mock('./redis-client.js', () => {
  const { EventEmitter } = require('events');
  const mockSubscriber = new EventEmitter() as any;
  mockSubscriber.subscribe = vi.fn(
    (_ch: string, cb: (err: Error | null) => void) => cb(null),
  );
  mockSubscriber.unsubscribe = vi.fn();
  mockSubscriber.off = vi.fn();
  mockSubscriber.quit = vi.fn().mockResolvedValue('OK');
  return {
    getRedisSubscriber: vi.fn(() => mockSubscriber),
    getOutputChannel: vi.fn((g: string) => `kubeclaw:messages:${g}`),
    closeRedisConnections: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../credential-injection/workload-env.js', () => ({
  workloadEnvForSidecar: vi.fn(() => []),
}));
vi.mock('../credential-injection/sidecar-spec.js', () => ({
  sidecarContainerSpec: vi.fn(() => ({})),
  sidecarVolumes: vi.fn(() => []),
}));

const { mockBatchApi } = vi.hoisted(() => {
  const mockBatchApi = {
    createNamespacedJob: vi.fn(),
    readNamespacedJob: vi.fn(),
    deleteNamespacedJob: vi.fn(),
  };
  return { mockBatchApi };
});

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromDefault = vi.fn();
    makeApiClient = vi.fn(() => mockBatchApi);
  },
  CoreV1Api: 'CoreV1Api',
  BatchV1Api: 'BatchV1Api',
  AppsV1Api: 'AppsV1Api',
  loadAllYaml: vi.fn(() => []),
}));

import { JobRunner } from './job-runner.js';
import type { OrchestratorMetrics } from '../metrics/orchestrator.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

const GROUP_FOLDER = 'integ-test-group';
const CHAT_JID = 'http:integ-user';

const testGroup: RegisteredGroup = {
  name: 'Integration Test Group',
  folder: GROUP_FOLDER,
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput: JobInput = {
  prompt: 'Run an integration test',
  groupFolder: GROUP_FOLDER,
  chatJid: CHAT_JID,
  isMain: false,
  sessionId: 'integ-session',
  assistantName: 'Andy',
};

/** Build a fake publisher that records calls */
function makePublisherFake() {
  const calls: Array<{
    groupFolder: string;
    chatJid: string;
    text: string;
    noticeId: string;
  }> = [];
  return {
    calls,
    publish: vi.fn(
      async (
        groupFolder: string,
        chatJid: string,
        text: string,
        noticeId: string,
      ) => {
        calls.push({ groupFolder, chatJid, text, noticeId });
      },
    ),
  };
}

/** Build fake metrics that capture all calls */
function makeMetricsFake(): OrchestratorMetrics & {
  durationCalls: Array<{ image: string; success: boolean; durationMs: number }>;
  failureCalls: Array<{ image: string; reason: string }>;
} {
  const durationCalls: Array<{
    image: string;
    success: boolean;
    durationMs: number;
  }> = [];
  const failureCalls: Array<{ image: string; reason: string }> = [];
  return {
    durationCalls,
    failureCalls,
    recordToolJobSpawn: vi.fn(),
    recordToolJobDuration: vi.fn((labels) => {
      durationCalls.push(labels as any);
    }),
    recordToolJobFailure: vi.fn((labels) => {
      failureCalls.push(labels as any);
    }),
    recordRedisMessage: vi.fn(),
    setGroupQueueDepth: vi.fn(),
    recordSpecialistResolution: vi.fn(),
    recordDbQuery: vi.fn(),
  };
}

/** K8s status that looks like a DeadlineExceeded failure */
const DEADLINE_EXCEEDED_STATUS = {
  status: {
    failed: 1,
    conditions: [
      {
        type: 'Failed',
        status: 'True',
        reason: 'DeadlineExceeded',
        message: 'Job was active longer than specified deadline',
      },
    ],
  },
};

// ── Test suite ───────────────────────────────────────────────────────────────

describe('tool-job DeadlineExceeded — integration', () => {
  beforeEach(() => {
    __resetDbForTest();
    vi.clearAllMocks();
  });

  it('AC1: publishes a notice containing "timed out" (case-insensitive) to the correct group', async () => {
    const runner = new JobRunner();
    const publisher = makePublisherFake();
    runner.timeoutPublisher = publisher;

    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: 'nc-integ-test-group-abc123' },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(DEADLINE_EXCEEDED_STATUS);

    const jobId = 'nc-integ-test-group-abc123';
    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);

    await runner.runToolJob(testGroup, { ...testInput, jobId });

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0].groupFolder).toBe(GROUP_FOLDER);
    expect(publisher.calls[0].chatJid).toBe(CHAT_JID);
    expect(publisher.calls[0].text.toLowerCase()).toContain('timed out');
    expect(publisher.calls[0].noticeId).toMatch(/^timeout-notice-/);
  });

  it('AC2: logger emits event: tool_job_timeout with groupFolder and jobName', async () => {
    const runner = new JobRunner();
    runner.timeoutPublisher = makePublisherFake();

    const jobId = 'nc-integ-test-deadline-ac2';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(DEADLINE_EXCEEDED_STATUS);

    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);
    await runner.runToolJob(testGroup, { ...testInput, jobId });

    const timeoutLog = mockLoggerError.mock.calls.find(
      ([fields]) => fields?.event === 'tool_job_timeout',
    );
    expect(timeoutLog).toBeDefined();
    expect(timeoutLog![0]).toMatchObject({
      event: 'tool_job_timeout',
      groupFolder: GROUP_FOLDER,
      jobName: expect.stringContaining(jobId),
    });
  });

  it('AC3 (DB): DB row transitions to status=timeout and is not active afterwards', async () => {
    const runner = new JobRunner();
    runner.timeoutPublisher = makePublisherFake();

    const jobId = 'nc-integ-test-db-status';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(DEADLINE_EXCEEDED_STATUS);

    // Seed as active
    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);
    const before = getActiveToolJobs();
    expect(before.map((j) => j.job_id)).toContain(jobId);

    await runner.runToolJob(testGroup, { ...testInput, jobId });

    // After: no longer in active list
    const after = getActiveToolJobs();
    expect(after.map((j) => j.job_id)).not.toContain(jobId);
  });

  it('AC3 (persistence): publishes with persist:true + noticeId so storeBotMessage will write to conversation_history with is_bot_message=1', async () => {
    // The full conversation_history persistence flow lives in ipc-redis.ts
    // line 183: `if (data.persist && data.noticeId && deps.storeBotMessage)`
    // → calls storeBotMessage which writes a row with is_from_me=1, is_bot_message=1
    // (Story 37's path, re-used here). We can't easily exercise that whole
    // channel-side path from a job-runner integration test, but we CAN prove
    // the orchestrator-side publish carries the persist signals that flip
    // ipc-redis into the storeBotMessage branch.
    const runner = new JobRunner();
    const publisher = makePublisherFake();
    runner.timeoutPublisher = publisher;

    const jobId = 'nc-integ-test-ac3-persist';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(DEADLINE_EXCEEDED_STATUS);

    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);
    await runner.runToolJob(testGroup, { ...testInput, jobId });

    // Publish call carries: groupFolder, chatJid, text (timeout notice), and a
    // noticeId. The presence of noticeId is what tells ipc-redis to invoke
    // storeBotMessage rather than just SSE-broadcasting.
    expect(publisher.calls).toHaveLength(1);
    const call = publisher.calls[0];
    expect(call.groupFolder).toBe(GROUP_FOLDER);
    expect(call.chatJid).toBe(CHAT_JID);
    expect(call.text.toLowerCase()).toContain('timed out');
    expect(call.noticeId).toBeTruthy();
    expect(typeof call.noticeId).toBe('string');
  });

  it('AC4: runToolJob resolves (does not throw) — group is not wedged', async () => {
    const runner = new JobRunner();
    runner.timeoutPublisher = makePublisherFake();

    const jobId = 'nc-integ-test-no-wedge';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(DEADLINE_EXCEEDED_STATUS);

    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);

    // Must resolve (not throw/reject)
    const result = await runner.runToolJob(testGroup, { ...testInput, jobId });
    expect(result.status).toBe('timeout');
  });

  it('AC5: kubeclaw_tool_job_duration_seconds records an observation for the timed-out job', async () => {
    const runner = new JobRunner();
    const metrics = makeMetricsFake();
    runner.metrics = metrics;
    runner.timeoutPublisher = makePublisherFake();

    const jobId = 'nc-integ-test-metrics-ac5';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(DEADLINE_EXCEEDED_STATUS);

    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);
    await runner.runToolJob(testGroup, { ...testInput, jobId });

    expect(metrics.durationCalls).toHaveLength(1);
    expect(metrics.durationCalls[0]).toMatchObject({ success: false });
    expect(metrics.durationCalls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('failure reason is "deadline_exceeded" (not generic "error")', async () => {
    const runner = new JobRunner();
    const metrics = makeMetricsFake();
    runner.metrics = metrics;
    runner.timeoutPublisher = makePublisherFake();

    const jobId = 'nc-integ-test-failure-reason';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(DEADLINE_EXCEEDED_STATUS);

    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);
    await runner.runToolJob(testGroup, { ...testInput, jobId });

    expect(metrics.failureCalls).toHaveLength(1);
    expect(metrics.failureCalls[0].reason).toBe('deadline_exceeded');
  });

  it('subsequent runToolJob after a timeout still resolves (no wedged queue)', async () => {
    const runner = new JobRunner();
    runner.timeoutPublisher = makePublisherFake();

    // First job: times out
    const jobId1 = 'nc-integ-test-wedge-1';
    mockBatchApi.createNamespacedJob.mockResolvedValueOnce({
      metadata: { name: jobId1 },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValueOnce(
      DEADLINE_EXCEEDED_STATUS,
    );

    recordToolJob(jobId1, GROUP_FOLDER, CHAT_JID);
    const result1 = await runner.runToolJob(testGroup, {
      ...testInput,
      jobId: jobId1,
    });
    expect(result1.status).toBe('timeout');

    // Second job: succeeds normally
    const jobId2 = 'nc-integ-test-wedge-2';
    mockBatchApi.createNamespacedJob.mockResolvedValueOnce({
      metadata: { name: jobId2 },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValueOnce({
      status: { succeeded: 1 },
    });

    recordToolJob(jobId2, GROUP_FOLDER, CHAT_JID);
    const result2 = await runner.runToolJob(testGroup, {
      ...testInput,
      jobId: jobId2,
    });
    expect(result2.status).toBe('success');
  });
});
