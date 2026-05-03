import { describe, it, expect } from 'vitest';
import { sidecarContainerSpec, sidecarVolumes, sidecarVolumeMounts } from './sidecar-spec.js';

describe('sidecarContainerSpec', () => {
  it('mounts envoy config and broker token', () => {
    const c = sidecarContainerSpec({ image: 'envoyproxy/envoy:v1.31', port: 8443 });
    const names = (c.volumeMounts ?? []).map((m) => m.name);
    expect(names).toContain('envoy-config');
    expect(names).toContain('broker-token');
    expect(names).toContain('egress-ca');
  });

  it('runs envoy with the config path', () => {
    const c = sidecarContainerSpec({ image: 'envoyproxy/envoy:v1.31', port: 8443 });
    expect(c.args).toEqual(['-c', '/etc/envoy/envoy.yaml']);
  });
});

describe('sidecarVolumes', () => {
  it('projects a broker-audience SA token', () => {
    const vols = sidecarVolumes();
    const tok = vols.find((v) => v.name === 'broker-token');
    const sources = (tok as any).projected.sources;
    expect(sources[0].serviceAccountToken.audience).toBe('kubeclaw-credential-broker');
  });
});
