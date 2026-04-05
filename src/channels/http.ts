import fs from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface HttpChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface HttpConfig {
  port: number;
  users: Record<string, string>; // username → password (plaintext)
}

// SSE client tracking
interface SseClient {
  username: string;
  res: ServerResponse;
}

const MAX_MULTIPART_SIZE = 10 * 1024 * 1024; // 10 MB

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
    // Find next boundary
    const bStart = body.indexOf(sep, pos);
    if (bStart === -1) break;
    pos = bStart + sep.length;

    // Check for end boundary
    if (body.slice(pos, pos + 2).equals(Buffer.from('--'))) break;

    // Skip CRLF after boundary
    if (body.slice(pos, pos + 2).equals(CRLF)) pos += 2;

    // Find end of headers (CRLFCRLF)
    const headerEnd = body.indexOf(CRLFCRLF, pos);
    if (headerEnd === -1) break;

    const headerStr = body.slice(pos, headerEnd).toString('utf8');
    pos = headerEnd + 4; // skip CRLFCRLF

    // Find next boundary to determine data end
    const nextBound = body.indexOf(sep, pos);
    if (nextBound === -1) break;

    // Data ends just before CRLF + boundary
    let dataEnd = nextBound;
    if (body.slice(dataEnd - 2, dataEnd).equals(CRLF)) dataEnd -= 2;
    const data = body.slice(pos, dataEnd);
    pos = nextBound;

    // Parse headers
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

// HTML chat UI served at GET /
const CHAT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ASSISTANT_NAME}</title>
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
  <textarea id="input" placeholder="Message ${ASSISTANT_NAME}…" rows="1"></textarea>
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

export class HttpChannel implements Channel {
  name = 'http';

  private opts: HttpChannelOpts;
  private config: HttpConfig;
  private server: Server | null = null;
  private sseClients: SseClient[] = [];
  private messageSeq = 0;

  constructor(config: HttpConfig, opts: HttpChannelOpts) {
    this.config = config;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, () => {
        const users = Object.keys(this.config.users);
        logger.info({ port: this.config.port, users }, 'HTTP channel listening');
        console.log(`\n  HTTP chat: http://localhost:${this.config.port}`);
        console.log(`  Users: ${users.join(', ')}`);
        console.log(`  Register each user as a group with JID: http:{username}\n`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  private authenticate(req: IncomingMessage): string | null {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Basic ')) return null;

    const b64 = authHeader.slice('Basic '.length);
    let decoded: string;
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

  private sendUnauthorized(res: ServerResponse): void {
    res.writeHead(401, {
      'WWW-Authenticate': `Basic realm="${ASSISTANT_NAME}"`,
      'Content-Type': 'text/plain',
    });
    res.end('Unauthorized');
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://localhost:${this.config.port}`);

    // Serve chat UI without auth (browser will prompt via Basic auth challenge)
    if (req.method === 'GET' && url.pathname === '/') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(CHAT_HTML);
      return;
    }

    // SSE stream for outbound messages
    if (req.method === 'GET' && url.pathname === '/stream') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // disable nginx buffering
      });
      res.write(':ok\n\n'); // initial heartbeat

      const client: SseClient = { username, res };
      this.sseClients.push(client);

      req.on('close', () => {
        this.sseClients = this.sseClients.filter((c) => c !== client);
      });

      // Keepalive ping every 30s to prevent proxy timeouts
      const ping = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': ping\n\n');
        } else {
          clearInterval(ping);
        }
      }, 30_000);

      return;
    }

    // Inbound message from browser
    if (req.method === 'POST' && url.pathname === '/message') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const contentType = (req.headers['content-type'] ?? '').toLowerCase();
      const chunks: Buffer[] = [];
      let totalSize = 0;

      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_MULTIPART_SIZE) {
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
          const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
          if (!boundaryMatch) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing boundary');
            return;
          }
          const boundary = boundaryMatch[1];
          const parts = parseMultipart(body, boundary);

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

          const jid = `http:${username}`;
          const group = this.opts.registeredGroups()[jid];
          if (!group) {
            logger.debug({ jid }, 'HTTP image from unregistered user');
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
            return;
          }

          const ext = mime.split('/')[1].replace('jpeg', 'jpg');
          const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
          const attachDir = path.join(GROUPS_DIR, jid, 'attachments', 'raw');
          fs.mkdirSync(attachDir, { recursive: true });
          fs.writeFileSync(path.join(attachDir, filename), imagePart.data);

          const caption = textPart?.data.toString('utf8').trim() ?? '';
          const marker = caption
            ? `[ImageAttachment: attachments/raw/${filename} caption="${caption}"]`
            : `[ImageAttachment: attachments/raw/${filename}]`;
          this.handleInbound(username, marker);

          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
          return;
        }

        // JSON text message
        try {
          const { text } = JSON.parse(body.toString('utf8')) as { text?: string };
          if (!text?.trim()) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing text');
            return;
          }
          this.handleInbound(username, text.trim());
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid JSON');
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  private handleInbound(username: string, text: string): void {
    const jid = `http:${username}`;
    const timestamp = new Date().toISOString();
    const msgId = `${Date.now()}-${++this.messageSeq}`;

    this.opts.onChatMetadata(jid, timestamp, username, 'http', false);

    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      logger.debug({ jid }, 'HTTP message from unregistered user');
      return;
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

    logger.info({ jid }, 'HTTP message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const username = jid.slice('http:'.length);
    const clients = this.sseClients.filter((c) => c.username === username);

    if (clients.length === 0) {
      logger.debug({ jid }, 'No SSE client connected for HTTP JID');
      return;
    }

    // Escape newlines for SSE data field; split into multiple data lines
    const lines = text.split('\n');
    const ssePayload = lines.map((l) => `data: ${l}`).join('\n') + '\n\n';

    for (const client of clients) {
      try {
        if (!client.res.writableEnded) {
          client.res.write(ssePayload);
        }
      } catch (err) {
        logger.debug({ jid, err }, 'SSE write failed — client likely disconnected');
      }
    }

    logger.info({ jid, clients: clients.length }, 'HTTP message sent via SSE');
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('http:');
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
      logger.info('HTTP channel closed');
    }
  }
}

function parseConfig(): HttpConfig | null {
  const envVars = readEnvFile(['HTTP_CHANNEL_PORT', 'HTTP_CHANNEL_USERS']);

  const port = parseInt(
    process.env.HTTP_CHANNEL_PORT || envVars.HTTP_CHANNEL_PORT || '4080',
    10,
  );

  // HTTP_CHANNEL_USERS format: "alice:pass1,bob:pass2"
  const usersStr =
    process.env.HTTP_CHANNEL_USERS || envVars.HTTP_CHANNEL_USERS;

  if (!usersStr) {
    logger.warn(
      'HTTP channel: HTTP_CHANNEL_USERS must be set (format: user1:pass1,user2:pass2)',
    );
    return null;
  }

  const users: Record<string, string> = {};
  for (const entry of usersStr.split(',')) {
    const colon = entry.indexOf(':');
    if (colon === -1) continue;
    const u = entry.slice(0, colon).trim();
    const p = entry.slice(colon + 1).trim();
    if (u && p) users[u] = p;
  }

  if (Object.keys(users).length === 0) {
    logger.warn(
      'HTTP channel: no valid users found in HTTP_CHANNEL_USERS (format: user1:pass1,user2:pass2)',
    );
    return null;
  }

  return { port, users };
}

registerChannel('http', (opts: ChannelOpts) => {
  const config = parseConfig();
  if (!config) return null;
  return new HttpChannel(config, opts);
});
