import { describe, it, expect } from 'vitest';
import { groupHash } from './hash.js';

describe('groupHash', () => {
  it('returns a 10-character lowercase hex string', () => {
    const h = groupHash('Family Chat');
    expect(h).toMatch(/^[0-9a-f]{10}$/);
  });

  it('is deterministic across calls', () => {
    expect(groupHash('Foo')).toBe(groupHash('Foo'));
  });

  it('differs for different inputs', () => {
    expect(groupHash('Foo')).not.toBe(groupHash('Bar'));
  });

  it('normalises consistently for unicode and spaces', () => {
    expect(groupHash('  café  ')).toBe(groupHash('café'));
  });

  it('rejects empty string', () => {
    expect(() => groupHash('')).toThrow();
  });
});
