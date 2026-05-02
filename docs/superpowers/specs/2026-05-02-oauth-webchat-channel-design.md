# OAuth Webchat Channel — Design

**Status:** Design
**Date:** 2026-05-02
**Scope:** A new KubeClaw channel that authenticates end users via generic OIDC and serves a browser-based chat UI.

## Goal

Replace the existing HTTP channel's Basic Auth with an OIDC login flow for the small-trusted-users / behind-a-tunnel use case. Operator runs one channel instance per OIDC provider; end users sign in with their email-verified account at that provider.

The existing `http` channel is unchanged. The new channel lives alongside it as a separate channel type so an operator can pick whichever fits each deployment.

## Non-goals

- Not a public anyone-can-sign-up assistant. The allowlist is mandatory.
- Not multi-tenant in the SaaS sense. One JID = one chat = one user.
- No multi-provider picker in a single channel pod (run two pods if you want two providers).
- No refresh-token storage. The session cookie is the source of truth; expired cookie = log in again.
- No bundled Ingress/TLS resources. The operator brings their own ingress.

## Channel identity

| Field | Value |
|---|---|
| Channel name | `oauth-webchat` |
| JID prefix | `oauth-webchat:` |
| JID body | lowercased verified email |
| JID example | `oauth-webchat:alice@example.com` |
| Folder prefix | `oauth` (added explicitly to `folderPrefixForChannel` in `src/channel-runner.ts`) |
| Folder example | `oauth-alice-example-com` |

**Identity stability:** Email is the canonical identifier. The OIDC `sub` claim is logged at first login for audit purposes but is not part of the JID. Email change = new JID = operator updates allowlist and renames the group folder if conversation history needs to be preserved. This is rare in the target deployment scenario and is not worth the readability cost of `sub`-based JIDs.

## Architecture

The channel is a Node `http` server in the same shape as `src/channels/http.ts` — no Express, no framework, hand-rolled handlers. It self-registers via `registerChannel('oauth-webchat', factory)` at module load and is added to `src/channels/index.ts` as `import './oauth-webchat.js'`.

### HTTP routes

| Method | Path | Auth required | Purpose |
|---|---|---|---|
| GET | `/` | session cookie | Serve chat UI; redirect to `/login` if no cookie |
| GET | `/login` | none | Render "Sign in" landing page |
| GET | `/login/start` | none | Build OIDC authorize URL with PKCE + state, set state cookie, 302 to provider |
| GET | `/callback` | validates `state` and `code` | Exchange code, verify ID token, check allowlist, set session cookie, 302 to `/` |
| GET | `/logout` | none | Clear session cookie, 302 to `/login` |
| GET | `/stream` | session cookie | SSE outbound stream (per existing HTTP channel) |
| POST | `/message` | session cookie | Inbound message — JSON or multipart (per existing HTTP channel) |

### OAuth flow

1. User visits `/`. No cookie → 302 to `/login`.
2. User clicks "Sign in" → 302 to `/login/start`.
3. Channel generates PKCE verifier + random `state`, stores both in a short-lived (5 min) HMAC-signed `oauth-state` cookie, and 302s the user to the provider's authorize endpoint.
4. Provider redirects back to `/callback?code=...&state=...`.
5. Channel validates `state` against the state cookie, exchanges `code` for tokens via the provider's token endpoint, and verifies the ID token's signature against the provider's JWKS.
6. Channel reads `email` and `email_verified` from the ID token. If `email_verified !== true` or the email isn't on the allowlist, respond 403 with a plain-text "not authorized" message (logged at info level with the email).
7. Channel issues a session cookie (see below) and 302s to `/`.

### Session cookie

- **Name:** `oauth-webchat-session`
- **Payload:** `{email, exp}` JSON, base64url-encoded
- **Signature:** HMAC-SHA256 over the encoded payload bytes using `OAUTH_WEBCHAT_COOKIE_SECRET` (the payload already contains `exp`, so no separate inclusion is needed)
- **Cookie format:** `<base64url-payload>.<base64url-signature>`
- **Attributes:** `HttpOnly; Secure; SameSite=Lax; Path=/`
- **Lifetime:** `OAUTH_WEBCHAT_SESSION_TTL_DAYS` (default 30)
- **Validation per request:** decode payload, check `exp > now`, recompute signature with the secret, constant-time compare. On any failure → no session, treat request as anonymous.

No server-side session store. The cookie is self-contained.

### Library choice

