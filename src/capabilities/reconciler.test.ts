import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApplyYaml = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDeleteDeployment = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDeleteService = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
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

import { applySpec, deleteSpec } from './reconciler.js';
import type { CapabilitySpec } from './types.js';

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
