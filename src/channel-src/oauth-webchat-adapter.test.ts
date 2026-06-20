import { describe, it, expect, vi } from 'vitest';
import register from '../../helm/kubeclaw/files/channel-src/oauth-webchat/channel-entry.js';

function fakeSdk(env: Record<string, string>) {
  const factories: Record<string, any> = {};
  return {
    sdk: {
      registerChannel: (name: string, f: any) => { factories[name] = f; },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      readEnvFile: () => env,
      assistantName: 'Andy',
      groupsDir: '/tmp/groups-test',
    },
    factories,
  };
}

function fakeOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'oauth-webchat:alice@example.com': {
        name: 'alice@example.com',
        folder: 'oauth-alice-example-com',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
  };
}

const REQUIRED_ENV = {
  OAUTH_WEBCHAT_PUBLIC_URL: 'https://chat.example.com',
  OAUTH_WEBCHAT_OIDC_ISSUER: 'https://accounts.example.com',
  OAUTH_WEBCHAT_CLIENT_ID: 'client-id',
  OAUTH_WEBCHAT_CLIENT_SECRET: 'client-secret',
  OAUTH_WEBCHAT_ALLOWED_EMAILS: 'alice@example.com',
  OAUTH_WEBCHAT_COOKIE_SECRET: 'a'.repeat(32),
};

describe('oauth-webchat-adapter: factory registration', () => {
  it('registers an oauth-webchat factory that builds a channel when all creds present', () => {
    const { sdk, factories } = fakeSdk(REQUIRED_ENV);
    register(sdk);
    const ch = factories['oauth-webchat'](fakeOpts());
    expect(ch).not.toBeNull();
    expect(ch.name).toBe('oauth-webchat');
  });

  it('factory returns null when public URL is missing', () => {
    const env = { ...REQUIRED_ENV };
    delete (env as Record<string, string | undefined>).OAUTH_WEBCHAT_PUBLIC_URL;
    const { sdk, factories } = fakeSdk(env as Record<string, string>);
    register(sdk);
    expect(factories['oauth-webchat'](fakeOpts())).toBeNull();
  });

  it('factory returns null when OIDC issuer is missing', () => {
    const env = { ...REQUIRED_ENV };
    delete (env as Record<string, string | undefined>).OAUTH_WEBCHAT_OIDC_ISSUER;
    const { sdk, factories } = fakeSdk(env as Record<string, string>);
    register(sdk);
    expect(factories['oauth-webchat'](fakeOpts())).toBeNull();
  });

  it('factory returns null when client credentials are missing', () => {
    const env = { ...REQUIRED_ENV };
    delete (env as Record<string, string | undefined>).OAUTH_WEBCHAT_CLIENT_ID;
    delete (env as Record<string, string | undefined>).OAUTH_WEBCHAT_CLIENT_SECRET;
    const { sdk, factories } = fakeSdk(env as Record<string, string>);
    register(sdk);
    expect(factories['oauth-webchat'](fakeOpts())).toBeNull();
  });

  it('factory returns null when allowed emails is missing', () => {
    const env = { ...REQUIRED_ENV };
    delete (env as Record<string, string | undefined>).OAUTH_WEBCHAT_ALLOWED_EMAILS;
    const { sdk, factories } = fakeSdk(env as Record<string, string>);
    register(sdk);
    expect(factories['oauth-webchat'](fakeOpts())).toBeNull();
  });

  it('factory returns null when allowed emails is empty string', () => {
    const env = { ...REQUIRED_ENV, OAUTH_WEBCHAT_ALLOWED_EMAILS: '' };
    const { sdk, factories } = fakeSdk(env);
    register(sdk);
    expect(factories['oauth-webchat'](fakeOpts())).toBeNull();
  });

  it('factory returns null when cookie secret is shorter than 32 chars', () => {
    const env = { ...REQUIRED_ENV, OAUTH_WEBCHAT_COOKIE_SECRET: 'short' };
    const { sdk, factories } = fakeSdk(env);
    register(sdk);
    expect(factories['oauth-webchat'](fakeOpts())).toBeNull();
  });
});

describe('oauth-webchat-adapter: channel observable properties', () => {
  it('channel.name is "oauth-webchat"', () => {
    const { sdk, factories } = fakeSdk(REQUIRED_ENV);
    register(sdk);
    const ch = factories['oauth-webchat'](fakeOpts());
    expect(ch.name).toBe('oauth-webchat');
  });

  it('channel.isConnected() is false before connect()', () => {
    const { sdk, factories } = fakeSdk(REQUIRED_ENV);
    register(sdk);
    const ch = factories['oauth-webchat'](fakeOpts());
    expect(ch.isConnected()).toBe(false);
  });

  it('channel.ownsJid returns true for oauth-webchat: prefix', () => {
    const { sdk, factories } = fakeSdk(REQUIRED_ENV);
    register(sdk);
    const ch = factories['oauth-webchat'](fakeOpts());
    expect(ch.ownsJid('oauth-webchat:alice@example.com')).toBe(true);
  });

  it('channel.ownsJid returns false for other prefixes', () => {
    const { sdk, factories } = fakeSdk(REQUIRED_ENV);
    register(sdk);
    const ch = factories['oauth-webchat'](fakeOpts());
    expect(ch.ownsJid('http:alice')).toBe(false);
    expect(ch.ownsJid('irc:#x@irc.test:6697')).toBe(false);
    expect(ch.ownsJid('telegram:123')).toBe(false);
  });

  it('channel.capabilities has inboundImages and outboundMedia', () => {
    const { sdk, factories } = fakeSdk(REQUIRED_ENV);
    register(sdk);
    const ch = factories['oauth-webchat'](fakeOpts());
    expect(ch.capabilities?.inboundImages).toBe(true);
    expect(ch.capabilities?.outboundMedia).toBe(true);
  });
});
