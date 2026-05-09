import { vi, describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

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

const mockServerInstance: {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _handler?: (req: IncomingMessage, res: ServerResponse) => void;
} = {
  listen: vi.fn((_port: number, cb: () => void) => cb()),
  close: vi.fn((cb: () => void) => cb()),
  on: vi.fn(),
};

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: vi.fn(
      (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
        mockServerInstance._handler = handler;
        return mockServerInstance;
      },
    ),
  };
});

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  GROUPS_DIR: '/tmp/groups-test',
}));

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('openid-client', () => {
  const callback = vi.fn();
  const authorizationUrl = vi.fn(
    () => 'https://issuer.example.com/authorize?client_id=cid&state=STATE',
  );
  const Client = vi.fn().mockImplementation(function () {
    return { authorizationUrl, callback };
  });
  const Issuer = {
    discover: vi.fn().mockResolvedValue({
      Client,
      metadata: {
        authorization_endpoint: 'https://issuer.example.com/authorize',
      },
    }),
  };
  return { Issuer, __mocks: { Client, callback, authorizationUrl } };
});

import {
  signSessionCookie,
  verifySessionCookie,
  type SessionPayload,
} from './oauth-webchat.js';
import { isEmailAllowed, parseAllowlist } from './oauth-webchat.js';

const SECRET = 'a'.repeat(64);

describe('signSessionCookie / verifySessionCookie', () => {
  it('round-trips a valid cookie', () => {
    const cookie = signSessionCookie(
      { kind: 'session', email: 'alice@example.com', exp: nowSeconds() + 3600 },
      SECRET,
    );
    const result = verifySessionCookie(cookie, SECRET);
    expect(result).toEqual({
      kind: 'session',
      email: 'alice@example.com',
      exp: expect.any(Number),
    });
  });

  it('rejects a cookie signed with a different secret', () => {
    const cookie = signSessionCookie(
      { kind: 'session', email: 'alice@example.com', exp: nowSeconds() + 3600 },
      SECRET,
    );
    expect(verifySessionCookie(cookie, 'b'.repeat(64))).toBeNull();
  });

  it('rejects an expired cookie', () => {
    const cookie = signSessionCookie(
      { kind: 'session', email: 'alice@example.com', exp: nowSeconds() - 1 },
      SECRET,
    );
    expect(verifySessionCookie(cookie, SECRET)).toBeNull();
  });

  it('rejects a cookie with tampered payload', () => {
    const cookie = signSessionCookie(
      { kind: 'session', email: 'alice@example.com', exp: nowSeconds() + 3600 },
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

import { parseConfig, OidcClient } from './oauth-webchat.js';
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
    delete (env as Record<string, string | undefined>)
      .OAUTH_WEBCHAT_OIDC_ISSUER;
    Object.assign(process.env, env);
    expect(parseConfig()).toBeNull();
  });

  it('returns null when allowlist is empty', () => {
    Object.assign(process.env, REQUIRED_ENV, {
      OAUTH_WEBCHAT_ALLOWED_EMAILS: '',
    });
    expect(parseConfig()).toBeNull();
  });

  it('returns null when cookie secret is shorter than 32 bytes', () => {
    Object.assign(process.env, REQUIRED_ENV, {
      OAUTH_WEBCHAT_COOKIE_SECRET: 'short',
    });
    expect(parseConfig()).toBeNull();
  });
});

import { OAuthWebchatChannel } from './oauth-webchat.js';

function makeConfig() {
  return {
    port: 4080,
    publicUrl: 'https://chat.example.com',
    oidcIssuer: 'https://issuer.example.com',
    clientId: 'cid',
    clientSecret: 'sec',
    allowlist: parseAllowlist('alice@example.com,@trusted.org'),
    cookieSecret: 'a'.repeat(64),
    sessionTtlDays: 30,
    scopes: 'openid email profile',
    providerName: 'OIDC',
  };
}

function makeOpts() {
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

describe('OAuthWebchatChannel — lifecycle and basics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has name "oauth-webchat"', () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    expect(channel.name).toBe('oauth-webchat');
  });

  it('declares inboundImages and outboundMedia capabilities', () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    expect(channel.capabilities?.inboundImages).toBe(true);
    expect(channel.capabilities?.outboundMedia).toBe(true);
  });

  it('owns oauth-webchat: prefixed JIDs', () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    expect(channel.ownsJid('oauth-webchat:alice@example.com')).toBe(true);
    expect(channel.ownsJid('http:alice')).toBe(false);
    expect(channel.ownsJid('telegram:123')).toBe(false);
  });

  it('isConnected() returns false before connect', () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    expect(channel.isConnected()).toBe(false);
  });

  it('isConnected() returns true after connect, false after disconnect', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it('listens on the configured port', async () => {
    const channel = new OAuthWebchatChannel(
      { ...makeConfig(), port: 9123 },
      makeOpts(),
    );
    await channel.connect();
    expect(mockServerInstance.listen).toHaveBeenCalledWith(
      9123,
      expect.any(Function),
    );
    await channel.disconnect();
  });
});

