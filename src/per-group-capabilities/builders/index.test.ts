/**
 * Unit tests for the per-group capability builder registry.
 *
 * Covers:
 *  - buildPerGroupCapabilitySpec returns a valid CapabilitySpec for known types
 *  - Unknown types throw a descriptive error
 *  - listPerGroupCapabilityTypes enumerates registered types
 *  - The echo builder produces the expected CapabilitySpec shape
 *  - Loading a JSON PER_GROUP_CAPABILITIES_VALUES blob → validated specs
 *    (exercises the same path index.ts uses at boot)
 */
import { describe, it, expect } from 'vitest';
import {
  buildPerGroupCapabilitySpec,
  listPerGroupCapabilityTypes,
  type PerGroupCapabilityHelmEntry,
} from './index.js';

describe('buildPerGroupCapabilitySpec', () => {
  it('builds a valid CapabilitySpec for the echo type', () => {
    const entry: PerGroupCapabilityHelmEntry = {
      type: 'echo',
      image: 'kubeclaw-echo:e2e-test',
      scaleDownAfterIdleSeconds: 120,
    };

    const spec = buildPerGroupCapabilitySpec(entry);

    expect(spec.kind).toBe('http');
    expect(spec.name).toBe('echo');
    expect(spec.image).toBe('kubeclaw-echo:e2e-test');
    expect(spec.scope).toBe('group');
    expect(spec.scaleDownAfterIdleSeconds).toBe(120);
    expect(spec.port).toBe(3000);
  });

  it('uses the default scaleDownAfterIdleSeconds when omitted', () => {
    const entry: PerGroupCapabilityHelmEntry = {
      type: 'echo',
      image: 'kubeclaw-echo:latest',
    };

    const spec = buildPerGroupCapabilitySpec(entry);
    expect(spec.scaleDownAfterIdleSeconds).toBe(120); // echo builder default
  });

  it('throws a descriptive error for an unknown type', () => {
    const entry: PerGroupCapabilityHelmEntry = {
      type: 'nonexistent-type',
      image: 'some-image:latest',
    };

    expect(() => buildPerGroupCapabilitySpec(entry)).toThrowError(
      "Unknown per-group capability type 'nonexistent-type'",
    );
  });

  it('error message for unknown type lists registered types', () => {
    const entry: PerGroupCapabilityHelmEntry = {
      type: 'mystery',
      image: 'mystery:latest',
    };

    expect(() => buildPerGroupCapabilitySpec(entry)).toThrowError(/echo/);
  });
});

describe('listPerGroupCapabilityTypes', () => {
  it('includes the echo type', () => {
    const types = listPerGroupCapabilityTypes();
    expect(types).toContain('echo');
  });

  it('returns a non-empty array', () => {
    expect(listPerGroupCapabilityTypes().length).toBeGreaterThan(0);
  });
});

describe('PER_GROUP_CAPABILITIES_VALUES JSON blob loading', () => {
  it('parses a JSON array and builds specs for each entry', () => {
    // Simulate what index.ts does: parse the env var string, then build each spec
    const envVar = JSON.stringify([
      {
        type: 'echo',
        image: 'kubeclaw-echo:e2e-test',
        scaleDownAfterIdleSeconds: 120,
      },
    ]);

    const entries: PerGroupCapabilityHelmEntry[] = JSON.parse(envVar);
    expect(entries).toHaveLength(1);

    const specs = entries.map(buildPerGroupCapabilitySpec);
    expect(specs).toHaveLength(1);
    expect(specs[0].name).toBe('echo');
    expect(specs[0].image).toBe('kubeclaw-echo:e2e-test');
    expect(specs[0].scope).toBe('group');
  });

  it('handles an empty array without error', () => {
    const entries: PerGroupCapabilityHelmEntry[] = JSON.parse('[]');
    expect(entries).toHaveLength(0);
    const specs = entries.map(buildPerGroupCapabilitySpec);
    expect(specs).toHaveLength(0);
  });

  it('throws on unknown type when processing entries from JSON blob', () => {
    const envVar = JSON.stringify([
      { type: 'unknown-capability', image: 'foo:latest' },
    ]);

    const entries: PerGroupCapabilityHelmEntry[] = JSON.parse(envVar);
    expect(() => buildPerGroupCapabilitySpec(entries[0])).toThrowError(
      "Unknown per-group capability type 'unknown-capability'",
    );
  });
});
