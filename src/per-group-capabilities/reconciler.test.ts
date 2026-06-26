import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { reconcileGroupCapabilities } from './reconciler.js';
import { listAllInstances } from './db.js';
import type { CapabilitySpec } from '../capabilities/types.js';
import { groupHash } from './hash.js';
import { pvcName } from './pvc.js';
import { credsSecretName } from './k8s-objects.js';

beforeAll(async () => {
  await _initTestDatabase();
});
beforeEach(() => {
  __resetDbForTest();
});

const fakeSpec: CapabilitySpec = {
  name: 'echo',
  kind: 'mcp',
  image: 'echo:1',
  scope: 'group',
  volumeFromGroupPvc: false,
  credentialsFrom: 'none',
};

describe('reconcileGroupCapabilities', () => {
  it('creates Deployment, Service, NetworkPolicy for each (group, capability) pair', async () => {
    const c = new FakePerGroupK8sClient();
    await reconcileGroupCapabilities({
      client: c,
      namespace: 'kubeclaw',
      groupsPvcName: 'pvc',
      groups: ['Family', 'Work'],
      specs: [fakeSpec],
    });
    expect(c.store.deployments.size).toBe(2);
    expect(c.store.services.size).toBe(2);
    expect(c.store.policies.size).toBe(2);
    expect(listAllInstances()).toHaveLength(2);
  });

  it('is idempotent (second call produces no extra objects)', async () => {
    const c = new FakePerGroupK8sClient();
    const args = {
      client: c,
      namespace: 'kubeclaw',
      groupsPvcName: 'pvc',
      groups: ['Family'],
      specs: [fakeSpec],
    };
    await reconcileGroupCapabilities(args);
    await reconcileGroupCapabilities(args);
    expect(c.store.deployments.size).toBe(1);
  });

  it('does not deploy cluster-scoped specs', async () => {
    const c = new FakePerGroupK8sClient();
    const clusterSpec: CapabilitySpec = {
      name: 'docling',
      kind: 'mcp',
      image: 'd:1',
    };
    await reconcileGroupCapabilities({
      client: c,
      namespace: 'kubeclaw',
      groupsPvcName: 'pvc',
      groups: ['Family'],
      specs: [clusterSpec, fakeSpec],
    });
    expect(c.store.deployments.size).toBe(1);
    const dep = [...c.store.deployments.values()][0];
    expect(dep.metadata?.labels?.['kubeclaw.io/capability']).toBe('echo');
  });

  it('records SQLite rows tagged with the correct group_hash', async () => {
    const c = new FakePerGroupK8sClient();
    await reconcileGroupCapabilities({
      client: c,
      namespace: 'kubeclaw',
      groupsPvcName: 'pvc',
      groups: ['Family'],
      specs: [fakeSpec],
    });
    const rows = listAllInstances();
    expect(rows).toHaveLength(1);
    expect(rows[0].groupHash).toMatch(/^[0-9a-f]{10}$/);
    expect(rows[0].deploymentName).toBe(`mcp-echo-${rows[0].groupHash}`);
  });

  it('applies a dedicated PVC before the Deployment for a storage-backed capability', async () => {
    const client = new FakePerGroupK8sClient();
    const dbSpec: CapabilitySpec = {
      name: 'database',
      kind: 'mcp',
      image: 'pg-mcp:1',
      scope: 'group',
      storage: {
        sizeGi: 5,
        mountPath: '/var/lib/postgresql/data',
        container: 'postgres',
      },
      sidecars: [{ name: 'postgres', image: 'postgres:16', port: 5432 }],
    };
    await reconcileGroupCapabilities({
      client,
      namespace: 'kubeclaw',
      groupsPvcName: 'kubeclaw-groups',
      groups: ['alice'],
      specs: [dbSpec],
    });
    const hash = groupHash('alice');
    const expectedPvcName = pvcName('database', hash);
    expect(client.appliedPvcs.map((p) => p.metadata?.name)).toContain(
      expectedPvcName,
    );
    // PVC must be applied before the Deployment
    const pvcIndex = client.applyOrder.indexOf('pvc:' + expectedPvcName);
    const deployName = `mcp-database-${hash}`;
    const deployIndex = client.applyOrder.indexOf('deployment:' + deployName);
    expect(pvcIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(pvcIndex);
  });

  it('provisions DB credentials for credentialsFrom:secret and skips for credentialsFrom:none', async () => {
    const client = new FakePerGroupK8sClient();

    const secretSpec: CapabilitySpec = {
      name: 'database',
      kind: 'mcp',
      image: 'pg-mcp:1',
      scope: 'group',
      credentialsFrom: 'secret',
    };
    const noneSpec: CapabilitySpec = {
      name: 'echo',
      kind: 'mcp',
      image: 'echo:1',
      scope: 'group',
      credentialsFrom: 'none',
    };

    await reconcileGroupCapabilities({
      client,
      namespace: 'kubeclaw',
      groupsPvcName: 'pvc',
      groups: ['alice'],
      specs: [secretSpec, noneSpec],
    });

    const hash = groupHash('alice');

    // The database capability should have a credentials secret with all required keys
    const dbSecretName = credsSecretName('database', hash);
    const dbSecret = await client.readSecret('kubeclaw', dbSecretName);
    expect(dbSecret, 'database creds secret should exist').not.toBeNull();

    const read = (k: string) => {
      const raw = dbSecret?.data?.[k];
      if (!raw) return null;
      return Buffer.from(raw, 'base64').toString('utf-8');
    };

    expect(read('KUBECLAW_MCP_TOKEN')).toMatch(/^[0-9a-f]{64}$/);
    expect(read('POSTGRES_PASSWORD')).toMatch(/^[0-9a-f]{48}$/);
    expect(read('PGPASSWORD')).toBe(read('POSTGRES_PASSWORD'));
    expect(read('PG_RO_PASSWORD')).toMatch(/^[0-9a-f]{48}$/);
    expect(read('PG_RO_PASSWORD')).not.toBe(read('POSTGRES_PASSWORD'));

    // The echo capability (credentialsFrom:none) should have NO creds secret
    const echoSecretName = credsSecretName('echo', hash);
    const echoSecret = await client.readSecret('kubeclaw', echoSecretName);
    expect(echoSecret, 'echo creds secret should NOT exist').toBeNull();
  });

  it('credentials are provisioned before the deployment is applied', async () => {
    const client = new FakePerGroupK8sClient();

    const secretSpec: CapabilitySpec = {
      name: 'database',
      kind: 'mcp',
      image: 'pg-mcp:1',
      scope: 'group',
      credentialsFrom: 'secret',
    };

    await reconcileGroupCapabilities({
      client,
      namespace: 'kubeclaw',
      groupsPvcName: 'pvc',
      groups: ['alice'],
      specs: [secretSpec],
    });

    const hash = groupHash('alice');
    const dbSecretName = credsSecretName('database', hash);
    const deployName = `mcp-database-${hash}`;

    // After reconcile completes, credentials must be present
    const dbSecret = await client.readSecret('kubeclaw', dbSecretName);
    expect(
      dbSecret,
      'creds secret must be present after reconcile',
    ).not.toBeNull();

    // Assert ordering: the last secret write for the creds secret must come
    // BEFORE the deployment apply — mirrors the PVC-ordering test above.
    const deployIndex = client.applyOrder.indexOf('deployment:' + deployName);
    expect(
      deployIndex,
      'deployment should be in applyOrder',
    ).toBeGreaterThanOrEqual(0);

    // Find the LAST write to the creds secret (credential provisioning writes
    // multiple times — once per key — so we want the final write index).
    const secretEntry = 'secret:' + dbSecretName;
    const lastSecretIndex = client.applyOrder.lastIndexOf(secretEntry);
    expect(
      lastSecretIndex,
      'creds secret write should be in applyOrder',
    ).toBeGreaterThanOrEqual(0);

    expect(
      lastSecretIndex,
      'creds secret write must appear before deployment apply',
    ).toBeLessThan(deployIndex);
  });
});