describe('OidcClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('discovers the issuer lazily on first use', async () => {
    const oidc = new OidcClient({
      issuer: 'https://issuer.example.com',
      clientId: 'cid',
      clientSecret: 'sec',
      redirectUri: 'https://chat.example.com/callback',
      scopes: 'openid email profile',
    });

    const { Issuer } = await import('openid-client');
    expect(Issuer.discover as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    const url = await oidc.buildAuthorizeUrl({
      state: 'STATE',
      codeChallenge: 'CHALLENGE',
    });
    expect(url).toContain('STATE');
    expect(Issuer.discover as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      'https://issuer.example.com',
    );
  });

  it('caches the issuer between calls', async () => {
    const oidc = new OidcClient({
      issuer: 'https://issuer.example.com',
      clientId: 'cid',
      clientSecret: 'sec',
      redirectUri: 'https://chat.example.com/callback',
      scopes: 'openid email profile',
    });
    await oidc.buildAuthorizeUrl({ state: 'A', codeChallenge: 'X' });
    await oidc.buildAuthorizeUrl({ state: 'B', codeChallenge: 'Y' });
    const { Issuer } = await import('openid-client');
    expect(
      (Issuer.discover as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
  });

  it('exchangeCode returns claims on success', async () => {
    const claims = {
      email: 'alice@example.com',
      email_verified: true,
      sub: '12345',
    };
    const mocks = (await import('openid-client')) as unknown as {
      __mocks: { callback: ReturnType<typeof vi.fn> };
    };
    mocks.__mocks.callback.mockResolvedValue({ claims: () => claims });

    const oidc = new OidcClient({
      issuer: 'https://issuer.example.com',
      clientId: 'cid',
      clientSecret: 'sec',
      redirectUri: 'https://chat.example.com/callback',
      scopes: 'openid email profile',
    });
    const result = await oidc.exchangeCode({
      params: { code: 'CODE', state: 'STATE' },
      checks: { state: 'STATE', code_verifier: 'VERIFIER' },
    });
    expect(result).toEqual(claims);
  });
});

function makeReq(overrides: {
  method?: string;
  url?: string;
  cookie?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (overrides.cookie) headers.cookie = overrides.cookie;
  return {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/',
    headers,
    on: vi.fn(),
    destroy: vi.fn(),
  } as unknown as IncomingMessage;
}

interface FakeRes {
  _status: number;
  _headers: Record<string, string | string[]>;
  _body: string;
  writableEnded: boolean;
  writeHead: (
    status: number,
    headers?: Record<string, string | string[]>,
  ) => void;
  write: (data: string) => void;
  end: (data?: string) => void;
  on: ReturnType<typeof vi.fn>;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    _status: 0,
    _headers: {},
    _body: '',
    writableEnded: false,
    writeHead: vi.fn((status, headers) => {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
    }),
    write: vi.fn((data) => {
      res._body += data;
    }),
    end: vi.fn((data) => {
      if (data) res._body += data;
      res.writableEnded = true;
    }),
    on: vi.fn(),
  };
  return res;
}

async function dispatch(
  channel: OAuthWebchatChannel,
  req: IncomingMessage,
  res: FakeRes,
) {
  await (
    mockServerInstance._handler as (
      r: IncomingMessage,
      s: ServerResponse,
    ) => unknown
  )(req, res as unknown as ServerResponse);
  await new Promise((r) => setTimeout(r, 0));
}

describe('GET /login', () => {
  it('serves the login page when no session cookie present', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({ url: '/login' });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(200);
    expect(String(res._headers['Content-Type'])).toContain('text/html');
    expect(res._body).toContain('Sign in with OIDC');
    expect(res._body).toContain('/login/start');
    await channel.disconnect();
  });
});

