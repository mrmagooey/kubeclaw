import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApplyYaml = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDeleteDeployment = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockDeleteService = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockDeletePvc = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../k8s/job-runner.js', () => ({
  jobRunner: {
    applyYamlToK8s: mockApplyYaml,
    deleteDeployment: mockDeleteDeployment,
    deleteService: mockDeleteService,
    deletePersistentVolumeClaim: mockDeletePvc,
  },
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../config.js', () => ({
  KUBECLAW_NAMESPACE: 'kubeclaw',
}));

import { applySpec, deleteSpec, reconcileAllOnStartup } from './reconciler.js';
import { buildYaml } from './builders/index.js';
import type { CapabilitySpec } from './types.js';
import { parseAllDocuments } from 'yaml';

const mcpSpec: CapabilitySpec = {
  kind: 'mcp',
  name: 'weather',
  image: 'mcp/weather:1.0',
};

describe('reconciler', () => {
  beforeEach(() => {
    mockApplyYaml.mockClear();
    mockDeleteDeployment.mockClear();
    mockDeleteService.mockClear();
    mockDeletePvc.mockClear();
  });

  it('applySpec calls applyYamlToK8s with rendered MCP YAML', async () => {
    await applySpec(mcpSpec);
    expect(mockApplyYaml).toHaveBeenCalledOnce();
    const yaml = mockApplyYaml.mock.calls[0][0] as string;
    expect(yaml).toContain('kubeclaw-cap-weather');
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
  });

  it('deleteSpec deletes Deployment and Service', async () => {
    await deleteSpec(mcpSpec);
    expect(mockDeleteDeployment).toHaveBeenCalledWith(
      'kubeclaw-cap-weather',
      'kubeclaw',
    );
    expect(mockDeleteService).toHaveBeenCalledWith(
      'kubeclaw-cap-weather',
      'kubeclaw',
    );
    expect(mockDeletePvc).not.toHaveBeenCalled();
  });

  it('reconcileAllOnStartup applies each spec; one failure does not stop the loop', async () => {
    mockApplyYaml
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    await reconcileAllOnStartup([
      { kind: 'mcp', name: 'a', image: 'mcp/a:1' },
      { kind: 'mcp', name: 'b', image: 'mcp/b:1' },
    ]);

    expect(mockApplyYaml).toHaveBeenCalledTimes(2);
    const secondCallYaml = mockApplyYaml.mock.calls[1][0] as string;
    expect(secondCallYaml).toContain('kubeclaw-cap-b');
  });

  it('deleteSpec also removes PVC when storage was declared', async () => {
    await deleteSpec({
      kind: 'http',
      name: 'cache',
      image: 'cache:1.0',
      storage: { sizeGi: 5, mountPath: '/data' },
    });
    expect(mockDeletePvc).toHaveBeenCalledWith(
      'kubeclaw-cap-cache-data',
      'kubeclaw',
    );
  });
});

describe('base generalization renders valid K8s', () => {
  it('renders a TCP-probed, GPU, fsGroup, scheduled http capability', () => {
    const yaml = buildYaml({
      kind: 'http',
      name: 'maindb',
      image: 'postgres:16',
      port: 5432,
      endpointScheme: 'postgresql',
      probe: { type: 'tcp', port: 5432, startup: { failureThreshold: 60 } },
      scheduling: {
        nodeSelector: { 'gpu.present': 'true' },
        tolerations: [{ key: 'nvidia.com/gpu', operator: 'Exists' }],
        runtimeClassName: 'nvidia',
      },
      podSecurity: { fsGroup: 999, runAsNonRoot: false, runAsUser: 999 },
      resources: { gpu: 1 },
      storage: { sizeGi: 10, mountPath: '/var/lib/postgresql/data' },
    });

    const docs = parseAllDocuments(yaml).map((d) => d.toJSON());
    const dep = docs.find((d) => d.kind === 'Deployment');
    const podSpec = dep.spec.template.spec;
    const c = podSpec.containers[0];

    expect(docs.map((d) => d.kind).sort()).toEqual(
      ['Deployment', 'PersistentVolumeClaim', 'Service'].sort(),
    );
    expect(c.readinessProbe.tcpSocket.port).toBe(5432);
    expect(c.startupProbe.failureThreshold).toBe(60);
    expect(c.resources.limits['nvidia.com/gpu']).toBe(1);
    expect(podSpec.runtimeClassName).toBe('nvidia');
    expect(podSpec.securityContext.fsGroup).toBe(999);
    expect(c.securityContext.runAsNonRoot).toBe(false);
  });
});
