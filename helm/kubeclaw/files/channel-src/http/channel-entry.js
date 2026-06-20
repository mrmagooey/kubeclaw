import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { createServer } from 'node:http';
import path from 'node:path';

const MAX_MULTIPART_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_SECRETS_BODY_SIZE = 64 * 1024; // 64 KiB
const MAX_MEMORY_BODY_SIZE = 1 * 1024 * 1024; // 1 MiB cap for PUT/PATCH /memory

// Candidate IDs: timestamp-hrtime-slug, e.g. "1714059600000-1a2b3c-my-skill"
const CANDIDATE_ID_RE = /^[a-z0-9][-a-z0-9_]{0,255}$/;

const MEDIA_MAGIC = [
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png' },
  { bytes: [0x47, 0x49, 0x46], mime: 'image/gif' },
];

export async function getAttachmentUsage(attachDir) {
  let entries;
  try {
    entries = await fsPromises.readdir(attachDir);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { count: 0, bytes: 0 };
    }
    throw err;
  }

  let bytes = 0;
  let fileCount = 0;
  for (const entry of entries) {
    try {
      const st = await fsPromises.stat(path.join(attachDir, entry));
      if (st.isFile()) {
        bytes += st.size;
        fileCount += 1;
      }
    } catch {
      // Ignore entries that disappear between readdir and stat
    }
  }

  return { count: fileCount, bytes };
}

export function detectMediaType(buffer) {
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  for (const sig of MEDIA_MAGIC) {
    if (sig.bytes.every((b, i) => buffer[i] === b)) return sig.mime;
  }
  return null;
}

function parseMultipart(body, boundary) {
  const parts = [];
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
    let filename;
    let contentType;

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

function getChatHtml(assistantName) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${assistantName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f5f5f5; height: 100dvh; display: flex; flex-direction: column; }
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
<div id="messages"></div>
<div id="status">Connecting…</div>
<div id="preview-area"></div>
<form id="form">
  <label id="attach-label" title="Attach image">📎<input id="file-input" type="file" accept="image/*"></label>
  <textarea id="input" placeholder="Message ${assistantName}…" rows="1"></textarea>
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

// SSE for incoming assistant messages
const es = new EventSource('/stream', { withCredentials: true });
es.onopen = () => { status.textContent = 'Connected'; };
es.onmessage = (e) => {
  addMsg(e.data, 'assistant');
};
es.onerror = () => { status.textContent = 'Reconnecting…'; };

// File picker preview
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

// Auto-grow textarea
input.addEventListener('input', () => {
  input.style.height = '2.5rem';
  input.style.height = Math.min(input.scrollHeight, 128) + 'px';
});

// Submit on Enter (Shift+Enter for newline)
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
}

/** Build the JSON payload for GET /version. Exported for unit testing. */
export function buildVersionPayload(sdk) {
  return {
    version: process.env.KUBECLAW_VERSION ?? 'dev',
    model: sdk.config.defaultModel ?? null,
    rateLimitWindowMs: Number.isFinite(sdk.config.rateLimitWindowMs) ? sdk.config.rateLimitWindowMs : null,
    toolJobsRetentionDays: Number.isFinite(sdk.config.toolJobsRetentionDays) ? sdk.config.toolJobsRetentionDays : null,
  };
}

export class HttpChannel {
  name = 'http';
  capabilities = {
    inboundImages: true,
    outboundMedia: true,
  };

  static CORS_PATH_METHODS = {
    '/': ['GET'],
    '/healthz': ['GET', 'HEAD'],
    '/readyz': ['GET', 'HEAD'],
    '/version': ['GET', 'HEAD'],
    '/whoami': ['GET', 'HEAD'],
    '/stream': ['GET'],
    '/message/rate-limit': ['GET', 'HEAD'],
    '/message': ['POST'],
    '/history': ['GET', 'DELETE'],
    '/history/': ['GET', 'HEAD', 'DELETE', 'PATCH'],
    '/attachments/list': ['GET'],
    '/attachments/raw/': ['GET', 'HEAD', 'DELETE'],
    '/export': ['GET', 'HEAD'],
    '/jobs': ['GET', 'HEAD'],
    '/jobs/': ['GET', 'HEAD', 'DELETE'],
    '/schedule': ['GET', 'HEAD', 'POST'],
    '/schedule/': ['DELETE', 'PATCH', 'HEAD', 'GET'],
    '/capabilities': ['GET', 'HEAD'],
    '/search': ['GET', 'HEAD'],
    '/secrets': ['GET', 'HEAD', 'POST'],
    '/secrets/': ['DELETE', 'HEAD'],
    '/secrets/catalog': ['GET', 'HEAD'],
    '/memory': ['GET', 'HEAD', 'PUT', 'PATCH'],
    '/skills': ['GET', 'HEAD'],
    '/skills/': ['POST'],
    '/diag': ['GET', 'HEAD'],
    '/audit': ['GET', 'HEAD'],
    '/debug/tool-jobs/inject': ['POST'],
  };

  constructor(config, opts, sdk) {
    this.config = config;
    this.opts = opts;
    this.sdk = sdk;
    this.server = null;
    this.processStartMs = Date.now();
    this.sseClients = [];
    this.messageSeq = 0;
    this.rateBuckets = new Map();

    // checkDb returns 'ok' by default; the real probe is host-injected via opts.checkDb (the channel-runner wires it).
    this.checkDb = opts.checkDb ?? (() => { return 'ok'; });
    this.checkRedis = opts.checkRedis ?? (async () => {
      throw new Error('http adapter: checkRedis must be injected via channel opts by the host');
    });

    this.killJobFn = opts.killJobFn ?? (async () => {
      throw new Error('http adapter: killJobFn must be injected via channel opts by the host');
    });
  }

