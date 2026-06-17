/**
 * channel-runner.sync.test.ts
 *
 * Unit tests for the adapter-aware capability-sync path in channel-runner.ts.
 * Exercises handleCapabilitiesUpdate → syncCapabilitiesToLocalDb with the
 * adapter-aware guard. capabilities/db.js is backed by an in-memory Map so
 * setCapability/getAllCapabilities writes are observable without a real SQL.js
 * database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CapabilitySpec } from './capabilities/types.js';

// channel-runner.ts has a module-level guard: `if (!KUBECLAW_CHANNEL) process.exit(1)`.
// Hoist the env stub above all imports so the guard passes.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'test';
});

// ── In-memory capabilities store (replaces SQL.js for these unit tests) ───────

const capStore = new Map<string, CapabilitySpec>();

vi.mock('./capabilities/db.js', () => ({
  setCapability: vi.fn((spec: CapabilitySpec) => {
    capStore.set(spec.name, spec);
  }),
  getAllCapabilities: vi.fn((): CapabilitySpec[] => Array.from(capStore.values())),
  deleteCapability: vi.fn((name: string) => {
    capStore.delete(name);
  }),
  getCapability: vi.fn((name: string) => capStore.get(name)),
  getCapabilitiesByKind: vi.fn((kind: string) =>
    Array.from(capStore.values()).filter((c) => c.kind === kind),
  ),
  updateCapabilityStatus: vi.fn(),
  getCapabilityStatus: vi.fn(),
}));

// ── Stubs required by channel-runner.ts import-time side-effects ─────────────

// runtime/index.js — getDirectLLMRunner().configureMcp / configureGroupMcpTemplates
vi.mock('./runtime/index.js', () => ({
  getDirectLLMRunner: vi.fn().mockReturnValue({
    configureMcp: vi.fn().mockResolvedValue(undefined),
    configureGroupMcpTemplates: vi.fn().mockResolvedValue(undefined),
  }),
  shutdownAllRunners: vi.fn(),
}));

// db.js — stub the functions called at module-level by channel-runner (loadState, etc.)
vi.mock('./db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    getMessagesSince: vi.fn().mockReturnValue([]),
    getAllTasks: vi.fn().mockReturnValue([]),
    getAllChats: vi.fn().mockReturnValue([]),
    getAllSessions: vi.fn().mockReturnValue({}),
    getAllRegisteredGroups: vi.fn().mockReturnValue({}),
    getRouterState: vi.fn().mockReturnValue(''),
    setRouterState: vi.fn(),
    setRegisteredGroup: vi.fn(),
    setSession: vi.fn(),
    initDatabase: vi.fn().mockResolvedValue(undefined),
    storeMessage: vi.fn(),
    storeChatMetadata: vi.fn(),
    getConversationHistory: vi.fn().mockReturnValue([]),
    appendConversationMessage: vi.fn(),
    getNewMessages: vi.fn().mockReturnValue({ messages: [], newTimestamp: '' }),
    createTask: vi.fn(),
    getTaskById: vi.fn().mockReturnValue(undefined),
    getTaskRunLogs: vi.fn().mockReturnValue([]),
    getTasksForGroup: vi.fn().mockReturnValue([]),
    deleteTaskForGroup: vi.fn().mockReturnValue(true),
    pauseTask: vi.fn().mockReturnValue(true),
    resumeTask: vi.fn().mockReturnValue(true),
    writeAuditEntry: vi.fn(),
    recordSpecialistUsage: vi.fn(),
    getSpecialistUsage: vi.fn().mockReturnValue([]),
    upsertGroupProfile: vi.fn(),
    getActiveToolJobs: vi.fn().mockReturnValue([]),
    getRecentToolJobsForGroup: vi.fn().mockReturnValue([]),
    pruneOldToolJobs: vi.fn(),
    clearConversationHistory: vi.fn(),
  };
});

// k8s/redis-client.js — no real Redis in unit tests
vi.mock('./k8s/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    publish: vi.fn().mockResolvedValue(0),
    quit: vi.fn(),
    xadd: vi.fn().mockResolvedValue('0-0'),
    xread: vi.fn().mockResolvedValue(null),
  }),
  getChannelStatusChannel: vi.fn().mockReturnValue('ch'),
  getTaskRequestStream: vi.fn().mockReturnValue('ts'),
  getSpawnToolPodStream: vi.fn().mockReturnValue('sp'),
}));

// k8s/ipc-redis.js — no real K8s watchers
vi.mock('./k8s/ipc-redis.js', () => ({
  startIpcWatcher: vi.fn(),
  startControlChannelWatcher: vi.fn(),
}));

// rag/provider.js — resetRagProvider is called by handleCapabilitiesUpdate;
// stub so it does not attempt to read from capabilities/registry.
vi.mock('./rag/provider.js', () => ({
  resetRagProvider: vi.fn(),
  getRagProvider: vi.fn().mockReturnValue(null),
}));

// capabilities/registry.js — transitively imported; stub to avoid K8s client.
vi.mock('./capabilities/registry.js', () => ({
  getEntriesForChannel: vi.fn().mockReturnValue([]),
  listCapabilities: vi.fn().mockReturnValue([]),
  installCapability: vi.fn().mockResolvedValue(undefined),
  removeCapability: vi.fn().mockResolvedValue(undefined),
}));

// k8s/job-runner.js — no Kubernetes cluster in tests.
vi.mock('./k8s/job-runner.js', () => {
  const noop = vi.fn().mockResolvedValue(undefined);
  const fakeRunner = {
    createToolPodJob: noop,
    createSidecarToolPodJob: noop,
    deleteJob: noop,
    getJobStatus: vi.fn().mockResolvedValue('running'),
    listJobs: vi.fn().mockResolvedValue([]),
    getPodLogs: vi.fn().mockResolvedValue(''),
  };
  return {
    JobRunner: vi.fn().mockImplementation(() => fakeRunner),
    jobRunner: fakeRunner,
    buildJobName: vi.fn().mockReturnValue('fake-job-name'),
  };
});

// router.js — channel-runner imports this at module level
vi.mock('./router.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    formatMessages: vi.fn().mockImplementation((msgs: Array<{ content: string }>) =>
      msgs.map((m) => m.content).join('\n'),
    ),
    findChannel: vi.fn(),
  };
});

// ── Imports under test ────────────────────────────────────────────────────────

import { getAllCapabilities } from './capabilities/db.js';
import { handleCapabilitiesUpdate } from './channel-runner.js';
import { resetRagProvider } from './rag/provider.js';

// ── Test suite ────────────────────────────────────────────────────────────────

beforeEach(() => {
  capStore.clear();
  vi.clearAllMocks();
});

describe('handleCapabilitiesUpdate — adapter-aware rag sync', () => {
  it('mirrors a vector-store rag entry with its provider config into local DB', async () => {
    await handleCapabilitiesUpdate({
      capabilities: JSON.stringify([
        {
          name: 'r',
          kind: 'rag',
          endpoint: 'http://kubeclaw-cap-r:6333',
          kindMetadata: {
            backend: 'qdrant',
            provider: { adapter: 'vector-store', embedding: { provider: 'openai' } },
          },
        },
      ]),
    } as never);

    const rows = getAllCapabilities().filter((c) => c.kind === 'rag');
    expect(rows).toHaveLength(1);
    expect((rows[0] as { provider?: { adapter: string } }).provider?.adapter).toBe(
      'vector-store',
    );
    expect(resetRagProvider).toHaveBeenCalledTimes(1);
  });

  it('skips an unknown adapter without writing a malformed row', async () => {
    await handleCapabilitiesUpdate({
      capabilities: JSON.stringify([
        {
          name: 'bad',
          kind: 'rag',
          endpoint: 'http://x:1',
          kindMetadata: { backend: 'x', provider: { adapter: 'mystery' } },
        },
      ]),
    } as never);

    expect(getAllCapabilities().filter((c) => c.kind === 'rag')).toHaveLength(0);
  });

  it('accepts a remote adapter and writes the row', async () => {
    await handleCapabilitiesUpdate({
      capabilities: JSON.stringify([
        {
          name: 'lr',
          kind: 'rag',
          endpoint: 'http://kubeclaw-cap-lr:9621',
          kindMetadata: {
            backend: 'lightrag',
            provider: { adapter: 'remote' },
          },
        },
      ]),
    } as never);

    const rows = getAllCapabilities().filter((c) => c.kind === 'rag');
    expect(rows).toHaveLength(1);
    expect((rows[0] as { provider?: { adapter: string } }).provider?.adapter).toBe('remote');
  });

  it('skips a rag entry with no provider field', async () => {
    await handleCapabilitiesUpdate({
      capabilities: JSON.stringify([
        {
          name: 'noProvider',
          kind: 'rag',
          endpoint: 'http://x:1',
          kindMetadata: { backend: 'qdrant' },
        },
      ]),
    } as never);

    expect(getAllCapabilities().filter((c) => c.kind === 'rag')).toHaveLength(0);
  });
});

describe('handleCapabilitiesUpdate — transcription sync', () => {
  it('mirrors a transcription entry with its provider config into local DB', async () => {
    await handleCapabilitiesUpdate({
      capabilities: JSON.stringify([{
        name: 'whisper', kind: 'transcription', endpoint: 'http://kubeclaw-cap-whisper:9000',
        kindMetadata: { provider: { transcribePath: '/v1/audio/transcriptions', responseField: 'text', timeoutMs: 60000 } },
      }]),
    } as never);
    const rows = getAllCapabilities().filter((c) => c.kind === 'transcription');
    expect(rows).toHaveLength(1);
    expect((rows[0] as { provider?: { transcribePath?: string } }).provider?.transcribePath)
      .toBe('/v1/audio/transcriptions');
  });

  it('skips a transcription entry missing its provider block', async () => {
    await handleCapabilitiesUpdate({
      capabilities: JSON.stringify([{
        name: 'bad', kind: 'transcription', endpoint: 'http://x:9000',
        kindMetadata: {},
      }]),
    } as never);
    expect(getAllCapabilities().filter((c) => c.kind === 'transcription')).toHaveLength(0);
  });
});
