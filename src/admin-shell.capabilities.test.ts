import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInstall = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRemove = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockList = vi.hoisted(() =>
  vi
    .fn()
    .mockReturnValue([
      { kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' },
    ]),
);
const mockStatus = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    name: 'weather',
    lifecycle: 'ready',
    lastProbeAt: '2026-05-10T00:00:00Z',
    lastError: null,
  }),
);

vi.mock('./capabilities/index.js', () => ({
  installCapability: mockInstall,
  removeCapability: mockRemove,
  listCapabilities: mockList,
}));
vi.mock('./capabilities/db.js', () => ({
  getCapabilityStatus: mockStatus,
}));

// ── Infrastructure mocks (prevent sql.js / Redis / K8s from loading) ──────────

vi.mock('./db.js', () => ({
  db: {},
  initDatabase: vi.fn().mockResolvedValue(undefined),
  getAllRegisteredGroups: vi.fn().mockReturnValue({}),
  setRegisteredGroup: vi.fn(),
  deleteRegisteredGroup: vi.fn(),
  getRegisteredGroup: vi.fn().mockReturnValue(undefined),
  getAllScheduledTasks: vi.fn().mockReturnValue([]),
  getAllSessions: vi.fn().mockReturnValue({}),
  clearConversationHistory: vi.fn(),
  pruneOldBootstrapHistory: vi.fn().mockReturnValue(0),
  recordBootstrapTerminal: vi.fn(),
  getRecentBootstrapHistory: vi.fn().mockReturnValue([]),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('./k8s/ipc-redis.js', () => ({
  currentStepByJob: new Map(),
  startBootstrapTaskWatcher: vi.fn(),
  registerBootstrapDeps: vi.fn(),
}));

vi.mock('./k8s/bootstrap-runner.js', () => ({
  bootstrapChannelFromSkill: vi
    .fn()
    .mockResolvedValue({ bootstrapJobId: 'test-job-id' }),
  waitForBootstrapJobCompletion: vi.fn().mockResolvedValue(undefined),
  bootstrapStatus: vi.fn().mockResolvedValue({ active: [], recent: [] }),
  registerBootstrapMeta: vi.fn(),
  deregisterBootstrapMeta: vi.fn(),
  getBootstrapMeta: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./k8s/job-runner.js', () => ({
  jobRunner: { waitForJobCompletion: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('./k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(1),
  })),
}));

vi.mock('@kubernetes/client-node', () => {
  class MockKubeConfig {
    loadFromCluster() {}
    loadFromDefault() {}
    makeApiClient() {
      return {};
    }
  }
  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: class {},
    AppsV1Api: class {},
    BatchV1Api: class {},
    NetworkingV1Api: class {},
  };
});

vi.mock('./runtime/llm-client.js', () => ({
  createLLMClient: vi.fn(() => ({})),
  DEFAULT_DIRECT_MODEL: 'gpt-4o',
}));

vi.mock('./skills/orchestrator/specialist-registry.js', () => ({
  registerSpecialist: vi.fn().mockReturnValue({ ok: true }),
  editSpecialist: vi.fn().mockReturnValue({ ok: true }),
  removeSpecialist: vi.fn().mockReturnValue({ ok: true }),
  listSpecialistOverrides: vi.fn().mockReturnValue([]),
}));

vi.mock('./skills/orchestrator/channel-manifest-registry.js', () => ({
  registerChannelManifest: vi.fn().mockReturnValue({
    ok: true,
    manifest_hash: 'abc',
    source: 'admin-registered',
  }),
  listChannelManifestOverrides: vi.fn().mockReturnValue([]),
}));

vi.mock('./channel-manifests/reconciler.js', () => ({
  ChannelManifestReconciler: class {
    apply() {
      return Promise.resolve();
    }
  },
  loadBaselineFromDisk: vi.fn().mockReturnValue([]),
  mergeManifests: vi.fn().mockReturnValue([]),
}));

vi.mock('./per-group-capabilities/k8s-client.js', () => ({
  RealPerGroupK8sClient: class {
    constructor(_kc?: unknown) {}
  },
}));

vi.mock('./per-group-capabilities/credentials.js', () => ({
  setGroupCredential: vi.fn().mockResolvedValue(undefined),
  unsetGroupCredential: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./per-group-capabilities/index.js', () => ({
  onGroupRemoved: vi.fn().mockResolvedValue(undefined),
}));

import { executeTool } from './admin-shell.js';

beforeEach(() => {
  mockInstall.mockClear();
  mockRemove.mockClear();
});

describe('admin-shell capability tools', () => {
  it('install_capability calls installCapability with the spec', async () => {
    const result = await executeTool('install_capability', {
      spec: { kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' },
    });
    expect(mockInstall).toHaveBeenCalledOnce();
    expect(result).toContain('weather');
  });

  it('install_capability returns error when spec missing', async () => {
    const result = await executeTool('install_capability', {});
    expect(result.toLowerCase()).toContain('error');
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('remove_capability delegates by name', async () => {
    const result = await executeTool('remove_capability', { name: 'weather' });
    expect(mockRemove).toHaveBeenCalledWith('weather');
    expect(result).toContain('weather');
  });

  it('list_capabilities returns specs with status', async () => {
    const result = await executeTool('list_capabilities', {});
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status.lifecycle).toBe('ready');
  });

  it('get_capability_logs returns error when name missing', async () => {
    const result = await executeTool('get_capability_logs', {});
    expect(result.toLowerCase()).toContain('error');
  });
});
