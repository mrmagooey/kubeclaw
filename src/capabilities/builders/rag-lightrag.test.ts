import { describe, it, expect, vi } from 'vitest';
import { parseAllDocuments } from 'yaml';

vi.mock('../../config.js', () => ({ KUBECLAW_NAMESPACE: 'kubeclaw' }));

import { buildRagLightRagYaml } from './rag-lightrag.js';
import type { RagCapabilitySpec } from '../types.js';

const spec: RagCapabilitySpec = {
  kind: 'rag',
  backend: 'lightrag',
  name: 'graph-rag',
  image: 'ghcr.io/hkuds/lightrag:latest',
  envFromSecrets: ['kubeclaw-lightrag-config'],
  storage: { sizeGi: 20, mountPath: '/app/data' },
};

describe('buildRagLightRagYaml', () => {
  it('renders Deployment, Service, PVC', () => {
    const yaml = buildRagLightRagYaml(spec);
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: PersistentVolumeClaim');
  });

  it('uses port 9621 by default', () => {
    expect(buildRagLightRagYaml(spec)).toContain('containerPort: 9621');
  });

  it('mounts /app/data PVC', () => {
    expect(buildRagLightRagYaml(spec)).toContain('mountPath: /app/data');
  });

  it('envFroms the config secret', () => {
    expect(buildRagLightRagYaml(spec)).toContain(
      'name: kubeclaw-lightrag-config',
    );
  });

  it('throws when backend is not lightrag', () => {
    expect(() =>
      buildRagLightRagYaml({ ...spec, backend: 'qdrant' as 'lightrag' }),
    ).toThrow();
  });

  it('parses cleanly to a 3-doc structure', () => {
    const yaml = buildRagLightRagYaml(spec);
    const docs = parseAllDocuments(yaml).map((d) => d.toJSON());
    expect(docs.map((d) => d.kind).sort()).toEqual(
      ['Deployment', 'PersistentVolumeClaim', 'Service'].sort(),
    );
    const dep = docs.find((d) => d.kind === 'Deployment');
    expect(dep.spec.template.spec.containers[0].envFrom).toEqual([
      { secretRef: { name: 'kubeclaw-lightrag-config' } },
    ]);
  });
});