describe('GET /login/start', () => {
  it('redirects to the provider authorize URL with state cookie set', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({ url: '/login/start' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(302);
    const loc = String(res._headers['Location']);
    expect(loc).toContain('issuer.example.com');
    expect(loc).toContain('STATE');
    const setCookie = res._headers['Set-Cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
    expect(
      cookies.some((c) => String(c).startsWith('oauth-webchat-state=')),
    ).toBe(true);
    await channel.disconnect();
  });
});

async function loginAndExtractStateCookie(
  channel: OAuthWebchatChannel,
  _cookieSecret: string,
): Promise<{ stateValue: string; cookieHeader: string }> {
  const req = makeReq({ url: '/login/start' });
  const res = makeRes();
  await dispatch(channel, req, res);
  const setCookie = res._headers['Set-Cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const stateCookie = cookies.find((c) =>
    String(c).startsWith('oauth-webchat-state='),
  )!;
  const cookieHeader = String(stateCookie).split(';')[0];
  // Extract the actual state by decoding the cookie value
  const rawValue = decodeURIComponent(
    cookieHeader.slice('oauth-webchat-state='.length),
  );
  const dot = rawValue.indexOf('.');
  const payloadB64 = rawValue.slice(0, dot);
  const payload = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString('utf8'),
  ) as { state: string };
  return { stateValue: payload.state, cookieHeader };
}

describe('GET /logout', () => {
  it('clears the session cookie and redirects to /login', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({ url: '/logout' });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(302);
    expect(String(res._headers['Location'])).toBe('/login');
    const setCookies = (
      Array.isArray(res._headers['Set-Cookie'])
        ? res._headers['Set-Cookie']
        : [String(res._headers['Set-Cookie'] ?? '')]
    ) as string[];
    expect(
      setCookies.some(
        (c) =>
          c.startsWith('oauth-webchat-session=') && c.includes('Max-Age=0'),
      ),
    ).toBe(true);
    await channel.disconnect();
  });
});

