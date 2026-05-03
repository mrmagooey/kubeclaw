import { describe, it, expect, vi } from 'vitest';
import { IdentityVerifier } from './identity.js';

describe('IdentityVerifier.verify', () => {
  it('returns sa/<name> when TokenReview authenticates', async () => {
    const fakeReview = vi.fn().mockResolvedValue({
      status: {
        authenticated: true,
        user: { username: 'system:serviceaccount:kubeclaw:kubeclaw-tool-job' },
      },
    });
    const v = new IdentityVerifier({ createTokenReview: fakeReview, audience: 'kubeclaw-credential-broker' });
    const id = await v.verify('Bearer eyJ...');
    expect(id).toBe('sa/kubeclaw-tool-job');
  });

  it('throws when authenticated=false', async () => {
    const fakeReview = vi.fn().mockResolvedValue({
      status: { authenticated: false, error: 'expired' },
    });
    const v = new IdentityVerifier({ createTokenReview: fakeReview, audience: 'kubeclaw-credential-broker' });
    await expect(v.verify('Bearer expired-token')).rejects.toThrow(/not authenticated/);
  });

  it('throws on missing/malformed header', async () => {
    const v = new IdentityVerifier({ createTokenReview: vi.fn(), audience: 'kubeclaw-credential-broker' });
    await expect(v.verify(undefined)).rejects.toThrow(/Authorization header/);
    await expect(v.verify('Basic foo')).rejects.toThrow(/Bearer/);
  });

  it('rejects user from non-kubeclaw namespace', async () => {
    const fakeReview = vi.fn().mockResolvedValue({
      status: { authenticated: true, user: { username: 'system:serviceaccount:other-ns:foo' } },
    });
    const v = new IdentityVerifier({ createTokenReview: fakeReview, audience: 'kubeclaw-credential-broker', namespace: 'kubeclaw' });
    await expect(v.verify('Bearer t')).rejects.toThrow(/namespace/);
  });
});
