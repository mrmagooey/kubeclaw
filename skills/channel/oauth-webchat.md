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
