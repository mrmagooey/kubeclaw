import { describe, it, expect } from 'vitest';
import { validateScopeFields, PerGroupCapabilityError } from './types.js';
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

  it('rejects cluster-scoped spec carrying group-only field', () => {
    const spec: CapabilitySpec = {
      name: 'x',
      kind: 'mcp',
      image: 'i:1',
      scope: 'cluster',
      scaleDownAfterIdleSeconds: 300,
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
