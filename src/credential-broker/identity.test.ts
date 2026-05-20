import { describe, it, expect, vi } from 'vitest';
import { IdentityVerifier } from './identity.js';
import { PodInformer, OWNER_GROUP_ANNOTATION } from './pod-informer.js';

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
      v.verify({
        xfcc: 'By=spiffe://x;Hash=abc;Subject="";URI=not-a-spiffe-uri',
      }),
    ).rejects.toThrow(/malformed SPIFFE URI/i);
  });

  it('prefers XFCC over bearer when both provided', async () => {
    const fakeReview = vi.fn();
    const v = new IdentityVerifier({
      createTokenReview: fakeReview,
      audience: 'kubeclaw-credential-broker',
      namespace: 'kubeclaw',
    });
    const id = await v.verify({
      xfcc: XFCC,
      authorization: 'Bearer some-token',
    });
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

// ── resolveOwnerGroup ─────────────────────────────────────────────────────────

describe('IdentityVerifier — resolveOwnerGroup', () => {
  it('sidecar: returns owner-group from pod by uid in TokenReview extras', async () => {
    const inf = new PodInformer();
    inf.upsert({
      uid: 'uid-1',
      name: 'pod-1',
      podIP: '10.0.0.1',
      terminating: false,
      annotations: { [OWNER_GROUP_ANNOTATION]: 'family' },
    });
    const v = new IdentityVerifier({
      createTokenReview: async () =>
        ({
          status: {
            authenticated: true,
            user: {
              username: 'system:serviceaccount:kubeclaw:kubeclaw-tool-job',
              extra: { 'authentication.kubernetes.io/pod-uid': ['uid-1'] },
            },
          },
        }) as any,
      audience: 'kubeclaw-credential-broker',
      namespace: 'kubeclaw',
      podInformer: inf,
    });
    const r = await v.resolveOwnerGroup({ authorization: 'Bearer xxx' });
    expect(r.identity).toBe('sa/kubeclaw-tool-job');
    expect(r.ownerGroup).toBe('family');
    expect(r.podUid).toBe('uid-1');
  });

  it('istio: returns owner-group via IP lookup', async () => {
    const inf = new PodInformer();
    inf.upsert({
      uid: 'uid-2',
      name: 'pod-2',
      podIP: '10.0.0.2',
      terminating: false,
      annotations: { [OWNER_GROUP_ANNOTATION]: 'work' },
    });
    const v = new IdentityVerifier({
      createTokenReview: async () => {
        throw new Error('not used');
      },
      audience: 'x',
      namespace: 'kubeclaw',
      podInformer: inf,
    });
    const r = await v.resolveOwnerGroup({
      xfcc: 'By=spiffe://x;URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-tool-job',
      sourceIP: '10.0.0.2',
    });
    expect(r.identity).toBe('sa/kubeclaw-tool-job');
    expect(r.ownerGroup).toBe('work');
    expect(r.podUid).toBe('uid-2');
  });

  it('returns null owner-group when pod has no annotation', async () => {
    const inf = new PodInformer();
    inf.upsert({
      uid: 'uid-3',
      name: 'pod-3',
      podIP: '10.0.0.3',
      terminating: false,
      annotations: {},
    });
    const v = new IdentityVerifier({
      createTokenReview: async () =>
        ({
          status: {
            authenticated: true,
            user: {
              username: 'system:serviceaccount:kubeclaw:kubeclaw-tool-job',
              extra: { 'authentication.kubernetes.io/pod-uid': ['uid-3'] },
            },
          },
        }) as any,
      audience: 'x',
      namespace: 'kubeclaw',
      podInformer: inf,
    });
    const r = await v.resolveOwnerGroup({ authorization: 'Bearer xxx' });
    expect(r.ownerGroup).toBeNull();
    expect(r.podUid).toBe('uid-3');
  });
});
