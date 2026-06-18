import { describe, it, expect, vi } from 'vitest';
import { parseAllDocuments } from 'yaml';

vi.mock('../../config.js', () => ({ KUBECLAW_NAMESPACE: 'kubeclaw' }));

import { buildYaml } from './index.js';
import type { RagCapabilitySpec } from '../types.js';

const base: RagCapabilitySpec = {
  kind: 'rag',
  backend: 'qdrant',
  name: 'main-rag',
  image: 'qdrant/qdrant:latest',
};

describe('generic rag builder', () => {
  it('renders Deployment, Service, and PVC with the RAG storage default', () => {
    const yaml = buildYaml(base);
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: PersistentVolumeClaim');
    expect(yaml).toContain('storage: 20Gi');
    expect(yaml).toContain('mountPath: /qdrant/storage');
    expect(yaml).toContain('containerPort: 6333');
  });

  it('parses to exactly Deployment + Service + PVC', () => {
    const docs = parseAllDocuments(buildYaml(base)).map((d) => d.toJSON());
    expect(docs.map((d) => d.kind).sort()).toEqual(
      ['Deployment', 'PersistentVolumeClaim', 'Service'].sort(),
    );
  });

  it('honours an explicit port and storage', () => {
    const yaml = buildYaml({
      ...base,
      backend: 'weaviate',
      port: 8080,
      storage: { sizeGi: 5, mountPath: '/data' },
    });
    expect(yaml).toContain('containerPort: 8080');
    expect(yaml).toContain('storage: 5Gi');
    expect(yaml).toContain('mountPath: /data');
  });

  it('applies SP1 probe + podSecurity fields', () => {
    const yaml = buildYaml({
      ...base,
      probe: { type: 'tcp', port: 6333 },
      podSecurity: { fsGroup: 1000 },
    });
    expect(yaml).toContain('tcpSocket:');
    expect(yaml).toContain('fsGroup: 1000');
  });
});
