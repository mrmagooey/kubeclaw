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
