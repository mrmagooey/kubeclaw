import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { sweepIdleInstances } from './scale-down-sweeper.js';
import {
  upsertInstance,
  setReplicas,
  touchLastUsed,
  getInstance,
} from './db.js';
import type { CapabilitySpec } from '../capabilities/types.js';

beforeAll(async () => {
  await _initTestDatabase();
});
beforeEach(() => {
  __resetDbForTest();
});

const spec: CapabilitySpec = {
  name: 'echo',
  kind: 'mcp',
  image: 'echo:1',
  scope: 'group',
  scaleDownAfterIdleSeconds: 600,
};

describe('sweepIdleInstances', () => {
  it('scales down instance idle longer than threshold', async () => {
    const c = new FakePerGroupK8sClient();
    upsertInstance({
      groupFolder: 'Family',
      capabilityName: 'echo',
      groupHash: 'h1',
      deploymentName: 'mcp-echo-h1',
      serviceName: 'mcp-echo-h1',
    });
    setReplicas('Family', 'echo', 1);
    touchLastUsed('Family', 'echo', Math.floor(Date.now() / 1000) - 700);
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
    await sweepIdleInstances({
      client: c,
      namespace: 'kubeclaw',
      specs: [spec],
    });
    expect(getInstance('Family', 'echo')?.currentReplicas).toBe(0);
    expect(
      (await c.readDeployment('kubeclaw', 'mcp-echo-h1'))?.spec?.replicas,
    ).toBe(0);
  });

  it('leaves instance alone if recently used', async () => {
    const c = new FakePerGroupK8sClient();
    upsertInstance({
      groupFolder: 'Family',
      capabilityName: 'echo',
      groupHash: 'h1',
      deploymentName: 'mcp-echo-h1',
      serviceName: 'mcp-echo-h1',
    });
    setReplicas('Family', 'echo', 1);
    touchLastUsed('Family', 'echo', Math.floor(Date.now() / 1000) - 30);
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
    await sweepIdleInstances({
      client: c,
      namespace: 'kubeclaw',
      specs: [spec],
    });
    expect(getInstance('Family', 'echo')?.currentReplicas).toBe(1);
  });

  it('treats missing last_used_at as idle (scales down)', async () => {
    const c = new FakePerGroupK8sClient();
    upsertInstance({
      groupFolder: 'Family',
      capabilityName: 'echo',
      groupHash: 'h1',
      deploymentName: 'mcp-echo-h1',
      serviceName: 'mcp-echo-h1',
    });
    setReplicas('Family', 'echo', 1);
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
    await sweepIdleInstances({
      client: c,
      namespace: 'kubeclaw',
      specs: [spec],
    });
    expect(getInstance('Family', 'echo')?.currentReplicas).toBe(0);
  });
});
