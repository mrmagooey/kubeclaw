import { describe, it, expect } from 'vitest';
import { SubstitutionPolicy } from './substitution-policy.js';

describe('SubstitutionPolicy', () => {
  const policy = new SubstitutionPolicy({
    perPlaceholderMax: 10,
    totalMax: 50,
  });

  it('accepts within both limits', () => {
    expect(() => policy.validateCounts({ a: 3, b: 5 })).not.toThrow();
  });

  it('rejects per-placeholder over limit', () => {
    expect(() => policy.validateCounts({ a: 11 })).toThrow(/per-placeholder/);
  });

  it('rejects total over limit', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10; i++) counts[`p${i}`] = 6; // total 60
    expect(() => policy.validateCounts(counts)).toThrow(/total/);
  });

  it('boundary: exactly at per-placeholder limit OK', () => {
    expect(() => policy.validateCounts({ a: 10 })).not.toThrow();
  });

  it('boundary: exactly at total limit OK', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 5; i++) counts[`p${i}`] = 10; // total 50
    expect(() => policy.validateCounts(counts)).not.toThrow();
  });

  it('allowedPositions=[body] rejects header position', () => {
    expect(() => policy.validatePosition('header', ['body'])).toThrow(
      /disallowed/,
    );
  });

  it('allowedPositions=[header,body] accepts both', () => {
    expect(() =>
      policy.validatePosition('header', ['header', 'body']),
    ).not.toThrow();
    expect(() =>
      policy.validatePosition('body', ['header', 'body']),
    ).not.toThrow();
  });
});
