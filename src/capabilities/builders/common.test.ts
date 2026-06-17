import { describe, it, expect } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { renderDeploymentAndService } from './common.js';
import type { CommonRenderArgs } from './common.js';

const base: CommonRenderArgs = {
  name: 'kubeclaw-cap-t',
  namespace: 'kubeclaw',
  component: 'capability-test',
  image: 'busybox:latest',
  port: 8080,
};

function deployment(yaml: string) {
  return parseAllDocuments(yaml)
    .map((d) => d.toJSON())
    .find((d) => d.kind === 'Deployment');
}
function container(yaml: string) {
  return deployment(yaml).spec.template.spec.containers[0];
}

function podSpec(yaml: string) {
  return deployment(yaml).spec.template.spec;
}

describe('renderDeploymentAndService probes', () => {
  it('defaults to an httpGet probe on /health (no probe, no healthPath)', () => {
    const c = container(renderDeploymentAndService(base));
    expect(c.readinessProbe.httpGet.path).toBe('/health');
    expect(c.readinessProbe.httpGet.port).toBe(8080);
    expect(c.readinessProbe.initialDelaySeconds).toBe(5);
    expect(c.livenessProbe.initialDelaySeconds).toBe(15);
    expect(c.startupProbe).toBeUndefined();
  });

  it('derives the httpGet path from healthPath when probe is absent', () => {
    const c = container(renderDeploymentAndService({ ...base, healthPath: '/healthz' }));
    expect(c.readinessProbe.httpGet.path).toBe('/healthz');
    expect(c.livenessProbe.httpGet.path).toBe('/healthz');
  });

  it('renders a tcpSocket probe when type is tcp', () => {
    const c = container(
      renderDeploymentAndService({ ...base, probe: { type: 'tcp', port: 5432 } }),
    );
    expect(c.readinessProbe.tcpSocket.port).toBe(5432);
    expect(c.livenessProbe.tcpSocket.port).toBe(5432);
    expect(c.readinessProbe.httpGet).toBeUndefined();
  });

  it('applies timing overrides to both readiness and liveness', () => {
    const c = container(
      renderDeploymentAndService({
        ...base,
        probe: { initialDelaySeconds: 7, periodSeconds: 20, failureThreshold: 4, timeoutSeconds: 3 },
      }),
    );
    expect(c.readinessProbe.initialDelaySeconds).toBe(7);
    expect(c.livenessProbe.initialDelaySeconds).toBe(7);
    expect(c.readinessProbe.failureThreshold).toBe(4);
    expect(c.livenessProbe.timeoutSeconds).toBe(3);
  });

  it('renders a startupProbe when startup is set', () => {
    const c = container(
      renderDeploymentAndService({
        ...base,
        probe: { startup: { failureThreshold: 60, periodSeconds: 5 } },
      }),
    );
    expect(c.startupProbe.failureThreshold).toBe(60);
    expect(c.startupProbe.periodSeconds).toBe(5);
    expect(c.startupProbe.httpGet.path).toBe('/health');
  });
});

describe('renderDeploymentAndService scheduling/security/gpu', () => {
  it('omits scheduling, fsGroup, and gpu by default', () => {
    const ps = podSpec(renderDeploymentAndService(base));
    expect(ps.nodeSelector).toBeUndefined();
    expect(ps.tolerations).toBeUndefined();
    expect(ps.runtimeClassName).toBeUndefined();
    expect(ps.securityContext).toBeUndefined();
    const c = ps.containers[0];
    expect(c.securityContext).toEqual({
      runAsUser: 1000,
      runAsGroup: 1000,
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
    });
    expect(c.resources.requests['nvidia.com/gpu']).toBeUndefined();
  });

  it('renders gpu into requests and limits', () => {
    const c = podSpec(renderDeploymentAndService({ ...base, resources: { gpu: 2 } })).containers[0];
    expect(c.resources.requests['nvidia.com/gpu']).toBe(2);
    expect(c.resources.limits['nvidia.com/gpu']).toBe(2);
  });

  it('renders nodeSelector, tolerations, and runtimeClassName', () => {
    const ps = podSpec(
      renderDeploymentAndService({
        ...base,
        scheduling: {
          nodeSelector: { 'nvidia.com/gpu.present': 'true' },
          tolerations: [{ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' }],
          runtimeClassName: 'nvidia',
        },
      }),
    );
    expect(ps.nodeSelector['nvidia.com/gpu.present']).toBe('true');
    expect(ps.tolerations[0]).toEqual({ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' });
    expect(ps.runtimeClassName).toBe('nvidia');
  });

  it('renders pod fsGroup and overrides container security context', () => {
    const ps = podSpec(
      renderDeploymentAndService({
        ...base,
        podSecurity: { fsGroup: 999, runAsUser: 999, runAsGroup: 999, runAsNonRoot: false },
      }),
    );
    expect(ps.securityContext.fsGroup).toBe(999);
    expect(ps.containers[0].securityContext).toEqual({
      runAsUser: 999,
      runAsGroup: 999,
      runAsNonRoot: false,
      allowPrivilegeEscalation: false,
    });
  });
});
