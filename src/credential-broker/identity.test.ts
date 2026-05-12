import { describe, it, expect, vi } from 'vitest';
import { IdentityVerifier } from './identity.js';

// ── Bearer / TokenReview path ─────────────────────────────────────────────────

describe('IdentityVerifier.verify — bearer path', () => {
  it('returns sa/<name> when TokenReview authenticates', async () => {
    const fakeReview = vi.fn().mockResolvedValue({
      status: {
        authenticated: true,
        user: { username: 'system:serviceaccount:kubeclaw:kubeclaw-tool-job' },
      },
    });
    const v = new IdentityVerifier({
      createTokenReview: fakeReview,
      audience: 'kubeclaw-credential-broker',
    });
    const id = await v.verify({ authorization: 'Bearer eyJ...' });
    expect(id).toBe('sa/kubeclaw-tool-job');
  });

  it('throws when authenticated=false', async () => {
    const fakeReview = vi.fn().mockResolvedValue({
      status: { authenticated: false, error: 'expired' },
    });
    const v = new IdentityVerifier({
      createTokenReview: fakeReview,
      audience: 'kubeclaw-credential-broker',
    });
    await expect(
      v.verify({ authorization: 'Bearer expired-token' }),
    ).rejects.toThrow(/not authenticated/);
  });

  it('throws on non-Bearer scheme', async () => {
    const v = new IdentityVerifier({
      createTokenReview: vi.fn(),
      audience: 'kubeclaw-credential-broker',
    });
    await expect(v.verify({ authorization: 'Basic foo' })).rejects.toThrow(
      /Bearer/,
    );
  });

  it('rejects token from non-kubeclaw namespace', async () => {
    const fakeReview = vi.fn().mockResolvedValue({
      status: {
        authenticated: true,
        user: { username: 'system:serviceaccount:other-ns:foo' },
      },
    });
    const v = new IdentityVerifier({
      createTokenReview: fakeReview,
      audience: 'kubeclaw-credential-broker',
      namespace: 'kubeclaw',
    });
    await expect(v.verify({ authorization: 'Bearer t' })).rejects.toThrow(
      /namespace/,
    );
  });
});

// ── SPIFFE / XFCC path ────────────────────────────────────────────────────────

describe('IdentityVerifier.verify — XFCC/SPIFFE path', () => {
  const makeVerifier = () =>
    new IdentityVerifier({
      createTokenReview: vi.fn(),
      audience: 'kubeclaw-credential-broker',
      namespace: 'kubeclaw',
    });

  const XFCC =
    'By=spiffe://cluster.local/ns/istio-system/sa/kubeclaw-istio-egressgateway;' +
    'Hash=abc123;Subject="";' +
    'URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-tool-job';

  it('returns sa/<name> when valid XFCC present', async () => {
    const v = makeVerifier();
    const id = await v.verify({ xfcc: XFCC });
    expect(id).toBe('sa/kubeclaw-tool-job');
  });

  it('throws when XFCC has no URI= clause', async () => {
    const v = makeVerifier();
    await expect(
      v.verify({
        xfcc: 'By=spiffe://cluster.local/ns/kubeclaw/sa/something;Hash=abc',
      }),
    ).rejects.toThrow(/no SPIFFE URI/i);
  });

  it('throws when XFCC has malformed SPIFFE URI', async () => {
    const v = makeVerifier();
    await expect(
      v.verify({ xfcc: 'By=spiffe://x;Hash=abc;Subject="";URI=not-a-spiffe-uri' }),
    ).rejects.toThrow(/malformed SPIFFE URI/i);
  });

  it('prefers XFCC over bearer when both provided', async () => {
    const fakeReview = vi.fn();
    const v = new IdentityVerifier({
      createTokenReview: fakeReview,
      audience: 'kubeclaw-credential-broker',
      namespace: 'kubeclaw',
    });
    const id = await v.verify({ xfcc: XFCC, authorization: 'Bearer some-token' });
    expect(id).toBe('sa/kubeclaw-tool-job');
    expect(fakeReview).not.toHaveBeenCalled();
  });
});

// ── Both absent ───────────────────────────────────────────────────────────────

describe('IdentityVerifier.verify — no credentials', () => {
  it('throws when both authorization and xfcc are absent', async () => {
    const v = new IdentityVerifier({
      createTokenReview: vi.fn(),
      audience: 'kubeclaw-credential-broker',
    });
    await expect(v.verify({})).rejects.toThrow(/no credentials/i);
  });
});
