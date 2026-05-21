// src/k8s/jobs-kill.integration.test.ts
//
// Integration tests for the /jobs <id> kill pipeline (Story 66).
//
// Exercises the extended job.cancel IPC handler with a jobId:
//  - DB ownership check enforced before any K8s call (getToolJobByIdForGroup).
//  - Active job belonging to the requesting group → stopJob called, result sent.
//  - Job belonging to a different group → not_found, stopJob never called.
//  - Unknown job id → not_found, stopJob never called.
//  - Already-resolved job (status != active) → not_active with current status.
//  - Story 49 (/cancel) path unbroken: no jobId → group-level cancel still works.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock state ────────────────────────────────────────────────────────

const {
  mockXadd,
  mockXread,
  mockPublish,
  mockStopJob,
  mockSubscriberOn,
  mockSubscribe,
} = vi.hoisted(() => {
  const mockXadd = vi.fn().mockResolvedValue('1-0');
  const mockXread = vi.fn().mockResolvedValue(null);
  const mockPublish = vi.fn().mockResolvedValue(1);
  const mockStopJob = vi.fn().mockResolvedValue(undefined);
  const mockSubscriberOn = vi.fn();
  const mockSubscribe = vi.fn();
  return { mockXadd, mockXread, mockPublish, mockStopJob, mockSubscriberOn, mockSubscribe };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    xadd: mockXadd,
    xread: mockXread,
    publish: mockPublish,
    quit: vi.fn(),
  }),
  getRedisSubscriber: vi.fn().mockReturnValue({
    subscribe: mockSubscribe,
    on: mockSubscriberOn,
    unsubscribe: vi.fn(),
    quit: vi.fn(),
  }),
  getTaskRequestStream: vi.fn().mockReturnValue('kubeclaw:task-requests'),
  getOutputChannel: vi.fn().mockImplementation((g: string) => `kubeclaw:messages:${g}`),
  getToolJobResultStream: vi.fn().mockImplementation((id: string) => `kubeclaw:agent-job-result:${id}`),
  getSpawnToolJobStream: vi.fn().mockReturnValue('kubeclaw:spawn-agent-job'),
  getSpawnToolPodStream: vi.fn().mockReturnValue('kubeclaw:spawn-tool-pod'),
  getInputStream: vi.fn().mockImplementation((id: string) => `kubeclaw:input:${id}`),
  createStreamWatcherClient: vi.fn().mockReturnValue({
    xread: mockXread,
    xrevrange: vi.fn().mockResolvedValue([]),
    xadd: mockXadd,
    quit: vi.fn(),
  }),
}));

vi.mock('../k8s/job-runner.js', () => ({
  jobRunner: {
    stopJob: mockStopJob,
    createToolPodJob: vi.fn().mockResolvedValue('nc-test-pod-abc123'),
    createSidecarToolPodJob: vi.fn().mockResolvedValue('nc-sidecar-abc123'),
    runToolJob: vi.fn().mockResolvedValue({ status: 'success', result: null }),
    applyYamlToK8s: vi.fn().mockResolvedValue(undefined),
    getJobLogs: vi.fn().mockResolvedValue('log output'),
  },
  buildJobName: vi.fn().mockReturnValue('nc-test-abc123'),
}));

// Mock DB — most functions stubbed; getToolJobByIdForGroup is what we control.
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getAllRegisteredGroups: vi.fn().mockReturnValue({}),
    getTaskById: vi.fn().mockReturnValue(null),
    getTasksForGroup: vi.fn().mockReturnValue([]),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    recordToolJob: vi.fn(),
    resolveToolJob: vi.fn(),
    getToolJobByIdForGroup: vi.fn().mockReturnValue(null),
  };
});

vi.mock('../capabilities/index.js', () => ({
  installCapability: vi.fn().mockResolvedValue(undefined),
  removeCapability: vi.fn().mockResolvedValue(undefined),
  listCapabilities: vi.fn().mockReturnValue([]),
}));

vi.mock('../group-folder.js', () => ({
  isValidGroupFolder: vi.fn().mockReturnValue(true),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  startIpcWatcher,
  startTaskRequestWatcher,
  stopIpcWatcher,
  _testSetActiveAgentJob,
  type IpcDeps,
} from './ipc-redis.js';
import * as db from '../db.js';
import type { ToolJobRecord } from '../db.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeMinimalDeps(): IpcDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    registeredGroups: vi.fn().mockReturnValue({}),
    registerGroup: vi.fn(),
    syncGroups: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: vi.fn().mockReturnValue([]),
    writeGroupsSnapshot: vi.fn(),
  };
}

function fakeActiveRow(jobId: string, groupFolder: string): ToolJobRecord {
  return {
    job_id: jobId,
    group_folder: groupFolder,
    chat_jid: `${groupFolder}@test`,
    status: 'active',
    created_at: new Date().toISOString(),
    resolved_at: null,
    message_id: null,
    specialist_name: '',
  };
}

function fakeCompletedRow(jobId: string, groupFolder: string): ToolJobRecord {
  return {
    ...fakeActiveRow(jobId, groupFolder),
    status: 'completed',
    resolved_at: new Date().toISOString(),
  };
}

/**
 * Start the watcher, deliver one task-request message, wait for processing,
 * then stop.  Mirrors the pattern from cancel-job.integration.test.ts.
 */
