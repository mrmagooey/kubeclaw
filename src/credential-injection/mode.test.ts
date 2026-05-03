import { describe, it, expect, afterEach } from 'vitest';
import { getInjectionMode, type InjectionMode } from './mode.js';

describe('getInjectionMode', () => {
  const original = process.env.CREDENTIAL_INJECTION_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.CREDENTIAL_INJECTION_MODE;
    else process.env.CREDENTIAL_INJECTION_MODE = original;
  });

  it('defaults to "off" when env unset', () => {
    delete process.env.CREDENTIAL_INJECTION_MODE;
    expect(getInjectionMode()).toBe('off');
  });

  it('reads "sidecar" from env', () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'sidecar';
    expect(getInjectionMode()).toBe('sidecar');
  });

  it('reads "istio" from env', () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'istio';
    expect(getInjectionMode()).toBe('istio');
  });

  it('throws on unknown value', () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'banana';
    expect(() => getInjectionMode()).toThrow(/CREDENTIAL_INJECTION_MODE/);
  });
});
