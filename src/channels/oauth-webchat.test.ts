import { vi, describe, it, expect } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

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
    expect(
      parseAllowlist('alice@example.com,@trusted.org,bob@example.com'),
    ).toEqual({
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

import { parseConfig } from './oauth-webchat.js';
import { afterEach, beforeEach } from 'vitest';

describe('parseConfig', () => {
  const REQUIRED_ENV = {
    OAUTH_WEBCHAT_PUBLIC_URL: 'https://chat.example.com',
    OAUTH_WEBCHAT_OIDC_ISSUER: 'https://accounts.example.com',
    OAUTH_WEBCHAT_CLIENT_ID: 'client-id',
    OAUTH_WEBCHAT_CLIENT_SECRET: 'client-secret',
    OAUTH_WEBCHAT_ALLOWED_EMAILS: 'alice@example.com',
    OAUTH_WEBCHAT_COOKIE_SECRET: 'a'.repeat(32),
  };

  let original: NodeJS.ProcessEnv;
  beforeEach(() => {
    original = { ...process.env };
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('OAUTH_WEBCHAT_')) delete process.env[k];
    }
  });
  afterEach(() => {
    process.env = original;
  });

  it('parses all required vars with defaults applied', () => {
    Object.assign(process.env, REQUIRED_ENV);
    const config = parseConfig();
    expect(config).not.toBeNull();
    expect(config!.port).toBe(4080);
    expect(config!.publicUrl).toBe('https://chat.example.com');
    expect(config!.oidcIssuer).toBe('https://accounts.example.com');
    expect(config!.clientId).toBe('client-id');
    expect(config!.clientSecret).toBe('client-secret');
    expect(config!.cookieSecret).toBe('a'.repeat(32));
    expect(config!.sessionTtlDays).toBe(30);
    expect(config!.scopes).toBe('openid email profile');
    expect(config!.providerName).toBe('OIDC');
    expect(config!.allowlist.exact.has('alice@example.com')).toBe(true);
  });

  it('honours custom overrides', () => {
    Object.assign(process.env, REQUIRED_ENV, {
      OAUTH_WEBCHAT_PORT: '9000',
      OAUTH_WEBCHAT_SESSION_TTL_DAYS: '7',
      OAUTH_WEBCHAT_SCOPES: 'openid email',
      OAUTH_WEBCHAT_PROVIDER_NAME: 'Google',
    });
    const config = parseConfig()!;
    expect(config.port).toBe(9000);
    expect(config.sessionTtlDays).toBe(7);
    expect(config.scopes).toBe('openid email');
    expect(config.providerName).toBe('Google');
  });

  it('returns null when public URL is missing', () => {
    const env = { ...REQUIRED_ENV };
    delete (env as Record<string, string | undefined>).OAUTH_WEBCHAT_PUBLIC_URL;
    Object.assign(process.env, env);
    expect(parseConfig()).toBeNull();
  });

  it('returns null when issuer is missing', () => {
    const env = { ...REQUIRED_ENV };
    delete (env as Record<string, string | undefined>).OAUTH_WEBCHAT_OIDC_ISSUER;
    Object.assign(process.env, env);
    expect(parseConfig()).toBeNull();
  });

  it('returns null when allowlist is empty', () => {
    Object.assign(process.env, REQUIRED_ENV, { OAUTH_WEBCHAT_ALLOWED_EMAILS: '' });
    expect(parseConfig()).toBeNull();
  });

  it('returns null when cookie secret is shorter than 32 bytes', () => {
    Object.assign(process.env, REQUIRED_ENV, { OAUTH_WEBCHAT_COOKIE_SECRET: 'short' });
    expect(parseConfig()).toBeNull();
  });
});
