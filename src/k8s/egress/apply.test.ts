import { describe, expect, it } from 'vitest';
import { makeEgressApplier, type CustomObjectsClient } from './apply.js';

function fakeClient(): {
  client: CustomObjectsClient;
  created: any[];
  deleted: any[];
} {
  const created: any[] = [];
  const deleted: any[] = [];
  return {
    created,
    deleted,
    client: {
      create: async (g, v, ns, plural, body) => {
        created.push({ g, v, plural, body });
      },
      delete: async (g, v, ns, plural, name) => {
        deleted.push({ plural, name });
      },
    },
  };
}

describe('egress applier', () => {
  it('creates a CiliumNetworkPolicy under the cilium substrate', async () => {
    const f = fakeClient();
    const applier = makeEgressApplier({
      substrate: 'cilium',
      customObjects: f.client,
      redisNamespace: 'kubeclaw',
    });
    await applier.applyForJob({
      jobName: 'j1',
      jobLabel: 'j1',
      namespace: 'kubeclaw',
      allowedEgress: [{ host: 'api.search.brave.com' }],
    });
    expect(f.created).toHaveLength(1);
    expect(f.created[0].plural).toBe('ciliumnetworkpolicies');
  });

  it('creates Sidecar + ServiceEntry under the istio substrate', async () => {
    const f = fakeClient();
    const applier = makeEgressApplier({
      substrate: 'istio',
      customObjects: f.client,
      redisNamespace: 'kubeclaw',
    });
    await applier.applyForJob({
      jobName: 'j1',
      jobLabel: 'j1',
      namespace: 'kubeclaw',
      allowedEgress: [{ host: 'api.openai.com' }],
    });
    const plurals = f.created.map((c) => c.plural).sort();
    expect(plurals).toEqual(['serviceentries', 'sidecars']);
  });

  it('is a no-op create under the none substrate', async () => {
    const f = fakeClient();
    const applier = makeEgressApplier({
      substrate: 'none',
      customObjects: f.client,
      redisNamespace: 'kubeclaw',
    });
    await applier.applyForJob({
      jobName: 'j1',
      jobLabel: 'j1',
      namespace: 'kubeclaw',
      allowedEgress: [{ host: 'h.example.com' }],
    });
    expect(f.created).toHaveLength(0);
  });

  it('stamps ownerReferences on CiliumNetworkPolicy when ownerRef is passed', async () => {
    const f = fakeClient();
    const applier = makeEgressApplier({
      substrate: 'cilium',
      customObjects: f.client,
      redisNamespace: 'kubeclaw',
    });
    await applier.applyForJob({
      jobName: 'j1',
      jobLabel: 'j1',
      namespace: 'kubeclaw',
      allowedEgress: [],
      ownerRef: { name: 'j1', uid: 'uid-abc' },
    });
    expect(f.created).toHaveLength(1);
    const body = f.created[0].body as any;
    expect(body.metadata.ownerReferences).toHaveLength(1);
    expect(body.metadata.ownerReferences[0].uid).toBe('uid-abc');
    expect(body.metadata.ownerReferences[0].controller).toBe(true);
  });

  it('stamps ownerReferences on Sidecar and ServiceEntry when ownerRef is passed (istio)', async () => {
    const f = fakeClient();
    const applier = makeEgressApplier({
      substrate: 'istio',
      customObjects: f.client,
      redisNamespace: 'kubeclaw',
    });
    await applier.applyForJob({
      jobName: 'j2',
      jobLabel: 'j2',
      namespace: 'kubeclaw',
      allowedEgress: [{ host: 'api.openai.com' }],
      ownerRef: { name: 'j2', uid: 'uid-xyz' },
    });
    expect(f.created).toHaveLength(2);
    for (const c of f.created) {
      const body = c.body as any;
      expect(body.metadata.ownerReferences).toHaveLength(1);
      expect(body.metadata.ownerReferences[0].uid).toBe('uid-xyz');
      expect(body.metadata.ownerReferences[0].controller).toBe(true);
    }
  });

  it('deleteForJob deletes the correct Sidecar name (egress-<job>-egress) under istio', async () => {
    const f = fakeClient();
    const applier = makeEgressApplier({
      substrate: 'istio',
      customObjects: f.client,
      redisNamespace: 'kubeclaw',
    });
    await applier.deleteForJob({ jobName: 'myjob', namespace: 'kubeclaw' });
    expect(f.deleted).toHaveLength(1);
    expect(f.deleted[0].plural).toBe('sidecars');
    expect(f.deleted[0].name).toBe('egress-myjob-egress');
  });
});
