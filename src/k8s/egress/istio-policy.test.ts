import { describe, expect, it } from 'vitest';

import { buildIstioEgressObjects } from './istio-policy.js';

describe('buildIstioEgressObjects', () => {
  it('creates a Sidecar and a ServiceEntry per host', () => {
    const objs: any[] = buildIstioEgressObjects({
      name: 'job1',
      namespace: 'kubeclaw',
      jobLabel: 'job1',
      allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
    });
    const sidecar = objs.find((o) => o.kind === 'Sidecar');
    const se = objs.find((o) => o.kind === 'ServiceEntry');
    expect(sidecar.spec.workloadSelector.labels['kubeclaw/agent-job']).toBe(
      'job1',
    );
    expect(se.spec.hosts).toContain('api.search.brave.com');
  });

  it('creates only a Sidecar (in-namespace only) when egress is empty', () => {
    const objs: any[] = buildIstioEgressObjects({
      name: 'j',
      namespace: 'kubeclaw',
      jobLabel: 'j',
      allowedEgress: [],
    });
    expect(objs.filter((o) => o.kind === 'ServiceEntry')).toHaveLength(0);
    expect(
      objs.find((o) => o.kind === 'Sidecar').spec.egress[0].hosts,
    ).toContain('./*');
  });

  it('sets ownerReferences on Sidecar and ServiceEntry when ownerRef is provided', () => {
    const objs: any[] = buildIstioEgressObjects({
      name: 'egress-job1',
      namespace: 'kubeclaw',
      jobLabel: 'job1',
      allowedEgress: [{ host: 'api.openai.com', ports: [443] }],
      ownerRef: { name: 'my-job', uid: 'uid-999' },
    });
    for (const obj of objs) {
      expect(obj.metadata.ownerReferences).toHaveLength(1);
      expect(obj.metadata.ownerReferences[0].uid).toBe('uid-999');
      expect(obj.metadata.ownerReferences[0].controller).toBe(true);
      expect(obj.metadata.ownerReferences[0].blockOwnerDeletion).toBe(true);
    }
  });

  it('omits ownerReferences when ownerRef is not provided', () => {
    const objs: any[] = buildIstioEgressObjects({
      name: 'egress-job1',
      namespace: 'kubeclaw',
      jobLabel: 'job1',
      allowedEgress: [],
    });
    for (const obj of objs) {
      expect(obj.metadata.ownerReferences).toBeUndefined();
    }
  });

  it('falls back to port 443 when ServiceEntry ports is an explicit empty array', () => {
    const objs: any[] = buildIstioEgressObjects({
      name: 'egress-job1',
      namespace: 'kubeclaw',
      jobLabel: 'job1',
      allowedEgress: [{ host: 'api.example.com', ports: [] }],
    });
    const se = objs.find((o: any) => o.kind === 'ServiceEntry');
    expect(se).toBeDefined();
    expect(se.spec.ports).toHaveLength(1);
    expect(se.spec.ports[0].number).toBe(443);
  });
});
