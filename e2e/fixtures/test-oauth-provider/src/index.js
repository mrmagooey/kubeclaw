'use strict';

/**
 * Minimal OIDC provider fixture for kubeclaw oauth-webchat e2e tests.
 *
 * Implements just enough of OpenID Connect Authorization Code Flow (+ PKCE):
 *   GET  /.well-known/openid-configuration  → OIDC discovery doc
 *   GET  /.well-known/jwks.json             → JWKS (RS256, fixed key)
 *   GET  /authorize                          → immediate 302 to redirect_uri?code=test-code&state=...
 *   POST /token                              → returns id_token JWT for test user alice@test.local
 *   GET  /userinfo                           → returns { sub, email, email_verified, name }
 *
 * The fixed test user is:
 *   sub:   "test-user-1"
 *   email: "alice@test.local"
 *   name:  "Alice"
 *
 * The RSA key pair is hard-coded below for reproducibility.
 * This server is intentionally not production-safe — it is a test fixture only.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.OAUTH_PORT) || 8080;

// ── Fixed RSA-2048 key pair (test-only) ───────────────────────────────────────
// Generated with: openssl genrsa 2048 | openssl rsa -pubout
// Private key is stored in PKCS#8 PEM format, public in SPKI PEM format.

const PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDp380uUxq9tlAI
RrODWroZGyutA4QJ+fp3umgMiZNzHGxYpdiADIc/1QTd7vRAvomNcVyBB4gru4B3
ZYMsPzNzB7M7f1ekwkMaFlbfK0Vs0E+TB8dhLvqCHz8Qm9dGh+2/2LD6YpVbqwWn
N8Fo6hO6lGYvh0l/GC9qfJTrYQkoOgqC1WfbTikoeEDiYA+6TJ0OCDAFdbTelf7g
0JrN38bZUhNkr+ODRefnWdGsjP7Bgjv/+/vuwsSf/PSYgMHatEAMXZec1HzlLy5P
vDvz2xPw/aUTYisPOyoSZiLrAga96+Hr66tgmBogwY6E0uMEnqHWzzFtjvTAVts1
DWRbn7cDAgMBAAECggEAbQ1lYEdx/aooMWO+Su6gPhq0R+2OwRQmHXP3FnmEHrXP
M5rJlBPDcRlENrQ4goQWIbUNXEEF1taMdaAJBTXHKMkbYw/i7zmCDoUCJvfHXJDZ
ugZzirZcKxak0nrIa+PwEXfaNjaHzIG3lhxifChB4MtXxqu/spq1aWMEEalimrVp
dH3RRbTDMNrBagq2cTq/RBdX1AJPEGngSVsfFuNjTIYSgJlPytpSlkAKxw+mnMxO
sWrem9si6pNjy8QiD029JZjfArtzsqioEyrNjGgs+SqYLGW4um/6qk/ubA7xw+Zr
MyKwdW0/Fw3wOE76l4dD2MuWNFGe5q+3FwHLN7AVkQKBgQD6x5w6OGSqlOiyjkYc
UdeLwSeLSzy59ye86pRDADiFGCqP534F4Fg80GDvWPVTUck2zrqEB4q+OFNUHGCn
+X77ZVa8cCCkH+p1Rz8oH+exgQqrGrrpdbf8CJWutuP195HyGzgiBT8/7ywbLl7n
kO8DF6NaEM+R4IJMMVhNlk9V+wKBgQDuvhpTrnBaIViQxsBNS9jx+qqk+/MBIXGN
bAy9Yrjn99AOF9teFU9rKqdH+8MMu/kX+fpe24jkdFOQfc0q+305kQlQYCBjE+2A
T/bVqKA+4aYLoW4wgBksZNpkPJVxUL3if8lYjNEv36EIsYMP5YAXx9RmT/C1pbIL
2roWmWO8mQKBgQDdtp57pqHxYid8vWZk4UKUr1dbwk/VBhse3bHorohJuzzd70cu
wNKiKYSZ92clm7gueYTS96wFUtzxDwmxWFaYwlZ10Rg6onDx8OR4gASinTimX8KC
Zu4bqCdVySIvswpYJxJwmXz69GRlP5DuX+fALyTfmt841Gm+HR45sjtAAwKBgAl5
n//cN3dMRYCRcsZekUChSy57FVzhH+mV9Td6+I20RxyYE8u7GsjNC5COzGHv/+XU
tPwYyGkQuNROOdtP2dt0ByOafQ6RluZ1xf0a0SlNuVJS2NWx783UPtqlkOTLaI3Z
tnr+M7srq+91ZBc4a4oGE0bwO0RqTBOuXZ5R/iRZAoGBAO9AKHTva20bAI21GFR8
rKZIzykhvCZRYDSBvlCTE0aaiP+Y2LZUNpOfuyKlg9djwyok5aJb604yEjIluVbC
sSwltMq3wCQuma8/oLIqM3oW0e9n/+Vfxhww7Nd0zejp9PcdespLx/TxP6v8MZG7
3Ffkfch73jOIwaOgzyN3LcpK
-----END PRIVATE KEY-----`;

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6d/NLlMavbZQCEazg1q6
GRsrrQOECfn6d7poDImTcxxsWKXYgAyHP9UE3e70QL6JjXFcgQeIK7uAd2WDLD8z
cwezO39XpMJDGhZW3ytFbNBPkwfHYS76gh8/EJvXRoftv9iw+mKVW6sFpzfBaOoT
upRmL4dJfxgvanyU62EJKDoKgtVn204pKHhA4mAPukydDggwBXW03pX+4NCazd/G
2VITZK/jg0Xn51nRrIz+wYI7//v77sLEn/z0mIDB2rRADF2XnNR85S8uT7w789sT
8P2lE2IrDzsqEmYi6wIGvevh6+urYJgaIMGOhNLjBJ6h1s8xbY70wFbbNQ1kW5+3
AwIDAQAB
-----END PUBLIC KEY-----`;

// ── JWKS export ────────────────────────────────────────────────────────────────

const KID = 'test-key-1';

function getJwks() {
  const pubKey = crypto.createPublicKey(PUBLIC_KEY_PEM);
  const jwk = pubKey.export({ format: 'jwk' });
  return {
    keys: [
      {
        ...jwk,
        kid: KID,
        alg: 'RS256',
        use: 'sig',
      },
    ],
  };
}

// ── JWT signing ────────────────────────────────────────────────────────────────

function signIdToken(claims) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }),
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const privKey = crypto.createPrivateKey(PRIVATE_KEY_PEM);
  const sig = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(privKey)
    .toString('base64url');
  return `${signingInput}.${sig}`;
}

// ── Test user ─────────────────────────────────────────────────────────────────

const TEST_USER = {
  sub: 'test-user-1',
  email: 'alice@test.local',
  email_verified: true,
  name: 'Alice',
};

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const base = `http://${host}`;
  const u = new URL(req.url || '/', base);

  // OIDC discovery document — openid-client calls this at Issuer.discover()
  if (u.pathname === '/.well-known/openid-configuration') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
        jwks_uri: `${base}/.well-known/jwks.json`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code'],
      }),
    );
    return;
  }

  // JWKS endpoint — openid-client fetches this to verify id_token signatures
  if (u.pathname === '/.well-known/jwks.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getJwks()));
    return;
  }

  // Authorization endpoint — immediately redirect back to redirect_uri with code
  // This skips any user-login UI, which is what we want in automated tests.
  if (u.pathname === '/authorize' && req.method === 'GET') {
    const state = u.searchParams.get('state') || '';
    const redirectUri = u.searchParams.get('redirect_uri') || '';
    if (!redirectUri) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing redirect_uri');
      return;
    }
    const dest = `${redirectUri}?code=test-code-${Date.now()}&state=${encodeURIComponent(state)}`;
    console.log(`[authorize] redirecting to: ${dest}`);
    res.writeHead(302, { Location: dest });
    res.end();
    return;
  }

  // Token endpoint — exchanges code for access_token + id_token
  if (u.pathname === '/token' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      console.log(`[token] body: ${body}`);

      const now = Math.floor(Date.now() / 1000);
      // Parse the redirect_uri from the token request body to derive the
      // issuer URL we should embed in the id_token (must match channel's publicUrl host).
      const params = new URLSearchParams(body);
      const clientId = params.get('client_id') || 'test-client';

      const idToken = signIdToken({
        iss: base,
        sub: TEST_USER.sub,
        aud: clientId,
        exp: now + 3600,
        iat: now,
        nbf: now,
        email: TEST_USER.email,
        email_verified: TEST_USER.email_verified,
        name: TEST_USER.name,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: `test-access-${Date.now()}`,
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
    });
    return;
  }

  // Userinfo endpoint
  if (u.pathname === '/userinfo' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(TEST_USER));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end(`Not found: ${u.pathname}`);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[test-oauth-provider] listening on port ${PORT}`);
  console.log(`[test-oauth-provider] test user: ${TEST_USER.email}`);
});

server.on('error', (err) => {
  console.error('[test-oauth-provider] server error:', err.message);
  process.exit(1);
});
