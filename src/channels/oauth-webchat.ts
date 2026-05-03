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

function verifyStateCookie(
  cookie: string,
  secret: string,
): StatePayload | null {
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

export class OAuthWebchatChannel implements Channel {
  name = 'oauth-webchat';
  readonly capabilities: ChannelCapabilities = {
    inboundImages: true,
    outboundMedia: true,
  };

  private opts: OAuthWebchatChannelOpts;
  private config: OAuthWebchatConfig;
  private server: Server | null = null;
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

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // Implemented in a later task
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
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

    if (req.method === 'GET' && url.pathname === '/callback') {
      const cookies = parseCookies(req.headers.cookie);
      const stateRaw = cookies[STATE_COOKIE];
      if (!stateRaw) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing state cookie');
        return;
      }
      const statePayload = verifyStateCookie(
        stateRaw,
        this.config.cookieSecret,
      );
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
          checks: {
            state: statePayload.state,
            code_verifier: statePayload.codeVerifier,
          },
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
          exp:
            Math.floor(Date.now() / 1000) + this.config.sessionTtlDays * 86400,
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

    if (req.method === 'GET' && url.pathname === '/logout') {
      res.writeHead(302, {
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
        Location: '/login',
      });
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
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

export function getSessionFromCookies(
  cookies: Record<string, string>,
  secret: string,
): SessionPayload | null {
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  return verifySessionCookie(raw, secret);
}
