import { describe, it, expect } from 'vitest';
import { makeEgressApplier, type CustomObjectsClient } from './apply.js';

describe('Egress applier', () => {
  it('cilium: credentialed image_search yields a toFQDNs policy for exactly its host', async () => {
    const created: any[] = [];
    const client: CustomObjectsClient = {
      create: async (_g, _v, _ns, plural, body) => { created.push({ plural, body }); },
      delete: async () => {},
    };
    const applier = makeEgressApplier({ substrate: 'cilium', customObjects: client, redisNamespace: 'kubeclaw' });
    await applier.applyForJob({
      jobName: 'job-xyz', jobLabel: 'job-xyz', namespace: 'kubeclaw',
      allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
    });
    const policy = created[0].body;
    const fqdn = policy.spec.egress.find((e: any) => e.toFQDNs);
    expect(fqdn.toFQDNs).toEqual([{ matchName: 'api.search.brave.com' }]);
    expect(policy.spec.egress.some((e: any) => e.toFQDNs?.some((f: any) => f.matchName !== 'api.search.brave.com'))).toBe(false);
  });
});
