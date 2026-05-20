/**
 * Integration test for job.cancel IPC handler (Story 49)
 *
 * Exercises the startTaskRequestWatcher path for type='job.cancel':
 *   - Seeds activeAgentJobsByGroup via the exported _testSetActiveAgentJob helper.
 *   - Simulates a job.cancel message arriving on the task-request stream.
 *   - Asserts jobRunner.stopJob was called with the correct K8s job name.
 *   - Asserts a "Cancelled" notice was published to kubeclaw:messages:<groupFolder>.
 *   - Asserts result stream receives { ok: true, status: 'cancelled' }.
 *   - Also tests the "no active job" path.
 */

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
  },
  buildJobName: vi.fn().mockReturnValue('nc-test-abc123'),
}));

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

// ── Imports after mocks ───────────────────────────────────────────────────────

import {
  startIpcWatcher,
  startTaskRequestWatcher,
  stopIpcWatcher,
  _testSetActiveAgentJob,
  type IpcDeps,
} from './ipc-redis.js';

// ── Minimal IpcDeps stub ──────────────────────────────────────────────────────

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

// ── Helper ────────────────────────────────────────────────────────────────────

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

/**
 * Start the watcher (which needs ipcWatcherRunning=true), prime xread to return
 * `messages` once, let it process, then stop the watcher.
 */
async function runWatcherWithMessages(
  messages: [string, string[]][],
): Promise<void> {
  // startIpcWatcher sets ipcWatcherRunning = true, which is required for
  // startTaskRequestWatcher's while loop to execute.
  startIpcWatcher(makeMinimalDeps());

  // After the first (real) message, make xread block for a long time so
  // the while-loop doesn't spin tight. stopIpcWatcher() will break the
  // outer condition, causing the loop to exit naturally on the next iteration.
  mockXread
    .mockResolvedValueOnce([['kubeclaw:task-requests', messages]])
    .mockImplementation(() => new Promise((r) => setTimeout(() => r(null), 500)));

  const watcherPromise = startTaskRequestWatcher();
  // Give the async loop a moment to process the queued message
  await new Promise((r) => setTimeout(r, 50));
  await stopIpcWatcher();
  await watcherPromise.catch(() => {/* loop exits normally once stopped */});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('job.cancel IPC handler — integration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Restore default blocking-ish implementation since clearAllMocks() wipes implementations.
    // Use a 500 ms delay so the while-loop doesn't spin tight between xread calls.
    mockXread.mockImplementation(
      () => new Promise((r) => setTimeout(() => r(null), 500)),
    );
    mockXadd.mockResolvedValue('1-0');
    mockPublish.mockResolvedValue(1);
    mockStopJob.mockResolvedValue(undefined);
    await stopIpcWatcher(); // ensure ipcWatcherRunning = false before each test
  });

  afterEach(async () => {
    await stopIpcWatcher();
  });

  it('calls stopJob with the K8s job name when an active job exists', async () => {
    _testSetActiveAgentJob('my-group', 'nc-my-group-abc12');

    await runWatcherWithMessages([
      ['1-0', buildCancelFields('my-group', 'kubeclaw:cancel-result:test-1')],
    ]);

    expect(mockStopJob).toHaveBeenCalledWith('nc-my-group-abc12');
  });

  it('publishes a "Cancelled" notice to kubeclaw:messages:<groupFolder>', async () => {
    _testSetActiveAgentJob('pub-group', 'nc-pub-group-xyz99');

    await runWatcherWithMessages([
      ['2-0', buildCancelFields('pub-group', 'kubeclaw:cancel-result:test-2')],
    ]);

    const publishCalls = mockPublish.mock.calls as [string, string][];
    const cancelPublish = publishCalls.find(
      ([ch]) => ch === 'kubeclaw:messages:pub-group',
    );
    expect(cancelPublish).toBeDefined();
    const payload = JSON.parse(cancelPublish![1]);
    expect(payload.text).toBe('Cancelled');
    expect(payload.type).toBe('message');
  });

  it('writes { ok: true, status: "no_active_job" } to result stream when no job exists', async () => {
    // Do NOT seed any active job for 'empty-group'
    const resultStream = 'kubeclaw:cancel-result:test-3';
    await runWatcherWithMessages([
      ['3-0', buildCancelFields('empty-group', resultStream)],
    ]);

    expect(mockStopJob).not.toHaveBeenCalled();

    // xadd args: (stream, '*', 'result', JSON)
    const xaddCalls = mockXadd.mock.calls as string[][];
    const resultCall = xaddCalls.find(([stream]) => stream === resultStream);
    expect(resultCall).toBeDefined();
    const resultObj = JSON.parse(resultCall![3]);
    expect(resultObj.ok).toBe(true);
    expect(resultObj.status).toBe('no_active_job');
  });

  it('writes { ok: true, status: "cancelled", jobName } to result stream on success', async () => {
    _testSetActiveAgentJob('ok-group', 'nc-ok-group-test1');

    const resultStream = 'kubeclaw:cancel-result:test-4';
    await runWatcherWithMessages([
      ['4-0', buildCancelFields('ok-group', resultStream)],
    ]);

    const xaddCalls = mockXadd.mock.calls as string[][];
    const resultCall = xaddCalls.find(([stream]) => stream === resultStream);
    expect(resultCall).toBeDefined();
    const resultObj = JSON.parse(resultCall![3]);
    expect(resultObj.ok).toBe(true);
    expect(resultObj.status).toBe('cancelled');
    expect(resultObj.jobName).toBe('nc-ok-group-test1');
  });
});
