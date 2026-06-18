/**
 * Tests for per-group-capabilities/index.ts lifecycle management.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Mocks (must appear before any imports of the module under test) ----

vi.mock('./reconciler.js', () => ({
  reconcileGroupCapabilities: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./scale-down-sweeper.js', () => ({
  sweepIdleInstances: vi.fn().mockResolvedValue(undefined),
  // Other exports referenced by the re-export barrel
  startSweeperLoop: vi.fn(),
}));

vi.mock('./gc.js', () => ({
  gcGroup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../capabilities/discovery.js', () => ({
  setDiscoveryDeps: vi.fn(),
}));

vi.mock('./schema-scraper.js', () => ({
  scrapeMissingSchemas: vi.fn().mockResolvedValue(undefined),
  startSchemaScraperLoop: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// ---- Additional re-exported modules (mocked to avoid side-effects) ----

vi.mock('./scale-up.js', () => ({
  scaleUpInstance: vi.fn(),
}));

vi.mock('./credentials.js', () => ({
  setGroupCredential: vi.fn(),
  unsetGroupCredential: vi.fn(),
}));

vi.mock('./k8s-client.js', () => ({
  RealPerGroupK8sClient: vi.fn(),
  FakePerGroupK8sClient: vi.fn(),
}));

vi.mock('./hash.js', () => ({
  groupHash: vi.fn(),
}));

vi.mock('./types.js', () => ({
  getScope: vi.fn(),
  validateScopeFields: vi.fn(),
  resolveGroupCapability: vi.fn(),
  PerGroupCapabilityError: class extends Error {},
}));

vi.mock('./schema-cache.js', () => ({
  cacheSchemas: vi.fn(),
  getCachedSchemas: vi.fn(),
  clearCachedSchemas: vi.fn(),
  listAllCachedSchemas: vi.fn(),
}));

vi.mock('./provision.js', () => ({
  provisionCapability: vi.fn(),
  listGroupCapabilities: vi.fn(),
  removeCapabilityInstance: vi.fn(),
}));

// ---- Import SUT and mocks ----

import {
  initPerGroupCapabilityLifecycle,
  onGroupAdded,
  onGroupRemoved,
  _resetLifecycleForTest,
} from './index.js';

import { reconcileGroupCapabilities } from './reconciler.js';
import { sweepIdleInstances } from './scale-down-sweeper.js';
import { gcGroup } from './gc.js';
import { setDiscoveryDeps } from '../capabilities/discovery.js';
import { scrapeMissingSchemas } from './schema-scraper.js';
import { logger } from '../logger.js';

// ---- Test helpers ----

function makeDeps(
  overrides: Partial<
    Parameters<typeof initPerGroupCapabilityLifecycle>[0]
  > = {},
) {
  return {
    client: {} as any,
    namespace: 'test-ns',
    groupsPvcName: 'groups-pvc',
    listGroupFolders: vi.fn().mockReturnValue(['group-a', 'group-b']),
    listSpecs: vi.fn().mockReturnValue([]),
    discoveryTimeoutMs: 5_000,
    sweepIntervalMs: 1_000,
    periodicReconcileMs: 2_000,
    schemaScrapeIntervalMs: 1_500,
    ...overrides,
  };
}

// ---- Tests ----

describe('initPerGroupCapabilityLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    _resetLifecycleForTest();
    vi.useRealTimers();
  });

  it('calls setDiscoveryDeps with the correct params', async () => {
    const deps = makeDeps();
    await initPerGroupCapabilityLifecycle(deps);

    expect(setDiscoveryDeps).toHaveBeenCalledOnce();
    expect(setDiscoveryDeps).toHaveBeenCalledWith({
      perGroupK8sClient: deps.client,
      namespace: deps.namespace,
      discoveryTimeoutMs: deps.discoveryTimeoutMs,
    });
  });

  it('calls reconcileGroupCapabilities once on startup (initial reconcile)', async () => {
    const deps = makeDeps();
    await initPerGroupCapabilityLifecycle(deps);

    expect(reconcileGroupCapabilities).toHaveBeenCalledOnce();
    expect(reconcileGroupCapabilities).toHaveBeenCalledWith({
      client: deps.client,
      namespace: deps.namespace,
      groupsPvcName: deps.groupsPvcName,
      groups: ['group-a', 'group-b'],
      specs: [],
    });
  });

  it('stop() prevents sweeper, scraper, and periodic timers from firing', async () => {
    const deps = makeDeps();
    const handle = await initPerGroupCapabilityLifecycle(deps);

    // Clear the initial reconcile call
    vi.mocked(reconcileGroupCapabilities).mockClear();

    handle.stop();

    // Advance well past all timer intervals
    await vi.advanceTimersByTimeAsync(10_000);

    // After stop, sweeper and scraper should not have run
    expect(sweepIdleInstances).not.toHaveBeenCalled();
    expect(scrapeMissingSchemas).not.toHaveBeenCalled();
    // Periodic reconcile should not have run
    expect(reconcileGroupCapabilities).not.toHaveBeenCalled();
  });
});

describe('onGroupAdded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    _resetLifecycleForTest();
    vi.useRealTimers();
  });

  it('calls reconcileGroupCapabilities when lifecycle is initialized', async () => {
    const deps = makeDeps();
    await initPerGroupCapabilityLifecycle(deps);
    vi.mocked(reconcileGroupCapabilities).mockClear();

    await onGroupAdded('new-group');

    expect(reconcileGroupCapabilities).toHaveBeenCalledOnce();
    expect(reconcileGroupCapabilities).toHaveBeenCalledWith({
      client: deps.client,
      namespace: deps.namespace,
      groupsPvcName: deps.groupsPvcName,
      groups: ['new-group'],
      specs: [],
    });
  });

  it('is a no-op when lifecycle is NOT initialized', async () => {
    // Don't call initPerGroupCapabilityLifecycle — lifecycle is null
    await expect(onGroupAdded('some-group')).resolves.toBeUndefined();
    expect(reconcileGroupCapabilities).not.toHaveBeenCalled();
  });
});

describe('onGroupRemoved', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    _resetLifecycleForTest();
    vi.useRealTimers();
  });

  it('calls gcGroup when lifecycle is initialized', async () => {
    const deps = makeDeps();
    await initPerGroupCapabilityLifecycle(deps);

    await onGroupRemoved('old-group');

    expect(gcGroup).toHaveBeenCalledOnce();
    expect(gcGroup).toHaveBeenCalledWith({
      client: deps.client,
      namespace: deps.namespace,
      groupFolder: 'old-group',
    });
  });

  it('is a no-op when lifecycle is NOT initialized', async () => {
    // Lifecycle not initialized
    await expect(onGroupRemoved('some-group')).resolves.toBeUndefined();
    expect(gcGroup).not.toHaveBeenCalled();
  });
});

describe('sweeper timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    _resetLifecycleForTest();
    vi.useRealTimers();
  });

  it('fires sweepIdleInstances after sweepIntervalMs', async () => {
    const deps = makeDeps({ sweepIntervalMs: 1_000 });
    await initPerGroupCapabilityLifecycle(deps);

    expect(sweepIdleInstances).not.toHaveBeenCalled();

    // Advance past the sweep interval
    await vi.advanceTimersByTimeAsync(1_000);
    // Let the async IIFE complete
    await Promise.resolve();

    expect(sweepIdleInstances).toHaveBeenCalledOnce();
  });

  it('logs a warning and schedules the next tick when sweeper throws', async () => {
    vi.mocked(sweepIdleInstances).mockRejectedValueOnce(
      new Error('sweep failed'),
    );

    const deps = makeDeps({ sweepIntervalMs: 1_000 });
    await initPerGroupCapabilityLifecycle(deps);

    // First tick — throws
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    await Promise.resolve(); // allow rejection handler to run

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'sweepIdleInstances threw',
    );

    // Reset mock so second tick succeeds
    vi.mocked(sweepIdleInstances).mockResolvedValue(undefined);

    // Second tick should still fire (sweeper re-scheduled itself)
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(sweepIdleInstances).toHaveBeenCalledTimes(2);
  });
});

describe('periodic reconcile timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    _resetLifecycleForTest();
    vi.useRealTimers();
  });

  it('fires reconcileGroupCapabilities after periodicReconcileMs', async () => {
    const deps = makeDeps({ periodicReconcileMs: 2_000 });
    await initPerGroupCapabilityLifecycle(deps);
    // Clear the startup call
    vi.mocked(reconcileGroupCapabilities).mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();

    expect(reconcileGroupCapabilities).toHaveBeenCalledOnce();
  });

  it('logs a warning when periodic reconcile throws', async () => {
    vi.mocked(reconcileGroupCapabilities)
      .mockResolvedValueOnce(undefined) // initial reconcile succeeds
      .mockRejectedValueOnce(new Error('reconcile boom')); // periodic fails

    const deps = makeDeps({ periodicReconcileMs: 2_000 });
    await initPerGroupCapabilityLifecycle(deps);

    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'per-group periodic reconcile failed',
    );
  });
});
