import { describe, it, expect } from 'vitest';
import { detectEgressSubstrate, hasHardEgressEnforcement } from './substrate';

describe('egress substrate detection', () => {
  it('prefers cilium when enabled', () => {
    expect(
      detectEgressSubstrate({
        CILIUM_NETWORK_POLICY_ENABLED: 'true',
        CREDENTIAL_INJECTION_MODE: 'sidecar',
      }),
    ).toBe('cilium');
  });
  it('falls back to istio when in istio mode without cilium', () => {
    expect(detectEgressSubstrate({ CREDENTIAL_INJECTION_MODE: 'istio' })).toBe(
      'istio',
    );
  });
  it('is none otherwise', () => {
    expect(
      detectEgressSubstrate({ CREDENTIAL_INJECTION_MODE: 'sidecar' }),
    ).toBe('none');
    expect(hasHardEgressEnforcement({ CREDENTIAL_INJECTION_MODE: 'off' })).toBe(
      false,
    );
  });
  it('reports hard enforcement for cilium and istio', () => {
    expect(
      hasHardEgressEnforcement({ CILIUM_NETWORK_POLICY_ENABLED: 'true' }),
    ).toBe(true);
    expect(
      hasHardEgressEnforcement({ CREDENTIAL_INJECTION_MODE: 'istio' }),
    ).toBe(true);
  });
});