[`openid-client`](https://github.com/panva/openid-client) — pure-Node, framework-agnostic, the maintained reference OIDC client. Used for:

- Discovery (`Issuer.discover(issuerUrl)`)
- Building the authorize URL with PKCE
- Token exchange and ID token verification

One new npm dependency. No changes to other channels.

## Configuration

All env vars are namespaced `OAUTH_WEBCHAT_*`. The skill manifest declares them in `env_additions`.

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `OAUTH_WEBCHAT_PORT` | no | `4080` | Listen port (channel binds inside the pod; Service/Ingress maps externally) |
| `OAUTH_WEBCHAT_PUBLIC_URL` | yes | — | External base URL with scheme, e.g., `https://chat.example.com`. Used to construct the OAuth redirect URI as `<public-url>/callback`. Channel refuses to start if missing. |
| `OAUTH_WEBCHAT_OIDC_ISSUER` | yes | — | OIDC issuer URL, e.g., `https://accounts.google.com`. Discovery URL is `<issuer>/.well-known/openid-configuration`. |
| `OAUTH_WEBCHAT_CLIENT_ID` | yes | — | OAuth client ID from the provider |
| `OAUTH_WEBCHAT_CLIENT_SECRET` | yes | — | OAuth client secret from the provider |
| `OAUTH_WEBCHAT_ALLOWED_EMAILS` | yes | — | Comma-separated allowlist; entries are full emails (`alice@example.com`) or domain wildcards (`@example.com`). Channel refuses to start if empty. |
| `OAUTH_WEBCHAT_COOKIE_SECRET` | yes | — | Random ≥32-byte string for HMAC. Channel refuses to start if missing or shorter than 32 bytes. Operator generates with `openssl rand -base64 32`. |
| `OAUTH_WEBCHAT_SESSION_TTL_DAYS` | no | `30` | Session cookie lifetime |
| `OAUTH_WEBCHAT_SCOPES` | no | `openid email profile` | OIDC scopes requested |
| `OAUTH_WEBCHAT_PROVIDER_NAME` | no | `OIDC` | Display name used on the login page button ("Sign in with `<name>`") |

### Allowlist matching rules

- Case-insensitive on both email and entries
- Each entry is either a full email or `@domain` for a domain wildcard
- ID token must include `email` and `email_verified === true`; otherwise reject
- An email matches if any entry equals it exactly OR any wildcard entry's domain part equals the email's domain

## Channel-pod integration

In `KUBECLAW_MODE=channel`, the existing channel-runner machinery handles auto-registration of new chats: when the channel calls `opts.onChatMetadata(jid, timestamp, email, 'oauth-webchat', false)` for a never-seen JID, the runner registers a group folder with `direct: true` LLM mode. No new orchestrator code is required for this path — it reuses the same `onChatMetadata` flow that the HTTP channel uses today.

## Capabilities

```ts
readonly capabilities: ChannelCapabilities = {
  inboundImages: true,
  outboundMedia: true,
};
```

`sendMessage`, `sendMedia`, `disconnect`, `isConnected`, and `ownsJid` mirror the HTTP channel's implementations, keyed on `oauth-webchat:` JIDs. The SSE outbound stream and multipart image upload reuse the same approach as `http.ts`.

## UI

Two HTML pages served inline as string constants in `oauth-webchat.ts`, matching the existing `CHAT_HTML` pattern in `http.ts`.

### `/login` page

Single button: "Sign in with `<OAUTH_WEBCHAT_PROVIDER_NAME>`". Submits as a GET to `/login/start`. No other content. Plain styling consistent with the chat UI.

### `/` chat page

Same UI as `http.ts`'s `CHAT_HTML`, with two changes:

1. Header strip shows `Signed in as <email>` and a `Logout` link to `/logout`.
2. The Basic Auth assumption is replaced by cookie auth — `fetch(..., { credentials: 'include' })` and `EventSource(..., { withCredentials: true })` already do the right thing once the cookie exists.

The chat HTML and SSE/upload plumbing are duplicated from `http.ts` rather than extracted into a shared module. See "Code-sharing decision" below.

## Code-sharing decision

The chat HTML, multipart parsing, SSE client tracking, and inbound image handling total ~300 lines of code that would be near-identical between `http.ts` and `oauth-webchat.ts`. **The design duplicates these rather than extracting them.**

Rationale:

- Two copies of stable code is not a real maintenance cost; both channels are already self-contained.
- A premature shared module creates a real coupling between two skills — deleting one risks breaking the other.
- Surrounding code style in `src/channels/` is already self-contained per channel (`telegram.ts`, `discord.ts`, `slack.ts`, etc. each own their full implementation).
- If a third web-style channel ever appears, extraction becomes worth it. Until then, YAGNI.

## Setup integration

`src/skills/orchestrator/channel-setup.ts` is extended with:

1. **`buildSecretData()`** — new branch:
   ```ts
   if (type === 'oauth-webchat') {
     // map ChannelSetupInput fields to OAUTH_WEBCHAT_* keys
   }
   ```
2. **`validateChannelCredentials()`** — new branch that does an HTTP GET to `<issuer>/.well-known/openid-configuration` with a 10-second timeout and asserts the response is JSON containing `authorization_endpoint` and `token_endpoint`. Analogous to the `getMe` check for Telegram.
3. **`ChannelSetupInput`** in `src/skills/orchestrator/types.ts` gains optional fields for the new env vars (`oidcIssuer`, `clientId`, `clientSecret`, `allowedEmails`, `publicUrl`, `cookieSecret`, optionally `sessionTtlDays`, `scopes`, `providerName`).

The channel deployment otherwise follows the same shape as other channels: same image, same `KUBECLAW_MODE=channel` runner, same PVC layout, same Redis/OpenAI env wiring.

## Operator deployment requirements

Documented in the skill README. The operator must:

1. **Register an OAuth client** with their OIDC provider, redirect URI = `<OAUTH_WEBCHAT_PUBLIC_URL>/callback`.
2. **Expose the channel pod externally over HTTPS.** The skill ships only a `ClusterIP` Service. The operator brings their own Ingress, Cloudflare Tunnel, Tailscale Funnel, or equivalent. The channel itself never terminates TLS — it trusts the proxy. The proxy must preserve the original `Host` header so the redirect URI matches what was registered.
3. **Generate `OAUTH_WEBCHAT_COOKIE_SECRET`** with `openssl rand -base64 32`.

The skill installer (orchestrator add-oauth-webchat path) prompts for these values and surfaces the redirect URI string the operator needs to paste into their provider's console.

## Skill packaging

This channel is a **built-in** channel: implementation ships in `src/channels/oauth-webchat.ts` and is imported from `src/channels/index.ts` like the existing `http` and `irc` channels. There is no external manifest pipeline involved — `skills/channel/oauth-webchat.md` is a single markdown doc with frontmatter that describes the channel for operators (mirroring `skills/channel/http.md` and `skills/channel/irc.md`).

`skills/channel/oauth-webchat.md` frontmatter shape (matching `skills/channel/irc.md`):

```yaml
---
name: oauth-webchat
description: OAuth/OIDC web chat channel
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
```

The `openid-client` npm dependency is added directly to `package.json`.

## Testing

Per `CLAUDE.md`'s three-level rule.

### Unit (`src/channels/oauth-webchat.test.ts`)

- Cookie sign / verify round-trip, including: tampered payload rejected, expired cookie rejected, wrong-secret cookie rejected, valid cookie accepted.
- Allowlist matching: exact email match, domain wildcard match, case-insensitivity on both sides, `email_verified=false` rejected, missing `email` claim rejected, unmatched email rejected.
- `ownsJid('oauth-webchat:foo@bar')` returns true; `ownsJid('http:foo')` returns false.
- JID-to-folder via `folderPrefixForChannel('oauth-webchat')` returns `oauth`.
- Config parser: missing required env vars cause `null` return (channel auto-disable); short cookie secret causes `null` return.

### Integration

Spin up the channel server bound to `127.0.0.1:0` with a fake OIDC issuer (a separate in-process Node `http` server that serves `/.well-known/openid-configuration`, `/authorize`, `/token`, `/jwks` with a static RSA keypair). Drive the full flow with a Node HTTP client that follows redirects manually:

- `GET /` → 302 to `/login`
- `GET /login/start` → 302 to fake `/authorize`, state cookie set
- `GET /callback?code=...&state=...` → 302 to `/`, session cookie set
- `GET /` with cookie → 200 with chat HTML
- `POST /message` with cookie → message lands in `onMessage` callback
- `GET /stream` with cookie → SSE stream receives `sendMessage` payloads
- `GET /logout` → cookie cleared

Rejection paths covered:

- bad `state` → 400
- expired session cookie → redirect to `/login`
- non-allowlisted email → 403 with logged email
- `email_verified=false` → 403

### End-to-end

`validateChannelCredentials('oauth-webchat', { OAUTH_WEBCHAT_OIDC_ISSUER: 'https://accounts.google.com' })` hits a real OIDC discovery URL (Google's, since it is stable, public, and requires no credentials) and confirms the validation returns null. This is the only e2e signal — full browser-driven login through a real provider is deferred to manual smoke testing because it requires real client credentials and a publicly reachable callback URL.

If a future change inside this channel genuinely doesn't apply at the e2e level, the implementer states so explicitly per `CLAUDE.md`.

## Open questions

None at design time. Implementation may surface OIDC-library-specific quirks (notably around PKCE state encoding and Google's `email_verified` behavior for non-Workspace accounts) — those are implementation details, not design decisions.
