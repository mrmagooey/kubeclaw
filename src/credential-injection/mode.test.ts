import { describe, it, expect, afterEach } from 'vitest';
import { getInjectionMode, type InjectionMode } from './mode.js';
import { getAuditOnly } from './mode.js';

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

describe('getAuditOnly', () => {
  const originalEnv = process.env.CREDENTIAL_INJECTION_AUDIT_ONLY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CREDENTIAL_INJECTION_AUDIT_ONLY;
    } else {
      process.env.CREDENTIAL_INJECTION_AUDIT_ONLY = originalEnv;
    }
  });

  it('returns false when env var is unset', () => {
    delete process.env.CREDENTIAL_INJECTION_AUDIT_ONLY;
    expect(getAuditOnly()).toBe(false);
  });

  it('returns true when env var is "true"', () => {
    process.env.CREDENTIAL_INJECTION_AUDIT_ONLY = 'true';
    expect(getAuditOnly()).toBe(true);
  });

  it('returns false when env var is "false"', () => {
    process.env.CREDENTIAL_INJECTION_AUDIT_ONLY = 'false';
    expect(getAuditOnly()).toBe(false);
  });

  it('returns false for any other string (not truthy-string)', () => {
    process.env.CREDENTIAL_INJECTION_AUDIT_ONLY = '1';
    expect(getAuditOnly()).toBe(false);
  });
});
