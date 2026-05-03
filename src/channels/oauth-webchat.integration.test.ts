import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

// ── Stub side-effectful deps (no node:http or openid-client mocks) ──────────

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

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  GROUPS_DIR: '/tmp/groups-test',
}));

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// ── Import after mocks are in place ─────────────────────────────────────────

import { OAuthWebchatChannel, parseAllowlist } from './oauth-webchat.js';

// ── Fake OIDC issuer ────────────────────────────────────────────────────────

interface FakeIssuer {
  base: string;
  server: http.Server;
  setNextEmail: (email: string, verified?: boolean) => void;
  close: () => Promise<void>;
}

async function startFakeIssuer(): Promise<FakeIssuer> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = 'test-key';
  let nextEmail = 'alice@example.com';
  let nextVerified = true;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', `http://localhost`);
    const base = `http://${req.headers.host}`;

    if (u.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          jwks_uri: `${base}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        }),
      );
      return;
    }

    if (u.pathname === '/jwks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }],
        }),
      );
      return;
    }

    if (u.pathname === '/authorize') {
      const state = u.searchParams.get('state') ?? '';
      const redirectUri = u.searchParams.get('redirect_uri') ?? '';
      const dest = `${redirectUri}?code=fake-code&state=${state}`;
      res.writeHead(302, { Location: dest });
      res.end();
      return;
    }

    if (u.pathname === '/token' && req.method === 'POST') {
      const idToken = signIdToken(
        {
          iss: base,
          sub: 'sub-12345',
          aud: 'cid',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
          nbf: Math.floor(Date.now() / 1000),
          email: nextEmail,
          email_verified: nextVerified,
        },
        privateKey,
        kid,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'fake-access',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;

  return {
    base,
    server,
    setNextEmail: (email: string, verified = true) => {
      nextEmail = email;
      nextVerified = verified;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function signIdToken(
  payload: Record<string, unknown>,
  privateKey: crypto.KeyObject,
  kid: string,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }),
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = crypto
    .createSign('RSA-SHA256')
    .update(data)
    .sign(privateKey)
    .toString('base64url');
  return `${data}.${sig}`;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function httpGet(
  url: string,
  cookies: string[] = [],
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'GET',
        headers: cookies.length ? { cookie: cookies.join('; ') } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OAuthWebchatChannel — integration', () => {
  let issuer: FakeIssuer;
  let channel: OAuthWebchatChannel;
  let channelBase: string;

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    const port = await pickFreePort();
    channelBase = `http://127.0.0.1:${port}`;

    const config = {
      port,
      publicUrl: channelBase,
      oidcIssuer: issuer.base,
      clientId: 'cid',
      clientSecret: 'sec',
      allowlist: parseAllowlist('alice@example.com'),
      cookieSecret: 'a'.repeat(64),
      sessionTtlDays: 30,
      scopes: 'openid email profile',
      providerName: 'OIDC',
    };

    channel = new OAuthWebchatChannel(config, {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        'oauth-webchat:alice@example.com': {
          name: 'alice@example.com',
          folder: 'oauth-alice-example-com',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
    });

    await channel.connect();
  }, 15_000);

  afterAll(async () => {
    await channel.disconnect();
    await issuer.close();
  });

  it('rejects /stream without a session', async () => {
    const r = await httpGet(`${channelBase}/stream`);
    expect(r.status).toBe(401);
  });

  it('login → start → fake authorize → callback yields a session cookie', async () => {
    issuer.setNextEmail('alice@example.com', true);

    // Step 1: GET /login/start — expect 302 to issuer /authorize + state cookie
    const start = await httpGet(`${channelBase}/login/start`);
    expect(start.status).toBe(302);

    const setCookies = start.headers['set-cookie'] ?? [];
    const stateCookieHeader = setCookies.find((c) =>
      c.startsWith('oauth-webchat-state='),
    );
    expect(stateCookieHeader).toBeDefined();

    // Extract just the name=value part (before first ';')
    const stateCookieValue = stateCookieHeader!.split(';')[0];

    // Step 2: Follow redirect to fake issuer's /authorize — it 302s back to /callback
    const authorizeUrl = String(start.headers.location);
    const authorizeRes = await new Promise<{
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      http
        .get(authorizeUrl, (r) => {
          r.resume(); // discard body
          resolve({ headers: r.headers });
        })
        .on('error', reject);
    });

    // Step 3: The fake issuer redirects to our channel's /callback
    const callbackUrl = String(authorizeRes.headers.location);
    const callbackPath = callbackUrl.replace(channelBase, '');

    const cb = await httpGet(`${channelBase}${callbackPath}`, [
      stateCookieValue,
    ]);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');

    const sessionCookieHeader = (cb.headers['set-cookie'] ?? []).find((c) =>
      c.startsWith('oauth-webchat-session='),
    );
    expect(sessionCookieHeader).toBeDefined();

    const sessionCookieValue = sessionCookieHeader!.split(';')[0];

    // Step 4: Authenticated GET / returns 200 with user's email
    const home = await httpGet(`${channelBase}/`, [sessionCookieValue]);
    expect(home.status).toBe(200);
    expect(home.body).toContain('alice@example.com');
  }, 15_000);
});
