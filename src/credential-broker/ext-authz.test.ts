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
  auditOnly: false,
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
    (d.secretSource.read as any) = vi
      .fn()
      .mockRejectedValue(new Error('secret deleted'));
    const res = await handleExtAuthz(
      {
        authorization: 'Bearer t',
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(res.status).toBe(503);
    expect(d.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503, mappingId: 'anthropic' }),
    );
  });
});

describe('audit-only mode', () => {
  const auditDeps = (): Deps => ({
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
    auditOnly: true,
  });

  it('case A: mapping found → 200 with NO authorization header, secretReadSkipped logged', async () => {
    const d = auditDeps();
    const res = await handleExtAuthz(
      {
        authorization: 'Bearer fake-sa-token',
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(res.status).toBe(200);
    expect(res.headers['authorization']).toBeUndefined();
    expect(d.secretSource.read).not.toHaveBeenCalled();
    expect(d.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 200,
        auditOnly: true,
        wouldStamp: true,
        secretReadSkipped: true,
      }),
    );
  });

  it('case B: mapping not found → 403, wouldStamp: false', async () => {
    const d = auditDeps();
    const res = await handleExtAuthz(
      {
        authorization: 'Bearer fake-sa-token',
        'x-forwarded-authority': 'evil.example.com',
      },
      d,
    );
    expect(res.status).toBe(403);
    expect(d.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 403,
        auditOnly: true,
        wouldStamp: false,
      }),
    );
  });

  it('case C: identity verification fails → 401 even in audit-only', async () => {
    const d = auditDeps();
    (d.identityVerifier.verify as any) = vi
      .fn()
      .mockRejectedValue(new Error('bad token'));
    const res = await handleExtAuthz(
      {
        authorization: 'Bearer bad-token',
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(res.status).toBe(401);
    expect(d.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, auditOnly: true }),
    );
  });

  it('case D: auditOnly=false still stamps the Authorization header normally', async () => {
    const d = auditDeps();
    d.auditOnly = false;
    const res = await handleExtAuthz(
      {
        authorization: 'Bearer fake-sa-token',
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(res.status).toBe(200);
    expect(res.headers['authorization']).toBe('Bearer sk-ant-xxx');
    expect(d.secretSource.read).toHaveBeenCalled();
  });
});

describe('handleExtAuthz — XFCC/SPIFFE path', () => {
  const XFCC =
    'By=spiffe://cluster.local/ns/istio-system/sa/kubeclaw-istio-egressgateway;' +
    'Hash=abc123;Subject="";' +
    'URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-tool-job';

  it('200 when valid XFCC supplied instead of bearer', async () => {
    const d = deps();
    const res = await handleExtAuthz(
      {
        'x-forwarded-client-cert': XFCC,
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(res.status).toBe(200);
    expect(d.identityVerifier.verify).toHaveBeenCalledWith({
      authorization: undefined,
      xfcc: XFCC,
    });
  });

  it('401 when XFCC is malformed (verifier rejects)', async () => {
    const d = deps();
    (d.identityVerifier.verify as any) = vi
      .fn()
      .mockRejectedValue(new Error('malformed SPIFFE URI'));
    const res = await handleExtAuthz(
      {
        'x-forwarded-client-cert': 'bad-xfcc-value',
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(res.status).toBe(401);
  });

  it('passes both XFCC and authorization to verifier when both present', async () => {
    const d = deps();
    await handleExtAuthz(
      {
        authorization: 'Bearer some-token',
        'x-forwarded-client-cert': XFCC,
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(d.identityVerifier.verify).toHaveBeenCalledWith({
      authorization: 'Bearer some-token',
      xfcc: XFCC,
    });
  });
});
