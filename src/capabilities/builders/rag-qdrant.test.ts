import { describe, it, expect, vi } from 'vitest';
import { parseAllDocuments } from 'yaml';

vi.mock('../../config.js', () => ({
  KUBECLAW_NAMESPACE: 'kubeclaw',
}));

import { buildRagQdrantYaml } from './rag-qdrant.js';
import type { RagCapabilitySpec } from '../types.js';

const spec: RagCapabilitySpec = {
  kind: 'rag',
  backend: 'qdrant',
  name: 'main-rag',
  image: 'qdrant/qdrant:latest',
  storage: { sizeGi: 20, mountPath: '/qdrant/storage' },
};

describe('buildRagQdrantYaml', () => {
  it('renders Deployment, Service, and PVC', () => {
    const yaml = buildRagQdrantYaml(spec);
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: PersistentVolumeClaim');
    expect(yaml).toContain('storage: 20Gi');
    expect(yaml).toContain('containerPort: 6333');
    expect(yaml).toContain('mountPath: /qdrant/storage');
  });

  it('uses /healthz as the default health path (Qdrant convention)', () => {
    const yaml = buildRagQdrantYaml(spec);
    expect(yaml).toMatch(/path: \/healthz/);
  });

  it('parses cleanly to a Deployment + Service + PVC structure', () => {
    const yaml = buildRagQdrantYaml(spec);
    const docs = parseAllDocuments(yaml).map((d) => d.toJSON());
    expect(docs.map((d) => d.kind).sort()).toEqual(
      ['Deployment', 'PersistentVolumeClaim', 'Service'].sort(),
    );
  });

  it('throws when backend is not qdrant', () => {
    expect(() =>
      buildRagQdrantYaml({ ...spec, backend: 'lightrag' as 'qdrant' }),
    ).toThrow();
  });

  it('uses default storage when none provided', () => {
    const yaml = buildRagQdrantYaml({
      kind: 'rag',
      backend: 'qdrant',
      name: 'no-storage',
      image: 'qdrant/qdrant:latest',
    });
    expect(yaml).toContain('storage: 20Gi');
    expect(yaml).toContain('mountPath: /qdrant/storage');
  });
});
