import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { scaleUpInstance } from './scale-up.js';
import { upsertInstance, getInstance } from './db.js';

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
});
