import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CatalogInformer } from './catalog.js';

describe('CatalogInformer', () => {
  let mockReadCM: ReturnType<typeof vi.fn>;
  let informer: CatalogInformer;

  beforeEach(() => {
    mockReadCM = vi.fn();
    informer = new CatalogInformer({
      namespace: 'kubeclaw',
      configMapName: 'kubeclaw-credential-broker-config',
      readConfigMap: mockReadCM,
    });
  });

  it('returns empty catalog before first sync', () => {
    expect(informer.getCatalog()).toEqual([]);
  });

  it('parses catalog from ConfigMap data', async () => {
    mockReadCM.mockResolvedValue({
      data: {
        'config.yaml': `
catalog:
  - id: replicate
    host: api.replicate.com
    credentialFields: [{ name: token, envVar: REPLICATE_API_TOKEN }]
`,
      },
    });
    await informer.sync();
    expect(informer.getCatalog()).toHaveLength(1);
    expect(informer.getEntry('replicate')?.host).toBe('api.replicate.com');
  });

  it('returns null for unknown catalog id', async () => {
    mockReadCM.mockResolvedValue({ data: { 'config.yaml': 'catalog: []' } });
    await informer.sync();
    expect(informer.getEntry('nonexistent')).toBeNull();
  });

  it('updates catalog on resync', async () => {
    mockReadCM.mockResolvedValueOnce({
      data: { 'config.yaml': 'catalog: []' },
    });
    await informer.sync();
    expect(informer.getCatalog()).toHaveLength(0);

    mockReadCM.mockResolvedValueOnce({
      data: {
        'config.yaml': `
catalog:
  - id: x
    host: x.example
    credentialFields: [{ name: t, envVar: T }]
`,
      },
    });
    await informer.sync();
    expect(informer.getCatalog()).toHaveLength(1);
  });

  it('preserves previous catalog if sync fails', async () => {
    mockReadCM.mockResolvedValueOnce({
      data: {
        'config.yaml': `
catalog:
  - id: a
    host: a.example
    credentialFields: [{ name: t, envVar: T }]
`,
      },
    });
    await informer.sync();
    expect(informer.getCatalog()).toHaveLength(1);

    mockReadCM.mockRejectedValueOnce(new Error('k8s api down'));
    await informer.sync(); // does not throw
    expect(informer.getCatalog()).toHaveLength(1); // still serves old
  });
});
