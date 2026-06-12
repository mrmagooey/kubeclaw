/**
 * Unit tests for Story 43 — tool-job DeadlineExceeded timeout handling.
 *
 * Tests the following:
 *   1. `waitForJobCompletion` throws `DeadlineExceededError` when the K8s Job
 *      has `status.conditions[].type=Failed, reason=DeadlineExceeded`.
 *   2. `runToolJob` returns `status: 'timeout'` and publishes a notice via
 *      `timeoutPublisher` when `waitForJobCompletion` throws `DeadlineExceededError`.
 *   3. The log entry contains `event: 'tool_job_timeout'` with `groupFolder` and `jobName`.
 *   4. `resolveToolJob` is called with `'timeout'`.
 *   5. Metrics record a completed observation on the failure path.
 *   6. The group is not wedged: the `runToolJob` resolves (doesn't throw).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { RegisteredGroup } from '../types.js';
import type { JobInput } from './types.js';

// --- Mocks ---

// Hoist all mocks that need to be captured before module resolution
const { mockBatchApi, mockLogger, mockResolveToolJob } = vi.hoisted(() => {
  const mockBatchApi = {
    createNamespacedJob: vi.fn(),
    readNamespacedJob: vi.fn(),
    deleteNamespacedJob: vi.fn(),
  };
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const mockResolveToolJob = vi.fn();
  return { mockBatchApi, mockLogger, mockResolveToolJob };
});

vi.mock('../config.js', () => ({
  CONTAINER_IMAGE: 'kubeclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
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

vi.mock('../logger.js', () => ({ logger: mockLogger }));

// Mock Redis client (subscriber + client)
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
    __mockSubscriber: mockSubscriber,
  };
});

// Mock db.js — we only need to capture calls to resolveToolJob
vi.mock('../db.js', () => ({
  resolveToolJob: mockResolveToolJob,
}));

// Mock credential injection helpers
vi.mock('../credential-injection/workload-env.js', () => ({
  workloadEnvForSidecar: vi.fn(() => []),
}));
vi.mock('../credential-injection/sidecar-spec.js', () => ({
  sidecarContainerSpec: vi.fn(() => ({})),
  sidecarVolumes: vi.fn(() => []),
}));

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

import {
  JobRunner,
  DeadlineExceededError,
  formatTimeoutNotice,
} from './job-runner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput: JobInput = {
  prompt: 'Hello, test agent',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
  sessionId: 'session-123',
  assistantName: 'Andy',
};

/** K8s job response with DeadlineExceeded condition (status.failed > 0). */
function makeDeadlineExceededJobStatus() {
  return {
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
}

/** K8s job response with DeadlineExceeded only via conditions (no failed count). */
function makeDeadlineExceededConditionOnly() {
  return {
    status: {
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
}

// ---------------------------------------------------------------------------
// Tests: DeadlineExceededError
// ---------------------------------------------------------------------------

describe('DeadlineExceededError', () => {
  it('is an instance of Error', () => {
    const err = new DeadlineExceededError('nc-test-abc123');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DeadlineExceededError);
  });

  it('has name DeadlineExceededError', () => {
    const err = new DeadlineExceededError('nc-test-abc123');
    expect(err.name).toBe('DeadlineExceededError');
  });

  it('message contains the job name', () => {
    const err = new DeadlineExceededError('nc-test-abc123');
    expect(err.message).toContain('nc-test-abc123');
  });
});

// ---------------------------------------------------------------------------
// Tests: formatTimeoutNotice
// ---------------------------------------------------------------------------

describe('formatTimeoutNotice', () => {
  it('contains "timed out" (case-insensitive)', () => {
    const notice = formatTimeoutNotice('test-group', 'nc-test-abc');
    expect(notice.toLowerCase()).toContain('timed out');
  });

  it('references the group folder', () => {
    const notice = formatTimeoutNotice('my-group', 'nc-job-123');
    expect(notice).toContain('my-group');
  });

  it('references the job name', () => {
    const notice = formatTimeoutNotice('my-group', 'nc-job-123');
    expect(notice).toContain('nc-job-123');
  });
});

// ---------------------------------------------------------------------------
// Tests: waitForJobCompletion — DeadlineExceeded detection
// ---------------------------------------------------------------------------

describe('JobRunner.waitForJobCompletion', () => {
  let jobRunner: JobRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    jobRunner = new JobRunner();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws DeadlineExceededError when status.failed>0 and reason=DeadlineExceeded', async () => {
    mockBatchApi.readNamespacedJob.mockResolvedValue(
      makeDeadlineExceededJobStatus(),
    );

    await expect(
      jobRunner.waitForJobCompletion('nc-test-abc123'),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it('throws DeadlineExceededError from condition-only path (no failed count)', async () => {
    mockBatchApi.readNamespacedJob.mockResolvedValue(
      makeDeadlineExceededConditionOnly(),
    );

    await expect(
      jobRunner.waitForJobCompletion('nc-test-abc123'),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it('throws a plain Error (not DeadlineExceededError) for BackoffLimitExceeded', async () => {
    mockBatchApi.readNamespacedJob.mockResolvedValue({
      status: {
        failed: 1,
        conditions: [
          {
            type: 'Failed',
            status: 'True',
            reason: 'BackoffLimitExceeded',
            message: 'Backoff',
          },
        ],
      },
    });

    await expect(
      jobRunner.waitForJobCompletion('nc-test-abc123'),
    ).rejects.toThrow('BackoffLimitExceeded');

    // Crucially, NOT a DeadlineExceededError
    let caughtErr: unknown;
    try {
      await jobRunner.waitForJobCompletion('nc-test-abc123');
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).not.toBeInstanceOf(DeadlineExceededError);
  });
});

// ---------------------------------------------------------------------------
// Tests: runToolJob — DeadlineExceeded end-to-end
// ---------------------------------------------------------------------------

describe('JobRunner.runToolJob — DeadlineExceeded (Story 43)', () => {
  let jobRunner: JobRunner;
  let publishSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    jobRunner = new JobRunner();

    publishSpy = vi.fn().mockResolvedValue(undefined);
    jobRunner.timeoutPublisher = { publish: publishSpy };

    // Stub metrics
    jobRunner.metrics = {
      recordToolJobSpawn: vi.fn(),
      recordToolJobDuration: vi.fn(),
      recordToolJobFailure: vi.fn(),
      recordRedisMessage: vi.fn(),
      setGroupQueueDepth: vi.fn(),
      recordSpecialistResolution: vi.fn(),
      recordDbQuery: vi.fn(),
    };

    // K8s job creation succeeds, then polling returns DeadlineExceeded
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: 'nc-test-group-abc123' },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(
      makeDeadlineExceededJobStatus(),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns status: "timeout" (not "error") when DeadlineExceeded', async () => {
    const result = await jobRunner.runToolJob(testGroup, testInput);
    expect(result.status).toBe('timeout');
  });

  it('does NOT throw — the group is not wedged (AC4)', async () => {
    await expect(
      jobRunner.runToolJob(testGroup, testInput),
    ).resolves.toBeDefined();
  });

  it('publishes a timeout notice via timeoutPublisher', async () => {
    await jobRunner.runToolJob(testGroup, testInput);

    expect(publishSpy).toHaveBeenCalledOnce();
    const [groupFolder, chatJid, text, noticeId] = publishSpy.mock.calls[0] as [
      string,
      string,
      string,
      string,
    ];
    expect(groupFolder).toBe('test-group');
    expect(chatJid).toBe('test@g.us');
    expect(text.toLowerCase()).toContain('timed out');
    expect(noticeId).toMatch(/^timeout-notice-/);
  });

  it('does not publish if timeoutPublisher is not set', async () => {
    jobRunner.timeoutPublisher = undefined;
    const result = await jobRunner.runToolJob(testGroup, testInput);
    expect(result.status).toBe('timeout');
    // No publisher call — just make sure it doesn't throw
  });

  it('calls resolveToolJob with "timeout" (AC DB update)', async () => {
    await jobRunner.runToolJob(testGroup, testInput);
    expect(mockResolveToolJob).toHaveBeenCalledWith(
      expect.any(String),
      'timeout',
    );
  });

  it('logs event: tool_job_timeout with groupFolder and jobName (AC2)', async () => {
    await jobRunner.runToolJob(testGroup, testInput);

    const errorCalls = mockLogger.error.mock.calls;
    const timeoutCall = errorCalls.find(
      ([fields]) => fields?.event === 'tool_job_timeout',
    );
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall![0]).toMatchObject({
      event: 'tool_job_timeout',
      groupFolder: 'test-group',
      jobName: expect.any(String),
    });
    // jobName should be the K8s Job name, not empty
    expect((timeoutCall![0] as { jobName: string }).jobName).toBeTruthy();
  });

  it('records kubeclaw_tool_job_duration_seconds histogram observation (AC5)', async () => {
    await jobRunner.runToolJob(testGroup, testInput);
    expect(jobRunner.metrics!.recordToolJobDuration).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it('records a tool job failure metric with reason "deadline_exceeded"', async () => {
    await jobRunner.runToolJob(testGroup, testInput);
    expect(jobRunner.metrics!.recordToolJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'deadline_exceeded' }),
    );
  });

  it('handles publish failure gracefully — still returns timeout status', async () => {
    publishSpy.mockRejectedValue(new Error('Redis connection error'));
    const result = await jobRunner.runToolJob(testGroup, testInput);
    expect(result.status).toBe('timeout');
  });

  it('handles resolveToolJob failure gracefully — still returns timeout status', async () => {
    mockResolveToolJob.mockImplementation(() => {
      throw new Error('DB error');
    });
    const result = await jobRunner.runToolJob(testGroup, testInput);
    expect(result.status).toBe('timeout');
  });
});
