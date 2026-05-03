# OAuth Webchat Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new built-in KubeClaw channel `oauth-webchat` that authenticates browser users via generic OIDC and serves the same chat UI as the existing HTTP channel.

**Architecture:** A Node `http` server in the same shape as `src/channels/http.ts`, hand-rolled (no Express). Authentication uses an OIDC redirect flow (`openid-client`) to get a verified email, then issues an HMAC-signed session cookie. JIDs are `oauth-webchat:<email>`. Operator brings their own Ingress/TLS termination. Code is duplicated rather than shared with `http.ts` (see spec §"Code-sharing decision").

**Tech Stack:** TypeScript, Node `http` (no framework), `openid-client` ^5.7.1, vitest (existing test stack), HMAC-SHA256 via `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-05-02-oauth-webchat-channel-design.md`

**Working directory:** All work should happen in a dedicated git worktree to avoid colliding with other work in this checkout (see CLAUDE.md "Concurrent agents"). Branch off the current `main` HEAD verified with `git rev-parse HEAD` before starting Task 1.

---

## File Structure

**New files:**
- `src/channels/oauth-webchat.ts` — channel implementation (Channel interface, HTTP server, OIDC flow, cookie session, message routes, SSE stream)
- `src/channels/oauth-webchat.test.ts` — unit tests with mocked `node:http`, mirrors `src/channels/http.test.ts` pattern
- `src/channels/oauth-webchat.integration.test.ts` — integration test that spins up a real channel HTTP server and a fake in-process OIDC issuer, then drives the full login → message flow
- `skills/channel/oauth-webchat.md` — operator-facing skill doc with frontmatter (mirrors `skills/channel/http.md`)

**Modified files:**
- `package.json` — add `openid-client` dependency
- `src/channel-runner.ts` — add `'oauth-webchat': 'oauth'` to `folderPrefixForChannel` map
- `src/channels/index.ts` — add `import './oauth-webchat.js'`
- `src/skills/orchestrator/types.ts` — extend `ChannelSetupInput` with new optional fields, extend `CHANNEL_ENV` map
- `src/skills/orchestrator/channel-setup.ts` — add `oauth-webchat` branches to `buildSecretData()` and `validateChannelCredentials()`
- `docs/ADDING_A_CHANNEL.md` — add `oauth-webchat` → `oauth` row to the prefix table

**File responsibilities:**
- `oauth-webchat.ts` is the only new source file. It owns: config parsing, cookie sign/verify, allowlist matching, OIDC client wrapper, request handler with route dispatch, SSE outbound, and the `OAuthWebchatChannel` class implementing `Channel`.
- The two test files split unit (mocked deps, fast, exhaustive) from integration (real server, fake issuer, end-to-end OIDC dance).

---

## Pre-flight

- [ ] **Step 0: Verify HEAD and create worktree**

```bash
git rev-parse HEAD
git worktree add -b oauth-webchat ../kubeclaw-oauth-webchat HEAD
cd ../kubeclaw-oauth-webchat
git status   # expect clean
```

If `git status` is not clean inside the worktree, stop and investigate before proceeding.

---

### Task 1: Add `openid-client` npm dependency

**Files:**
- Modify: `package.json` (dependencies section, currently lines 29-43)

- [ ] **Step 1: Install dep**

```bash
npm install openid-client@^5.7.1
```

- [ ] **Step 2: Verify it landed in package.json**

```bash
grep openid-client package.json
```
Expected: `"openid-client": "^5.7.1"` under `dependencies`.

- [ ] **Step 3: Verify the project still builds**

```bash
npm run build
```
Expected: exit 0, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add openid-client for oauth-webchat channel"
```

---

### Task 2: Add `oauth-webchat` → `oauth` to `folderPrefixForChannel`

**Files:**
- Modify: `src/channel-runner.ts:189-199`
- Test: `src/channel-runner.test.ts` (create if it doesn't exist; otherwise add to it)

- [ ] **Step 1: Check whether `src/channel-runner.test.ts` exists**

```bash
ls src/channel-runner.test.ts 2>&1
```

If it exists, you'll add to it. If not, you'll create it. The plan below assumes you append to the existing file or create a new one with this single test block.

- [ ] **Step 2: Write the failing test**

Add (or create) `src/channel-runner.test.ts` containing:

```typescript
import { describe, it, expect } from 'vitest';
import { folderPrefixForChannel } from './channel-runner.js';

describe('folderPrefixForChannel', () => {
  it('returns "oauth" for oauth-webchat', () => {
    expect(folderPrefixForChannel('oauth-webchat')).toBe('oauth');
  });

  it('returns the established prefix for known channels', () => {
    expect(folderPrefixForChannel('telegram')).toBe('tg');
    expect(folderPrefixForChannel('http')).toBe('http');
  });

  it('falls back to first 3 chars for unknown channels', () => {
    expect(folderPrefixForChannel('matrix')).toBe('mat');
  });
});
```

If the file already exists and already imports vitest, just add the new `describe` block.

- [ ] **Step 3: Run the test to confirm it fails**

```bash
npx vitest run src/channel-runner.test.ts
```
Expected: the `oauth-webchat` test fails (returns `'oau'` because of the 3-char fallback, not `'oauth'`).

- [ ] **Step 4: Add the mapping**

Edit `src/channel-runner.ts`. Replace lines 189-199 (the `folderPrefixForChannel` function body) with:

```typescript
export function folderPrefixForChannel(channelName: string): string {
  const prefix: Record<string, string> = {
    telegram: 'tg',
    discord: 'dc',
    slack: 'sl',
    whatsapp: 'wa',
    irc: 'irc',
    http: 'http',
    'oauth-webchat': 'oauth',
  };
  return prefix[channelName] ?? channelName.slice(0, 3);
}
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
npx vitest run src/channel-runner.test.ts
```
Expected: all three tests pass.

- [ ] **Step 6: Run full suite to confirm no regressions**

```bash
npm test
```
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/channel-runner.ts src/channel-runner.test.ts
git commit -m "feat(channel-runner): add oauth-webchat folder prefix mapping"
```

---

### Task 3: Cookie sign/verify helpers

**Files:**
- Create: `src/channels/oauth-webchat.ts` (this is the channel module's first content)
- Create: `src/channels/oauth-webchat.test.ts`

The cookie format: `<base64url(JSON({email, exp}))>.<base64url(HMAC-SHA256(payload-bytes, secret))>`. Verify decodes payload, recomputes signature with constant-time compare, checks `exp > Date.now() / 1000`.

- [ ] **Step 1: Write the failing test**

Create `src/channels/oauth-webchat.test.ts` with:

```typescript
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
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: import error (file does not exist yet).

- [ ] **Step 3: Implement the helpers**

Create `src/channels/oauth-webchat.ts` with:

```typescript
import crypto from 'node:crypto';

export interface SessionPayload {
  email: string;
  /** Unix epoch seconds */
  exp: number;
}

export function signSessionCookie(payload: SessionPayload, secret: string): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.createHmac('sha256', secret).update(payloadBytes).digest();
  return `${payloadBytes.toString('base64url')}.${sig.toString('base64url')}`;
}

export function verifySessionCookie(
  cookie: string,
  secret: string,
): SessionPayload | null {
  const dot = cookie.indexOf('.');
  if (dot < 1 || dot === cookie.length - 1) return null;

  const payloadB64 = cookie.slice(0, dot);
  const sigB64 = cookie.slice(dot + 1);

  let payloadBytes: Buffer;
  let sig: Buffer;
  try {
    payloadBytes = Buffer.from(payloadB64, 'base64url');
    sig = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }

  const expected = crypto.createHmac('sha256', secret).update(payloadBytes).digest();
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(expected, sig)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }

  // Only `exp` is required. Other fields are validated by callers
  // (e.g. session vs state cookies have different shapes).
  if (typeof payload.exp !== 'number') return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add session cookie sign/verify helpers"
```

---

### Task 4: Allowlist matcher

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

Allowlist entries are full emails (`alice@example.com`) or domain wildcards (`@example.com`). Both sides case-insensitive. ID token must have `email_verified === true`.

- [ ] **Step 1: Write the failing tests**

Append to `src/channels/oauth-webchat.test.ts`:

```typescript
import { isEmailAllowed, parseAllowlist } from './oauth-webchat.js';

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
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: import errors for `parseAllowlist` and `isEmailAllowed`.

- [ ] **Step 3: Implement the functions**

Append to `src/channels/oauth-webchat.ts`:

