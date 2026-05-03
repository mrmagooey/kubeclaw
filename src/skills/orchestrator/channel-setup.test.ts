import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db.js', () => ({
  setRegisteredGroup: vi.fn(),
}));
vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromCluster() {}
    makeApiClient() {
      return {};
    }
  },
  CoreV1Api: class {},
  AppsV1Api: class {},
}));

import {
  buildSecretData,
  validateChannelCredentials,
} from './channel-setup.js';

describe('buildSecretData (oauth-webchat)', () => {
  it('maps all oauth-webchat fields to OAUTH_WEBCHAT_* keys', () => {
    const data = buildSecretData({
      type: 'oauth-webchat',
      publicUrl: 'https://chat.example.com',
      oidcIssuer: 'https://accounts.example.com',
      clientId: 'cid',
      clientSecret: 'sec',
      allowedEmails: 'alice@example.com',
      cookieSecret: 'a'.repeat(64),
      sessionTtlDays: 7,
      scopes: 'openid email',
      providerName: 'Google',
    });
    expect(data).toEqual({
      OAUTH_WEBCHAT_PUBLIC_URL: 'https://chat.example.com',
      OAUTH_WEBCHAT_OIDC_ISSUER: 'https://accounts.example.com',
      OAUTH_WEBCHAT_CLIENT_ID: 'cid',
      OAUTH_WEBCHAT_CLIENT_SECRET: 'sec',
      OAUTH_WEBCHAT_ALLOWED_EMAILS: 'alice@example.com',
      OAUTH_WEBCHAT_COOKIE_SECRET: 'a'.repeat(64),
      OAUTH_WEBCHAT_SESSION_TTL_DAYS: '7',
      OAUTH_WEBCHAT_SCOPES: 'openid email',
      OAUTH_WEBCHAT_PROVIDER_NAME: 'Google',
    });
  });

  it('omits optional fields not provided', () => {
    const data = buildSecretData({
      type: 'oauth-webchat',
      publicUrl: 'https://chat.example.com',
      oidcIssuer: 'https://accounts.example.com',
      clientId: 'cid',
      clientSecret: 'sec',
      allowedEmails: 'alice@example.com',
      cookieSecret: 'a'.repeat(64),
    });
    expect(data.OAUTH_WEBCHAT_SESSION_TTL_DAYS).toBeUndefined();
    expect(data.OAUTH_WEBCHAT_SCOPES).toBeUndefined();
    expect(data.OAUTH_WEBCHAT_PROVIDER_NAME).toBeUndefined();
  });
});

describe('validateChannelCredentials (oauth-webchat)', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null when discovery endpoint returns valid metadata', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        authorization_endpoint: 'https://issuer/authorize',
        token_endpoint: 'https://issuer/token',
      }),
    })) as unknown as typeof fetch;
    const result = await validateChannelCredentials('oauth-webchat', {
      OAUTH_WEBCHAT_OIDC_ISSUER: 'https://accounts.example.com',
    });
    expect(result).toBeNull();
  });

  it('returns an error when discovery returns non-OK', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const result = await validateChannelCredentials('oauth-webchat', {
      OAUTH_WEBCHAT_OIDC_ISSUER: 'https://accounts.example.com',
    });
    expect(result).not.toBeNull();
    expect(result).toContain('discovery');
  });

  it('returns an error when issuer URL is missing', async () => {
    const result = await validateChannelCredentials('oauth-webchat', {});
    expect(result).toContain('OAUTH_WEBCHAT_OIDC_ISSUER');
  });

  it('returns an error when discovery JSON is missing required endpoints', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ wrong: 'data' }),
    })) as unknown as typeof fetch;
    const result = await validateChannelCredentials('oauth-webchat', {
      OAUTH_WEBCHAT_OIDC_ISSUER: 'https://accounts.example.com',
    });
    expect(result).toContain('endpoint');
  });
});
