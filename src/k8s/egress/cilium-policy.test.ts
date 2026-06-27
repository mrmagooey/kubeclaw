import { describe, expect, it } from 'vitest';

import { buildCiliumEgressPolicy } from './cilium-policy.js';

describe('buildCiliumEgressPolicy', () => {
  const base = {
    name: 'egress-job1',
    namespace: 'kubeclaw',
    jobLabel: 'job1',
    redisNamespace: 'kubeclaw',
  };

  it('renders toFQDNs for each allowed host', () => {
    const p: any = buildCiliumEgressPolicy({
      ...base,
      allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
    });
    expect(p.kind).toBe('CiliumNetworkPolicy');
    expect(p.spec.endpointSelector.matchLabels['kubeclaw/agent-job']).toBe(
      'job1',
    );
    const fqdnRule = p.spec.egress.find((e: any) => e.toFQDNs);
    expect(fqdnRule.toFQDNs).toContainEqual({
      matchName: 'api.search.brave.com',
    });
  });

  it('omits any toFQDNs rule when allowedEgress is empty (DNS+Redis only)', () => {
    const p: any = buildCiliumEgressPolicy({ ...base, allowedEgress: [] });
    expect(p.spec.egress.some((e: any) => e.toFQDNs)).toBe(false);
    // DNS + Redis still present
    expect(p.spec.egress.length).toBe(2);
  });

  it('falls back to port 443 when ports is an explicit empty array', () => {
    const p: any = buildCiliumEgressPolicy({
      ...base,
      allowedEgress: [{ host: 'api.example.com', ports: [] }],
    });
    const fqdnRule = p.spec.egress.find((e: any) => e.toFQDNs);
    expect(fqdnRule).toBeDefined();
    const portNumbers = fqdnRule.toPorts[0].ports.map((p: any) =>
      Number(p.port),
    );
    expect(portNumbers).toContain(443);
    expect(portNumbers).not.toHaveLength(0);
  });

  it('sets ownerReferences when ownerRef is provided', () => {
    const p: any = buildCiliumEgressPolicy({
      ...base,
      allowedEgress: [],
      ownerRef: { name: 'my-job', uid: 'abc-123' },
    });
    expect(p.metadata.ownerReferences).toHaveLength(1);
    expect(p.metadata.ownerReferences[0].uid).toBe('abc-123');
    expect(p.metadata.ownerReferences[0].controller).toBe(true);
    expect(p.metadata.ownerReferences[0].blockOwnerDeletion).toBe(true);
    expect(p.metadata.ownerReferences[0].kind).toBe('Job');
  });

  it('omits ownerReferences when ownerRef is not provided', () => {
    const p: any = buildCiliumEgressPolicy({ ...base, allowedEgress: [] });
    expect(p.metadata.ownerReferences).toBeUndefined();
  });
});
