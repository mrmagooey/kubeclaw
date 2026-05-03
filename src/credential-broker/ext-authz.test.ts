import { describe, it, expect, vi } from 'vitest';
import { handleExtAuthz, type Deps } from './ext-authz.js';
import { Resolver } from './resolver.js';

const deps = (): Deps => ({
  resolver: new Resolver([
    {
      id: 'anthropic',
      destinations: ['api.anthropic.com'],
      identities: ['*'],
      credentialRef: {
        kind: 'Secret',
        name: 'kubeclaw-secrets',
        key: 'anthropic-api-key',
      },
      headerScheme: 'bearer',
    },
  ]),
  identityVerifier: {
    verify: vi.fn().mockResolvedValue('sa/kubeclaw-tool-job'),
  } as any,
  secretSource: { read: vi.fn().mockResolvedValue('sk-ant-xxx') } as any,
  audit: { record: vi.fn() } as any,
});

describe('handleExtAuthz', () => {
  it('200 + Authorization header on match', async () => {
    const res = await handleExtAuthz(
      {
        authorization: 'Bearer fake-sa-token',
        'x-forwarded-authority': 'api.anthropic.com',
      },
      deps(),
    );
    expect(res.status).toBe(200);
    expect(res.headers['authorization']).toBe('Bearer sk-ant-xxx');
  });

  it('403 on no mapping', async () => {
    const res = await handleExtAuthz(
      { authorization: 'Bearer t', 'x-forwarded-authority': 'evil.example' },
      deps(),
    );
    expect(res.status).toBe(403);
  });

  it('401 on bad identity', async () => {
    const d = deps();
    (d.identityVerifier.verify as any) = vi
      .fn()
      .mockRejectedValue(new Error('bad'));
    const res = await handleExtAuthz(
      {
        authorization: 'Bearer t',
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(res.status).toBe(401);
  });

  it('400 on missing destination header', async () => {
    const res = await handleExtAuthz(
      { authorization: 'Bearer t' /* no x-forwarded-authority */ },
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it('503 when secret read fails', async () => {
    const d = deps();
    (d.secretSource.read as any) = vi.fn().mockRejectedValue(new Error('secret deleted'));
    const res = await handleExtAuthz(
      { authorization: 'Bearer t', 'x-forwarded-authority': 'api.anthropic.com' },
      d,
    );
    expect(res.status).toBe(503);
    expect(d.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503, mappingId: 'anthropic' }),
    );
  });
});