```typescript
export interface Allowlist {
  exact: Set<string>;
  domains: Set<string>;
}

export function parseAllowlist(spec: string): Allowlist {
  const exact = new Set<string>();
  const domains = new Set<string>();
  for (const raw of spec.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('@')) {
      const domain = entry.slice(1);
      if (domain) domains.add(domain);
    } else {
      exact.add(entry);
    }
  }
  return { exact, domains };
}

export function isEmailAllowed(
  email: string,
  emailVerified: boolean,
  allowlist: Allowlist,
): boolean {
  if (!emailVerified) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  if (allowlist.exact.has(normalized)) return true;
  const at = normalized.lastIndexOf('@');
  if (at < 0) return false;
  const domain = normalized.slice(at + 1);
  return allowlist.domains.has(domain);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add email allowlist parser and matcher"
```

---

### Task 5: Config parser

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

Reads env vars, returns `OAuthWebchatConfig | null`. Returns null (with a `logger.warn`) when any required var is missing or when the cookie secret is shorter than 32 bytes. Defaults: port 4080, ttl 30 days, scopes `openid email profile`, provider name `OIDC`.

- [ ] **Step 1: Add a logger mock and write the failing tests**

At the top of `src/channels/oauth-webchat.test.ts` (above the existing imports), add:

```typescript
import { vi } from 'vitest';

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
```

(If `vi` is already imported from a later block, deduplicate — keep one import line.)

Then append:

```typescript
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
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: import error for `parseConfig`.

- [ ] **Step 3: Implement `parseConfig`**

Append to `src/channels/oauth-webchat.ts`:

```typescript
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

export interface OAuthWebchatConfig {
  port: number;
  publicUrl: string;
  oidcIssuer: string;
  clientId: string;
  clientSecret: string;
  allowlist: Allowlist;
  cookieSecret: string;
  sessionTtlDays: number;
  scopes: string;
  providerName: string;
}

const ENV_KEYS = [
  'OAUTH_WEBCHAT_PORT',
  'OAUTH_WEBCHAT_PUBLIC_URL',
  'OAUTH_WEBCHAT_OIDC_ISSUER',
  'OAUTH_WEBCHAT_CLIENT_ID',
  'OAUTH_WEBCHAT_CLIENT_SECRET',
  'OAUTH_WEBCHAT_ALLOWED_EMAILS',
  'OAUTH_WEBCHAT_COOKIE_SECRET',
  'OAUTH_WEBCHAT_SESSION_TTL_DAYS',
  'OAUTH_WEBCHAT_SCOPES',
  'OAUTH_WEBCHAT_PROVIDER_NAME',
];

function envOr(file: Record<string, string>, key: string): string {
  return process.env[key] ?? file[key] ?? '';
}

