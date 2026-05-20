/**
 * Unit tests for Story 46 — OOMKilled tool-job surfaces user-visible
 * "out of memory" reply.
 *
 * Tests:
 *   1. `OOMKilledError` shape.
 *   2. `formatOomKillNotice` content.
 *   3. `JobRunner.isOOMKilled` detects OOMKilled via lastState.terminated.
 *   4. `JobRunner.isOOMKilled` detects OOMKilled via state.terminated.
 *   5. `JobRunner.isOOMKilled` returns false when no OOM reason present.
 *   6. `JobRunner.waitForJobCompletion` throws `OOMKilledError` when the
 *      job fails with BackoffLimitExceeded and the pod was OOMKilled.
 *   7. `JobRunner.runToolJob` returns `status: 'oomkill'` and publishes
 *      via oomKillPublisher.
 *   8. OOMKill path is distinct from DeadlineExceeded path.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { RegisteredGroup } from '../types.js';
import type { JobInput } from './types.js';

// ── Mocks ───────────────────────────────────────────────────────────────────

const { mockBatchApi, mockCoreApi, mockLogger, mockResolveToolJob } = vi.hoisted(() => {
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
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const mockResolveToolJob = vi.fn();
  return { mockBatchApi, mockCoreApi, mockLogger, mockResolveToolJob };
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

vi.mock('../logger.js', () => ({ logger: mockLogger }));

vi.mock('./redis-client.js', () => {
  const { EventEmitter } = require('events');
  const mockSubscriber = new EventEmitter() as any;
  mockSubscriber.subscribe = vi.fn((_ch: string, cb: (err: Error | null) => void) => cb(null));
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

vi.mock('../db.js', () => ({
  resolveToolJob: mockResolveToolJob,
}));

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

import {
  JobRunner,
  OOMKilledError,
  DeadlineExceededError,
  formatOomKillNotice,
} from './job-runner.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/** K8s job status with BackoffLimitExceeded (typical OOMKill wrapping) */
function makeBackoffLimitExceededStatus() {
  return {
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
}

/** Pod listing where the agent container was OOMKilled (lastState path) */
function makeOOMKilledPodList() {
  return {
    items: [
      {
        metadata: { name: 'nc-test-group-abc123-pod-x' },
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
}

/** Pod listing where the agent container was OOMKilled (state path) */
function makeOOMKilledPodListStatePath() {
  return {
    items: [
      {
        metadata: { name: 'nc-test-group-abc123-pod-x' },
        status: {
          containerStatuses: [
            {
              name: 'agent',
              lastState: {},
              state: {
                terminated: {
                  reason: 'OOMKilled',
                  exitCode: 137,
                  finishedAt: new Date().toISOString(),
                },
              },
            },
          ],
        },
      },
    ],
  };
}

/** Pod listing where the container exited normally (no OOM) */
function makeNonOOMPodList() {
  return {
    items: [
      {
        metadata: { name: 'nc-test-group-abc123-pod-x' },
        status: {
          containerStatuses: [
            {
              name: 'agent',
              lastState: {
                terminated: {
                  reason: 'Error',
                  exitCode: 1,
                },
              },
              state: {},
            },
          ],
        },
      },
    ],
  };
}

/** K8s job status with DeadlineExceeded (Story 43 path — must NOT trigger OOMKill) */
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

// ── Tests: OOMKilledError ────────────────────────────────────────────────────

describe('OOMKilledError', () => {
  it('is an instance of Error', () => {
    const err = new OOMKilledError('nc-test-abc123');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OOMKilledError);
  });

  it('has name OOMKilledError', () => {
    const err = new OOMKilledError('nc-test-abc123');
    expect(err.name).toBe('OOMKilledError');
  });

  it('exposes jobName field', () => {
    const err = new OOMKilledError('nc-test-abc123');
    expect(err.jobName).toBe('nc-test-abc123');
  });

  it('message contains the job name', () => {
    const err = new OOMKilledError('nc-test-abc123');
    expect(err.message).toContain('nc-test-abc123');
  });

  it('is NOT an instance of DeadlineExceededError', () => {
    const err = new OOMKilledError('nc-test-abc123');
    expect(err).not.toBeInstanceOf(DeadlineExceededError);
  });
});

// ── Tests: formatOomKillNotice ───────────────────────────────────────────────

describe('formatOomKillNotice', () => {
  it('contains "out of memory" (case-insensitive)', () => {
    const notice = formatOomKillNotice('test-group', 'nc-test-abc');
    expect(notice.toLowerCase()).toContain('out of memory');
  });

  it('references the group folder', () => {
    const notice = formatOomKillNotice('my-group', 'nc-job-123');
    expect(notice).toContain('my-group');
  });

  it('references the job name', () => {
    const notice = formatOomKillNotice('my-group', 'nc-job-123');
    expect(notice).toContain('nc-job-123');
  });
});

// ── Tests: isOOMKilled ───────────────────────────────────────────────────────

describe('JobRunner.isOOMKilled', () => {
  let jobRunner: JobRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    jobRunner = new JobRunner();
  });

  it('returns true when lastState.terminated.reason is OOMKilled', async () => {
    mockCoreApi.listNamespacedPod.mockResolvedValue(makeOOMKilledPodList());
    await expect(jobRunner.isOOMKilled('nc-test-abc123')).resolves.toBe(true);
  });

  it('returns true when state.terminated.reason is OOMKilled', async () => {
    mockCoreApi.listNamespacedPod.mockResolvedValue(makeOOMKilledPodListStatePath());
    await expect(jobRunner.isOOMKilled('nc-test-abc123')).resolves.toBe(true);
  });

  it('returns false when no container was OOMKilled', async () => {
    mockCoreApi.listNamespacedPod.mockResolvedValue(makeNonOOMPodList());
    await expect(jobRunner.isOOMKilled('nc-test-abc123')).resolves.toBe(false);
  });

  it('returns false when pod list is empty', async () => {
    mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [] });
    await expect(jobRunner.isOOMKilled('nc-test-abc123')).resolves.toBe(false);
  });

  it('returns false (and warns) when coreApi throws', async () => {
    mockCoreApi.listNamespacedPod.mockRejectedValue(new Error('API error'));
    await expect(jobRunner.isOOMKilled('nc-test-abc123')).resolves.toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'nc-test-abc123' }),
      expect.stringContaining('isOOMKilled'),
    );
  });
});

