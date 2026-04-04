import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { ASSISTANT_NAME } from '../config.js';
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
  #form { display: flex; gap: 0.5rem; padding: 0.75rem; background: #fff; border-top: 1px solid #e0e0e0; }
  #input { flex: 1; padding: 0.5rem 0.75rem; border: 1px solid #ccc; border-radius: 8px; font-size: 1rem; resize: none; height: 2.5rem; max-height: 8rem; overflow-y: auto; }
  #send { padding: 0.5rem 1rem; background: #0b93f6; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; }
  #send:disabled { opacity: 0.5; cursor: default; }
  #status { font-size: 0.75rem; color: #888; padding: 0.25rem 1rem; }
</style>
</head>
<body>
<div id="messages"></div>
<div id="status">Connecting…</div>
<form id="form">
  <textarea id="input" placeholder="Message ${ASSISTANT_NAME}…" rows="1"></textarea>
  <button id="send" type="submit">Send</button>
</form>
<script>
const msgs = document.getElementById('messages');
const status = document.getElementById('status');
const form = document.getElementById('form');
const input = document.getElementById('input');
const send = document.getElementById('send');

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
  if (!text) return;
  input.value = '';
  input.style.height = '2.5rem';
  send.disabled = true;
  addMsg(text, 'user');
  try {
    await fetch('/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text }),
    });
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
        logger.info(
          { port: this.config.port, users },
          'HTTP channel listening',
        );
        console.log(`\n  HTTP chat: http://localhost:${this.config.port}`);
        console.log(`  Users: ${users.join(', ')}`);
        console.log(
          `  Register each user as a group with JID: http:{username}\n`,
        );
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

      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 65_536) {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Payload too large');
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          const { text } = JSON.parse(body) as { text?: string };
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
        logger.debug(
          { jid, err },
          'SSE write failed — client likely disconnected',
        );
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
  const usersStr = process.env.HTTP_CHANNEL_USERS || envVars.HTTP_CHANNEL_USERS;

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
