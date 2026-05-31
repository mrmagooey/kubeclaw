/**
 * Integration tests for Story 46 — OOMKilled tool-job surfaces user-visible
 * "out of memory" reply.
 *
 * Uses a real in-process SQLite database and fake K8s / Redis collaborators.
 * Tests the full side-effect chain:
 *   AC1 — Notice text contains "out of memory" (case-insensitive) and is
 *          published to the correct group within the runToolJob call.
 *   AC2 — Logger emits `{ event: "tool_job_oomkill", groupFolder, jobName }`.
 *   AC3 — DB row is no longer active after the OOM (resolveToolJob called).
 *         Publisher carries a noticeId so ipc-redis will invoke storeBotMessage
 *         (same path as Story 37/43).
 *   AC4 — runToolJob resolves; group is not wedged.
 *   AC5 — Metrics histogram records an observation for the OOM-killed job.
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
  REDIS_ADAPTER_PASSWORD: '',
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

const { mockBatchApi, mockCoreApi } = vi.hoisted(() => {
  const mockBatchApi = {
    createNamespacedJob: vi.fn(),
    readNamespacedJob: vi.fn(),
    deleteNamespacedJob: vi.fn(),
  };
  const mockCoreApi = {
    listNamespacedPod: vi.fn(),
    readNamespacedPodLog: vi.fn(),
    createNamespacedPersistentVolumeClaim: vi.fn(),
    createNamespacedService: vi.fn(),
    replaceNamespacedService: vi.fn(),
    deleteNamespacedService: vi.fn(),
    deleteNamespacedPersistentVolumeClaim: vi.fn(),
  };
  return { mockBatchApi, mockCoreApi };
});

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromDefault = vi.fn();
    makeApiClient = vi.fn((ApiClass: string) => {
      if (ApiClass === 'CoreV1Api') return mockCoreApi;
      return mockBatchApi;
    });
  },
  CoreV1Api: 'CoreV1Api',
  BatchV1Api: 'BatchV1Api',
  AppsV1Api: 'AppsV1Api',
  loadAllYaml: vi.fn(() => []),
}));

import { JobRunner } from './job-runner.js';
import type { OrchestratorMetrics } from '../metrics/orchestrator.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const GROUP_FOLDER = 'integ-oomkill-group';
const CHAT_JID = 'http:oomkill-user';

const testGroup: RegisteredGroup = {
  name: 'OOM Integration Test Group',
  folder: GROUP_FOLDER,
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput: JobInput = {
  prompt: 'Run a memory-intensive task',
  groupFolder: GROUP_FOLDER,
  chatJid: CHAT_JID,
  isMain: false,
  sessionId: 'integ-session-oom',
  assistantName: 'Andy',
};

/** K8s job status: job failed because the pod failed (backoff limit 0) */
const BACKOFF_LIMIT_EXCEEDED_STATUS = {
  status: {
    failed: 1,
    conditions: [
      {
        type: 'Failed',
        status: 'True',
        reason: 'BackoffLimitExceeded',
        message: 'Job has reached the specified backoff limit',
      },
    ],
  },
};

/** Pod listing with OOMKilled container */
const OOM_KILLED_POD_LIST = {
  items: [
    {
      metadata: { name: 'nc-integ-oomkill-group-pod-x' },
      status: {
        containerStatuses: [
          {
            name: 'agent',
            lastState: {
              terminated: {
                reason: 'OOMKilled',
                exitCode: 137,
                finishedAt: new Date().toISOString(),
              },
            },
            state: {},
          },
        ],
      },
    },
  ],
};

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

// ── Test suite ───────────────────────────────────────────────────────────────

