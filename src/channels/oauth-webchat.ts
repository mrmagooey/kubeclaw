import crypto from 'node:crypto';

export interface SessionPayload {
  email: string;
  /** Unix epoch seconds */
  exp: number;
}

export function signSessionCookie(
  payload: SessionPayload,
  secret: string,
): string {
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

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payloadBytes)
    .digest();
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

import { Issuer, type Client as OidcLibClient } from 'openid-client';
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
    logger.warn(
      'oauth-webchat: OAUTH_WEBCHAT_ALLOWED_EMAILS produced no entries',
    );
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
    sessionTtlDays: parseInt(
      envOr(file, 'OAUTH_WEBCHAT_SESSION_TTL_DAYS') || '30',
      10,
    ),
    scopes: envOr(file, 'OAUTH_WEBCHAT_SCOPES') || 'openid email profile',
    providerName: envOr(file, 'OAUTH_WEBCHAT_PROVIDER_NAME') || 'OIDC',
  };
}

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