// ── Tests: waitForJobCompletion — OOMKill detection ──────────────────────────

describe('JobRunner.waitForJobCompletion — OOMKill detection', () => {
  let jobRunner: JobRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    jobRunner = new JobRunner();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws OOMKilledError when job fails with BackoffLimitExceeded + pod was OOMKilled', async () => {
    mockBatchApi.readNamespacedJob.mockResolvedValue(makeBackoffLimitExceededStatus());
    mockCoreApi.listNamespacedPod.mockResolvedValue(makeOOMKilledPodList());

    await expect(
      jobRunner.waitForJobCompletion('nc-test-abc123'),
    ).rejects.toBeInstanceOf(OOMKilledError);
  });

  it('throws a plain Error (not OOMKilledError) when pod was NOT OOMKilled', async () => {
    mockBatchApi.readNamespacedJob.mockResolvedValue(makeBackoffLimitExceededStatus());
    mockCoreApi.listNamespacedPod.mockResolvedValue(makeNonOOMPodList());

    await expect(
      jobRunner.waitForJobCompletion('nc-test-abc123'),
    ).rejects.toThrow('BackoffLimitExceeded');

    let caughtErr: unknown;
    try {
      mockBatchApi.readNamespacedJob.mockResolvedValue(makeBackoffLimitExceededStatus());
      mockCoreApi.listNamespacedPod.mockResolvedValue(makeNonOOMPodList());
      await jobRunner.waitForJobCompletion('nc-test-abc123');
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).not.toBeInstanceOf(OOMKilledError);
  });

  it('DeadlineExceeded path is NOT affected — does NOT throw OOMKilledError', async () => {
    mockBatchApi.readNamespacedJob.mockResolvedValue(makeDeadlineExceededJobStatus());
    // Even if for some reason OOMKill pods existed, DeadlineExceeded short-circuits first
    mockCoreApi.listNamespacedPod.mockResolvedValue(makeOOMKilledPodList());

    let caughtErr: unknown;
    try {
      await jobRunner.waitForJobCompletion('nc-test-abc123');
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(DeadlineExceededError);
    expect(caughtErr).not.toBeInstanceOf(OOMKilledError);
  });
});

// ── Tests: runToolJob — OOMKill end-to-end ───────────────────────────────────

