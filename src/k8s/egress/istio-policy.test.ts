import { describe, expect, it } from 'vitest';

import { buildIstioEgressObjects } from './istio-policy.js';

describe('buildIstioEgressObjects', () => {
  it('creates a Sidecar and a ServiceEntry per host', () => {
    const objs: any[] = buildIstioEgressObjects({
      name: 'job1', namespace: 'kubeclaw', jobLabel: 'job1',
      allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
    });
    const sidecar = objs.find((o) => o.kind === 'Sidecar');
    const se = objs.find((o) => o.kind === 'ServiceEntry');
    expect(sidecar.spec.workloadSelector.labels['kubeclaw/agent-job']).toBe('job1');
    expect(se.spec.hosts).toContain('api.search.brave.com');
  });

  it('creates only a Sidecar (in-namespace only) when egress is empty', () => {
    const objs: any[] = buildIstioEgressObjects({ name: 'j', namespace: 'kubeclaw', jobLabel: 'j', allowedEgress: [] });
    expect(objs.filter((o) => o.kind === 'ServiceEntry')).toHaveLength(0);
    expect(objs.find((o) => o.kind === 'Sidecar').spec.egress[0].hosts).toContain('./*');
  });
});
