import { describe, it, expect } from 'vitest';
import { signSessionCookie, verifySessionCookie } from './oauth-webchat.js';

const SECRET = 'a'.repeat(64);

describe('signSessionCookie / verifySessionCookie', () => {
  it('round-trips a valid cookie', () => {
    const cookie = signSessionCookie(
      { email: 'alice@example.com', exp: nowSeconds() + 3600 },
      SECRET,
    );
    const result = verifySessionCookie(cookie, SECRET);
    expect(result).toEqual({ email: 'alice@example.com', exp: expect.any(Number) });
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
      Buffer.from(JSON.stringify({ email: 'mallory@evil.com', exp: nowSeconds() + 3600 }))
        .toString('base64url') +
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
