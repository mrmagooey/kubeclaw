import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { scaleUpInstance } from './scale-up.js';
import { upsertInstance, getInstance, setReplicas } from './db.js';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { logger } from '../logger.js';

beforeAll(async () => {
  await _initTestDatabase();
});

beforeEach(() => {
  __resetDbForTest();
  upsertInstance({
    groupFolder: 'Family',
    capabilityName: 'echo',
    groupHash: 'h1',
    deploymentName: 'mcp-echo-h1',
    serviceName: 'mcp-echo-h1',
  });
});

describe('scaleUpInstance', () => {
  beforeEach(() => {
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
  });

  it('returns ready when fake reaches ready', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    setTimeout(() => c.markReady('kubeclaw', 'mcp-echo-h1'), 10);
    const res = await scaleUpInstance({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'echo',
      timeoutMs: 1000,
    });
    expect(res.state).toBe('ready');
    expect(getInstance('Family', 'echo')?.currentReplicas).toBe(1);
  });

  it('returns failed on timeout', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    const res = await scaleUpInstance({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'echo',
      timeoutMs: 50,
    });
    expect(res.state).toBe('failed');
  });

  it('returns failed if instance not in db', async () => {
    const c = new FakePerGroupK8sClient();
    const res = await scaleUpInstance({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Unknown',
      capabilityName: 'x',
      timeoutMs: 50,
    });
    expect(res.state).toBe('failed');
    if (res.state === 'failed') expect(res.error).toMatch(/no instance/i);
  });

  it('records last_used_at on success', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    setTimeout(() => c.markReady('kubeclaw', 'mcp-echo-h1'), 10);
    await scaleUpInstance({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'echo',
      timeoutMs: 1000,
    });
    const lastUsed = getInstance('Family', 'echo')?.lastUsedAt;
    expect(lastUsed).toBeTruthy();
    expect(lastUsed!).toBeGreaterThan(0);
  });

  // Story 39 — wake-from-zero specific cases

  it('emits per_group_capability_scale_up log with coldStartMs >= 0 on wake', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    setTimeout(() => c.markReady('kubeclaw', 'mcp-echo-h1'), 10);
    const res = await scaleUpInstance({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'echo',
      timeoutMs: 1000,
    });
    expect(res.state).toBe('ready');
    if (res.state === 'ready') {
      expect(res.coldStartMs).toBeGreaterThanOrEqual(0);
    }
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'Family',
        capability: 'echo',
        coldStartMs: expect.any(Number),
      }),
      'per_group_capability_scale_up',
    );
    const logCall = vi.mocked(logger.info).mock.calls.find(
      (c) => c[1] === 'per_group_capability_scale_up',
    );
    expect(logCall?.[0]).toMatchObject({ coldStartMs: expect.any(Number) });
    const coldStartMs = (logCall?.[0] as { coldStartMs: number }).coldStartMs;
    expect(coldStartMs).toBeGreaterThanOrEqual(0);
  });

  it('calls patchDeploymentReplicas when currentReplicas is 0 (cold start)', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    const patchSpy = vi.spyOn(c, 'patchDeploymentReplicas');
    setTimeout(() => c.markReady('kubeclaw', 'mcp-echo-h1'), 10);
    await scaleUpInstance({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'echo',
      timeoutMs: 1000,
    });
    expect(patchSpy).toHaveBeenCalledWith('kubeclaw', 'mcp-echo-h1', 1);
  });

  it('skips patchDeploymentReplicas when currentReplicas is already 1', async () => {
    // Simulate instance already running (e.g. not yet swept).
    setReplicas('Family', 'echo', 1);
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: {
        replicas: 1,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    const patchSpy = vi.spyOn(c, 'patchDeploymentReplicas');
    c.markReady('kubeclaw', 'mcp-echo-h1');
    await scaleUpInstance({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'echo',
      timeoutMs: 1000,
    });
    // Should NOT have called patch since it was already at 1.
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('per-group isolation: alice wake does not affect bob deployment', async () => {
    // Add alice's instance (already set up in beforeEach as 'Family')
    // Add bob's separate instance.
    upsertInstance({
      groupFolder: 'Bob',
      capabilityName: 'echo',
      groupHash: 'h2',
      deploymentName: 'mcp-echo-h2',
      serviceName: 'mcp-echo-h2',
    });
    setReplicas('Bob', 'echo', 0);

    const c = new FakePerGroupK8sClient();
    // Alice's deployment at replicas=0.
    await c.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    // Bob's deployment at replicas=0.
    await c.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'mcp-echo-h2', namespace: 'kubeclaw' },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });

    setTimeout(() => c.markReady('kubeclaw', 'mcp-echo-h1'), 10);

    // Only wake alice.
    const res = await scaleUpInstance({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'echo',
      timeoutMs: 1000,
    });
    expect(res.state).toBe('ready');

    // Alice's deployment woke up.
    const aliceDep = await c.readDeployment('kubeclaw', 'mcp-echo-h1');
    expect(aliceDep?.spec?.replicas).toBe(1);

    // Bob's deployment remains at replicas=0 — not touched.
    const bobDep = await c.readDeployment('kubeclaw', 'mcp-echo-h2');
    expect(bobDep?.spec?.replicas).toBe(0);
    expect(getInstance('Bob', 'echo')?.currentReplicas).toBe(0);
  });
});
