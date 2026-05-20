import { describe, it, expect, vi } from 'vitest';
import { K8sSecretSource, GROUP_SECRETS_LABEL } from './k8s-secret-source.js';

describe('K8sSecretSource — group secrets', () => {
  it('parses JSON-blob group secret', async () => {
    const src = new K8sSecretSource({
      readSecret: vi.fn(),
      cacheTtlMs: 0,
    });
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: {
          name: 'kubeclaw-group-secrets-family',
          labels: { [GROUP_SECRETS_LABEL]: 'true' },
        },
        data: {
          replicate: Buffer.from(
            JSON.stringify({
              fields: {
                token: { value: 'r8_real', placeholder: 'KC_PH_token_xxx' },
              },
              registeredAt: '2026-05-16T10:00:00Z',
            }),
          ).toString('base64'),
        },
      },
    });
    expect(src.getGroupCredential('family', 'replicate')).toEqual({
      fields: { token: { value: 'r8_real', placeholder: 'KC_PH_token_xxx' } },
      registeredAt: '2026-05-16T10:00:00Z',
    });
  });

  it('returns null for unknown group or catalog', () => {
    const src = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
    expect(src.getGroupCredential('nobody', 'x')).toBeNull();
  });

  it('evicts on DELETED event', () => {
    const src = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: {
          name: 'kubeclaw-group-secrets-family',
          labels: { [GROUP_SECRETS_LABEL]: 'true' },
        },
        data: {
          replicate: Buffer.from('{"fields":{},"registeredAt":""}').toString(
            'base64',
          ),
        },
      },
    });
    expect(src.getGroupCredential('family', 'replicate')).not.toBeNull();
    src.applyGroupSecretEvent({
      type: 'DELETED',
      secret: { metadata: { name: 'kubeclaw-group-secrets-family' } },
    });
    expect(src.getGroupCredential('family', 'replicate')).toBeNull();
  });

  it('ignores Secrets without the label', () => {
    const src = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: { name: 'unrelated', labels: {} },
        data: {
          something: Buffer.from('{"fields":{},"registeredAt":""}').toString(
            'base64',
          ),
        },
      },
    });
    expect(src.listGroups()).toEqual([]);
  });

  it('rejects malformed JSON-blob', () => {
    const src = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: {
          name: 'kubeclaw-group-secrets-family',
          labels: { [GROUP_SECRETS_LABEL]: 'true' },
        },
        data: { bad: Buffer.from('not-json').toString('base64') },
      },
    });
    // Bad entry skipped, no throw
    expect(src.getGroupCredential('family', 'bad')).toBeNull();
  });

  it('legacy read(ref) path still works for kubeclaw-secrets', async () => {
    const readSecret = vi.fn().mockResolvedValue({
      data: { 'anthropic-api-key': Buffer.from('sk-real').toString('base64') },
    });
    const src = new K8sSecretSource({ readSecret, cacheTtlMs: 0 });
    const v = await src.read({
      kind: 'Secret',
      name: 'kubeclaw-secrets',
      key: 'anthropic-api-key',
    });
    expect(v).toBe('sk-real');
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

  it('MODIFIED event updates existing group cache', () => {
    const src = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: {
          name: 'kubeclaw-group-secrets-family',
          labels: { [GROUP_SECRETS_LABEL]: 'true' },
        },
        data: {
          replicate: Buffer.from(
            JSON.stringify({
              fields: {
                token: { value: 'r8_old', placeholder: 'KC_PH_token_aaa' },
              },
              registeredAt: '2026-05-16T09:00:00Z',
            }),
          ).toString('base64'),
        },
      },
    });
    src.applyGroupSecretEvent({
      type: 'MODIFIED',
      secret: {
        metadata: {
          name: 'kubeclaw-group-secrets-family',
          labels: { [GROUP_SECRETS_LABEL]: 'true' },
        },
        data: {
          replicate: Buffer.from(
            JSON.stringify({
              fields: {
                token: { value: 'r8_new', placeholder: 'KC_PH_token_bbb' },
              },
              registeredAt: '2026-05-16T10:00:00Z',
            }),
          ).toString('base64'),
        },
      },
    });
    expect(
      src.getGroupCredential('family', 'replicate')?.fields.token.value,
    ).toBe('r8_new');
  });

  it('listGroups reflects currently cached groups', () => {
    const src = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: {
          name: 'kubeclaw-group-secrets-alpha',
          labels: { [GROUP_SECRETS_LABEL]: 'true' },
        },
        data: {
          replicate: Buffer.from('{"fields":{},"registeredAt":""}').toString(
            'base64',
          ),
        },
      },
    });
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: {
          name: 'kubeclaw-group-secrets-beta',
          labels: { [GROUP_SECRETS_LABEL]: 'true' },
        },
        data: {
          jenkins: Buffer.from('{"fields":{},"registeredAt":""}').toString(
            'base64',
          ),
        },
      },
    });
    expect(src.listGroups().sort()).toEqual(['alpha', 'beta']);
  });
});
