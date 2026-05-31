/**
 * Integration tests for Story 39 — per-group capability wakes from zero on
 * first use after scale-down.
 *
 * Exercises the full discovery → scaleUpInstance → waitForReady path using
 * FakePerGroupK8sClient + in-memory SQLite, with no live K8s or Redis
 * dependencies.
 *
 * Covers:
 *   AC1 – wake returns state=ready with a usable endpoint.
 *   AC2 – orchestrator log contains per_group_capability_scale_up with coldStartMs >= 0.
 *   AC3 – second concurrent discovery request for the same group is serialized
 *          (both succeed after readiness — not dropped, not errored).
 *   AC4 – after wake, currentReplicas=1 and last_used_at is updated.
 *   AC5 – a different group's deployment remains at replicas=0.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import {
  __handleRequestForTest,
  setDiscoveryDeps,
  _resetDiscoveryDepsForTest,
} from '../capabilities/discovery.js';
import { setCapability } from '../capabilities/db.js';
import { upsertInstance, getInstance, setReplicas } from './db.js';
import { groupHash } from './hash.js';
import type { CapabilityDiscoveryEntry } from '../capabilities/types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSet = vi.hoisted(() => vi.fn().mockResolvedValue('OK'));
const mockXrevrange = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({
    set: mockSet,
    xrevrange: mockXrevrange,
  })),
  createStreamWatcherClient: vi.fn(() => ({
    xread: vi.fn(),
    xrevrange: mockXrevrange,
  })),
  getDiscoveryRequestStream: () => 'kubeclaw:discovery:request',
  getDiscoveryResponseKey: (id: string) => `kubeclaw:discovery:response:${id}`,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../capabilities/reconciler.js', () => ({
  applySpec: vi.fn().mockResolvedValue(undefined),
  deleteSpec: vi.fn().mockResolvedValue(undefined),
  reconcileAllOnStartup: vi.fn().mockResolvedValue(undefined),
}));

import { logger } from '../logger.js';

// ── Test setup ────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw';

// Alice's group
const ALICE_GROUP = 'http-http-alice';
const ALICE_HASH = groupHash(ALICE_GROUP);
const ALICE_DEP = `mcp-echo-${ALICE_HASH}`;

// Bob's group
const BOB_GROUP = 'http-http-bob';
const BOB_HASH = groupHash(BOB_GROUP);
const BOB_DEP = `mcp-echo-${BOB_HASH}`;

const echoSpec = {
  kind: 'mcp' as const,
  name: 'echo',
  image: 'kubeclaw-echo:e2e-test',
  scope: 'group' as const,
  scaleDownAfterIdleSeconds: 10,
};

function setupDb(): void {
  setCapability(echoSpec);
  upsertInstance({
    groupFolder: ALICE_GROUP,
    capabilityName: 'echo',
    groupHash: ALICE_HASH,
    deploymentName: ALICE_DEP,
    serviceName: ALICE_DEP,
  });
  upsertInstance({
    groupFolder: BOB_GROUP,
    capabilityName: 'echo',
    groupHash: BOB_HASH,
    deploymentName: BOB_DEP,
    serviceName: BOB_DEP,
  });
  // Both start at replicas=0 (simulating post-sweep idle state).
  setReplicas(ALICE_GROUP, 'echo', 0);
  setReplicas(BOB_GROUP, 'echo', 0);
}

beforeAll(async () => {
  await _initTestDatabase();
});

beforeEach(() => {
  __resetDbForTest();
  mockSet.mockClear();
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  _resetDiscoveryDepsForTest();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('wake-from-zero: per-group capability wakes on first use (Story 39)', () => {
  it('AC1 – discovery request for scaled-to-zero capability returns state=ready with endpoint', async () => {
    setupDb();
    const client = new FakePerGroupK8sClient();
    await client.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: ALICE_DEP, namespace: NAMESPACE },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });

    setDiscoveryDeps({
      perGroupK8sClient: client,
      namespace: NAMESPACE,
      discoveryTimeoutMs: 1000,
    });
    setTimeout(() => client.markReady(NAMESPACE, ALICE_DEP), 20);

    await __handleRequestForTest({
      requestId: 'wake-ac1',
      capability: 'echo',
      group: ALICE_GROUP,
    });

    expect(mockSet).toHaveBeenCalledOnce();
    const result = JSON.parse(
      mockSet.mock.calls[0][1] as string,
    ) as CapabilityDiscoveryEntry[];
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.state).toBe('ready');
    expect(entry.endpoint).toContain(ALICE_DEP);
    expect(entry.endpoint).toContain(NAMESPACE);
  });

  it('AC2 – wake emits per_group_capability_scale_up log with coldStartMs >= 0', async () => {
    setupDb();
    const client = new FakePerGroupK8sClient();
    await client.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: ALICE_DEP, namespace: NAMESPACE },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });

    setDiscoveryDeps({
      perGroupK8sClient: client,
      namespace: NAMESPACE,
      discoveryTimeoutMs: 1000,
    });
    setTimeout(() => client.markReady(NAMESPACE, ALICE_DEP), 20);

    await __handleRequestForTest({
      requestId: 'wake-ac2',
      capability: 'echo',
      group: ALICE_GROUP,
    });

    const scaleUpCall = vi
      .mocked(logger.info)
      .mock.calls.find((c) => c[1] === 'per_group_capability_scale_up');
    expect(
      scaleUpCall,
      'expected per_group_capability_scale_up log entry',
    ).toBeTruthy();
    const logData = scaleUpCall![0] as {
      group: string;
      capability: string;
      coldStartMs: number;
    };
    expect(logData.group).toBe(ALICE_GROUP);
    expect(logData.capability).toBe('echo');
    expect(logData.coldStartMs).toBeGreaterThanOrEqual(0);
  });

  it('AC3 – concurrent second request from same group is answered after readiness, not dropped', async () => {
    setupDb();
    const client = new FakePerGroupK8sClient();
    await client.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: ALICE_DEP, namespace: NAMESPACE },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });

    setDiscoveryDeps({
      perGroupK8sClient: client,
      namespace: NAMESPACE,
      discoveryTimeoutMs: 1000,
    });
    // Mark ready slightly later than requests are issued.
    setTimeout(() => client.markReady(NAMESPACE, ALICE_DEP), 30);

    // Fire two concurrent discovery requests. Both settle without error;
    // the assertions below check the responses were written.
    await Promise.all([
      __handleRequestForTest({
        requestId: 'wake-ac3-a',
        capability: 'echo',
        group: ALICE_GROUP,
      }),
      __handleRequestForTest({
        requestId: 'wake-ac3-b',
        capability: 'echo',
        group: ALICE_GROUP,
      }),
    ]);

    // Both requestIds should have had a response written.
    const writtenKeys = mockSet.mock.calls.map((c) => c[0] as string);
    expect(writtenKeys).toContain('kubeclaw:discovery:response:wake-ac3-a');
    expect(writtenKeys).toContain('kubeclaw:discovery:response:wake-ac3-b');

    // Both responses should report state=ready.
    for (const call of mockSet.mock.calls) {
      if (
        (call[0] as string).startsWith('kubeclaw:discovery:response:wake-ac3-')
      ) {
        const entries = JSON.parse(
          call[1] as string,
        ) as CapabilityDiscoveryEntry[];
        expect(entries[0].state).toBe('ready');
      }
    }
  });

  it('AC4 – after wake, currentReplicas=1 and last_used_at is updated in DB', async () => {
    setupDb();
    const client = new FakePerGroupK8sClient();
    await client.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: ALICE_DEP, namespace: NAMESPACE },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });

    setDiscoveryDeps({
      perGroupK8sClient: client,
      namespace: NAMESPACE,
      discoveryTimeoutMs: 1000,
    });
    setTimeout(() => client.markReady(NAMESPACE, ALICE_DEP), 20);

    const beforeTs = Math.floor(Date.now() / 1000);
    await __handleRequestForTest({
      requestId: 'wake-ac4',
      capability: 'echo',
      group: ALICE_GROUP,
    });

    const inst = getInstance(ALICE_GROUP, 'echo');
    expect(inst?.currentReplicas).toBe(1);
    expect(inst?.lastUsedAt).toBeGreaterThanOrEqual(beforeTs);

    // K8s Deployment also has replicas=1.
    const dep = await client.readDeployment(NAMESPACE, ALICE_DEP);
    expect(dep?.spec?.replicas).toBe(1);
  });

  it('AC5 – alice request does not wake bob deployment (per-group isolation)', async () => {
    setupDb();
    const client = new FakePerGroupK8sClient();
    await client.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: ALICE_DEP, namespace: NAMESPACE },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    await client.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: BOB_DEP, namespace: NAMESPACE },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });

    setDiscoveryDeps({
      perGroupK8sClient: client,
      namespace: NAMESPACE,
      discoveryTimeoutMs: 1000,
    });
    setTimeout(() => client.markReady(NAMESPACE, ALICE_DEP), 20);

    // Only alice sends a request.
    await __handleRequestForTest({
      requestId: 'wake-ac5',
      capability: 'echo',
      group: ALICE_GROUP,
    });

    // Alice's deployment woke up.
    const aliceDep = await client.readDeployment(NAMESPACE, ALICE_DEP);
    expect(aliceDep?.spec?.replicas).toBe(1);

    // Bob's deployment is untouched — still at replicas=0.
    const bobDep = await client.readDeployment(NAMESPACE, BOB_DEP);
    expect(bobDep?.spec?.replicas).toBe(0);
    expect(getInstance(BOB_GROUP, 'echo')?.currentReplicas).toBe(0);
  });

  it('no-op when capability already running (replicas=1 in DB, already ready)', async () => {
    setupDb();
    // Simulate alice's capability already running (not swept yet).
    setReplicas(ALICE_GROUP, 'echo', 1);
    const client = new FakePerGroupK8sClient();
    await client.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: ALICE_DEP, namespace: NAMESPACE },
      spec: {
        replicas: 1,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    // Already ready.
    client.markReady(NAMESPACE, ALICE_DEP);
    const patchSpy = vi.spyOn(client, 'patchDeploymentReplicas');

    setDiscoveryDeps({
      perGroupK8sClient: client,
      namespace: NAMESPACE,
      discoveryTimeoutMs: 1000,
    });

    await __handleRequestForTest({
      requestId: 'wake-noop',
      capability: 'echo',
      group: ALICE_GROUP,
    });

    const result = JSON.parse(
      mockSet.mock.calls[0][1] as string,
    ) as CapabilityDiscoveryEntry[];
    expect(result[0].state).toBe('ready');
    // No patch was issued since it was already at replicas=1.
    expect(patchSpy).not.toHaveBeenCalled();
  });
});
