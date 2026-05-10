import { describe, it, expect, vi } from 'vitest';
import { parseAllDocuments } from 'yaml';

vi.mock('../../config.js', () => ({
  KUBECLAW_NAMESPACE: 'kubeclaw',
}));

import { buildHttpYaml } from './http.js';

describe('buildHttpYaml', () => {
  it('renders a basic http capability', () => {
    const yaml = buildHttpYaml({
      kind: 'http',
      name: 'shortener',
      image: 'shortener:1.0',
      port: 8080,
    });
    expect(yaml).toContain('name: kubeclaw-cap-shortener');
    expect(yaml).toContain('containerPort: 8080');
    expect(yaml).toContain('kubeclaw-component: capability-http');
  });

  it('mounts a PVC when storage is requested', () => {
    const yaml = buildHttpYaml({
      kind: 'http',
      name: 'cache',
      image: 'cache:1.0',
      storage: { sizeGi: 5, mountPath: '/data' },
    });
    expect(yaml).toContain('kind: PersistentVolumeClaim');
    expect(yaml).toContain('storage: 5Gi');
    expect(yaml).toContain('mountPath: /data');
  });

  it('parses to a valid Deployment + Service + PVC structure with storage', () => {
    const yaml = buildHttpYaml({
      kind: 'http',
      name: 'cache',
      image: 'cache:1.0',
      storage: { sizeGi: 5, mountPath: '/data' },
    });
    const docs = parseAllDocuments(yaml).map((d) => d.toJSON());
    const kinds = docs.map((d) => d.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'Deployment',
        'Service',
        'PersistentVolumeClaim',
      ]),
    );
    const dep = docs.find((d) => d.kind === 'Deployment');
    expect(dep.spec.template.spec.containers[0].volumeMounts).toEqual([
      { name: 'data', mountPath: '/data' },
    ]);
    expect(dep.spec.template.spec.volumes).toEqual([
      {
        name: 'data',
        persistentVolumeClaim: { claimName: 'kubeclaw-cap-cache-data' },
      },
    ]);
    const pvc = docs.find((d) => d.kind === 'PersistentVolumeClaim');
    expect(pvc.metadata.name).toBe('kubeclaw-cap-cache-data');
    expect(pvc.spec.resources.requests.storage).toBe('5Gi');
  });
});