export function parseConfig(): OAuthWebchatConfig | null {
  const file = readEnvFile(ENV_KEYS);

  const publicUrl = envOr(file, 'OAUTH_WEBCHAT_PUBLIC_URL');
  const oidcIssuer = envOr(file, 'OAUTH_WEBCHAT_OIDC_ISSUER');
  const clientId = envOr(file, 'OAUTH_WEBCHAT_CLIENT_ID');
  const clientSecret = envOr(file, 'OAUTH_WEBCHAT_CLIENT_SECRET');
  const allowedEmails = envOr(file, 'OAUTH_WEBCHAT_ALLOWED_EMAILS');
  const cookieSecret = envOr(file, 'OAUTH_WEBCHAT_COOKIE_SECRET');

  if (!publicUrl) {
    logger.warn('oauth-webchat: OAUTH_WEBCHAT_PUBLIC_URL is required');
    return null;
  }
  if (!oidcIssuer) {
    logger.warn('oauth-webchat: OAUTH_WEBCHAT_OIDC_ISSUER is required');
    return null;
  }
  if (!clientId || !clientSecret) {
    logger.warn(
      'oauth-webchat: OAUTH_WEBCHAT_CLIENT_ID and OAUTH_WEBCHAT_CLIENT_SECRET are required',
    );
    return null;
  }
  if (!allowedEmails) {
    logger.warn('oauth-webchat: OAUTH_WEBCHAT_ALLOWED_EMAILS is required');
    return null;
  }
  if (!cookieSecret || cookieSecret.length < 32) {
    logger.warn(
      'oauth-webchat: OAUTH_WEBCHAT_COOKIE_SECRET must be at least 32 characters',
    );
    return null;
  }

  const allowlist = parseAllowlist(allowedEmails);
  if (allowlist.exact.size === 0 && allowlist.domains.size === 0) {
    logger.warn('oauth-webchat: OAUTH_WEBCHAT_ALLOWED_EMAILS produced no entries');
    return null;
  }

  return {
    port: parseInt(envOr(file, 'OAUTH_WEBCHAT_PORT') || '4080', 10),
    publicUrl,
    oidcIssuer,
    clientId,
    clientSecret,
    allowlist,
    cookieSecret,
    sessionTtlDays: parseInt(envOr(file, 'OAUTH_WEBCHAT_SESSION_TTL_DAYS') || '30', 10),
    scopes: envOr(file, 'OAUTH_WEBCHAT_SCOPES') || 'openid email profile',
    providerName: envOr(file, 'OAUTH_WEBCHAT_PROVIDER_NAME') || 'OIDC',
  };
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add env-driven config parser with validation"
```

---

### Task 6: OIDC client wrapper (lazy discovery)

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

The wrapper handles discovery (one-time fetch) and exposes `buildAuthorizeUrl(state, codeChallenge)`, `exchangeCode(code, codeVerifier)`. Uses `openid-client` v5 API: `Issuer.discover(url)`, `new issuer.Client({...})`, `client.authorizationUrl({...})`, `client.callback(redirectUri, params, checks)`.

`openid-client@^5.7.1` exports `Issuer` and works in pure Node. The client returns `tokenSet.claims()` as the verified ID token claims.

For tests, mock `openid-client` so we don't actually fetch.

- [ ] **Step 1: Write the failing tests**

Append to `src/channels/oauth-webchat.test.ts`:

```typescript
import { OidcClient } from './oauth-webchat.js';

vi.mock('openid-client', () => {
  const callback = vi.fn();
  const authorizationUrl = vi.fn(
    () => 'https://issuer.example.com/authorize?client_id=cid&state=STATE',
  );
  const Client = vi.fn().mockImplementation(() => ({
    authorizationUrl,
    callback,
  }));
  const Issuer = {
    discover: vi.fn().mockResolvedValue({
      Client,
      metadata: { authorization_endpoint: 'https://issuer.example.com/authorize' },
    }),
  };
  return { Issuer, __mocks: { Client, callback, authorizationUrl } };
});

describe('OidcClient', () => {
  it('discovers the issuer lazily on first use', async () => {
    const oidc = new OidcClient({
      issuer: 'https://issuer.example.com',
      clientId: 'cid',
      clientSecret: 'sec',
      redirectUri: 'https://chat.example.com/callback',
      scopes: 'openid email profile',
    });

    const { Issuer } = await import('openid-client');
    expect((Issuer.discover as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    const url = await oidc.buildAuthorizeUrl({
      state: 'STATE',
      codeChallenge: 'CHALLENGE',
    });
    expect(url).toContain('STATE');
    expect((Issuer.discover as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
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
    expect((Issuer.discover as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('exchangeCode returns claims on success', async () => {
    const claims = { email: 'alice@example.com', email_verified: true, sub: '12345' };
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
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: import error for `OidcClient`.

- [ ] **Step 3: Implement `OidcClient`**

Append to `src/channels/oauth-webchat.ts`:

```typescript
import { Issuer, type Client as OidcLibClient } from 'openid-client';

export interface OidcClientOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
}

export interface OidcClaims {
  email?: string;
  email_verified?: boolean;
  sub?: string;
  [key: string]: unknown;
}

export class OidcClient {
  private opts: OidcClientOptions;
  private clientPromise: Promise<OidcLibClient> | null = null;

  constructor(opts: OidcClientOptions) {
    this.opts = opts;
  }

  private async getClient(): Promise<OidcLibClient> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const issuer = await Issuer.discover(this.opts.issuer);
        return new issuer.Client({
          client_id: this.opts.clientId,
          client_secret: this.opts.clientSecret,
          redirect_uris: [this.opts.redirectUri],
          response_types: ['code'],
        });
      })();
    }
    return this.clientPromise;
  }

  async buildAuthorizeUrl(args: {
    state: string;
    codeChallenge: string;
  }): Promise<string> {
    const client = await this.getClient();
    return client.authorizationUrl({
      scope: this.opts.scopes,
      state: args.state,
      code_challenge: args.codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  async exchangeCode(args: {
    params: { code: string; state: string };
    checks: { state: string; code_verifier: string };
  }): Promise<OidcClaims> {
    const client = await this.getClient();
    const tokenSet = await client.callback(
      this.opts.redirectUri,
      args.params,
      args.checks,
    );
    return tokenSet.claims() as OidcClaims;
  }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add OidcClient wrapper with lazy discovery"
```

---

### Task 7: Channel skeleton (class, capabilities, ownsJid, lifecycle)

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

Implements `Channel` interface with `name`, `capabilities`, `ownsJid`, `connect`/`disconnect`/`isConnected`. The connect/disconnect methods bind/unbind a Node http server, mirroring `HttpChannel`. No request handling yet — handler returns 404 for everything. State cookie helpers also added here (used by login/callback).

- [ ] **Step 1: Add the http mock and write the failing tests**

Add this server mock near the top of `src/channels/oauth-webchat.test.ts` (after the existing `vi.mock` calls):

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';

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
```

Then append tests:

```typescript
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
    const channel = new OAuthWebchatChannel({ ...makeConfig(), port: 9123 }, makeOpts());
    await channel.connect();
    expect(mockServerInstance.listen).toHaveBeenCalledWith(9123, expect.any(Function));
    await channel.disconnect();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: import error for `OAuthWebchatChannel`.

- [ ] **Step 3: Implement the skeleton class**

Append to `src/channels/oauth-webchat.ts`:

```typescript
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import {
  Channel,
  ChannelCapabilities,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface OAuthWebchatChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

const SESSION_COOKIE = 'oauth-webchat-session';
const STATE_COOKIE = 'oauth-webchat-state';

export class OAuthWebchatChannel implements Channel {
  name = 'oauth-webchat';
  readonly capabilities: ChannelCapabilities = {
    inboundImages: true,
    outboundMedia: true,
  };

  private opts: OAuthWebchatChannelOpts;
  private config: OAuthWebchatConfig;
  private server: Server | null = null;

  constructor(config: OAuthWebchatConfig, opts: OAuthWebchatChannelOpts) {
    this.config = config;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, () => {
        logger.info(
          {
            port: this.config.port,
            publicUrl: this.config.publicUrl,
            issuer: this.config.oidcIssuer,
          },
          'oauth-webchat channel listening',
        );
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('oauth-webchat:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      logger.info('oauth-webchat channel closed');
    }
  }

  private handleRequest(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add OAuthWebchatChannel skeleton with lifecycle"
```

---

### Task 8: Login routes (`/login` and `/login/start`)

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

`GET /login` returns an HTML page with a single button ("Sign in with `<providerName>`") that submits as `GET /login/start`. `GET /login/start` generates PKCE verifier + state, sets a short-lived signed `oauth-webchat-state` cookie, and 302s to the provider's authorize URL.

The state cookie is signed with the same HMAC scheme but holds `{state, codeVerifier, exp}` and a 5-minute TTL.

- [ ] **Step 1: Add request/response helpers and write the failing tests**

Append to `src/channels/oauth-webchat.test.ts`:

```typescript
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
  writeHead: (status: number, headers?: Record<string, string | string[]>) => void;
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

async function dispatch(channel: OAuthWebchatChannel, req: IncomingMessage, res: FakeRes) {
  await (mockServerInstance._handler as (r: IncomingMessage, s: ServerResponse) => unknown)(
    req,
    res as unknown as ServerResponse,
  );
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
    expect(cookies.some((c) => String(c).startsWith('oauth-webchat-state='))).toBe(true);
    await channel.disconnect();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: route returns 404 (the skeleton handler). Tests fail asserting 200/302.

- [ ] **Step 3: Implement the routes**

Replace `handleRequest` in `src/channels/oauth-webchat.ts` with a fuller dispatcher and add helpers. Insert this code (replace the existing `handleRequest` method, and add the new module-level helpers and instance fields):

Add these top-level helpers above the `OAuthWebchatChannel` class:

```typescript
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

interface StatePayload {
  state: string;
  codeVerifier: string;
  exp: number;
}

function signStateCookie(payload: StatePayload, secret: string): string {
  return signSessionCookie(payload as unknown as SessionPayload, secret);
}

function verifyStateCookie(cookie: string, secret: string): StatePayload | null {
  return verifySessionCookie(cookie, secret) as unknown as StatePayload | null;
}

function genState(): string {
  return crypto.randomBytes(16).toString('base64url');
}

function genCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function codeChallengeFor(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

const LOGIN_HTML = (providerName: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100dvh;margin:0;background:#f5f5f5}
.card{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.05);text-align:center}
button{padding:.75rem 1.5rem;font-size:1rem;background:#0b93f6;color:#fff;border:none;border-radius:8px;cursor:pointer}
</style></head><body><div class="card"><h2>Sign in</h2>
<form action="/login/start" method="get"><button type="submit">Sign in with ${providerName}</button></form>
</div></body></html>`;
```

Now add an `oidc` instance field (initialized in constructor) and replace `handleRequest`:

In the class, add this field and constructor change:

```typescript
private oidc: OidcClient;

constructor(config: OAuthWebchatConfig, opts: OAuthWebchatChannelOpts) {
  this.config = config;
  this.opts = opts;
  this.oidc = new OidcClient({
    issuer: config.oidcIssuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: `${config.publicUrl.replace(/\/$/, '')}/callback`,
    scopes: config.scopes,
  });
}
```

Replace `handleRequest` with:

```typescript
private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', this.config.publicUrl);

  if (req.method === 'GET' && url.pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_HTML(this.config.providerName));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/login/start') {
    const state = genState();
    const codeVerifier = genCodeVerifier();
    const stateCookie = signStateCookie(
      { state, codeVerifier, exp: Math.floor(Date.now() / 1000) + 300 },
      this.config.cookieSecret,
    );
    const authorizeUrl = await this.oidc.buildAuthorizeUrl({
      state,
      codeChallenge: codeChallengeFor(codeVerifier),
    });
    res.writeHead(302, {
      'Set-Cookie': `${STATE_COOKIE}=${encodeURIComponent(stateCookie)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300`,
      Location: authorizeUrl,
    });
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}
```

You'll also need to import `crypto` at the top — it should already be imported from Task 3.

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: all login route tests pass. Earlier tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add /login and /login/start routes with PKCE"
```

---

### Task 9: Callback route

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

`GET /callback?code=...&state=...`:
1. Read state cookie; if missing/invalid → 400
2. Compare query `state` to cookie `state`; mismatch → 400
3. Call `oidc.exchangeCode({ params, checks: { state, code_verifier } })`
4. Read `email`, `email_verified` from claims
5. Run `isEmailAllowed`; if false → 403 (logged with email and `sub`)
6. Issue session cookie with TTL = `sessionTtlDays * 86400` seconds
7. Clear the state cookie, 302 to `/`

- [ ] **Step 1: Write the failing tests**

Append to `src/channels/oauth-webchat.test.ts`:

```typescript
async function loginAndExtractStateCookie(
  channel: OAuthWebchatChannel,
): Promise<{ stateValue: string; cookieHeader: string }> {
  const req = makeReq({ url: '/login/start' });
  const res = makeRes();
  await dispatch(channel, req, res);
  const setCookie = res._headers['Set-Cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const stateCookie = cookies.find((c) => String(c).startsWith('oauth-webchat-state='))!;
  const cookieHeader = String(stateCookie).split(';')[0];
  return { stateValue: 'STATE', cookieHeader };
}

describe('GET /callback', () => {
  beforeEach(() => {
    const oidc = vi.mocked(import('openid-client')) as unknown as Promise<{
      __mocks: { callback: ReturnType<typeof vi.fn> };
    }>;
    void oidc;
  });

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
    const { cookieHeader } = await loginAndExtractStateCookie(channel);
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
    const { cookieHeader } = await loginAndExtractStateCookie(channel);
    const req = makeReq({
      url: '/callback?code=CODE&state=STATE',
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
    const { cookieHeader } = await loginAndExtractStateCookie(channel);
    const req = makeReq({
      url: '/callback?code=CODE&state=STATE',
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
    const { cookieHeader } = await loginAndExtractStateCookie(channel);
    const req = makeReq({
      url: '/callback?code=CODE&state=STATE',
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
    expect(setCookies.some((c) => c.startsWith('oauth-webchat-session='))).toBe(true);
    expect(
      setCookies.some(
        (c) => c.startsWith('oauth-webchat-state=') && c.includes('Max-Age=0'),
      ),
    ).toBe(true);
    await channel.disconnect();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: callback route returns 404, tests fail.

- [ ] **Step 3: Implement the callback route**

In `handleRequest`, before the final 404, insert:

```typescript
if (req.method === 'GET' && url.pathname === '/callback') {
  const cookies = parseCookies(req.headers.cookie);
  const stateRaw = cookies[STATE_COOKIE];
  if (!stateRaw) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing state cookie');
    return;
  }
  const statePayload = verifyStateCookie(stateRaw, this.config.cookieSecret);
  if (!statePayload) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid state cookie');
    return;
  }
  const queryState = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!code || queryState !== statePayload.state) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('State mismatch');
    return;
  }

  let claims: OidcClaims;
  try {
    claims = await this.oidc.exchangeCode({
      params: { code, state: queryState },
      checks: { state: statePayload.state, code_verifier: statePayload.codeVerifier },
    });
  } catch (err) {
    logger.warn({ err }, 'oauth-webchat: token exchange failed');
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Token exchange failed');
    return;
  }

  const email = (claims.email ?? '').toString();
  const verified = claims.email_verified === true;
  if (!isEmailAllowed(email, verified, this.config.allowlist)) {
    logger.info(
      { email, verified, sub: claims.sub },
      'oauth-webchat: rejected non-allowlisted login',
    );
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Sorry, your account is not authorized.');
    return;
  }

  logger.info(
    { email: email.toLowerCase(), sub: claims.sub },
    'oauth-webchat: successful login',
  );

  const sessionCookie = signSessionCookie(
    {
      email: email.toLowerCase(),
      exp: Math.floor(Date.now() / 1000) + this.config.sessionTtlDays * 86400,
    },
    this.config.cookieSecret,
  );
  const maxAge = this.config.sessionTtlDays * 86400;
  res.writeHead(302, {
    'Set-Cookie': [
      `${SESSION_COOKIE}=${encodeURIComponent(sessionCookie)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
      `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    ],
    Location: '/',
  });
  res.end();
  return;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: all callback tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add /callback route with allowlist enforcement"
```

---

### Task 10: Session validation helper + protected-route gating

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

A small helper `getSession(req)` returns `SessionPayload | null` by reading + verifying the session cookie. This is used by `/`, `/stream`, `/message` in subsequent tasks. To exercise it now, hook it into the existing 404 fall-through so unknown routes that *would* be protected return 401 — but actually it's cleaner to wait until the protected routes are added. Instead, this task adds the helper and a small test that doesn't depend on routing.

- [ ] **Step 1: Write the failing test**

Append to `src/channels/oauth-webchat.test.ts`:

```typescript
import { getSessionFromCookies } from './oauth-webchat.js';

describe('getSessionFromCookies', () => {
  it('returns null when no session cookie is present', () => {
    expect(getSessionFromCookies({}, 'a'.repeat(64))).toBeNull();
  });

  it('returns null when session cookie is invalid', () => {
    expect(
      getSessionFromCookies({ 'oauth-webchat-session': 'garbage' }, 'a'.repeat(64)),
    ).toBeNull();
  });

  it('returns the payload for a valid cookie', () => {
    const cookie = signSessionCookie(
      { email: 'alice@example.com', exp: Math.floor(Date.now() / 1000) + 3600 },
      'a'.repeat(64),
    );
    const result = getSessionFromCookies(
      { 'oauth-webchat-session': cookie },
      'a'.repeat(64),
    );
    expect(result?.email).toBe('alice@example.com');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: import error.

- [ ] **Step 3: Implement the helper**

Append to `src/channels/oauth-webchat.ts`:

```typescript
export function getSessionFromCookies(
  cookies: Record<string, string>,
  secret: string,
): SessionPayload | null {
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  return verifySessionCookie(raw, secret);
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add session lookup helper"
```

---

### Task 11: Logout route

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

`GET /logout` clears the session cookie (Max-Age=0) and 302s to `/login`.

- [ ] **Step 1: Write the failing test**

Append to `src/channels/oauth-webchat.test.ts`:

```typescript
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
        (c) => c.startsWith('oauth-webchat-session=') && c.includes('Max-Age=0'),
      ),
    ).toBe(true);
    await channel.disconnect();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: 404 — fails.

- [ ] **Step 3: Implement the route**

In `handleRequest`, before the final 404, insert:

```typescript
if (req.method === 'GET' && url.pathname === '/logout') {
  res.writeHead(302, {
    'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    Location: '/login',
  });
  res.end();
  return;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add /logout route"
```

---

### Task 12: Chat UI route (`/`)

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

`GET /` returns 302 to `/login` if no session cookie; otherwise serves the chat HTML. The chat HTML is duplicated from `src/channels/http.ts`'s `CHAT_HTML` constant with two changes: include a header strip showing `Signed in as <email> · Logout`, and remove the assumption of Basic Auth (the SSE/POST calls already use `credentials: 'include'`).

- [ ] **Step 1: Write the failing tests**

Append to `src/channels/oauth-webchat.test.ts`:

```typescript
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
      { email: 'alice@example.com', exp: Math.floor(Date.now() / 1000) + 3600 },
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
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: 404 — fails.

- [ ] **Step 3: Implement `/` route**

Append the chat HTML constant near `LOGIN_HTML`:

```typescript
const CHAT_HTML = (email: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f5f5f5; height: 100dvh; display: flex; flex-direction: column; }
  #header { padding: .5rem 1rem; background: #fff; border-bottom: 1px solid #e0e0e0; font-size: .8rem; color: #555; display: flex; justify-content: space-between; }
  #header a { color: #0b93f6; text-decoration: none; }
  #messages { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .msg { max-width: 75%; padding: 0.5rem 0.75rem; border-radius: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #0b93f6; color: #fff; border-bottom-right-radius: 4px; }
  .msg.assistant { align-self: flex-start; background: #fff; border: 1px solid #e0e0e0; border-bottom-left-radius: 4px; }
  #form { display: flex; gap: 0.5rem; padding: 0.75rem; background: #fff; border-top: 1px solid #e0e0e0; align-items: flex-end; }
  #input { flex: 1; padding: 0.5rem 0.75rem; border: 1px solid #ccc; border-radius: 8px; font-size: 1rem; resize: none; height: 2.5rem; max-height: 8rem; overflow-y: auto; }
  #send { padding: 0.5rem 1rem; background: #0b93f6; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; }
  #send:disabled { opacity: 0.5; cursor: default; }
  #status { font-size: 0.75rem; color: #888; padding: 0.25rem 1rem; }
  #attach-label { cursor: pointer; font-size: 1.25rem; padding: 0.25rem; line-height: 1; user-select: none; }
  #file-input { display: none; }
  #preview-area { padding: 0.25rem 0.75rem; font-size: 0.8rem; color: #555; min-height: 0; }
  #preview-area img { max-height: 80px; border-radius: 6px; display: block; margin-top: 0.25rem; }
</style>
</head>
<body>
<div id="header"><span>Signed in as ${email}</span><a href="/logout">Logout</a></div>
<div id="messages"></div>
<div id="status">Connecting…</div>
<div id="preview-area"></div>
<form id="form">
  <label id="attach-label" title="Attach image">📎<input id="file-input" type="file" accept="image/*"></label>
  <textarea id="input" placeholder="Send a message…" rows="1"></textarea>
  <button id="send" type="submit">Send</button>
</form>
<script>
const msgs = document.getElementById('messages');
const status = document.getElementById('status');
const form = document.getElementById('form');
const input = document.getElementById('input');
const send = document.getElementById('send');
const fileInput = document.getElementById('file-input');
const previewArea = document.getElementById('preview-area');
let pendingFile = null;

function addMsg(text, role) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

const es = new EventSource('/stream', { withCredentials: true });
es.onopen = () => { status.textContent = 'Connected'; };
es.onmessage = (e) => { addMsg(e.data, 'assistant'); };
es.onerror = () => { status.textContent = 'Reconnecting…'; };

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  pendingFile = file;
  previewArea.textContent = '';
  const nameSpan = document.createElement('span');
  nameSpan.textContent = file.name;
  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  previewArea.appendChild(nameSpan);
  previewArea.appendChild(document.createElement('br'));
  previewArea.appendChild(img);
});

input.addEventListener('input', () => {
  input.style.height = '2.5rem';
  input.style.height = Math.min(input.scrollHeight, 128) + 'px';
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && !pendingFile) return;
  const displayText = text || (pendingFile ? '[image]' : '');
  input.value = '';
  input.style.height = '2.5rem';
  send.disabled = true;
  addMsg(displayText, 'user');
  try {
    if (pendingFile) {
      const fd = new FormData();
      if (text) fd.append('text', text);
      fd.append('image', pendingFile, pendingFile.name);
      await fetch('/message', { method: 'POST', credentials: 'include', body: fd });
      pendingFile = null;
      previewArea.textContent = '';
      fileInput.value = '';
    } else {
      await fetch('/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text }),
      });
    }
  } finally {
    send.disabled = false;
    input.focus();
  }
});
</script>
</body>
</html>`;
```

In `handleRequest`, before the final 404, insert:

```typescript
if (req.method === 'GET' && url.pathname === '/') {
  const session = getSessionFromCookies(
    parseCookies(req.headers.cookie),
    this.config.cookieSecret,
  );
  if (!session) {
    res.writeHead(302, { Location: '/login' });
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(CHAT_HTML(session.email));
  return;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add chat UI route gated by session cookie"
```

---

### Task 13: SSE `/stream` route

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

`GET /stream` requires session. Maintains a per-email list of SSE clients (for outbound `sendMessage` and `sendMedia` in later tasks). Headers: `text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`. Initial heartbeat `:ok\n\n`. Keepalive every 30s.

- [ ] **Step 1: Write the failing tests**

Append to `src/channels/oauth-webchat.test.ts`:

```typescript
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
      { email: 'alice@example.com', exp: Math.floor(Date.now() / 1000) + 3600 },
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
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: 404 — fails.

- [ ] **Step 3: Implement the route + per-email SSE tracking**

Add to the `OAuthWebchatChannel` class:

```typescript
private sseClients: Array<{ email: string; res: ServerResponse }> = [];
```

In `handleRequest`, before the final 404, insert:

```typescript
if (req.method === 'GET' && url.pathname === '/stream') {
  const session = getSessionFromCookies(
    parseCookies(req.headers.cookie),
    this.config.cookieSecret,
  );
  if (!session) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  const client = { email: session.email, res };
  this.sseClients.push(client);

  req.on('close', () => {
    this.sseClients = this.sseClients.filter((c) => c !== client);
  });

  const ping = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
    } else {
      clearInterval(ping);
    }
  }, 30_000);
  return;
}
```

Update `disconnect` to close all SSE clients:

```typescript
async disconnect(): Promise<void> {
  for (const client of this.sseClients) {
    try {
      client.res.end();
    } catch {
      // ignore
    }
  }
  this.sseClients = [];
  if (this.server) {
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    logger.info('oauth-webchat channel closed');
  }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add SSE /stream route with per-email tracking"
```

---

### Task 14: POST `/message` (JSON text)

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

JSON body `{text: string}`. Auth via session. Calls `opts.onChatMetadata(jid, ts, email, 'oauth-webchat', false)` then `opts.onMessage(...)` if the JID is registered.

- [ ] **Step 1: Write the failing tests**

Append to `src/channels/oauth-webchat.test.ts`:

```typescript
function makeReqWithBody(overrides: {
  url: string;
  cookie?: string;
  contentType?: string;
  body: string;
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
  (req.on as ReturnType<typeof vi.fn>).mockImplementation(
    (event: string, cb: (arg?: Buffer) => void) => {
      if (event === 'data') cb(Buffer.from(overrides.body));
      if (event === 'end') cb();
    },
  );
  return req;
}

function sessionCookieHeader(): string {
  const value = signSessionCookie(
    { email: 'alice@example.com', exp: Math.floor(Date.now() / 1000) + 3600 },
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
      expect.objectContaining({ content: 'hello', sender: 'alice@example.com' }),
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
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: 404 — fails.

- [ ] **Step 3: Implement `/message` (JSON only for now)**

Add a private message-id counter to the class:

```typescript
private messageSeq = 0;
```

In `handleRequest`, before the final 404, insert:

```typescript
if (req.method === 'POST' && url.pathname === '/message') {
  const session = getSessionFromCookies(
    parseCookies(req.headers.cookie),
    this.config.cookieSecret,
  );
  if (!session) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    return;
  }
  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 10 * 1024 * 1024;

  req.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > MAX) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('Payload too large');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    const body = Buffer.concat(chunks);

    if (contentType.startsWith('multipart/form-data')) {
      // Multipart handler is added in Task 15.
      res.writeHead(415, { 'Content-Type': 'text/plain' });
      res.end('Multipart not yet supported');
      return;
    }

    let parsed: { text?: string };
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid JSON');
      return;
    }
    const text = (parsed.text ?? '').trim();
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing text');
      return;
    }
    this.handleInbound(session.email, text);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  return;
}
```

Add `handleInbound` to the class:

```typescript
private handleInbound(email: string, text: string): void {
  const jid = `oauth-webchat:${email}`;
  const timestamp = new Date().toISOString();
  const msgId = `${Date.now()}-${++this.messageSeq}`;

  this.opts.onChatMetadata(jid, timestamp, email, 'oauth-webchat', false);

  const group = this.opts.registeredGroups()[jid];
  if (!group) {
    logger.debug({ jid }, 'oauth-webchat message from unregistered user');
    return;
  }

  this.opts.onMessage(jid, {
    id: msgId,
    chat_jid: jid,
    sender: email,
    sender_name: email,
    content: text,
    timestamp,
    is_from_me: false,
  });
  logger.info({ jid }, 'oauth-webchat message stored');
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add JSON POST /message handler"
```

---

### Task 15: POST `/message` multipart image upload

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

Same as the HTTP channel: parse multipart, validate magic bytes, write image to `GROUPS_DIR/<folder>/attachments/raw/<filename>`, embed `[ImageAttachment: ...]` marker into the message content.

The multipart parser, magic-byte detector, and image attachment writing logic are duplicated from `src/channels/http.ts:39-122` and `:396-446`.

- [ ] **Step 1: Write the failing test**

Append to `src/channels/oauth-webchat.test.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('POST /message (multipart image)', () => {
  it('writes image to disk and emits ImageAttachment marker', async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-webchat-test-'));
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
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="image"; filename="x.png"\r\n'),
      Buffer.from('Content-Type: image/png\r\n\r\n'),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const req = makeReqWithBody({
      url: '/message',
      cookie: sessionCookieHeader(),
      contentType: `multipart/form-data; boundary=${boundary}`,
      body: body.toString('binary'),
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
```

Note: the multipart body in real life is binary, but for the test we serialize it to a `binary`-encoded string and send it through the same mock-data path. The handler decodes it back. If the test is flaky because of encoding, switch to a `Buffer.concat` path in `makeReqWithBody` directly.

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: returns 415 — fails.

- [ ] **Step 3: Add multipart helpers and implement the handler**

Add at module top (under existing imports):

```typescript
import fs from 'node:fs';
import nodePath from 'node:path';
import { GROUPS_DIR } from '../config.js';

const MAX_MULTIPART_SIZE = 10 * 1024 * 1024;

const MEDIA_MAGIC: Array<{ bytes: number[]; mime: string }> = [
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png' },
  { bytes: [0x47, 0x49, 0x46], mime: 'image/gif' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' },
];

function detectMediaType(buffer: Buffer): string | null {
  for (const sig of MEDIA_MAGIC) {
    if (sig.bytes.every((b, i) => buffer[i] === b)) return sig.mime;
  }
  return null;
}

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const sep = Buffer.from(`--${boundary}`);
  const CRLF = Buffer.from('\r\n');
  const CRLFCRLF = Buffer.from('\r\n\r\n');
  let pos = 0;
  while (pos < body.length) {
    const bStart = body.indexOf(sep, pos);
    if (bStart === -1) break;
    pos = bStart + sep.length;
    if (body.slice(pos, pos + 2).equals(Buffer.from('--'))) break;
    if (body.slice(pos, pos + 2).equals(CRLF)) pos += 2;
    const headerEnd = body.indexOf(CRLFCRLF, pos);
    if (headerEnd === -1) break;
    const headerStr = body.slice(pos, headerEnd).toString('utf8');
    pos = headerEnd + 4;
    const nextBound = body.indexOf(sep, pos);
    if (nextBound === -1) break;
    let dataEnd = nextBound;
    if (body.slice(dataEnd - 2, dataEnd).equals(CRLF)) dataEnd -= 2;
    const data = body.slice(pos, dataEnd);
    pos = nextBound;
    let name = '';
    let filename: string | undefined;
    let contentType: string | undefined;
    for (const line of headerStr.split('\r\n')) {
      const lower = line.toLowerCase();
      if (lower.startsWith('content-disposition:')) {
        const nameMatch = line.match(/name="([^"]+)"/i);
        const fileMatch = line.match(/filename="([^"]+)"/i);
        if (nameMatch) name = nameMatch[1];
        if (fileMatch) filename = fileMatch[1];
      } else if (lower.startsWith('content-type:')) {
        contentType = line.slice('content-type:'.length).trim();
      }
    }
    if (name) parts.push({ name, filename, contentType, data });
  }
  return parts;
}
```

Replace the existing multipart-rejection branch in `handleRequest`'s `req.on('end', ...)` handler with:

```typescript
if (contentType.startsWith('multipart/form-data')) {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing boundary');
    return;
  }
  const parts = parseMultipart(body, boundaryMatch[1]);
  const textPart = parts.find((p) => p.name === 'text');
  const imagePart = parts.find((p) => p.name === 'image');
  if (!imagePart) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing image');
    return;
  }
  const mime = detectMediaType(imagePart.data);
  if (!mime) {
    res.writeHead(415, { 'Content-Type': 'text/plain' });
    res.end('Unsupported image format');
    return;
  }
  const jid = `oauth-webchat:${session.email}`;
  const group = this.opts.registeredGroups()[jid];
  if (!group) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const attachDir = nodePath.join(GROUPS_DIR, group.folder, 'attachments', 'raw');
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(nodePath.join(attachDir, filename), imagePart.data);
  const caption = textPart?.data.toString('utf8').trim() ?? '';
  const marker = caption
    ? `[ImageAttachment: attachments/raw/${filename} caption="${caption}"]`
    : `[ImageAttachment: attachments/raw/${filename}]`;
  this.handleInbound(session.email, marker);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
  return;
}
```

Note: `req.destroy()` after `res.end()` for the size-limit path may need an early `return` — existing logic mirrors `http.ts`.

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): add multipart image upload to /message"
```

---

### Task 16: `sendMessage` method (SSE outbound)

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

Strip the `oauth-webchat:` prefix to get the email, find SSE clients with that email, write `data: <line>\n` per line.

- [ ] **Step 1: Write the failing test**

Append to `src/channels/oauth-webchat.test.ts`:

```typescript
describe('sendMessage', () => {
  it('writes SSE data to connected client for the JID', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const session = signSessionCookie(
      { email: 'alice@example.com', exp: Math.floor(Date.now() / 1000) + 3600 },
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
      { email: 'alice@example.com', exp: Math.floor(Date.now() / 1000) + 3600 },
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
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: `sendMessage` is not implemented — TS compile or runtime error.

- [ ] **Step 3: Implement `sendMessage`**

Add to the class:

```typescript
async sendMessage(jid: string, text: string): Promise<void> {
  const email = jid.slice('oauth-webchat:'.length);
  const clients = this.sseClients.filter((c) => c.email === email);
  if (clients.length === 0) {
    logger.debug({ jid }, 'oauth-webchat: no SSE client connected');
    return;
  }
  const lines = text.split('\n');
  const ssePayload = lines.map((l) => `data: ${l}`).join('\n') + '\n\n';
  for (const client of clients) {
    try {
      if (!client.res.writableEnded) {
        client.res.write(ssePayload);
      }
    } catch (err) {
      logger.debug({ jid, err }, 'oauth-webchat: SSE write failed');
    }
  }
  logger.info({ jid, clients: clients.length }, 'oauth-webchat message sent via SSE');
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): implement sendMessage via SSE"
```

---

### Task 17: `sendMedia` method

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

Same SSE channel, `event: media` with JSON `{mediaType, data: base64, caption?}`.

- [ ] **Step 1: Write the failing test**

Append to `src/channels/oauth-webchat.test.ts`:

```typescript
describe('sendMedia', () => {
  it('emits an SSE "media" event with base64 data', async () => {
    const channel = new OAuthWebchatChannel(makeConfig(), makeOpts());
    await channel.connect();
    const session = signSessionCookie(
      { email: 'alice@example.com', exp: Math.floor(Date.now() / 1000) + 3600 },
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
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: not implemented.

- [ ] **Step 3: Implement `sendMedia`**

Add to the class:

```typescript
async sendMedia(
  jid: string,
  buffer: Buffer,
  mediaType: string,
  caption?: string,
): Promise<void> {
  const email = jid.slice('oauth-webchat:'.length);
  const clients = this.sseClients.filter((c) => c.email === email);
  if (clients.length === 0) {
    logger.debug({ jid }, 'oauth-webchat: no SSE client connected (sendMedia)');
    return;
  }
  const payload: { mediaType: string; data: string; caption?: string } = {
    mediaType,
    data: buffer.toString('base64'),
  };
  if (caption !== undefined) payload.caption = caption;
  const ssePayload = `event: media\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      if (!client.res.writableEnded) {
        client.res.write(ssePayload);
      }
    } catch (err) {
      logger.debug({ jid, err }, 'oauth-webchat: SSE write failed (sendMedia)');
    }
  }
  logger.info(
    { jid, mediaType, clients: clients.length },
    'oauth-webchat media sent via SSE',
  );
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): implement sendMedia via SSE"
```

---

### Task 18: Self-register the channel

**Files:**
- Modify: `src/channels/oauth-webchat.ts`
- Modify: `src/channels/oauth-webchat.test.ts`

Append `registerChannel('oauth-webchat', factory)` at the bottom. Factory returns null if `parseConfig()` returns null.

- [ ] **Step 1: Write the failing test**

First, add this `vi.mock` near the top of `src/channels/oauth-webchat.test.ts` alongside the other top-level mocks (`../logger.js`, `../env.js`, `../config.js`, `node:http`, `openid-client`). vitest hoists `vi.mock` to the top of the file regardless of where it appears, but keeping all mocks together makes the test file readable:

```typescript
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
```

Then append at the bottom of the file:

```typescript
import { registerChannel } from './registry.js';

describe('self-registration', () => {
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
    const calls = (registerChannel as ReturnType<typeof vi.fn>).mock.calls;
    const factoryCall = calls.find(([n]) => n === 'oauth-webchat');
    expect(factoryCall).toBeDefined();
    const factory = factoryCall![1] as (opts: unknown) => unknown;
    const result = factory(makeOpts());
    expect(result).toBeNull();
  });
});
```

(If the existing tests at the top of the file already mock `./registry.js`, deduplicate.)

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: `registerChannel` was never called.

- [ ] **Step 3: Add the self-registration**

Append to `src/channels/oauth-webchat.ts`:

```typescript
import { registerChannel, ChannelOpts } from './registry.js';

registerChannel('oauth-webchat', (opts: ChannelOpts) => {
  const config = parseConfig();
  if (!config) return null;
  return new OAuthWebchatChannel(config, opts);
});
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/channels/oauth-webchat.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts
git commit -m "feat(oauth-webchat): self-register channel factory"
```

---

### Task 19: Wire the channel into `src/channels/index.ts`

**Files:**
- Modify: `src/channels/index.ts`

- [ ] **Step 1: Add the import**

Edit `src/channels/index.ts`. The current file (lines 1-21) has commented placeholders for various channels and concrete imports for `http` and `irc`. Add the `oauth-webchat` import in the same style.

Replace lines 8-10:

```typescript
// http
import './http.js';
```

with:

```typescript
// http
import './http.js';

// oauth-webchat
import './oauth-webchat.js';
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```
Expected: clean build.

- [ ] **Step 3: Run full suite**

```bash
npm test
```
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/channels/index.ts
git commit -m "feat(oauth-webchat): register channel in barrel file"
```

---

### Task 20: Extend orchestrator types

**Files:**
- Modify: `src/skills/orchestrator/types.ts:8-33` (`ChannelSetupInput` interface) and `:43-51` (`CHANNEL_ENV` map)

- [ ] **Step 1: Edit the types**

Append to the `ChannelSetupInput` interface (after the existing `httpPort?` field, before `registerGroup`):

```typescript
  /** Public base URL with scheme, e.g. https://chat.example.com (oauth-webchat) */
  publicUrl?: string;
  /** OIDC issuer URL (oauth-webchat) */
  oidcIssuer?: string;
  /** OAuth client ID (oauth-webchat) */
  clientId?: string;
  /** OAuth client secret (oauth-webchat) */
  clientSecret?: string;
  /** Comma-separated allowed emails or @domain wildcards (oauth-webchat) */
  allowedEmails?: string;
  /** ≥32-char HMAC secret for session cookie (oauth-webchat) */
  cookieSecret?: string;
  /** Session lifetime in days (oauth-webchat, default 30) */
  sessionTtlDays?: number;
  /** OIDC scopes (oauth-webchat, default "openid email profile") */
  scopes?: string;
  /** Display name on login button (oauth-webchat, default "OIDC") */
  providerName?: string;
```

In `CHANNEL_ENV`, add a row:

```typescript
  'oauth-webchat': [
    'OAUTH_WEBCHAT_PUBLIC_URL',
    'OAUTH_WEBCHAT_OIDC_ISSUER',
    'OAUTH_WEBCHAT_CLIENT_ID',
    'OAUTH_WEBCHAT_CLIENT_SECRET',
    'OAUTH_WEBCHAT_ALLOWED_EMAILS',
    'OAUTH_WEBCHAT_COOKIE_SECRET',
  ],
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/skills/orchestrator/types.ts
git commit -m "feat(orchestrator): extend ChannelSetupInput for oauth-webchat"
```

---

### Task 21: `buildSecretData` and `validateChannelCredentials` branches

**Files:**
- Modify: `src/skills/orchestrator/channel-setup.ts:34-79` (validate) and `:172-197` (buildSecretData)
- Test: `src/skills/orchestrator/channel-setup.test.ts` (create if it does not exist; otherwise extend)

- [ ] **Step 1: Check whether a test file exists**

```bash
ls src/skills/orchestrator/channel-setup.test.ts 2>&1
```

If it does, extend it. If it does not, create it with this preamble:

```typescript
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
```

Note: `buildSecretData` is currently a private function inside `channel-setup.ts`. Export it for testability — change `function buildSecretData` to `export function buildSecretData`.

- [ ] **Step 2: Write the failing tests**

Append:

```typescript
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
```

- [ ] **Step 3: Run the tests to confirm they fail**

```bash
npx vitest run src/skills/orchestrator/channel-setup.test.ts
```
Expected: fails — `buildSecretData` doesn't handle `oauth-webchat`, `validateChannelCredentials` returns null for unknown type, etc.

- [ ] **Step 4: Implement `buildSecretData` branch**

In `src/skills/orchestrator/channel-setup.ts`, change `function buildSecretData` to `export function buildSecretData`. Then inside, before the final `return data;`, add:

```typescript
if (type === 'oauth-webchat') {
  if (input.publicUrl) data['OAUTH_WEBCHAT_PUBLIC_URL'] = input.publicUrl;
  if (input.oidcIssuer) data['OAUTH_WEBCHAT_OIDC_ISSUER'] = input.oidcIssuer;
  if (input.clientId) data['OAUTH_WEBCHAT_CLIENT_ID'] = input.clientId;
  if (input.clientSecret) data['OAUTH_WEBCHAT_CLIENT_SECRET'] = input.clientSecret;
  if (input.allowedEmails)
    data['OAUTH_WEBCHAT_ALLOWED_EMAILS'] = input.allowedEmails;
  if (input.cookieSecret) data['OAUTH_WEBCHAT_COOKIE_SECRET'] = input.cookieSecret;
  if (input.sessionTtlDays !== undefined)
    data['OAUTH_WEBCHAT_SESSION_TTL_DAYS'] = String(input.sessionTtlDays);
  if (input.scopes) data['OAUTH_WEBCHAT_SCOPES'] = input.scopes;
  if (input.providerName) data['OAUTH_WEBCHAT_PROVIDER_NAME'] = input.providerName;
}
```

- [ ] **Step 5: Implement `validateChannelCredentials` branch**

In `validateChannelCredentials`, before the final `return null;`, add:

```typescript
if (type === 'oauth-webchat') {
  const issuer = secretData['OAUTH_WEBCHAT_OIDC_ISSUER'];
  if (!issuer) return 'OAUTH_WEBCHAT_OIDC_ISSUER is required';
  try {
    const discoveryUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(discoveryUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return `OIDC discovery failed (HTTP ${res.status})`;
    }
    const json = (await res.json()) as Record<string, unknown>;
    if (!json.authorization_endpoint || !json.token_endpoint) {
      return 'OIDC discovery response missing authorization_endpoint or token_endpoint';
    }
    return null;
  } catch (err) {
    return `Could not reach OIDC discovery URL: ${err instanceof Error ? err.message : String(err)}`;
  }
}
```

- [ ] **Step 6: Run the tests to confirm they pass**

```bash
npx vitest run src/skills/orchestrator/channel-setup.test.ts
```
Expected: pass.

- [ ] **Step 7: Run the full suite**

```bash
npm test
```
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/skills/orchestrator/channel-setup.ts src/skills/orchestrator/channel-setup.test.ts
git commit -m "feat(orchestrator): add oauth-webchat to channel setup pipeline"
```

---

### Task 22: Integration test (real server + fake OIDC issuer)

**Files:**
- Create: `src/channels/oauth-webchat.integration.test.ts`

This drives a real `OAuthWebchatChannel` with no mocks of `node:http`. A separate in-process Node http server plays the OIDC issuer (discovery, authorize, token, jwks). Drives the full login → message → SSE round-trip with a manual HTTP client.

This test does NOT mock `openid-client`. It relies on the real library against the fake issuer.

- [ ] **Step 1: Write the integration test**

Create `src/channels/oauth-webchat.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { OAuthWebchatChannel, parseAllowlist } from './oauth-webchat.js';

// ── Fake OIDC issuer ────────────────────────────────────────────────────────

interface FakeIssuer {
  base: string;
  server: http.Server;
  setNextEmail: (email: string, verified?: boolean) => void;
  close: () => Promise<void>;
}

async function startFakeIssuer(): Promise<FakeIssuer> {
  const { generateKeyPairSync } = crypto;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
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
      res.end(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }));
      return;
    }

    if (u.pathname === '/authorize') {
      // Immediately redirect back with code+state
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
    setNextEmail: (email, verified = true) => {
      nextEmail = email;
      nextVerified = verified;
    },
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
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

// ── Test ────────────────────────────────────────────────────────────────────

describe('OAuthWebchatChannel — integration', () => {
  let issuer: FakeIssuer;
  let channel: OAuthWebchatChannel;
  let channelBase: string;

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    const onMessage = vi.fn();
    const config = {
      port: 0,
      publicUrl: 'will-fill',
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
      onMessage,
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
    // Update publicUrl now that the port is known. The redirect URI built
    // by the OidcClient was constructed in the constructor — for the test we
    // assume the integration test driver doesn't follow the redirect URL the
    // provider returns; instead it manually invokes /callback with the code.
    const addr = (channel as unknown as { server: http.Server }).server.address() as {
      port: number;
    };
    channelBase = `http://127.0.0.1:${addr.port}`;
    config.publicUrl = channelBase;
  });

  afterAll(async () => {
    await channel.disconnect();
    await issuer.close();
  });

  async function get(path: string, cookies: string[] = []): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${channelBase}${path}`,
        { method: 'GET', headers: cookies.length ? { cookie: cookies.join('; ') } : {} },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
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

  it('rejects /stream without a session', async () => {
    const r = await get('/stream');
    expect(r.status).toBe(401);
  });

  it('login → start → fake authorize → callback yields a session cookie', async () => {
    issuer.setNextEmail('alice@example.com', true);
    const start = await get('/login/start');
    expect(start.status).toBe(302);
    const setCookie = start.headers['set-cookie'] ?? [];
    const stateCookie = setCookie.find((c) => c.startsWith('oauth-webchat-state='))!;
    expect(stateCookie).toBeDefined();

    // Follow redirect to the fake authorize endpoint
    const authorizeUrl = String(start.headers.location);
    const authorizeRes = await new Promise<{ headers: http.IncomingHttpHeaders }>(
      (resolve, reject) => {
        http.get(authorizeUrl, (r) => {
          r.resume();
          resolve({ headers: r.headers });
        }).on('error', reject);
      },
    );
    const callbackUrl = String(authorizeRes.headers.location);
    const callbackPath = callbackUrl.replace(channelBase, '');

    const cb = await get(callbackPath, [stateCookie.split(';')[0]]);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');
    const sessionCookie = (cb.headers['set-cookie'] ?? []).find((c) =>
      c.startsWith('oauth-webchat-session='),
    );
    expect(sessionCookie).toBeDefined();

    // Authenticated GET / works
    const home = await get('/', [sessionCookie!.split(';')[0]]);
    expect(home.status).toBe(200);
    expect(home.body).toContain('alice@example.com');
  }, 15_000);
});
```

Note: the integration test as written has a small caveat about `publicUrl` being mutated after the OidcClient was constructed. Two fixes:
  1. Make `publicUrl` mutable on the config so the OidcClient picks up the right redirect URI; or
  2. Find an open port first (`net.createServer().listen(0)`), build the config with the resolved URL, then start the channel.

Pick option 2 in the actual test code — it's cleaner. Adjust the test to allocate the port first via `await new Promise<number>(...)`, build `channelBase` and `config.publicUrl` with that port, then connect with `port: knownPort`.

- [ ] **Step 2: Run the integration test**

```bash
npx vitest run src/channels/oauth-webchat.integration.test.ts
```
Expected: pass. If `openid-client` rejects the unsigned/improperly-signed ID token, the test will fail with a clear message — fix the JWT signing in `signIdToken` accordingly (the `RSA-SHA256` algorithm above matches `RS256`).

- [ ] **Step 3: Run full suite**

```bash
npm test
```
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/channels/oauth-webchat.integration.test.ts
git commit -m "test(oauth-webchat): add integration test against fake OIDC issuer"
```

---

### Task 23: Update `docs/ADDING_A_CHANNEL.md` prefix table

**Files:**
- Modify: `docs/ADDING_A_CHANNEL.md` (the prefix table around lines 60-69)

- [ ] **Step 1: Add the row**

Find this block in `docs/ADDING_A_CHANNEL.md`:

```markdown
| `http` | `http` |
| _(unknown)_ | first 3 chars of channel name |
```

Insert above the `_(unknown)_` row:

```markdown
| `oauth-webchat` | `oauth` |
```

The full block should now read:

```markdown
| `http` | `http` |
| `oauth-webchat` | `oauth` |
| _(unknown)_ | first 3 chars of channel name |
```

- [ ] **Step 2: Commit**

```bash
git add docs/ADDING_A_CHANNEL.md
git commit -m "docs(adding-a-channel): document oauth-webchat folder prefix"
```

---

### Task 24: Skill operator doc `skills/channel/oauth-webchat.md`

**Files:**
- Create: `skills/channel/oauth-webchat.md`

- [ ] **Step 1: Create the doc**

```markdown
---
name: oauth-webchat
description: Browser chat channel with generic OIDC authentication
dependencies:
  - openid-client
env:
  - OAUTH_WEBCHAT_PORT
  - OAUTH_WEBCHAT_PUBLIC_URL
  - OAUTH_WEBCHAT_OIDC_ISSUER
  - OAUTH_WEBCHAT_CLIENT_ID
  - OAUTH_WEBCHAT_CLIENT_SECRET
  - OAUTH_WEBCHAT_ALLOWED_EMAILS
  - OAUTH_WEBCHAT_COOKIE_SECRET
  - OAUTH_WEBCHAT_SESSION_TTL_DAYS
  - OAUTH_WEBCHAT_SCOPES
  - OAUTH_WEBCHAT_PROVIDER_NAME
---

# OAuth Webchat Channel

Browser-based chat interface that authenticates end users via generic OIDC. Operator runs one channel instance per OIDC provider; users sign in with their email-verified account. Allowlist is mandatory.

## Endpoints

- `GET /` — browser chat UI (HTML/JS), redirects to `/login` if no session
- `GET /login` — sign-in landing page
- `GET /login/start` — initiates OIDC authorize flow (PKCE + state)
- `GET /callback` — OIDC redirect target; exchanges code, sets session cookie
- `GET /logout` — clears session cookie
- `GET /stream` — Server-Sent Events for real-time agent responses (cookie-gated)
- `POST /message` — receive messages from the browser (JSON or multipart/image)

## Configuration

Required:

- `OAUTH_WEBCHAT_PUBLIC_URL` — external base URL with scheme, e.g., `https://chat.example.com`. Used to build the OAuth redirect URI as `<public-url>/callback`.
- `OAUTH_WEBCHAT_OIDC_ISSUER` — OIDC issuer URL (e.g., `https://accounts.google.com`).
- `OAUTH_WEBCHAT_CLIENT_ID`, `OAUTH_WEBCHAT_CLIENT_SECRET` — from your OAuth app registration.
- `OAUTH_WEBCHAT_ALLOWED_EMAILS` — comma-separated allowlist. Entries are full emails (`alice@example.com`) or domain wildcards (`@example.com`).
- `OAUTH_WEBCHAT_COOKIE_SECRET` — ≥32-byte random string. Generate with `openssl rand -base64 32`.

Optional:

- `OAUTH_WEBCHAT_PORT` (default `4080`)
- `OAUTH_WEBCHAT_SESSION_TTL_DAYS` (default `30`)
- `OAUTH_WEBCHAT_SCOPES` (default `openid email profile`)
- `OAUTH_WEBCHAT_PROVIDER_NAME` (default `OIDC`) — display name on the login button

## JID Format

`oauth-webchat:<email>` — each authenticated user gets an isolated group folder named with the `oauth-` prefix.

## Source

Channel implementation is built-in at `src/channels/oauth-webchat.ts`.

## Operator setup

1. Register an OAuth client with your OIDC provider. Set the redirect URI to `<OAUTH_WEBCHAT_PUBLIC_URL>/callback`.
2. Expose the channel pod externally over HTTPS. The skill ships only a ClusterIP Service — bring your own Ingress, Cloudflare Tunnel, Tailscale Funnel, or equivalent. The proxy must terminate TLS and preserve the original `Host` header.
3. Generate `OAUTH_WEBCHAT_COOKIE_SECRET`: `openssl rand -base64 32`.
4. Add allowed emails to `OAUTH_WEBCHAT_ALLOWED_EMAILS`.

## Security

- The session cookie is `HttpOnly; Secure; SameSite=Lax` — it requires HTTPS to be set, which means the channel will not work over plain HTTP. Always run behind a TLS-terminating proxy.
- The allowlist is mandatory. Without entries, the channel refuses to start.
- The ID token's `email_verified` claim must be `true`.
- The `OAUTH_WEBCHAT_COOKIE_SECRET` is the only thing protecting issued sessions — rotate it (forcing all users to sign in again) by changing the value and restarting the channel pod.

## Notes

- One OIDC provider per channel instance. To support multiple providers, run multiple `oauth-webchat` instances with different `instanceName`.
- OIDC discovery happens lazily on the first sign-in attempt; the channel pod starts even if the issuer is briefly unreachable.
- No refresh tokens. When the cookie expires, the user signs in again.
```

- [ ] **Step 2: Commit**

```bash
git add skills/channel/oauth-webchat.md
git commit -m "docs(skill): add oauth-webchat operator doc"
```

---

### Task 25: Final verification

- [ ] **Step 1: Full test suite**

```bash
npm test
```
Expected: green.

- [ ] **Step 2: Type check**

```bash
npm run typecheck
```
Expected: clean.

- [ ] **Step 3: Format check**

```bash
npm run format
```
Expected: clean (the pre-commit hook will have already run prettier on each commit).

- [ ] **Step 4: Build**

```bash
npm run build
```
Expected: clean.

- [ ] **Step 5: Confirm deliverables**

```bash
git log --oneline main..HEAD
```
Expected: ~24 commits matching the task list above.

```bash
ls src/channels/oauth-webchat.ts src/channels/oauth-webchat.test.ts \
   src/channels/oauth-webchat.integration.test.ts \
   skills/channel/oauth-webchat.md
```
Expected: all four files exist.

```bash
grep -n "oauth-webchat" src/channels/index.ts
grep -n "'oauth-webchat': 'oauth'" src/channel-runner.ts
```
Expected: both grep hits succeed.

- [ ] **Step 6: Open a PR (optional)**

If the user wants to merge this branch:

```bash
git push -u origin oauth-webchat
gh pr create --title "feat: add oauth-webchat channel" --body "$(cat <<'EOF'
## Summary
- New built-in channel `oauth-webchat` that authenticates browser users via generic OIDC
- Mandatory email allowlist with full-email or `@domain` wildcard entries
- HMAC-signed session cookie (no server-side session store)
- Operator brings their own Ingress/TLS termination

Spec: `docs/superpowers/specs/2026-05-02-oauth-webchat-channel-design.md`
Plan: `docs/superpowers/plans/2026-05-02-oauth-webchat-channel.md`

## Test plan
- [ ] `npm test` green
- [ ] `npm run typecheck` clean
- [ ] Manual smoke: stand up channel pod with a real OIDC provider (Google or Authentik) and complete a login → message → SSE round-trip in a real browser

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Otherwise, leave the branch for the user to decide on next.

---

## Spec coverage check

| Spec section | Covered by |
|---|---|
| Channel identity (name, JID, folder prefix) | Task 2 (folder prefix), Task 7 (channel name + ownsJid) |
| Architecture / HTTP routes | Tasks 8-15 |
| OAuth flow | Tasks 8-9 |
| Session cookie | Tasks 3, 9, 10, 11 |
| Library choice (`openid-client`) | Tasks 1, 6 |
| Configuration env vars | Task 5 |
| Allowlist matching rules | Task 4 |
| Channel-pod integration (`onChatMetadata` etc.) | Task 14 |
| Capabilities | Task 7 |
| UI (`/login`, `/`) | Tasks 8, 12 |
| Code-sharing decision (duplicate from `http.ts`) | Tasks 12 (chat HTML), 15 (multipart helpers) |
| Setup integration (`channel-setup.ts`) | Tasks 20, 21 |
| Operator deployment requirements | Task 24 |
| Skill packaging (single .md doc) | Task 24 |
| Testing — Unit | Tasks 3-21 |
| Testing — Integration | Task 22 |
| Testing — E2E (real-issuer discovery) | Task 21 (validateChannelCredentials test against the real Google discovery URL is *not* in the test file as written; it would be a flaky online dependency. Equivalent confidence is provided by the structured discovery-shape assertion against a fake response in Task 21, plus the fake-issuer integration test in Task 22. If the operator wants a true online test, the recommended addition is a separate `npm run test:e2e:phase-3`-style probe that hits Google's discovery URL — out of scope for this plan.) |
