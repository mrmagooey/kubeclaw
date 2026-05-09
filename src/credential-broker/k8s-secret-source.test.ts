import { describe, it, expect, vi } from 'vitest';
import { K8sSecretSource } from './k8s-secret-source.js';

describe('K8sSecretSource', () => {
  it('returns decoded secret value', async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        'anthropic-api-key': Buffer.from('sk-ant-xxx').toString('base64'),
      },
    });
    const src = new K8sSecretSource({ readSecret: get, cacheTtlMs: 0 });
    const v = await src.read({
      kind: 'Secret',
      name: 'kubeclaw-secrets',
      key: 'anthropic-api-key',
    });
    expect(v).toBe('sk-ant-xxx');
  });

  it('caches reads within TTL', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { k: Buffer.from('v').toString('base64') },
    });
    const src = new K8sSecretSource({ readSecret: get, cacheTtlMs: 60_000 });
    await src.read({ kind: 'Secret', name: 's', key: 'k' });
    await src.read({ kind: 'Secret', name: 's', key: 'k' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('throws if key missing from secret', async () => {
    const get = vi.fn().mockResolvedValue({ data: {} });
    const src = new K8sSecretSource({ readSecret: get, cacheTtlMs: 0 });
    await expect(
      src.read({ kind: 'Secret', name: 's', key: 'absent' }),
    ).rejects.toThrow(/absent/);
  });
});
