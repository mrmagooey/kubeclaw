import { describe, expect, it } from 'vitest';

import { buildCiliumEgressPolicy } from './cilium-policy.js';

describe('buildCiliumEgressPolicy', () => {
  const base = { name: 'egress-job1', namespace: 'kubeclaw', jobLabel: 'job1', redisNamespace: 'kubeclaw' };

  it('renders toFQDNs for each allowed host', () => {
    const p: any = buildCiliumEgressPolicy({ ...base, allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }] });
    expect(p.kind).toBe('CiliumNetworkPolicy');
    expect(p.spec.endpointSelector.matchLabels['kubeclaw/agent-job']).toBe('job1');
    const fqdnRule = p.spec.egress.find((e: any) => e.toFQDNs);
    expect(fqdnRule.toFQDNs).toContainEqual({ matchName: 'api.search.brave.com' });
  });

  it('omits any toFQDNs rule when allowedEgress is empty (DNS+Redis only)', () => {
    const p: any = buildCiliumEgressPolicy({ ...base, allowedEgress: [] });
    expect(p.spec.egress.some((e: any) => e.toFQDNs)).toBe(false);
    // DNS + Redis still present
    expect(p.spec.egress.length).toBe(2);
  });
});
