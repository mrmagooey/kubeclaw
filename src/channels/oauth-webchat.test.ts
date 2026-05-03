import { describe, it, expect } from 'vitest';
import { signSessionCookie, verifySessionCookie } from './oauth-webchat.js';
import { isEmailAllowed, parseAllowlist } from './oauth-webchat.js';

const SECRET = 'a'.repeat(64);

describe('signSessionCookie / verifySessionCookie', () => {
  it('round-trips a valid cookie', () => {
    const cookie = signSessionCookie(
      { email: 'alice@example.com', exp: nowSeconds() + 3600 },
      SECRET,
    );
    const result = verifySessionCookie(cookie, SECRET);
    expect(result).toEqual({
      email: 'alice@example.com',
      exp: expect.any(Number),
    });
  });

  it('rejects a cookie signed with a different secret', () => {
    const cookie = signSessionCookie(
      { email: 'alice@example.com', exp: nowSeconds() + 3600 },
      SECRET,
    );
    expect(verifySessionCookie(cookie, 'b'.repeat(64))).toBeNull();
  });

  it('rejects an expired cookie', () => {
    const cookie = signSessionCookie(
      { email: 'alice@example.com', exp: nowSeconds() - 1 },
      SECRET,
    );
    expect(verifySessionCookie(cookie, SECRET)).toBeNull();
  });

  it('rejects a cookie with tampered payload', () => {
    const cookie = signSessionCookie(
      { email: 'alice@example.com', exp: nowSeconds() + 3600 },
      SECRET,
    );
    const [, sig] = cookie.split('.');
    const tampered =
      Buffer.from(
        JSON.stringify({ email: 'mallory@evil.com', exp: nowSeconds() + 3600 }),
      ).toString('base64url') +
      '.' +
      sig;
    expect(verifySessionCookie(tampered, SECRET)).toBeNull();
  });

  it('rejects a malformed cookie', () => {
    expect(verifySessionCookie('not-a-cookie', SECRET)).toBeNull();
    expect(verifySessionCookie('only-one-part.', SECRET)).toBeNull();
    expect(verifySessionCookie('', SECRET)).toBeNull();
  });
});

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe('parseAllowlist', () => {
  it('parses a mix of full emails and wildcards', () => {
    expect(parseAllowlist('alice@example.com,@trusted.org,bob@example.com')).toEqual({
      exact: new Set(['alice@example.com', 'bob@example.com']),
      domains: new Set(['trusted.org']),
    });
  });

  it('lowercases entries', () => {
    expect(parseAllowlist('Alice@Example.com,@TRUSTED.ORG')).toEqual({
      exact: new Set(['alice@example.com']),
      domains: new Set(['trusted.org']),
    });
  });

  it('skips empty entries and trims whitespace', () => {
    expect(parseAllowlist(' , alice@example.com , ,@trusted.org , ')).toEqual({
      exact: new Set(['alice@example.com']),
      domains: new Set(['trusted.org']),
    });
  });
});

describe('isEmailAllowed', () => {
  const allowlist = parseAllowlist('alice@example.com,@trusted.org');

  it('accepts an exact email match (case-insensitive)', () => {
    expect(isEmailAllowed('alice@example.com', true, allowlist)).toBe(true);
    expect(isEmailAllowed('ALICE@example.com', true, allowlist)).toBe(true);
  });

  it('accepts a domain wildcard match (case-insensitive)', () => {
    expect(isEmailAllowed('carol@trusted.org', true, allowlist)).toBe(true);
    expect(isEmailAllowed('Carol@TRUSTED.ORG', true, allowlist)).toBe(true);
  });

  it('rejects an unmatched email', () => {
    expect(isEmailAllowed('eve@evil.com', true, allowlist)).toBe(false);
  });

  it('rejects when email_verified is false', () => {
    expect(isEmailAllowed('alice@example.com', false, allowlist)).toBe(false);
  });

  it('rejects an empty / missing email', () => {
    expect(isEmailAllowed('', true, allowlist)).toBe(false);
  });
});
