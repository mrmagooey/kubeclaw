import { describe, it, expect } from 'vitest';
import { capRows, isAuthorized } from './server.js';

describe('capRows', () => {
  it('truncates to the max and flags truncation', () => {
    expect(capRows([1, 2, 3], 2)).toEqual({ rows: [1, 2], truncated: true });
    expect(capRows([1], 2)).toEqual({ rows: [1], truncated: false });
  });
});

describe('isAuthorized', () => {
  it('accepts the exact bearer token, rejects otherwise', () => {
    expect(isAuthorized('Bearer abc', 'abc')).toBe(true);
    expect(isAuthorized('Bearer abc', 'xyz')).toBe(false);
    expect(isAuthorized(undefined, 'abc')).toBe(false);
    expect(isAuthorized('abc', 'abc')).toBe(false);
  });
});