  consumeRateLimit(username, nowMs = Date.now()) {
    const capacity = this.config.perUserMessagesPerMinute ?? 0;
    if (capacity === 0) return { allowed: true };

    const refillRatePerMs = capacity / 60_000;

    let bucket = this.rateBuckets.get(username);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefillMs: nowMs };
      this.rateBuckets.set(username, bucket);
    }

    const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillRatePerMs);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterSeconds = Math.ceil(tokensNeeded / refillRatePerMs / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  peekRateLimit(username, nowMs = Date.now()) {
    const capacity = this.config.perUserMessagesPerMinute ?? 0;
    if (capacity === 0) {
      return { limit: null, remaining: null, resetInSeconds: null };
    }

    const refillRatePerMs = capacity / 60_000;

    const bucket = this.rateBuckets.get(username);
    let currentTokens;
    if (!bucket) {
      currentTokens = capacity;
    } else {
      const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
      currentTokens = Math.min(capacity, bucket.tokens + elapsed * refillRatePerMs);
    }

    const remaining = Math.floor(currentTokens);

    const tokensNeeded = capacity - currentTokens;
    const resetInSeconds = tokensNeeded <= 0 ? 0 : Math.ceil(tokensNeeded / refillRatePerMs / 1000);

    return {
      limit: capacity,
      remaining,
      resetInSeconds: Math.min(resetInSeconds, 60),
    };
  }

  get maxAttachmentCount() {
    return this.opts.maxAttachmentCount ?? this.config.maxAttachmentCount ?? 0;
  }

  get maxAttachmentBytes() {
    return this.opts.maxAttachmentBytes ?? this.config.maxAttachmentBytes ?? 0;
  }

  async connect() {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.sdk.logger.error({ err }, 'Unhandled error in HTTP request handler');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      });
    });

    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, () => {
        const users = Object.keys(this.config.users);
        this.sdk.logger.info({ port: this.config.port, users }, 'HTTP channel listening');
        console.log(`\n  HTTP chat: http://localhost:${this.config.port}`);
        console.log(`  Users: ${users.join(', ')}`);
        console.log(`  Register each user as a group with JID: http:{username}\n`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  authenticate(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Basic ')) return null;

    const b64 = authHeader.slice('Basic '.length);
    let decoded;
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      return null;
    }

    const colon = decoded.indexOf(':');
    if (colon === -1) return null;

    const username = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);

    if (this.config.users[username] === password) return username;
    return null;
  }

  sendUnauthorized(res) {
    res.writeHead(401, {
      'WWW-Authenticate': `Basic realm="${this.sdk.assistantName}"`,
      'Content-Type': 'text/plain',
    });
    res.end('Unauthorized');
  }

  addCorsHeaders(headers) {
    return {
      ...headers,
      'Access-Control-Allow-Origin': this.config.corsOrigin ?? '*',
    };
  }

  async handleRequest(req, res) {
    const rawUrl = req.url ?? '/';
    if (rawUrl.includes('..')) {
      res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Bad Request');
      return;
    }

    const url = new URL(rawUrl, `http://localhost:${this.config.port}`);

    if (req.method === 'OPTIONS') {
      let allowedMethods = HttpChannel.CORS_PATH_METHODS[url.pathname];
      if (!allowedMethods && url.pathname.startsWith('/attachments/raw/')) {
        allowedMethods = HttpChannel.CORS_PATH_METHODS['/attachments/raw/'];
      }
      if (!allowedMethods && /^\/history\/[^/]+$/.test(url.pathname)) {
        allowedMethods = HttpChannel.CORS_PATH_METHODS['/history/'];
      }
      if (!allowedMethods && /^\/jobs\/[^/]+$/.test(url.pathname)) {
        allowedMethods = HttpChannel.CORS_PATH_METHODS['/jobs/'];
      }
      if (!allowedMethods && /^\/schedule\/[^/]+\/runs$/.test(url.pathname)) {
        allowedMethods = HttpChannel.CORS_PATH_METHODS['/schedule/'];
      }
      if (!allowedMethods && /^\/schedule\/[^/]+$/.test(url.pathname)) {
        allowedMethods = HttpChannel.CORS_PATH_METHODS['/schedule/'];
      }
      if (
        !allowedMethods &&
        /^\/secrets\/[^/]+$/.test(url.pathname) &&
        url.pathname !== '/secrets/catalog'
      ) {
        allowedMethods = HttpChannel.CORS_PATH_METHODS['/secrets/'];
      }
      if (
        !allowedMethods &&
        /^\/skills\/candidates\/[^/]+\/(accept|reject)$/.test(url.pathname)
      ) {
        allowedMethods = HttpChannel.CORS_PATH_METHODS['/skills/'];
      }

      const methodsList = allowedMethods ? allowedMethods.join(', ') : 'GET, POST, DELETE';

      res.writeHead(204, {
        'Access-Control-Allow-Origin': this.config.corsOrigin,
        'Access-Control-Allow-Methods': methodsList,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    if (url.pathname === '/healthz') {
      if (req.method === 'GET') {
        const uptime_ms = Date.now() - this.processStartMs;
        const body = JSON.stringify({ status: 'ok', uptime_ms });
        res.writeHead(200, this.addCorsHeaders({
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'Cache-Control': 'no-store',
        }));
        res.end(body);
        return;
      }
      if (req.method === 'HEAD') {
        const uptime_ms = Date.now() - this.processStartMs;
        const body = JSON.stringify({ status: 'ok', uptime_ms });
        res.writeHead(200, this.addCorsHeaders({
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'Cache-Control': 'no-store',
        }));
        res.end();
        return;
      }
    }

    if (url.pathname === '/readyz') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const dbResult = this.checkDb();
        const redisResult = await this.checkRedis();
        const allOk = dbResult === 'ok' && redisResult === 'ok';
        const statusCode = allOk ? 200 : 503;
        const responseBody = {
          status: allOk ? 'ready' : 'not_ready',
          checks: { db: dbResult, redis: redisResult },
        };
        const body = JSON.stringify(responseBody);
        res.writeHead(statusCode, this.addCorsHeaders({
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'Cache-Control': 'no-store',
        }));
        if (req.method === 'HEAD') {
          res.end();
        } else {
          res.end(body);
        }
        return;
      }
    }

    if (url.pathname === '/version') {
      if (req.method === 'GET') {
        const body = JSON.stringify(buildVersionPayload(this.sdk));
        res.writeHead(200, this.addCorsHeaders({
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'Cache-Control': 'no-store',
        }));
        res.end(body);
        return;
      }
      if (req.method === 'HEAD') {
        const body = JSON.stringify(buildVersionPayload(this.sdk));
        res.writeHead(200, this.addCorsHeaders({
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'Cache-Control': 'no-store',
        }));
        res.end();
        return;
      }
    }

    if (url.pathname === '/whoami') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: 'GET, HEAD',
        }));
        res.end('Method Not Allowed');
        return;
      }

      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const group = `http:${username}`;
      const registered = this.opts.registeredGroups()[group];
      const group_folder = registered?.folder ?? '';
      const payload = { username, group, group_folder };
      const body = JSON.stringify(payload);
      res.writeHead(200, this.addCorsHeaders({
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'Cache-Control': 'no-store',
      }));
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      res.writeHead(200, this.addCorsHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      }));
      res.end(getChatHtml(this.sdk.assistantName));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/stream') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      res.writeHead(200, this.addCorsHeaders({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      }));
      res.write(':ok\n\n');

      const lastEventIdHeader = req.headers['last-event-id'];
      if (lastEventIdHeader) {
        const lastEventIdMs = Number(lastEventIdHeader);
        const maxAgeMs = 24 * 60 * 60 * 1000;
        if (Number.isFinite(lastEventIdMs) && Date.now() - lastEventIdMs <= maxAgeMs) {
          const jid = `http:${username}`;
          const sinceIso = new Date(lastEventIdMs).toISOString();
          try {
            const missed = this.sdk.history.getOutboundSince(jid, sinceIso, 200);
            for (const msg of missed) {
              const msgIdMs = new Date(msg.timestamp).getTime();
              const lines = msg.content.split('\n');
              const payload = `id: ${msgIdMs}\n` + lines.map((l) => `data: ${l}`).join('\n') + '\n\n';
              if (!res.writableEnded) res.write(payload);
            }
          } catch (err) {
            this.sdk.logger.warn({ err, username }, 'SSE catch-up query failed');
          }
        }
      }

      const client = { username, res };
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

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/message/rate-limit') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const peek = this.peekRateLimit(username);
      const body = JSON.stringify(peek);
      res.writeHead(200, this.addCorsHeaders({
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'Cache-Control': 'no-store',
      }));
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/message') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const rl = this.consumeRateLimit(username);
      if (!rl.allowed) {
        res.writeHead(429, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          'Retry-After': String(rl.retryAfterSeconds),
        }));
        res.end('Too Many Requests');
        return;
      }

      const contentType = (req.headers['content-type'] ?? '').toLowerCase();

      if (!contentType.startsWith('application/json') && !contentType.startsWith('multipart/form-data')) {
        res.writeHead(415, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Unsupported Media Type');
        return;
      }

      const chunks = [];
      let totalSize = 0;

      req.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > MAX_MULTIPART_SIZE) {
          res.writeHead(413, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Payload too large');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        void (async () => {
          try {
            const body = Buffer.concat(chunks);

            if (contentType.startsWith('multipart/form-data')) {
              const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
              if (!boundaryMatch) {
                res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
                res.end('Missing boundary');
                return;
              }
              const boundary = boundaryMatch[1];
              const parts = parseMultipart(body, boundary);

              const textPart = parts.find((p) => p.name === 'text');
              const imagePart = parts.find((p) => p.name === 'image');

              if (!imagePart) {
                res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
                res.end('Missing image');
                return;
              }

              const mime = detectMediaType(imagePart.data);
              if (!mime) {
                res.writeHead(415, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
                res.end('Unsupported image format');
                return;
              }

              const jid = `http:${username}`;
              this.opts.onChatMetadata(jid, new Date().toISOString(), username, 'http', false);
              const group = this.opts.registeredGroups()[jid];
              if (!group) {
                this.sdk.logger.debug({ jid }, 'HTTP image from unregistered user');
                res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
                res.end(JSON.stringify({ id: null }));
                return;
              }

              const ext = mime.split('/')[1].replace('jpeg', 'jpg');
              const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
              const attachDir = path.join(this.sdk.groupsDir, jid, 'attachments', 'raw');

              const usage = await getAttachmentUsage(attachDir);
              if (this.maxAttachmentCount > 0 && usage.count >= this.maxAttachmentCount) {
                res.writeHead(413, { 'Content-Type': 'text/plain' });
                res.end(`Attachment limit reached (max ${this.maxAttachmentCount})`);
                return;
              }
              if (this.maxAttachmentBytes > 0 && usage.bytes + imagePart.data.length > this.maxAttachmentBytes) {
                res.writeHead(413, { 'Content-Type': 'text/plain' });
                res.end('Attachment storage limit reached');
                return;
              }

              fs.mkdirSync(attachDir, { recursive: true });
              fs.writeFileSync(path.join(attachDir, filename), imagePart.data);

              const caption = textPart?.data.toString('utf8').trim() ?? '';
              const marker = caption
                ? `[ImageAttachment: attachments/raw/${filename} caption="${caption}"]`
                : `[ImageAttachment: attachments/raw/${filename}]`;
              this.sdk.history.append(group.folder, 'user', marker);
              const attachMsgId = this.handleInbound(username, marker);

              res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
              res.end(JSON.stringify({ id: attachMsgId, attachment: filename }));
              return;
            }

            // JSON text message
            try {
              const { text } = JSON.parse(body.toString('utf8'));
              if (!text?.trim()) {
                res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
                res.end('Missing text');
                return;
              }
              const msgId = this.handleInbound(username, text.trim());
              res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
              res.end(JSON.stringify({ id: msgId }));
            } catch {
              res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
              res.end('Invalid JSON');
            }
          } catch (err) {
            this.sdk.logger.error({ err }, 'POST /message handler error after body received');
            if (!res.writableEnded) {
              try {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
              } catch {
                /* response already partially written, nothing to do */
              }
            }
          }
        })();
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/attachments/list') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      const jid = `http:${username}`;
      const attachDir = path.join(this.sdk.groupsDir, jid, 'attachments', 'raw');
      let entries;
      try {
        const names = await fsPromises.readdir(attachDir);
        entries = await Promise.all(
          names.map(async (name) => {
            const st = await fsPromises.stat(path.join(attachDir, name));
            return { filename: name, size: st.size, modifiedAt: st.mtime.toISOString() };
          }),
        );
      } catch (err) {
        if (err?.code === 'ENOENT') {
          entries = [];
        } else {
          this.sdk.logger.error({ err, attachDir }, 'GET /attachments/list failed');
          res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Internal server error' }));
          return;
        }
      }
      res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify(entries));
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/attachments/raw/')) {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const filename = url.pathname.slice('/attachments/raw/'.length);

      if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Bad Request');
        return;
      }

      const jid = `http:${username}`;
      const attachDir = path.join(this.sdk.groupsDir, jid, 'attachments', 'raw');
      const filePath = path.join(attachDir, filename);

      let fileData;
      try {
        fileData = fs.readFileSync(filePath);
      } catch (err) {
        if (err?.code === 'ENOENT') {
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Not Found');
        } else {
          this.sdk.logger.error({ err, filePath }, 'GET /attachments/raw failed');
          res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Internal Server Error');
        }
        return;
      }

      const ext = path.extname(filename).toLowerCase();
      const extMime = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      };
      const contentType = extMime[ext] ?? detectMediaType(fileData) ?? 'application/octet-stream';

      res.writeHead(200, this.addCorsHeaders({
        'Content-Type': contentType,
        'Content-Length': String(fileData.length),
        'Cache-Control': 'private, max-age=3600',
      }));
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(fileData);
      }
      return;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/attachments/raw/')) {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const filename = url.pathname.slice('/attachments/raw/'.length);

      if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Bad Request');
        return;
      }

      const jid = `http:${username}`;
      const attachDir = path.join(this.sdk.groupsDir, jid, 'attachments', 'raw');
      const filePath = path.join(attachDir, filename);

      fs.unlink(filePath, (err) => {
        if (!err) {
          res.writeHead(204, this.addCorsHeaders({}));
          res.end();
        } else if (err.code === 'ENOENT') {
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Not Found');
        } else {
          this.sdk.logger.error({ err, filePath }, 'DELETE /attachments/raw failed');
          res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Internal Server Error');
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/history') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Group not found' }));
        return;
      }

      const rawLimit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20;
      const before = url.searchParams.get('before') ?? undefined;

      try {
        const messages = this.sdk.history.getPage(group.folder, { limit, before: before ?? undefined });
        res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ messages }));
      } catch (err) {
        this.sdk.logger.error({ err, jid }, 'GET /history failed');
        res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/history') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Group not found' }));
        return;
      }

      const beforeParam = url.searchParams.get('before');
      if (beforeParam !== null) {
        const d = new Date(beforeParam);
        if (!Number.isFinite(d.getTime())) {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'before must be a valid ISO-8601 timestamp' }));
          return;
        }
        try {
          const deleted = this.sdk.history.deleteBefore(group.folder, d);
          try {
            this.sdk.audit.write({
              groupFolder: group.folder,
              actor: username,
              action: 'history.purge',
              detail: `before=${beforeParam}, deleted=${deleted}`,
            });
          } catch (auditErr) {
            this.sdk.logger.error({ err: auditErr, jid }, 'Audit write failed for history.purge');
          }
          res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ deleted }));
        } catch (err) {
          this.sdk.logger.error({ err, jid }, 'DELETE /history?before= failed');
          res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
      }

      try {
        this.sdk.history.clear(group.folder);
        try {
          this.sdk.audit.write({ groupFolder: group.folder, actor: username, action: 'history.clear' });
        } catch (auditErr) {
          this.sdk.logger.error({ err: auditErr, jid }, 'Audit write failed for history.clear');
        }
        res.writeHead(204, this.addCorsHeaders({}));
        res.end();
      } catch (err) {
        this.sdk.logger.error({ err, jid }, 'DELETE /history failed');
        res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }

    const historyIdMatch = url.pathname.match(/^\/history\/([^/]+)$/);
    if (historyIdMatch) {
      const method = req.method ?? '';
      if (!['GET', 'HEAD', 'DELETE', 'PATCH'].includes(method)) {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: 'GET, HEAD, DELETE, PATCH',
        }));
        res.end('Method Not Allowed');
        return;
      }
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Group not found' }));
        return;
      }
      const msgId = historyIdMatch[1];

      if (method === 'PATCH') {
        const MAX_PATCH_BODY = 256 * 1024;
        const chunks = [];
        let totalSize = 0;
        let tooLarge = false;

        req.on('data', (chunk) => {
          if (tooLarge) return;
          totalSize += chunk.length;
          if (totalSize > MAX_PATCH_BODY) {
            tooLarge = true;
            res.writeHead(413, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'Payload too large' }));
            req.resume();
            return;
          }
          chunks.push(chunk);
        });

        req.on('end', () => {
          if (tooLarge) return;
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }
          if (typeof parsed !== 'object' || parsed === null || typeof parsed.content !== 'string') {
            res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'content must be a string' }));
            return;
          }
          const newContent = parsed.content;
          const updated = this.sdk.history.update(msgId, newContent, group.folder);
          if (!updated) {
            res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
          }
          const row = this.sdk.history.getById(msgId, group.folder);
          if (!row) {
            res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
          }
          const body = JSON.stringify(row);
          res.writeHead(200, this.addCorsHeaders({
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
          }));
          res.end(body);
        });
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        const row = this.sdk.history.getById(msgId, group.folder);
        if (!row) {
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          if (method === 'GET') {
            res.end(JSON.stringify({ error: 'Not found' }));
          } else {
            res.end();
          }
          return;
        }
        const body = JSON.stringify(row);
        res.writeHead(200, this.addCorsHeaders({
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        }));
        if (method === 'HEAD') {
          res.end();
        } else {
          res.end(body);
        }
        return;
      }

      const deleted = this.sdk.history.deleteById(msgId, group.folder);
      if (deleted) {
        try {
          this.sdk.audit.write({ groupFolder: group.folder, actor: username, action: 'history.delete', target: msgId });
        } catch (auditErr) {
          this.sdk.logger.error({ err: auditErr, msgId }, 'Audit write failed for history.delete');
        }
        res.writeHead(204, this.addCorsHeaders({}));
        res.end();
        return;
      }
      const otherGroup = this.sdk.history.groupFolderForMessage(msgId);
      if (otherGroup != null) {
        res.writeHead(403, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Forbidden' }));
      } else {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Not found' }));
      }
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/export') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Group not found' }));
        return;
      }
      const date = new Date().toISOString().slice(0, 10);
      const filename = `kubeclaw-export-${group.folder}-${date}.ndjson`;
      res.writeHead(200, this.addCorsHeaders({
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': `attachment; filename="${filename}"`,
      }));
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      try {
        const rows = this.sdk.history.getAll(group.folder, username);
        for (const row of rows) {
          res.write(JSON.stringify(row) + '\n');
        }
        res.end();
      } catch (err) {
        this.sdk.logger.error({ err, jid }, 'GET /export failed mid-stream');
        res.end();
      }
      return;
    }

    const jobsIdMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (jobsIdMatch) {
      const method = req.method ?? '';
      if (!['GET', 'HEAD', 'DELETE'].includes(method)) {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: 'GET, HEAD, DELETE',
        }));
        res.end('Method Not Allowed');
        return;
      }

      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      const groupFolder = group?.folder ?? jid;
      const jobId = jobsIdMatch[1];

      const job = this.sdk.jobs.byIdForGroup(jobId, groupFolder);

      if (method === 'GET' || method === 'HEAD') {
        if (!job) {
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          if (method === 'GET') {
            res.end(JSON.stringify({ error: 'Not found' }));
          } else {
            res.end();
          }
          return;
        }
        const payload = {
          job_id: job.job_id,
          specialist_name: job.specialist_name,
          status: job.status,
          created_at: job.created_at,
          resolved_at: job.resolved_at,
        };
        const body = JSON.stringify(payload);
        res.writeHead(200, this.addCorsHeaders({
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        }));
        if (method === 'HEAD') {
          res.end();
        } else {
          res.end(body);
        }
        return;
      }

      if (!job) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      if (job.status !== 'active') {
        res.writeHead(409, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'not_active', current_status: job.status }));
        return;
      }
      try {
        const result = await this.killJobFn(jobId, groupFolder);
        if (!result.ok) {
          if (result.status === 'not_found') {
            res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
          }
          if (result.status === 'not_active') {
            res.writeHead(409, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'not_active', current_status: result.currentStatus ?? job.status }));
            return;
          }
          res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: result.error ?? 'kill failed' }));
          return;
        }
        try {
          this.sdk.audit.write({ groupFolder, actor: username, action: 'job.kill', target: jobId });
        } catch (auditErr) {
          this.sdk.logger.error({ err: auditErr, jobId }, 'Audit write failed for job.kill');
        }
        res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ status: 'cancelled', job_id: jobId }));
      } catch (err) {
        this.sdk.logger.error({ err, jobId, groupFolder }, 'DELETE /jobs/<id> kill failed');
        res.writeHead(504, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'IPC timeout — orchestrator did not respond' }));
      }
      return;
    }

    if (url.pathname === '/jobs') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: 'GET, HEAD',
        }));
        res.end('Method Not Allowed');
        return;
      }

      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const statusParam = url.searchParams.get('status');
      if (statusParam !== null && statusParam !== 'active' && statusParam !== 'completed') {
        res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Invalid status parameter. Must be "active" or "completed".' }));
        return;
      }

      const limitParam = url.searchParams.get('limit');
      let limit = 20;
      if (limitParam !== null) {
        const parsed = Number(limitParam);
        if (Number.isFinite(parsed) && parsed >= 1) {
          limit = Math.min(Math.floor(parsed), 100);
        }
      }

      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      const groupFolder = group?.folder ?? jid;

      let jobs;
      if (statusParam === 'active') {
        jobs = this.sdk.jobs.active().filter((j) => j.group_folder === groupFolder);
      } else {
        jobs = this.sdk.jobs.recentForGroup(groupFolder, limit);
      }

      const payload = jobs.map((j) => ({
        job_id: j.job_id,
        specialist_name: j.specialist_name,
        status: j.status,
        created_at: j.created_at,
        resolved_at: j.resolved_at,
      }));

      const body = JSON.stringify(payload);
      const headers = this.addCorsHeaders({
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Content-Length': String(Buffer.byteLength(body)),
      });

      if (req.method === 'HEAD') {
        res.writeHead(200, headers);
        res.end();
        return;
      }

      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    if (url.pathname === '/schedule') {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: 'GET, HEAD, POST',
        }));
        res.end('Method Not Allowed');
        return;
      }

      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      const groupFolder = group?.folder ?? jid;

      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        await new Promise((resolve) => req.on('end', resolve));
        const rawBody = Buffer.concat(chunks).toString('utf8');

        let parsed;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Body must be a JSON object' }));
          return;
        }

        const body = parsed;
        const { schedule_type, schedule_expression, prompt } = body;

        if (typeof schedule_type !== 'string' || typeof schedule_expression !== 'string' || typeof prompt !== 'string') {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'schedule_type, schedule_expression, and prompt are required strings' }));
          return;
        }

        if (!prompt.trim()) {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'prompt must not be empty' }));
          return;
        }

        if (schedule_type !== 'interval' && schedule_type !== 'cron' && schedule_type !== 'once') {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'schedule_type must be "interval", "cron", or "once"' }));
          return;
        }

        let next_run;
        if (schedule_type === 'once') {
          const d = new Date(schedule_expression);
          if (isNaN(d.getTime())) {
            res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'schedule_expression must be a valid ISO date for schedule_type "once"' }));
            return;
          }
          next_run = schedule_expression;
        } else if (schedule_type === 'interval') {
          const ms = parseInt(schedule_expression, 10);
          if (!ms || ms <= 0 || String(ms) !== schedule_expression.trim()) {
            res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'schedule_expression must be a positive integer (milliseconds) for schedule_type "interval"' }));
            return;
          }
          next_run = new Date(Date.now() + ms).toISOString();
        } else {
          try {
            next_run = CronExpressionParser.parse(schedule_expression, { tz: this.sdk.config.timezone }).next().toISOString();
          } catch {
            res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: `Invalid cron expression: '${schedule_expression}'` }));
            return;
          }
        }

        const id = randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');

        const created_at = new Date().toISOString();
        this.sdk.tasks.create({
          id,
          group_folder: groupFolder,
          chat_jid: jid,
          prompt: prompt.trim(),
          schedule_type: schedule_type,
          schedule_value: schedule_expression,
          context_mode: 'isolated',
          next_run,
          status: 'active',
          created_at,
        });

        const responseBody = JSON.stringify({
          id,
          status: 'active',
          schedule_type,
          schedule_expression,
          prompt: prompt.trim(),
          next_run,
          created_at,
        });

        res.writeHead(201, this.addCorsHeaders({
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(responseBody)),
        }));
        res.end(responseBody);
        return;
      }

      const statusParam = url.searchParams.get('status');
      if (statusParam !== null && statusParam !== 'active' && statusParam !== 'paused') {
        res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Invalid status parameter. Must be "active" or "paused".' }));
        return;
      }

      let tasks = this.sdk.tasks.getForGroup(groupFolder);

      if (statusParam !== null) {
        tasks = tasks.filter((t) => t.status === statusParam);
      }

      const payload = tasks.map((t) => ({
        id: t.id,
        schedule_type: t.schedule_type,
        schedule_expression: t.schedule_value,
        prompt: t.prompt,
        status: t.status,
        next_run: t.next_run,
        created_at: t.created_at,
      }));

      const listBody = JSON.stringify(payload);
      const listHeaders = this.addCorsHeaders({
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Content-Length': String(Buffer.byteLength(listBody)),
      });

      if (req.method === 'HEAD') {
        res.writeHead(200, listHeaders);
        res.end();
        return;
      }

      res.writeHead(200, listHeaders);
      res.end(listBody);
      return;
    }

    const scheduleIdMatch = /^\/schedule\/([^/]+)$/.exec(url.pathname);
    if (scheduleIdMatch) {
      const taskId = scheduleIdMatch[1];

      if (req.method !== 'DELETE' && req.method !== 'PATCH' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: 'DELETE, PATCH, HEAD',
        }));
        res.end('Method Not Allowed');
        return;
      }

      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      const groupFolder = group?.folder ?? jid;

      if (req.method === 'HEAD') {
        const task = this.sdk.tasks.getById(taskId);
        if (!task || task.group_folder !== groupFolder) {
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end();
          return;
        }
        res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end();
        return;
      }

      if (req.method === 'DELETE') {
        const deleted = this.sdk.tasks.deleteForGroup(taskId, groupFolder);
        if (!deleted) {
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        try {
          this.sdk.audit.write({ groupFolder, actor: username, action: 'schedule.delete', target: taskId });
        } catch (auditErr) {
          this.sdk.logger.error({ err: auditErr, taskId }, 'Audit write failed for schedule.delete');
        }
        res.writeHead(204, this.addCorsHeaders({}));
        res.end();
        return;
      }

      if (req.method === 'PATCH') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        await new Promise((resolve) => req.on('end', resolve));
        const rawBody = Buffer.concat(chunks).toString('utf8');

        let patchBody;
        try {
          patchBody = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        if (
          typeof patchBody !== 'object' ||
          patchBody === null ||
          Array.isArray(patchBody) ||
          typeof patchBody.paused !== 'boolean'
        ) {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: '{ paused: boolean } required' }));
          return;
        }

        const { paused } = patchBody;

        const task = this.sdk.tasks.getById(taskId);
        if (!task || task.group_folder !== groupFolder) {
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        const ok = paused
          ? this.sdk.tasks.pause(taskId, groupFolder)
          : this.sdk.tasks.resume(taskId, groupFolder);

        if (!ok) {
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        try {
          this.sdk.audit.write({
            groupFolder,
            actor: username,
            action: paused ? 'schedule.pause' : 'schedule.resume',
            target: taskId,
          });
        } catch (auditErr) {
          this.sdk.logger.error({ err: auditErr, taskId }, 'Audit write failed for schedule.pause/resume');
        }

        const updated = this.sdk.tasks.getById(taskId);
        const respBody = JSON.stringify({
          id: updated.id,
          status: updated.status,
          schedule_type: updated.schedule_type,
          schedule_expression: updated.schedule_value,
          prompt: updated.prompt,
          next_run: updated.next_run,
          created_at: updated.created_at,
        });

        res.writeHead(200, this.addCorsHeaders({
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(respBody)),
        }));
        res.end(respBody);
        return;
      }
    }

    const scheduleRunsMatch = /^\/schedule\/([^/]+)\/runs$/.exec(url.pathname);
    if (scheduleRunsMatch) {
      const taskId = scheduleRunsMatch[1];

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: 'GET, HEAD',
        }));
        res.end('Method Not Allowed');
        return;
      }

      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      const groupFolder = group?.folder ?? jid;

      const task = this.sdk.tasks.getById(taskId);
      if (!task || task.group_folder !== groupFolder) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      const rawLimit = url.searchParams.get('limit');
      const parsedLimit = rawLimit !== null ? parseInt(rawLimit, 10) : 20;
      const limit = Number.isNaN(parsedLimit) || parsedLimit < 1 ? 20 : Math.min(parsedLimit, 100);

      const runs = this.sdk.tasks.getRunLogs(taskId, groupFolder, limit);
      const respBody = JSON.stringify({ runs });

      res.writeHead(200, this.addCorsHeaders({
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(respBody)),
      }));
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(respBody);
      }
      return;
    }

    if (url.pathname === '/capabilities') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: 'GET, HEAD',
        }));
        res.end('Method Not Allowed');
        return;
      }

      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      const groupFolder = group?.folder ?? jid;

      const capabilities = this.opts.getCapabilities ? this.opts.getCapabilities(groupFolder) : [];

      const body = JSON.stringify(capabilities);
      const headers = this.addCorsHeaders({
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'Cache-Control': 'no-cache',
      });

      if (req.method === 'HEAD') {
        res.writeHead(200, headers);
        res.end();
        return;
      }

      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    if (url.pathname === '/search') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'application/json',
          Allow: 'GET, HEAD',
        }));
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const q = url.searchParams.get('q');
      if (q === null || q.trim() === '') {
        res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'q required' }));
        return;
      }
      if (q.length > 500) {
        res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'q must be 500 characters or fewer' }));
        return;
      }

      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Group not found' }));
        return;
      }

      const DEFAULT_LIMIT = 20;
      const MAX_LIMIT = 100;
      const rawLimit = url.searchParams.get('limit');
      let limit = DEFAULT_LIMIT;
      if (rawLimit !== null) {
        const parsed = Number(rawLimit);
        limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), MAX_LIMIT) : DEFAULT_LIMIT;
      }

      const results = this.sdk.history.search({ groupFolder: group.folder, query: q.trim(), limit });

      const payload = JSON.stringify(
        results.map((r) => ({ id: r.id, role: r.role, content: r.content, timestamp: r.createdAt })),
      );

      const headers = this.addCorsHeaders({
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
        'Cache-Control': 'no-cache',
      });

      if (req.method === 'HEAD') {
        res.writeHead(200, headers);
        res.end();
        return;
      }

      res.writeHead(200, headers);
      res.end(payload);
      return;
    }

    if (url.pathname === '/secrets/catalog') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({ Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }));
        res.end('Method Not Allowed');
        return;
      }
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end();
        return;
      }
      void this.handleGetCatalog(res);
      return;
    }

    const secretTypeMatch = url.pathname.match(/^\/secrets\/([^/]+)$/);
    if (secretTypeMatch) {
      if (req.method !== 'DELETE' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({ Allow: 'DELETE, HEAD', 'Content-Type': 'text/plain' }));
        res.end('Method Not Allowed');
        return;
      }
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      const secretType = secretTypeMatch[1];
      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      const groupFolder = group?.folder ?? jid;

      if (req.method === 'HEAD') {
        res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end();
        return;
      }
      void this.handleDeleteSecret(groupFolder, secretType, username, res);
      return;
    }

    if (url.pathname === '/secrets') {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        res.writeHead(405, this.addCorsHeaders({ Allow: 'GET, HEAD, POST', 'Content-Type': 'text/plain' }));
        res.end('Method Not Allowed');
        return;
      }
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      const groupFolder = group?.folder ?? jid;

      if (req.method === 'HEAD') {
        res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end();
        return;
      }
      if (req.method === 'POST') {
        void this.handleAddSecret(groupFolder, username, req, res);
        return;
      }
      void this.handleListSecrets(groupFolder, res);
      return;
    }

    if (url.pathname === '/skills') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({ Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }));
        res.end('Method Not Allowed');
        return;
      }
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Not found');
        return;
      }

      const accepted = this.sdk.skills.listAccepted(group.folder).map((s) => ({
        slug: s.frontmatter.name,
        title: s.frontmatter.name,
        description: s.frontmatter.description,
      }));
      const candidates = this.sdk.skills.listCandidates(group.folder).map((c) => ({
        slug: c.id,
        title: c.skill.frontmatter.name,
        description: c.skill.frontmatter.description,
      }));
      const archived = this.sdk.skills.listArchived(group.folder).map((s) => ({
        slug: s.frontmatter.name,
        title: s.frontmatter.name,
        description: s.frontmatter.description,
      }));

      const payload = JSON.stringify({ accepted, candidates, archived });
      res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(payload);
      }
      return;
    }

    const candidateActionMatch = url.pathname.match(/^\/skills\/candidates\/([^/]+)\/(accept|reject)$/);
    if (candidateActionMatch) {
      if (req.method !== 'POST') {
        res.writeHead(405, this.addCorsHeaders({ Allow: 'POST', 'Content-Type': 'text/plain' }));
        res.end('Method Not Allowed');
        return;
      }
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      const candidateId = candidateActionMatch[1];
      const action = candidateActionMatch[2];

      if (!CANDIDATE_ID_RE.test(candidateId)) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Not found');
        return;
      }

      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Not found');
        return;
      }

      try {
        if (action === 'accept') {
          this.sdk.skills.accept(group.folder, candidateId);
        } else {
          this.sdk.skills.reject(group.folder, candidateId);
        }
        try {
          this.sdk.audit.write({
            groupFolder: group.folder,
            actor: username,
            action: action === 'accept' ? 'skill.accept' : 'skill.reject',
            target: candidateId,
          });
        } catch (auditErr) {
          this.sdk.logger.error({ err: auditErr, candidateId }, `Audit write failed for skill.${action}`);
        }
        const result = action === 'accept' ? 'accepted' : 'rejected';
        res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ status: result, slug: candidateId }));
      } catch {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Not found');
      }
      return;
    }

    if (url.pathname === '/memory') {
      const method = req.method ?? '';

      if (!['GET', 'HEAD', 'PUT', 'PATCH'].includes(method)) {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: 'GET, HEAD, PUT, PATCH',
        }));
        res.end('Method Not Allowed');
        return;
      }

      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Not found');
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        void this.handleGetMemory(group.folder, method, res);
        return;
      }

      this.handleMemoryWrite(req, res, method, group.folder);
      return;
    }

    if (url.pathname === '/diag') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({ Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }));
        res.end('Method Not Allowed');
        return;
      }

      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      const groupFolder = group?.folder ?? `http-${username}`;

      const snap = this.sdk.diag(groupFolder);
      const body = JSON.stringify(snap);

      res.writeHead(200, this.addCorsHeaders({
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      }));
      if (req.method === 'GET') {
        res.end(body);
      } else {
        res.end();
      }
      return;
    }

    if (url.pathname === '/audit') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({ Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }));
        res.end('Method Not Allowed');
        return;
      }

      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      const groupFolder = group?.folder ?? `http-${username}`;

      const rawLimit = url.searchParams.get('limit');
      let auditLimit = 50;
      if (rawLimit !== null) {
        const parsed = parseInt(rawLimit, 10);
        if (Number.isFinite(parsed) && parsed >= 1) {
          auditLimit = Math.min(parsed, 200);
        }
      }

      const entries = this.sdk.audit.entries(groupFolder, auditLimit);
      const body = JSON.stringify({ entries });

      res.writeHead(200, this.addCorsHeaders({
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'Cache-Control': 'no-cache',
      }));
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
      return;
    }

    const pathMethods = {
      '/': ['GET'],
      '/healthz': ['GET', 'HEAD'],
      '/readyz': ['GET', 'HEAD'],
      '/version': ['GET', 'HEAD'],
      '/whoami': ['GET', 'HEAD'],
      '/stream': ['GET'],
      '/message/rate-limit': ['GET', 'HEAD'],
      '/message': ['POST'],
      '/history': ['GET', 'DELETE'],
      '/attachments/list': ['GET'],
      '/export': ['GET', 'HEAD'],
      '/jobs': ['GET', 'HEAD'],
      '/schedule': ['GET', 'HEAD', 'POST'],
      '/capabilities': ['GET', 'HEAD'],
      '/search': ['GET', 'HEAD'],
      '/secrets': ['GET', 'HEAD', 'POST'],
      '/secrets/catalog': ['GET', 'HEAD'],
      '/memory': ['GET', 'HEAD', 'PUT', 'PATCH'],
      '/skills': ['GET', 'HEAD'],
      '/diag': ['GET', 'HEAD'],
      '/audit': ['GET', 'HEAD'],
    };
    const allowed = pathMethods[url.pathname];
    if (allowed && !allowed.includes(req.method ?? '')) {
      res.writeHead(405, this.addCorsHeaders({
        'Content-Type': 'text/plain',
        Allow: allowed.join(', '),
      }));
      res.end('Method Not Allowed');
      return;
    }
    if (url.pathname.startsWith('/attachments/raw/')) {
      const allowedRaw = ['GET', 'HEAD', 'DELETE'];
      if (!allowedRaw.includes(req.method ?? '')) {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: allowedRaw.join(', '),
        }));
        res.end('Method Not Allowed');
        return;
      }
    }
    if (/^\/schedule\/[^/]+\/runs$/.test(url.pathname)) {
      const allowedScheduleRuns = ['GET', 'HEAD'];
      if (!allowedScheduleRuns.includes(req.method ?? '')) {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: allowedScheduleRuns.join(', '),
        }));
        res.end('Method Not Allowed');
        return;
      }
    }
    if (/^\/schedule\/[^/]+$/.test(url.pathname)) {
      const allowedScheduleId = ['DELETE', 'PATCH', 'HEAD'];
      if (!allowedScheduleId.includes(req.method ?? '')) {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: allowedScheduleId.join(', '),
        }));
        res.end('Method Not Allowed');
        return;
      }
    }

    if (url.pathname === '/debug/tool-jobs/inject') {
      if (!this.sdk.config.debugEndpointsEnabled) {
        // fall through to 404
      } else {
        if (req.method !== 'POST') {
          res.writeHead(405, this.addCorsHeaders({ 'Content-Type': 'text/plain', Allow: 'POST' }));
          res.end('Method Not Allowed');
          return;
        }

        const username = this.authenticate(req);
        if (!username) {
          this.sendUnauthorized(res);
          return;
        }

        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        await new Promise((resolve) => req.on('end', resolve));
        const rawBody = Buffer.concat(chunks).toString('utf8');

        let parsed;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Body must be a JSON object' }));
          return;
        }

        const body = parsed;
        const jobId = body['job_id'];
        const groupFolder = body['group_folder'];
        const status = body['status'];

        if (
          typeof jobId !== 'string' || !jobId ||
          typeof groupFolder !== 'string' || !groupFolder ||
          typeof status !== 'string' || !status
        ) {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'job_id, group_folder, and status are required strings' }));
          return;
        }

        const createdAt = typeof body['created_at'] === 'string' ? body['created_at'] : undefined;
        const resolvedAt = typeof body['resolved_at'] === 'string' ? body['resolved_at'] : null;

        try {
          this.sdk.jobs.insertForDebug({ jobId, groupFolder, status, createdAt, resolvedAt });
        } catch (err) {
          this.sdk.logger.error({ err }, 'debug inject: insertForDebug failed');
          res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Internal server error' }));
          return;
        }

        res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ ok: true, job_id: jobId }));
        return;
      }
    }

    res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
    res.end('Not found');
  }

  handleInbound(username, text) {
    const jid = `http:${username}`;
    const timestamp = new Date().toISOString();
    const msgId = `${Date.now()}-${++this.messageSeq}`;

    this.opts.onChatMetadata(jid, timestamp, username, 'http', false);

    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      this.sdk.logger.debug({ jid }, 'HTTP message from unregistered user');
      return msgId;
    }

    this.opts.onMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender: username,
      sender_name: username,
      content: text,
      timestamp,
      is_from_me: false,
    });

    this.sdk.logger.info({ jid }, 'HTTP message stored');
    return msgId;
  }

  async handleListSecrets(groupFolder, res) {
    const fn = this.opts.listSecretsFn;
    if (!fn) {
      res.writeHead(503, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Secret IPC not configured' }));
      return;
    }
    try {
      const entries = await fn(groupFolder);
      const safe = entries.map((e) => ({
        type: String(e.type),
        fields_present: Array.isArray(e.fields_present) ? e.fields_present.map(String) : [],
      }));
      res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify(safe));
    } catch (err) {
      this.sdk.logger.error({ err, groupFolder }, 'GET /secrets failed');
      res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  }

  async handleAddSecret(groupFolder, actor, req, res) {
    const fn = this.opts.addSecretFn;
    if (!fn) {
      res.writeHead(503, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Secret IPC not configured' }));
      return;
    }

    const chunks = [];
    let totalSize = 0;
    let oversized = false;

    await new Promise((resolve) => {
      req.on('data', (chunk) => {
        if (oversized) return;
        totalSize += chunk.length;
        if (totalSize > MAX_SECRETS_BODY_SIZE) {
          oversized = true;
          if (!res.writableEnded) {
            res.writeHead(413, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'Request body too large' }));
          }
          if (typeof req.resume === 'function') req.resume();
          resolve();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', resolve);
      req.on('error', resolve);
    });

    if (oversized) return;

    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: '{"type":"<id>","fields":{...}} required' }));
      return;
    }
    const raw = body;

    if (typeof raw.type !== 'string' || raw.type.trim() === '') {
      res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: '"type" must be a non-empty string' }));
      return;
    }

    if (typeof raw.fields !== 'object' || raw.fields === null || Array.isArray(raw.fields)) {
      res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: '"fields" must be a non-null object' }));
      return;
    }

    const secretType = raw.type.trim();
    const fields = raw.fields;

    for (const [k, v] of Object.entries(fields)) {
      if (typeof v !== 'string') {
        res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: `field "${k}" must be a string` }));
        return;
      }
    }

    let result;
    try {
      result = await Promise.race([
        fn(groupFolder, secretType, fields),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5500)),
      ]);
    } catch (err) {
      this.sdk.logger.error({ err, groupFolder, secretType }, 'POST /secrets IPC error');
      res.writeHead(502, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'IPC error' }));
      return;
    }

    if (!result.ok) {
      const errMsg = result.error ?? 'unknown';
      if (errMsg === 'timeout') {
        res.writeHead(504, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'IPC timeout' }));
        return;
      }
      const sanitized = errMsg.replace(/\b[A-Za-z0-9_\-]{20,}\b/g, '[redacted]');
      res.writeHead(502, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: sanitized }));
      return;
    }

    try {
      const fieldNames = Object.keys(fields);
      this.sdk.audit.write({
        groupFolder,
        actor,
        action: 'secret.add',
        target: secretType,
        detail: `fields=${fieldNames.join(',')}`,
      });
    } catch (auditErr) {
      this.sdk.logger.error({ err: auditErr, groupFolder, secretType }, 'Audit write failed for secret.add');
    }

    res.writeHead(201, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
    res.end(JSON.stringify({ status: 'ok', type: secretType }));
  }

  async handleDeleteSecret(groupFolder, secretType, actor, res) {
    const fn = this.opts.removeSecretFn;
    if (!fn) {
      res.writeHead(503, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Secret IPC not configured' }));
      return;
    }
    try {
      const result = await fn(groupFolder, secretType);
      if (result === 'not_found') {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      try {
        this.sdk.audit.write({ groupFolder, actor, action: 'secret.remove', target: secretType });
      } catch (auditErr) {
        this.sdk.logger.error({ err: auditErr, groupFolder, secretType }, 'Audit write failed for secret.remove');
      }
      res.writeHead(204, this.addCorsHeaders({}));
      res.end();
    } catch (err) {
      this.sdk.logger.error({ err, groupFolder, secretType }, 'DELETE /secrets/:type failed');
      res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  }

  async handleGetCatalog(res) {
    const fn = this.opts.listCatalogFn;
    if (!fn) {
      res.writeHead(503, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Catalog IPC not configured' }));
      return;
    }
    try {
      const entries = await fn();
      const safe = entries.map((e) => ({
        type: String(e.type),
        required_fields: Array.isArray(e.required_fields) ? e.required_fields.map(String) : [],
        optional_fields: Array.isArray(e.optional_fields) ? e.optional_fields.map(String) : [],
        description: String(e.description ?? ''),
      }));
      res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify(safe));
    } catch (err) {
      this.sdk.logger.error({ err }, 'GET /secrets/catalog failed');
      res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  }

  async handleGetMemory(groupFolder, method, res) {
    const memoryPath = path.join(this.sdk.groupsDir, groupFolder, 'CLAUDE.md');
    let content = '';
    try {
      content = await fsPromises.readFile(memoryPath, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this.sdk.logger.error({ err, groupFolder }, 'GET /memory read error');
        res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Internal Server Error');
        return;
      }
    }
    const body = JSON.stringify({ content });
    if (method === 'HEAD') {
      res.writeHead(200, this.addCorsHeaders({
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      }));
      res.end();
      return;
    }
    res.writeHead(200, this.addCorsHeaders({
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    }));
    res.end(body);
  }

  handleMemoryWrite(req, res, method, groupFolder) {
    const chunks = [];
    let totalSize = 0;
    let oversized = false;

    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_MEMORY_BODY_SIZE) {
        if (!oversized) {
          oversized = true;
          res.writeHead(413, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Payload Too Large');
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (oversized) return;
      void (async () => {
        try {
          const bodyStr = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
            res.end('Bad Request: invalid JSON');
            return;
          }

          const memoryPath = path.join(this.sdk.groupsDir, groupFolder, 'CLAUDE.md');

          if (method === 'PUT') {
            const obj = parsed;
            if (typeof obj?.content !== 'string') {
              res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
              res.end('Bad Request: content must be a string');
              return;
            }
            await fsPromises.mkdir(path.dirname(memoryPath), { recursive: true });
            const tmpPath = path.join(path.dirname(memoryPath), `.claude-md-tmp-${Date.now()}-${process.pid}`);
            await fsPromises.writeFile(tmpPath, obj.content, 'utf8');
            await fsPromises.rename(tmpPath, memoryPath);
            res.writeHead(204, this.addCorsHeaders({}));
            res.end();
            return;
          }

          if (method === 'PATCH') {
            const obj = parsed;
            if (typeof obj?.append !== 'string') {
              res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
              res.end('Bad Request: append must be a string');
              return;
            }
            await fsPromises.mkdir(path.dirname(memoryPath), { recursive: true });
            let existing = '';
            try {
              existing = await fsPromises.readFile(memoryPath, 'utf8');
            } catch (err) {
              if (err?.code !== 'ENOENT') throw err;
            }
            const separator = existing.length > 0 ? '\n' : '';
            const newContent = existing + separator + obj.append;
            const tmpPath = path.join(path.dirname(memoryPath), `.claude-md-tmp-${Date.now()}-${process.pid}`);
            await fsPromises.writeFile(tmpPath, newContent, 'utf8');
            await fsPromises.rename(tmpPath, memoryPath);
            res.writeHead(204, this.addCorsHeaders({}));
            res.end();
            return;
          }
        } catch (err) {
          this.sdk.logger.error({ err, groupFolder }, '/memory write error');
          if (!res.writableEnded) {
            res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
            res.end('Internal Server Error');
          }
        }
      })();
    });
  }

  sendSse(username, eventType, data) {
    const clients = this.sseClients.filter((c) => c.username === username);
    const payload = `event: ${eventType}\ndata: ${data}\n\n`;
    for (const client of clients) {
      try {
        if (!client.res.writableEnded) {
          client.res.write(payload);
        }
      } catch (err) {
        this.sdk.logger.debug({ username, err }, 'SSE write failed — client likely disconnected');
      }
    }
  }

  async sendMessage(jid, text) {
    const username = jid.slice('http:'.length);
    const clients = this.sseClients.filter((c) => c.username === username);

    const nowMs = Date.now();
    const timestamp = new Date(nowMs).toISOString();

    try {
      this.sdk.history.storeOutbound({
        id: `http-out-${nowMs}-${++this.messageSeq}`,
        chat_jid: jid,
        sender: this.sdk.assistantName,
        sender_name: this.sdk.assistantName,
        content: text,
        timestamp,
        is_from_me: true,
        is_bot_message: true,
      });
    } catch (err) {
      this.sdk.logger.warn({ err, jid }, 'Failed to persist outbound HTTP message for SSE catch-up');
    }

    if (clients.length === 0) {
      this.sdk.logger.debug({ jid }, 'No SSE client connected for HTTP JID');
      return;
    }

    const lines = text.split('\n');
    const ssePayload = `id: ${nowMs}\n` + lines.map((l) => `data: ${l}`).join('\n') + '\n\n';

    for (const client of clients) {
      try {
        if (!client.res.writableEnded) {
          client.res.write(ssePayload);
        }
      } catch (err) {
        this.sdk.logger.debug({ jid, err }, 'SSE write failed — client likely disconnected');
      }
    }

    this.sdk.logger.info({ jid, clients: clients.length }, 'HTTP message sent via SSE');
  }

  async sendMedia(jid, buffer, mediaType, caption) {
    const username = jid.slice('http:'.length);
    const clients = this.sseClients.filter((c) => c.username === username);

    if (clients.length === 0) {
      this.sdk.logger.debug({ jid }, 'No SSE client connected for HTTP JID (sendMedia)');
      return;
    }

    const payload = { mediaType, data: buffer.toString('base64') };
    if (caption !== undefined) payload.caption = caption;

    this.sendSse(username, 'media', JSON.stringify(payload));
    this.sdk.logger.info({ jid, mediaType, clients: clients.length }, 'HTTP media sent via SSE');
  }

  isConnected() {
    return this.server !== null;
  }

  ownsJid(jid) {
    return jid.startsWith('http:');
  }

  async disconnect() {
    for (const client of this.sseClients) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    this.sseClients = [];

    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
      this.sdk.logger.info('HTTP channel closed');
    }
  }
}

function parseConfig(sdk) {
  const envVars = sdk.readEnvFile([
    'HTTP_CHANNEL_PORT',
    'HTTP_CHANNEL_USERS',
    'HTTP_CHANNEL_RATE_LIMIT_PER_USER_MESSAGES_PER_MINUTE',
    'HTTP_CHANNEL_MAX_ATTACHMENT_COUNT_PER_USER',
    'HTTP_CHANNEL_MAX_ATTACHMENT_BYTES_PER_USER',
    'HTTP_CHANNEL_CORS_ORIGIN',
  ]);

  const port = parseInt(
    process.env.HTTP_CHANNEL_PORT || envVars.HTTP_CHANNEL_PORT || '4080',
    10,
  );

  const usersStr = process.env.HTTP_CHANNEL_USERS || envVars.HTTP_CHANNEL_USERS;

  if (!usersStr) {
    sdk.logger.warn('HTTP channel: HTTP_CHANNEL_USERS must be set (format: user1:pass1,user2:pass2)');
    return null;
  }

  const users = {};
  for (const entry of usersStr.split(',')) {
    const colon = entry.indexOf(':');
    if (colon === -1) continue;
    const u = entry.slice(0, colon).trim();
    const p = entry.slice(colon + 1).trim();
    if (u && p) users[u] = p;
  }

  if (Object.keys(users).length === 0) {
    sdk.logger.warn('HTTP channel: no valid users found in HTTP_CHANNEL_USERS (format: user1:pass1,user2:pass2)');
    return null;
  }

  const rateLimitRaw =
    process.env.HTTP_CHANNEL_RATE_LIMIT_PER_USER_MESSAGES_PER_MINUTE ||
    envVars.HTTP_CHANNEL_RATE_LIMIT_PER_USER_MESSAGES_PER_MINUTE ||
    '60';
  const parsedRateLimit = parseInt(rateLimitRaw, 10);
  const perUserMessagesPerMinute = Math.max(0, Number.isNaN(parsedRateLimit) ? 60 : parsedRateLimit);

  const maxAttachmentCount = parseInt(
    process.env.HTTP_CHANNEL_MAX_ATTACHMENT_COUNT_PER_USER ||
      envVars.HTTP_CHANNEL_MAX_ATTACHMENT_COUNT_PER_USER ||
      '0',
    10,
  );

  const maxAttachmentBytes = parseInt(
    process.env.HTTP_CHANNEL_MAX_ATTACHMENT_BYTES_PER_USER ||
      envVars.HTTP_CHANNEL_MAX_ATTACHMENT_BYTES_PER_USER ||
      '0',
    10,
  );

  const corsOrigin =
    process.env.HTTP_CHANNEL_CORS_ORIGIN ||
    envVars.HTTP_CHANNEL_CORS_ORIGIN ||
    '*';

  return {
    port,
    users,
    perUserMessagesPerMinute,
    maxAttachmentCount: isNaN(maxAttachmentCount) ? 0 : maxAttachmentCount,
    maxAttachmentBytes: isNaN(maxAttachmentBytes) ? 0 : maxAttachmentBytes,
    corsOrigin,
  };
}

export default function register(sdk) {
  sdk.registerChannel('http', (opts) => {
    const config = parseConfig(sdk);
    if (!config) return null;
    return new HttpChannel(config, opts, sdk);
  });
}