describe('GET /callback', () => {
  it('rejects when state cookie is missing', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({ url: '/callback?code=CODE&state=STATE' });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('rejects when state value does not match cookie', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const { cookieHeader } = await loginAndExtractStateCookie(
      channel,
      makeConfig().cookieSecret,
    );
    const req = makeReq({
      url: '/callback?code=CODE&state=WRONG',
      cookie: cookieHeader,
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('rejects an unverified email with 403', async () => {
    const oidcMod = (await import('openid-client')) as unknown as {
      __mocks: { callback: ReturnType<typeof vi.fn> };
    };
    oidcMod.__mocks.callback.mockResolvedValue({
      claims: () => ({
        email: 'alice@example.com',
        email_verified: false,
        sub: '12345',
      }),
    });
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const { stateValue, cookieHeader } = await loginAndExtractStateCookie(
      channel,
      makeConfig().cookieSecret,
    );
    const req = makeReq({
      url: `/callback?code=CODE&state=${stateValue}`,
      cookie: cookieHeader,
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(403);
    await channel.disconnect();
  });

  it('rejects an email not on the allowlist with 403', async () => {
    const oidcMod = (await import('openid-client')) as unknown as {
      __mocks: { callback: ReturnType<typeof vi.fn> };
    };
    oidcMod.__mocks.callback.mockResolvedValue({
      claims: () => ({
        email: 'eve@evil.com',
        email_verified: true,
        sub: '12345',
      }),
    });
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const { stateValue, cookieHeader } = await loginAndExtractStateCookie(
      channel,
      makeConfig().cookieSecret,
    );
    const req = makeReq({
      url: `/callback?code=CODE&state=${stateValue}`,
      cookie: cookieHeader,
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(403);
    await channel.disconnect();
  });

  it('issues a session cookie and 302 to / on success', async () => {
    const oidcMod = (await import('openid-client')) as unknown as {
      __mocks: { callback: ReturnType<typeof vi.fn> };
    };
    oidcMod.__mocks.callback.mockResolvedValue({
      claims: () => ({
        email: 'alice@example.com',
        email_verified: true,
        sub: '12345',
      }),
    });
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const { stateValue, cookieHeader } = await loginAndExtractStateCookie(
      channel,
      makeConfig().cookieSecret,
    );
    const req = makeReq({
      url: `/callback?code=CODE&state=${stateValue}`,
      cookie: cookieHeader,
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(302);
    expect(String(res._headers['Location'])).toBe('/');
    const setCookies = (
      Array.isArray(res._headers['Set-Cookie'])
        ? res._headers['Set-Cookie']
        : [String(res._headers['Set-Cookie'] ?? '')]
    ) as string[];
    expect(setCookies.some((c) => c.startsWith('oauth-webchat-session='))).toBe(
      true,
    );
    expect(
      setCookies.some(
        (c) => c.startsWith('oauth-webchat-state=') && c.includes('Max-Age=0'),
      ),
    ).toBe(true);
    await channel.disconnect();
  });
});

import { getSessionFromCookies } from './oauth-webchat.js';

describe('getSessionFromCookies', () => {
  it('returns null when no session cookie is present', () => {
    expect(getSessionFromCookies({}, 'a'.repeat(64))).toBeNull();
  });

  it('returns null when session cookie is invalid', () => {
    expect(
      getSessionFromCookies(
        { 'oauth-webchat-session': 'garbage' },
        'a'.repeat(64),
      ),
    ).toBeNull();
  });

  it('returns the payload for a valid cookie', () => {
    const cookie = signSessionCookie(
      {
        kind: 'session',
        email: 'alice@example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      'a'.repeat(64),
    );
    const result = getSessionFromCookies(
      { 'oauth-webchat-session': cookie },
      'a'.repeat(64),
    );
    expect(result?.email).toBe('alice@example.com');
  });
});

describe('GET /', () => {
  it('redirects to /login when no session', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({ url: '/' });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(302);
    expect(String(res._headers['Location'])).toBe('/login');
    await channel.disconnect();
  });

  it('serves chat HTML with email when session is valid', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const session = signSessionCookie(
      {
        kind: 'session',
        email: 'alice@example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      makeConfig().cookieSecret,
    );
    const req = makeReq({
      url: '/',
      cookie: `oauth-webchat-session=${encodeURIComponent(session)}`,
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(200);
    expect(String(res._headers['Content-Type'])).toContain('text/html');
    expect(res._body).toContain('alice@example.com');
    expect(res._body).toContain('/stream');
    expect(res._body).toContain('/logout');
    await channel.disconnect();
  });
});

describe('GET /stream', () => {
  it('rejects with 401 when no session', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({ url: '/stream' });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('opens SSE stream with correct headers when authenticated', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const session = signSessionCookie(
      {
        kind: 'session',
        email: 'alice@example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      makeConfig().cookieSecret,
    );
    const req = makeReq({
      url: '/stream',
      cookie: `oauth-webchat-session=${encodeURIComponent(session)}`,
    });
    const closeHandlers: Array<() => void> = [];
    (req.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: () => void) => {
        if (event === 'close') closeHandlers.push(cb);
      },
    );
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('text/event-stream');
    expect(res._headers['Cache-Control']).toBe('no-cache');
    expect(res._body).toContain(':ok');
    closeHandlers.forEach((h) => h());
    await channel.disconnect();
  });
});

function makeReqWithBody(overrides: {
  url: string;
  cookie?: string;
  contentType?: string;
  // Accept a Buffer directly to preserve binary bytes (e.g. PNG magic bytes).
  // When a string is passed, Buffer.from(string) uses utf8 encoding as usual.
  body: string | Buffer;
}): IncomingMessage {
  const headers: Record<string, string> = {
    'content-type': overrides.contentType ?? 'application/json',
  };
  if (overrides.cookie) headers.cookie = overrides.cookie;
  const req = {
    method: 'POST',
    url: overrides.url,
    headers,
    on: vi.fn(),
    destroy: vi.fn(),
  } as unknown as IncomingMessage;
  const bodyBuf = Buffer.isBuffer(overrides.body)
    ? overrides.body
    : Buffer.from(overrides.body);
  (req.on as ReturnType<typeof vi.fn>).mockImplementation(
    (event: string, cb: (arg?: Buffer) => void) => {
      if (event === 'data') cb(bodyBuf);
      if (event === 'end') cb();
    },
  );
  return req;
}

function sessionCookieHeader(): string {
  const value = signSessionCookie(
    {
      kind: 'session',
      email: 'alice@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    makeConfig().cookieSecret,
  );
  return `oauth-webchat-session=${encodeURIComponent(value)}`;
}

describe('POST /message (JSON)', () => {
  it('rejects with 401 when no session', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReqWithBody({ url: '/message', body: '{"text":"hi"}' });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('delivers a message for a registered email', async () => {
    const opts = makeOpts();
    const channel = new OAuthWebchatChannel(makeConfig(), opts);
    await channel.connect();
    const req = makeReqWithBody({
      url: '/message',
      cookie: sessionCookieHeader(),
      body: '{"text":"hello"}',
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(200);
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'oauth-webchat:alice@example.com',
      expect.any(String),
      'alice@example.com',
      'oauth-webchat',
      false,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'oauth-webchat:alice@example.com',
      expect.objectContaining({
        content: 'hello',
        sender: 'alice@example.com',
      }),
    );
    await channel.disconnect();
  });

  it('records metadata but does not deliver for unregistered email', async () => {
    const opts = makeOpts();
    opts.registeredGroups = vi.fn(() => ({})) as ReturnType<typeof vi.fn>;
    const channel = new OAuthWebchatChannel(makeConfig(), opts);
    await channel.connect();
    const req = makeReqWithBody({
      url: '/message',
      cookie: sessionCookieHeader(),
      body: '{"text":"hi"}',
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(200);
    expect(opts.onChatMetadata).toHaveBeenCalled();
    expect(opts.onMessage).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('returns 400 for missing text', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReqWithBody({
      url: '/message',
      cookie: sessionCookieHeader(),
      body: '{}',
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('returns 400 for invalid JSON', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReqWithBody({
      url: '/message',
      cookie: sessionCookieHeader(),
      body: 'not-json',
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(400);
    await channel.disconnect();
  });
});

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('POST /message (multipart image)', () => {
  it('writes image to disk and emits ImageAttachment marker', async () => {
    const tmpdir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'oauth-webchat-test-'),
    );
    vi.doMock('../config.js', () => ({
      ASSISTANT_NAME: 'Andy',
      TRIGGER_PATTERN: /^@Andy\b/i,
      GROUPS_DIR: tmpdir,
    }));
    const mod = await import('./oauth-webchat.js');
    const opts = makeOpts();
    opts.registeredGroups = vi.fn(() => ({
      'oauth-webchat:alice@example.com': {
        name: 'alice@example.com',
        folder: 'oauth-webchat:alice@example.com',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })) as ReturnType<typeof vi.fn>;
    const channel = new mod.OAuthWebchatChannel(makeConfig(), opts);
    await channel.connect();

    const boundary = '----testboundary';
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ]);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(
        'Content-Disposition: form-data; name="image"; filename="x.png"\r\n',
      ),
      Buffer.from('Content-Type: image/png\r\n\r\n'),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const req = makeReqWithBody({
      url: '/message',
      cookie: sessionCookieHeader(),
      contentType: `multipart/form-data; boundary=${boundary}`,
      body: body,
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(opts.onMessage).toHaveBeenCalledWith(
      'oauth-webchat:alice@example.com',
      expect.objectContaining({
        content: expect.stringContaining('[ImageAttachment: attachments/raw/'),
      }),
    );
    fs.rmSync(tmpdir, { recursive: true, force: true });
    await channel.disconnect();
  });
});

describe('sendMessage', () => {
  it('writes SSE data to connected client for the JID', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const session = signSessionCookie(
      {
        kind: 'session',
        email: 'alice@example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      makeConfig().cookieSecret,
    );
    const req = makeReq({
      url: '/stream',
      cookie: `oauth-webchat-session=${encodeURIComponent(session)}`,
    });
    const closeHandlers: Array<() => void> = [];
    (req.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: () => void) => {
        if (event === 'close') closeHandlers.push(cb);
      },
    );
    const streamRes = makeRes();
    await dispatch(channel, req, streamRes);

    await channel.sendMessage('oauth-webchat:alice@example.com', 'Hello');
    const written = (streamRes.write as ReturnType<typeof vi.fn>).mock.calls
      .map(([d]: [string]) => d)
      .join('');
    expect(written).toContain('data: Hello');

    closeHandlers.forEach((h) => h());
    await channel.disconnect();
  });

  it('encodes multi-line messages as multiple data: lines', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const session = signSessionCookie(
      {
        kind: 'session',
        email: 'alice@example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      makeConfig().cookieSecret,
    );
    const req = makeReq({
      url: '/stream',
      cookie: `oauth-webchat-session=${encodeURIComponent(session)}`,
    });
    const closeHandlers: Array<() => void> = [];
    (req.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: () => void) => {
        if (event === 'close') closeHandlers.push(cb);
      },
    );
    const streamRes = makeRes();
    await dispatch(channel, req, streamRes);

    await channel.sendMessage('oauth-webchat:alice@example.com', 'one\ntwo');
    const written = (streamRes.write as ReturnType<typeof vi.fn>).mock.calls
      .map(([d]: [string]) => d)
      .join('');
    expect(written).toContain('data: one\ndata: two');
    closeHandlers.forEach((h) => h());
    await channel.disconnect();
  });

  it('does nothing when no SSE client is connected', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    await expect(
      channel.sendMessage('oauth-webchat:alice@example.com', 'no client'),
    ).resolves.toBeUndefined();
    await channel.disconnect();
  });
});

describe('sendMedia', () => {
  it('emits an SSE "media" event with base64 data', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const session = signSessionCookie(
      {
        kind: 'session',
        email: 'alice@example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      makeConfig().cookieSecret,
    );
    const req = makeReq({
      url: '/stream',
      cookie: `oauth-webchat-session=${encodeURIComponent(session)}`,
    });
    const closeHandlers: Array<() => void> = [];
    (req.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: () => void) => {
        if (event === 'close') closeHandlers.push(cb);
      },
    );
    const res = makeRes();
    await dispatch(channel, req, res);

    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await channel.sendMedia(
      'oauth-webchat:alice@example.com',
      buf,
      'image/png',
      'Hi',
    );

    const written = (res.write as ReturnType<typeof vi.fn>).mock.calls
      .map(([d]: [string]) => d)
      .join('');
    expect(written).toContain('event: media');
    const dataLine = written.split('\n').find((l) => l.startsWith('data:'));
    const parsed = JSON.parse(dataLine!.slice('data: '.length));
    expect(parsed.mediaType).toBe('image/png');
    expect(parsed.caption).toBe('Hi');
    expect(parsed.data).toBe(buf.toString('base64'));
    closeHandlers.forEach((h) => h());
    await channel.disconnect();
  });
});

import { registerChannel } from './registry.js';

describe('self-registration', () => {
  beforeEach(() => {
    vi.resetModules();
    (registerChannel as ReturnType<typeof vi.fn>).mockClear();
  });

  it('registers a factory under "oauth-webchat"', async () => {
    await import('./oauth-webchat.js');
    expect(registerChannel).toHaveBeenCalledWith(
      'oauth-webchat',
      expect.any(Function),
    );
  });

  it('factory returns null when env is missing', async () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('OAUTH_WEBCHAT_')) delete process.env[k];
    }
    await import('./oauth-webchat.js');
    const calls = (registerChannel as ReturnType<typeof vi.fn>).mock.calls;
    const factoryCall = calls.find(([n]) => n === 'oauth-webchat');
    expect(factoryCall).toBeDefined();
    const factory = factoryCall![1] as (opts: unknown) => unknown;
    const result = factory(makeOpts());
    expect(result).toBeNull();
  });
});

describe('C1 regression: state cookie cannot be used as session cookie', () => {
  it('verifySessionCookie rejects a state-shaped payload', () => {
    // signSessionCookie produces a cookie whose payload has kind:'state'.
    // Even though signed with the same secret, verifySessionCookie must reject it.
    const stateCookie = signSessionCookie(
      // Cast to bypass the new TypeScript narrowing — this simulates an
      // attacker presenting a state cookie.
      {
        kind: 'state',
        state: 'X',
        codeVerifier: 'Y',
        exp: Math.floor(Date.now() / 1000) + 300,
      } as unknown as SessionPayload,
      'a'.repeat(64),
    );
    expect(verifySessionCookie(stateCookie, 'a'.repeat(64))).toBeNull();
  });

  it('getSessionFromCookies rejects a cookie that lacks email', () => {
    const cookie = signSessionCookie(
      {
        kind: 'state',
        exp: Math.floor(Date.now() / 1000) + 300,
      } as unknown as SessionPayload,
      'a'.repeat(64),
    );
    expect(
      getSessionFromCookies(
        { 'oauth-webchat-session': cookie },
        'a'.repeat(64),
      ),
    ).toBeNull();
  });

  it('GET /stream rejects a state cookie presented as a session cookie', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    // First, get a real state cookie by hitting /login/start
    const startReq = makeReq({ url: '/login/start' });
    const startRes = makeRes();
    await dispatch(channel, startReq, startRes);
    const setCookie = startRes._headers['Set-Cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    const stateCookie = cookies.find((c) =>
      String(c).startsWith('oauth-webchat-state='),
    )!;
    const stateValue = String(stateCookie)
      .split(';')[0]
      .slice('oauth-webchat-state='.length);
    // Present that value as the session cookie
    const req = makeReq({
      url: '/stream',
      cookie: `oauth-webchat-session=${stateValue}`,
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(401);
    await channel.disconnect();
  });
});
