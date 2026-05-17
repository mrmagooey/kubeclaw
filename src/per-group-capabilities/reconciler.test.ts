import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { reconcileGroupCapabilities } from './reconciler.js';
import { listAllInstances } from './db.js';
import type { CapabilitySpec } from '../capabilities/types.js';

beforeAll(async () => {
  await _initTestDatabase();
});
beforeEach(() => {
  __resetDbForTest();
});

const fakeSpec: CapabilitySpec = {
  name: 'echo', kind: 'mcp', image: 'echo:1',
  scope: 'group', volumeFromGroupPvc: false, credentialsFrom: 'none',
};

describe('reconcileGroupCapabilities', () => {
  it('creates Deployment, Service, NetworkPolicy for each (group, capability) pair', async () => {
    const c = new FakePerGroupK8sClient();
    await reconcileGroupCapabilities({
      client: c, namespace: 'kubeclaw', groupsPvcName: 'pvc',
      groups: ['Family', 'Work'], specs: [fakeSpec],
    });
    expect(c.store.deployments.size).toBe(2);
    expect(c.store.services.size).toBe(2);
    expect(c.store.policies.size).toBe(2);
    expect(listAllInstances()).toHaveLength(2);
  });

  it('is idempotent (second call produces no extra objects)', async () => {
    const c = new FakePerGroupK8sClient();
    const args = { client: c, namespace: 'kubeclaw', groupsPvcName: 'pvc',
      groups: ['Family'], specs: [fakeSpec] };
    await reconcileGroupCapabilities(args);
    await reconcileGroupCapabilities(args);
    expect(c.store.deployments.size).toBe(1);
  });

  it('does not deploy cluster-scoped specs', async () => {
    const c = new FakePerGroupK8sClient();
    const clusterSpec: CapabilitySpec = { name: 'docling', kind: 'mcp', image: 'd:1' };
    await reconcileGroupCapabilities({
      client: c, namespace: 'kubeclaw', groupsPvcName: 'pvc',
      groups: ['Family'], specs: [clusterSpec, fakeSpec],
    });
    expect(c.store.deployments.size).toBe(1);
    const dep = [...c.store.deployments.values()][0];
    expect(dep.metadata?.labels?.['kubeclaw.io/capability']).toBe('echo');
  });

  it('records SQLite rows tagged with the correct group_hash', async () => {
    const c = new FakePerGroupK8sClient();
    await reconcileGroupCapabilities({
      client: c, namespace: 'kubeclaw', groupsPvcName: 'pvc',
      groups: ['Family'], specs: [fakeSpec],
    });
    const rows = listAllInstances();
    expect(rows).toHaveLength(1);
    expect(rows[0].groupHash).toMatch(/^[0-9a-f]{10}$/);
    expect(rows[0].deploymentName).toBe(`mcp-echo-${rows[0].groupHash}`);
  });
});
