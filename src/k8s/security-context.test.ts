import { describe, it, expect } from 'vitest';
import { hardenedPodSecurityContext, hardenedContainerSecurityContext } from './security-context';

describe('hardened securityContext', () => {
  it('pod context requires non-root and keeps fsGroup 2000', () => {
    const ctx: any = hardenedPodSecurityContext();
    expect(ctx.runAsNonRoot).toBe(true);
    expect(ctx.fsGroup).toBe(2000);
    expect(ctx.seccompProfile.type).toBe('RuntimeDefault');
  });
  it('container context drops all caps and is read-only root', () => {
    const ctx: any = hardenedContainerSecurityContext();
    expect(ctx.allowPrivilegeEscalation).toBe(false);
    expect(ctx.readOnlyRootFilesystem).toBe(true);
    expect(ctx.capabilities.drop).toEqual(['ALL']);
  });
});
