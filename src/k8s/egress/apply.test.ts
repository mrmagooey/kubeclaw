import { describe, expect, it } from 'vitest';
import { makeEgressApplier, type CustomObjectsClient } from './apply.js';

function fakeClient(): { client: CustomObjectsClient; created: any[]; deleted: any[] } {
  const created: any[] = [];
  const deleted: any[] = [];
  return {
    created, deleted,
    client: {
      create: async (g, v, ns, plural, body) => { created.push({ g, v, plural, body }); },
      delete: async (g, v, ns, plural, name) => { deleted.push({ plural, name }); },
    },
  };
}

describe('egress applier', () => {
  it('creates a CiliumNetworkPolicy under the cilium substrate', async () => {
    const f = fakeClient();
    const applier = makeEgressApplier({ substrate: 'cilium', customObjects: f.client, redisNamespace: 'kubeclaw' });
    await applier.applyForJob({ jobName: 'j1', jobLabel: 'j1', namespace: 'kubeclaw', allowedEgress: [{ host: 'api.search.brave.com' }] });
    expect(f.created).toHaveLength(1);
    expect(f.created[0].plural).toBe('ciliumnetworkpolicies');
  });

  it('creates Sidecar + ServiceEntry under the istio substrate', async () => {
    const f = fakeClient();
    const applier = makeEgressApplier({ substrate: 'istio', customObjects: f.client, redisNamespace: 'kubeclaw' });
    await applier.applyForJob({ jobName: 'j1', jobLabel: 'j1', namespace: 'kubeclaw', allowedEgress: [{ host: 'api.openai.com' }] });
    const plurals = f.created.map((c) => c.plural).sort();
    expect(plurals).toEqual(['serviceentries', 'sidecars']);
  });

  it('is a no-op create under the none substrate', async () => {
    const f = fakeClient();
    const applier = makeEgressApplier({ substrate: 'none', customObjects: f.client, redisNamespace: 'kubeclaw' });
    await applier.applyForJob({ jobName: 'j1', jobLabel: 'j1', namespace: 'kubeclaw', allowedEgress: [{ host: 'h.example.com' }] });
    expect(f.created).toHaveLength(0);
  });
});
