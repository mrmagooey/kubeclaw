import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { gcGroup } from './gc.js';
import { upsertInstance, listInstances } from './db.js';

beforeAll(async () => {
  await _initTestDatabase();
});

beforeEach(() => {
  __resetDbForTest();
});

describe('gcGroup', () => {
  it('deletes all K8s objects and DB rows for the group', async () => {
    const { groupHash } = await import('./hash.js');
    const c = new FakePerGroupK8sClient();
    const hash = groupHash('Family');
    upsertInstance({
      groupFolder: 'Family',
      capabilityName: 'echo',
      groupHash: hash,
      deploymentName: `mcp-echo-${hash}`,
      serviceName: `mcp-echo-${hash}`,
    });
    await c.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: `mcp-echo-${hash}`,
        namespace: 'kubeclaw',
        labels: { 'kubeclaw.io/group-hash': hash },
      },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    await c.applyService({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: `mcp-echo-${hash}`,
        namespace: 'kubeclaw',
        labels: { 'kubeclaw.io/group-hash': hash },
      },
      spec: {},
    });

    await gcGroup({ client: c, namespace: 'kubeclaw', groupFolder: 'Family' });

    expect(await c.readDeployment('kubeclaw', `mcp-echo-${hash}`)).toBeNull();
    expect(await c.readService('kubeclaw', `mcp-echo-${hash}`)).toBeNull();
    expect(listInstances('Family')).toEqual([]);
  });

  it('is safe to call on a group with no instances', async () => {
    const c = new FakePerGroupK8sClient();
    await expect(
      gcGroup({ client: c, namespace: 'kubeclaw', groupFolder: 'Empty' }),
    ).resolves.not.toThrow();
  });
});
