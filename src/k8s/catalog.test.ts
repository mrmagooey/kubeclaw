import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CatalogInformer } from './catalog.js';
import { logger } from '../logger.js';

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

  describe('404 / NotFound tolerance', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    });

    afterEach(() => {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('does not log warn/error when ConfigMap is missing (statusCode 404)', async () => {
      mockReadCM.mockRejectedValueOnce({ statusCode: 404 });
      await informer.sync(); // must not throw
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(informer.getCatalog()).toEqual([]); // serves empty catalog
    });

    it('does not log warn/error when ConfigMap is missing (response.statusCode 404)', async () => {
      mockReadCM.mockRejectedValueOnce({ response: { statusCode: 404 } });
      await informer.sync();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(informer.getCatalog()).toEqual([]);
    });

    it('does not log warn/error when ConfigMap is missing (code 404)', async () => {
      mockReadCM.mockRejectedValueOnce({ code: 404 });
      await informer.sync();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(informer.getCatalog()).toEqual([]);
    });

    it('preserves previous catalog silently on 404', async () => {
      mockReadCM.mockResolvedValueOnce({
        data: {
          'config.yaml': `
catalog:
  - id: b
    host: b.example
    credentialFields: [{ name: t, envVar: T }]
`,
        },
      });
      await informer.sync();
      expect(informer.getCatalog()).toHaveLength(1);

      mockReadCM.mockRejectedValueOnce({ statusCode: 404 });
      await informer.sync(); // silent
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(informer.getCatalog()).toHaveLength(1); // still serves old
    });

    it('still logs warn for genuine non-404 errors', async () => {
      mockReadCM.mockRejectedValueOnce(new Error('k8s api unavailable'));
      await informer.sync();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('still logs warn for 500 errors', async () => {
      mockReadCM.mockRejectedValueOnce({ statusCode: 500, message: 'Internal Server Error' });
      await informer.sync();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
