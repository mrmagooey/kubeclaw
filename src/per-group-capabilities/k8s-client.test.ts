import { describe, it, expect } from 'vitest';
import { FakePerGroupK8sClient } from './k8s-client.js';

describe('FakePerGroupK8sClient', () => {
  it('apply + read round-trip a Deployment', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'd1', namespace: 'ns', labels: { x: 'y' } },
      spec: { replicas: 0, selector: { matchLabels: { x: 'y' } },
        template: { metadata: { labels: { x: 'y' } }, spec: { containers: [] } } },
    });
    const got = await c.readDeployment('ns', 'd1');
    expect(got?.spec?.replicas).toBe(0);
  });

  it('patchDeploymentReplicas updates replica count', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'd1', namespace: 'ns' },
      spec: { replicas: 0, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    await c.patchDeploymentReplicas('ns', 'd1', 1);
    const got = await c.readDeployment('ns', 'd1');
    expect(got?.spec?.replicas).toBe(1);
  });

  it('deleteByLabel removes matching objects across all kinds', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'd1', namespace: 'ns', labels: { 'kubeclaw.io/group-hash': 'h1' } },
      spec: { replicas: 0, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    await c.applyService({
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: 's1', namespace: 'ns', labels: { 'kubeclaw.io/group-hash': 'h1' } },
      spec: {},
    });
    await c.deleteByLabel('ns', 'kubeclaw.io/group-hash=h1');
    expect(await c.readDeployment('ns', 'd1')).toBeNull();
    expect(await c.readService('ns', 's1')).toBeNull();
  });

  it('waitForReady resolves when fake marks ready', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'd1', namespace: 'ns' },
      spec: { replicas: 1, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    setTimeout(() => c.markReady('ns', 'd1'), 10);
    await c.waitForReady('ns', 'd1', 1000);
  });

  it('waitForReady throws on timeout', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'd1', namespace: 'ns' },
      spec: { replicas: 1, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    await expect(c.waitForReady('ns', 'd1', 50)).rejects.toThrow(/timeout/);
  });

  it('listDeploymentsByLabel returns matching deployments', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'd1', namespace: 'ns', labels: { app: 'a' } },
      spec: { replicas: 0, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'd2', namespace: 'ns', labels: { app: 'b' } },
      spec: { replicas: 0, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    const matches = await c.listDeploymentsByLabel('ns', 'app=a');
    expect(matches).toHaveLength(1);
    expect(matches[0].metadata?.name).toBe('d1');
  });

  it('deleteSecret removes the secret', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applySecret({
      apiVersion: 'v1', kind: 'Secret',
      metadata: { name: 's1', namespace: 'ns' },
      type: 'Opaque', data: {},
    });
    await c.deleteSecret('ns', 's1');
    expect(await c.readSecret('ns', 's1')).toBeNull();
  });
});