describe('tool-job OOMKill — integration', () => {
  beforeEach(() => {
    __resetDbForTest();
    vi.clearAllMocks();
  });

  it('AC1: publishes a notice containing "out of memory" (case-insensitive) to the correct group', async () => {
    const runner = new JobRunner();
    const publisher = makePublisherFake();
    runner.oomKillPublisher = publisher;

    const jobId = 'nc-integ-oomkill-group-abc123';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(
      BACKOFF_LIMIT_EXCEEDED_STATUS,
    );
    mockCoreApi.listNamespacedPod.mockResolvedValue(OOM_KILLED_POD_LIST);

    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);
    await runner.runToolJob(testGroup, { ...testInput, jobId });

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0].groupFolder).toBe(GROUP_FOLDER);
    expect(publisher.calls[0].chatJid).toBe(CHAT_JID);
    expect(publisher.calls[0].text.toLowerCase()).toContain('out of memory');
    expect(publisher.calls[0].noticeId).toMatch(/^oomkill-notice-/);
  });

  it('AC2: logger emits event: tool_job_oomkill with groupFolder and jobName', async () => {
    const runner = new JobRunner();
    runner.oomKillPublisher = makePublisherFake();

    const jobId = 'nc-integ-oomkill-ac2';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(
      BACKOFF_LIMIT_EXCEEDED_STATUS,
    );
    mockCoreApi.listNamespacedPod.mockResolvedValue(OOM_KILLED_POD_LIST);

    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);
    await runner.runToolJob(testGroup, { ...testInput, jobId });

    const oomLog = mockLoggerError.mock.calls.find(
      ([fields]: [{ event?: string }]) => fields?.event === 'tool_job_oomkill',
    );
    expect(oomLog).toBeDefined();
    expect(oomLog![0]).toMatchObject({
      event: 'tool_job_oomkill',
      groupFolder: GROUP_FOLDER,
      jobName: expect.stringContaining(jobId),
    });
  });

  it('AC3 (DB): job row is no longer active after OOMKill', async () => {
    const runner = new JobRunner();
    runner.oomKillPublisher = makePublisherFake();

    const jobId = 'nc-integ-oomkill-db-status';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(
      BACKOFF_LIMIT_EXCEEDED_STATUS,
    );
    mockCoreApi.listNamespacedPod.mockResolvedValue(OOM_KILLED_POD_LIST);

    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);
    const before = getActiveToolJobs();
    expect(before.map((j) => j.job_id)).toContain(jobId);

    await runner.runToolJob(testGroup, { ...testInput, jobId });

    const after = getActiveToolJobs();
    expect(after.map((j) => j.job_id)).not.toContain(jobId);
  });

  it('AC3 (persistence): publish carries a noticeId so ipc-redis invokes storeBotMessage', async () => {
    const runner = new JobRunner();
    const publisher = makePublisherFake();
    runner.oomKillPublisher = publisher;

    const jobId = 'nc-integ-oomkill-ac3-persist';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(
      BACKOFF_LIMIT_EXCEEDED_STATUS,
    );
    mockCoreApi.listNamespacedPod.mockResolvedValue(OOM_KILLED_POD_LIST);

    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);
    await runner.runToolJob(testGroup, { ...testInput, jobId });

    expect(publisher.calls).toHaveLength(1);
    const call = publisher.calls[0];
    expect(call.groupFolder).toBe(GROUP_FOLDER);
    expect(call.chatJid).toBe(CHAT_JID);
    expect(call.text.toLowerCase()).toContain('out of memory');
    // noticeId presence triggers storeBotMessage in ipc-redis.ts
    expect(call.noticeId).toBeTruthy();
    expect(typeof call.noticeId).toBe('string');
  });

  it('AC4: runToolJob resolves (does not throw) — group is not wedged', async () => {
    const runner = new JobRunner();
    runner.oomKillPublisher = makePublisherFake();

    const jobId = 'nc-integ-oomkill-no-wedge';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(
      BACKOFF_LIMIT_EXCEEDED_STATUS,
    );
    mockCoreApi.listNamespacedPod.mockResolvedValue(OOM_KILLED_POD_LIST);

    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);
    const result = await runner.runToolJob(testGroup, { ...testInput, jobId });
    expect(result.status).toBe('oomkill');
  });

  it('AC5: kubeclaw_tool_job_duration_seconds records an observation for the OOM-killed job', async () => {
    const runner = new JobRunner();
    const metrics = makeMetricsFake();
    runner.metrics = metrics;
    runner.oomKillPublisher = makePublisherFake();

    const jobId = 'nc-integ-oomkill-metrics-ac5';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(
      BACKOFF_LIMIT_EXCEEDED_STATUS,
    );
    mockCoreApi.listNamespacedPod.mockResolvedValue(OOM_KILLED_POD_LIST);

    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);
    await runner.runToolJob(testGroup, { ...testInput, jobId });

    expect(metrics.durationCalls).toHaveLength(1);
    expect(metrics.durationCalls[0]).toMatchObject({ success: false });
    expect(metrics.durationCalls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('failure reason is "oomkilled" (not generic "error" or "deadline_exceeded")', async () => {
    const runner = new JobRunner();
    const metrics = makeMetricsFake();
    runner.metrics = metrics;
    runner.oomKillPublisher = makePublisherFake();

    const jobId = 'nc-integ-oomkill-failure-reason';
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: jobId },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(
      BACKOFF_LIMIT_EXCEEDED_STATUS,
    );
    mockCoreApi.listNamespacedPod.mockResolvedValue(OOM_KILLED_POD_LIST);

    recordToolJob(jobId, GROUP_FOLDER, CHAT_JID);
    await runner.runToolJob(testGroup, { ...testInput, jobId });

    expect(metrics.failureCalls).toHaveLength(1);
    expect(metrics.failureCalls[0].reason).toBe('oomkilled');
  });

  it('subsequent runToolJob after OOMKill still resolves (no wedged queue)', async () => {
    const runner = new JobRunner();
    runner.oomKillPublisher = makePublisherFake();

    // First job: OOMKilled
    const jobId1 = 'nc-integ-oomkill-wedge-1';
    mockBatchApi.createNamespacedJob.mockResolvedValueOnce({
      metadata: { name: jobId1 },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValueOnce(
      BACKOFF_LIMIT_EXCEEDED_STATUS,
    );
    mockCoreApi.listNamespacedPod.mockResolvedValueOnce(OOM_KILLED_POD_LIST);

    recordToolJob(jobId1, GROUP_FOLDER, CHAT_JID);
    const result1 = await runner.runToolJob(testGroup, {
      ...testInput,
      jobId: jobId1,
    });
    expect(result1.status).toBe('oomkill');

    // Second job: succeeds normally
    const jobId2 = 'nc-integ-oomkill-wedge-2';
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
