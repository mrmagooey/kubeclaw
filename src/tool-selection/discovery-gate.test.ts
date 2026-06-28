import { describe, it, expect } from 'vitest';
import { buildTsaSearchRegistry } from './discovery.js';

describe('discovery hard-gate', () => {
  const factoryDeps = {
    fetchJson: async () => ({}),
    chat: async () => '',
    probe: { runProbeToolJob: async () => ({ ok: true }) },
    catalogHostLookup: () => undefined,
  };

  it('returns a search function when cilium hard egress enforcement is present', () => {
    expect(
      typeof buildTsaSearchRegistry(
        { CILIUM_NETWORK_POLICY_ENABLED: 'true' },
        factoryDeps,
      ),
    ).toBe('function');
  });

  it('returns a search function when istio hard egress enforcement is present', () => {
    expect(
      typeof buildTsaSearchRegistry(
        { CREDENTIAL_INJECTION_MODE: 'istio' },
        factoryDeps,
      ),
    ).toBe('function');
  });

  it('returns undefined (tier-3 disabled) without hard enforcement', () => {
    expect(
      buildTsaSearchRegistry(
        { CREDENTIAL_INJECTION_MODE: 'sidecar' },
        factoryDeps,
      ),
    ).toBeUndefined();
  });

  it('returns undefined (tier-3 disabled) when enforcement is off', () => {
    expect(
      buildTsaSearchRegistry({ CREDENTIAL_INJECTION_MODE: 'off' }, factoryDeps),
    ).toBeUndefined();
  });

  it('returns undefined (tier-3 disabled) when no env vars set', () => {
    expect(buildTsaSearchRegistry({}, factoryDeps)).toBeUndefined();
  });
});
