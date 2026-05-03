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
  private sseClients: Array<{ email: string; res: ServerResponse }> = [];

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

    if (req.method === 'GET' && url.pathname === '/logout') {
      res.writeHead(302, {
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
        Location: '/login',
      });
      res.end();
      return;
    }

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
