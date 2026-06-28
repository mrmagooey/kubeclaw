import { describe, it, expect } from 'vitest';
import {
  validateScopeFields,
  getScope,
  resolveGroupCapability,
  PerGroupCapabilityError,
} from './types.js';
import type { CapabilitySpec } from '../capabilities/types.js';

describe('validateScopeFields', () => {
  it('accepts cluster-scoped spec with no group-only fields', () => {
    const spec: CapabilitySpec = {
      name: 'x',
      kind: 'mcp',
      image: 'i:1',
      scope: 'cluster',
    };
    expect(() => validateScopeFields(spec)).not.toThrow();
  });

  it('rejects cluster-scoped spec carrying scaleDownAfterIdleSeconds', () => {
    const spec: CapabilitySpec = {
      name: 'x',
      kind: 'mcp',
      image: 'i:1',
      scope: 'cluster',
      scaleDownAfterIdleSeconds: 300,
    };
    expect(() => validateScopeFields(spec)).toThrow(PerGroupCapabilityError);
  });

  it('rejects cluster-scoped spec carrying volumeFromGroupPvc', () => {
    const spec: CapabilitySpec = {
      name: 'x',
      kind: 'mcp',
      image: 'i:1',
      scope: 'cluster',
      volumeFromGroupPvc: true,
    };
    expect(() => validateScopeFields(spec)).toThrow(PerGroupCapabilityError);
  });

  it('rejects cluster-scoped spec carrying credentialsFrom', () => {
    const spec: CapabilitySpec = {
      name: 'x',
      kind: 'mcp',
      image: 'i:1',
      scope: 'cluster',
      credentialsFrom: 'secret',
    };
    expect(() => validateScopeFields(spec)).toThrow(PerGroupCapabilityError);
  });

  it('accepts group-scoped spec with defaults', () => {
    const spec: CapabilitySpec = {
      name: 'x',
      kind: 'mcp',
      image: 'i:1',
      scope: 'group',
    };
    expect(() => validateScopeFields(spec)).not.toThrow();
  });

  it('rejects group-scoped spec with scaleDownAfterIdleSeconds < 60', () => {
    const spec: CapabilitySpec = {
      name: 'x',
      kind: 'mcp',
      image: 'i:1',
      scope: 'group',
      scaleDownAfterIdleSeconds: 30,
    };
    expect(() => validateScopeFields(spec)).toThrow(/at least 60/);
  });

  it('defaults scope to cluster when omitted', () => {
    const spec: CapabilitySpec = { name: 'x', kind: 'mcp', image: 'i:1' };
    expect(() => validateScopeFields(spec)).not.toThrow();
  });
});

describe('getScope', () => {
  it('returns cluster when scope is unset', () => {
    const spec: CapabilitySpec = { name: 'x', kind: 'mcp', image: 'i:1' };
    expect(getScope(spec)).toBe('cluster');
  });

  it('returns the explicit scope value', () => {
    const groupSpec: CapabilitySpec = {
      name: 'x',
      kind: 'mcp',
      image: 'i:1',
      scope: 'group',
    };
    expect(getScope(groupSpec)).toBe('group');
    const clusterSpec: CapabilitySpec = {
      name: 'x',
      kind: 'mcp',
      image: 'i:1',
      scope: 'cluster',
    };
    expect(getScope(clusterSpec)).toBe('cluster');
  });
});

describe('resolveGroupCapability', () => {
  it('applies documented defaults when group-only fields are unset', () => {
    const spec: CapabilitySpec = {
      name: 'x',
      kind: 'mcp',
      image: 'i:1',
      scope: 'group',
    };
    const r = resolveGroupCapability(spec);
    expect(r.scaleDownAfterIdleSeconds).toBe(600);
    expect(r.volumeFromGroupPvc).toBe(false);
    expect(r.credentialsFrom).toBe('none');
    expect(r.spec).toBe(spec);
  });

  it('returns the explicit values when set', () => {
    const spec: CapabilitySpec = {
      name: 'x',
      kind: 'mcp',
      image: 'i:1',
      scope: 'group',
      scaleDownAfterIdleSeconds: 900,
      volumeFromGroupPvc: true,
      credentialsFrom: 'secret',
    };
    const r = resolveGroupCapability(spec);
    expect(r.scaleDownAfterIdleSeconds).toBe(900);
    expect(r.volumeFromGroupPvc).toBe(true);
    expect(r.credentialsFrom).toBe('secret');
  });

  it('throws when called on a cluster-scoped spec', () => {
    const spec: CapabilitySpec = {
      name: 'x',
      kind: 'mcp',
      image: 'i:1',
      scope: 'cluster',
    };
    expect(() => resolveGroupCapability(spec)).toThrow(PerGroupCapabilityError);
  });

  it('throws when called on a spec with default (cluster) scope', () => {
    const spec: CapabilitySpec = { name: 'x', kind: 'mcp', image: 'i:1' };
    expect(() => resolveGroupCapability(spec)).toThrow(PerGroupCapabilityError);
  });
});

describe('pinned scope validation', () => {
  const base: CapabilitySpec = {
    name: 'db',
    kind: 'mcp',
    image: 'x:1',
    scope: 'group',
  };

  it('accepts pinned on a group capability', () => {
    expect(() => validateScopeFields({ ...base, pinned: true })).not.toThrow();
  });

  it('rejects pinned on a cluster capability', () => {
    expect(() =>
      validateScopeFields({ ...base, scope: 'cluster', pinned: true }),
    ).toThrow(/pinned/);
  });
});