async function runWatcherWithMessages(
  messages: [string, string[]][],
): Promise<void> {
  startIpcWatcher(makeMinimalDeps());

  mockXread
    .mockResolvedValueOnce([['kubeclaw:task-requests', messages]])
    .mockImplementation(() => new Promise((r) => setTimeout(() => r(null), 500)));

  const watcherPromise = startTaskRequestWatcher();
  await new Promise((r) => setTimeout(r, 80));
  await stopIpcWatcher();
  await watcherPromise.catch(() => {/* loop exits once stopped */});
}

function buildKillFields(
  groupFolder: string,
  jobId: string,
  resultStream: string,
): string[] {
  return [
    'type', 'job.cancel',
    'jobId', jobId,
    'groupFolder', groupFolder,
    'resultStream', resultStream,
  ];
}

function buildCancelFields(
  groupFolder: string,
  resultStream: string,
  chatJid = 'chat@g.us',
): string[] {
  return [
    'type', 'job.cancel',
    'groupFolder', groupFolder,
    'chatJid', chatJid,
    'resultStream', resultStream,
  ];
}

const RESULT_STREAM = 'kubeclaw:job-kill-result:test-1';
const K8S_JOB_NAME = 'nc-test-abc123';
const GROUP = 'grp-test';
const JOB_ID = 'job-abc123';

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.clearAllMocks();
  mockXread.mockImplementation(
    () => new Promise((r) => setTimeout(() => r(null), 500)),
  );
  mockXadd.mockResolvedValue('1-0');
  mockPublish.mockResolvedValue(1);
  mockStopJob.mockResolvedValue(undefined);
  vi.mocked(db.getToolJobByIdForGroup).mockReturnValue(null);
  await stopIpcWatcher();
});

afterEach(async () => {
  await stopIpcWatcher();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('job.cancel with jobId (Story 66): active job, correct group', () => {
  it('AC1: stopJob called with K8s job name and result stream receives cancelled', async () => {
    vi.mocked(db.getToolJobByIdForGroup).mockReturnValue(fakeActiveRow(JOB_ID, GROUP));
    _testSetActiveAgentJob(GROUP, K8S_JOB_NAME);

    await runWatcherWithMessages([
      ['1-0', buildKillFields(GROUP, JOB_ID, RESULT_STREAM)],
    ]);

    expect(mockStopJob).toHaveBeenCalledWith(K8S_JOB_NAME);
    const resultCall = mockXadd.mock.calls.find((c) => c[0] === RESULT_STREAM);
    expect(resultCall).toBeDefined();
    const result = JSON.parse(resultCall![3] as string);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('cancelled');
  });
});

describe('job.cancel with jobId (Story 66): not-found cases', () => {
  it('AC3/AC4: unknown id or cross-group → not_found, stopJob never called', async () => {
    vi.mocked(db.getToolJobByIdForGroup).mockReturnValue(null);

    await runWatcherWithMessages([
      ['1-0', buildKillFields(GROUP, 'no-such-job', RESULT_STREAM)],
    ]);

    expect(mockStopJob).not.toHaveBeenCalled();
    const resultCall = mockXadd.mock.calls.find((c) => c[0] === RESULT_STREAM);
    expect(resultCall).toBeDefined();
    const result = JSON.parse(resultCall![3] as string);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('not_found');
  });
});

describe('job.cancel with jobId (Story 66): already-resolved job', () => {
  it('AC2: completed job → not_active with currentStatus', async () => {
    vi.mocked(db.getToolJobByIdForGroup).mockReturnValue(fakeCompletedRow(JOB_ID, GROUP));

    await runWatcherWithMessages([
      ['1-0', buildKillFields(GROUP, JOB_ID, RESULT_STREAM)],
    ]);

    expect(mockStopJob).not.toHaveBeenCalled();
    const resultCall = mockXadd.mock.calls.find((c) => c[0] === RESULT_STREAM);
    expect(resultCall).toBeDefined();
    const result = JSON.parse(resultCall![3] as string);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('not_active');
    expect(result.currentStatus).toBe('completed');
  });
});

describe('job.cancel without jobId (Story 49 regression)', () => {
  it('legacy /cancel: active job → stopped', async () => {
    _testSetActiveAgentJob(GROUP, K8S_JOB_NAME);

    await runWatcherWithMessages([
      ['1-0', buildCancelFields(GROUP, RESULT_STREAM)],
    ]);

    expect(mockStopJob).toHaveBeenCalledWith(K8S_JOB_NAME);
    const resultCall = mockXadd.mock.calls.find((c) => c[0] === RESULT_STREAM);
    expect(resultCall).toBeDefined();
    const result = JSON.parse(resultCall![3] as string);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('cancelled');
  });

  it('legacy /cancel: no active job → no_active_job', async () => {
    await runWatcherWithMessages([
      ['1-0', buildCancelFields('grp-empty', RESULT_STREAM)],
    ]);

    expect(mockStopJob).not.toHaveBeenCalled();
    const resultCall = mockXadd.mock.calls.find((c) => c[0] === RESULT_STREAM);
    expect(resultCall).toBeDefined();
    const result = JSON.parse(resultCall![3] as string);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('no_active_job');
  });
});