describe('JobRunner.runToolJob — OOMKill (Story 46)', () => {
  let jobRunner: JobRunner;
  let oomKillPublishSpy: ReturnType<typeof vi.fn>;
  let timeoutPublishSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    jobRunner = new JobRunner();

    oomKillPublishSpy = vi.fn().mockResolvedValue(undefined);
    timeoutPublishSpy = vi.fn().mockResolvedValue(undefined);
    jobRunner.oomKillPublisher = { publish: oomKillPublishSpy };
    jobRunner.timeoutPublisher = { publish: timeoutPublishSpy };

    jobRunner.metrics = {
      recordToolJobSpawn: vi.fn(),
      recordToolJobDuration: vi.fn(),
      recordToolJobFailure: vi.fn(),
      recordRedisMessage: vi.fn(),
      setGroupQueueDepth: vi.fn(),
      recordSpecialistResolution: vi.fn(),
      recordDbQuery: vi.fn(),
    };

    // K8s job creation succeeds, then polling returns BackoffLimitExceeded + OOMKilled pod
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: 'nc-test-group-abc123' },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue(makeBackoffLimitExceededStatus());
    mockCoreApi.listNamespacedPod.mockResolvedValue(makeOOMKilledPodList());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns status: "oomkill" (not "error" or "timeout") when OOMKilled', async () => {
    const result = await jobRunner.runToolJob(testGroup, testInput);
    expect(result.status).toBe('oomkill');
  });

  it('does NOT throw — the group is not wedged (AC4)', async () => {
    await expect(jobRunner.runToolJob(testGroup, testInput)).resolves.toBeDefined();
  });

  it('publishes an OOM notice via oomKillPublisher', async () => {
    await jobRunner.runToolJob(testGroup, testInput);

    expect(oomKillPublishSpy).toHaveBeenCalledOnce();
    const [groupFolder, chatJid, text, noticeId] =
      oomKillPublishSpy.mock.calls[0] as [string, string, string, string];
    expect(groupFolder).toBe('test-group');
    expect(chatJid).toBe('test@g.us');
    expect(text.toLowerCase()).toContain('out of memory');
    expect(noticeId).toMatch(/^oomkill-notice-/);
  });

  it('does NOT call timeoutPublisher on the OOM path', async () => {
    await jobRunner.runToolJob(testGroup, testInput);
    expect(timeoutPublishSpy).not.toHaveBeenCalled();
  });

  it('does not publish if oomKillPublisher is not set', async () => {
    jobRunner.oomKillPublisher = undefined;
    const result = await jobRunner.runToolJob(testGroup, testInput);
    expect(result.status).toBe('oomkill');
    // No publisher call — just make sure it doesn't throw
  });

  it('logs event: tool_job_oomkill with groupFolder and jobName (AC2)', async () => {
    await jobRunner.runToolJob(testGroup, testInput);

    const errorCalls = mockLogger.error.mock.calls;
    const oomLog = errorCalls.find(
      ([fields]) => fields?.event === 'tool_job_oomkill',
    );
    expect(oomLog).toBeDefined();
    expect(oomLog![0]).toMatchObject({
      event: 'tool_job_oomkill',
      groupFolder: 'test-group',
      jobName: expect.any(String),
    });
    expect((oomLog![0] as { jobName: string }).jobName).toBeTruthy();
  });

  it('calls resolveToolJob with "oomkill" (AC3 DB persist)', async () => {
    await jobRunner.runToolJob(testGroup, testInput);
    expect(mockResolveToolJob).toHaveBeenCalledWith(
      expect.any(String),
      'oomkill',
    );
  });

  it('records kubeclaw_tool_job_duration_seconds histogram observation', async () => {
    await jobRunner.runToolJob(testGroup, testInput);
    expect(jobRunner.metrics!.recordToolJobDuration).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it('records a tool job failure metric with reason "oomkilled"', async () => {
    await jobRunner.runToolJob(testGroup, testInput);
    expect(jobRunner.metrics!.recordToolJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'oomkilled' }),
    );
  });

  it('handles publish failure gracefully — still returns oomkill status', async () => {
    oomKillPublishSpy.mockRejectedValue(new Error('Redis connection error'));
    const result = await jobRunner.runToolJob(testGroup, testInput);
    expect(result.status).toBe('oomkill');
  });

  it('handles resolveToolJob failure gracefully — still returns oomkill status', async () => {
    mockResolveToolJob.mockImplementation(() => {
      throw new Error('DB error');
    });
    const result = await jobRunner.runToolJob(testGroup, testInput);
    expect(result.status).toBe('oomkill');
  });

  it('OOMKill and DeadlineExceeded paths are distinct — OOM does NOT publish to timeoutPublisher', async () => {
    // OOM scenario — oomKillPublisher should be called, NOT timeoutPublisher
    await jobRunner.runToolJob(testGroup, testInput);
    expect(oomKillPublishSpy).toHaveBeenCalledOnce();
    expect(timeoutPublishSpy).not.toHaveBeenCalled();
  });
});
