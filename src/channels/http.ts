import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  RATE_LIMIT_WINDOW_MS,
  STORE_DIR,
  TIMEZONE,
  TOOL_JOBS_RETENTION_DAYS,
} from '../config.js';
import {
  appendConversationMessage,
  clearConversationHistory,
  createTask,
  deleteConversationHistoryBefore,
  db,
  deleteMessageById,
  deleteTaskForGroup,
  getAllConversationHistory,
  getActiveToolJobs,
  getAuditEntries,
  getConversationHistoryPage,
  getDiagSnapshot,
  getMessageById,
  updateConversationMessage,
  getOutboundMessagesSince,
  getRecentToolJobsForGroup,
  getTaskById,
  getTaskRunLogs,
  getTasksForGroup,
  getToolJobByIdForGroup,
  pauseTask,
  resumeTask,
  searchConversations,
  storeMessageDirect,
  writeAuditEntry,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  ChannelCapabilities,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { DEFAULT_DIRECT_MODEL } from '../runtime/llm-client.js';
import {
  listAcceptedSkills,
  listCandidates,
  listArchived,
  acceptCandidate,
  rejectCandidate,
} from '../runtime/skill-store.js';

/** Stable capability entry shape exposed by GET /capabilities. */
export interface CapabilityEntry {
  type: string;
  state: 'running' | 'scaled_down';
  provisioned_at: string;
  scale: number;
}

/** Result of a single readiness sub-check. */
export type CheckResult = 'ok' | 'failed' | 'unreachable';

/** Shape of the /readyz response body. */
export interface ReadyzBody {
  status: 'ready' | 'not_ready';
  checks: {
    db: CheckResult;
    redis: CheckResult;
  };
}

/** Shape of one entry from secret.list IPC reply (scrubbed — no values). */
export interface SecretListEntry {
  type: string;
  fields_present: string[];
}

/** Shape of one catalog entry from catalog.list IPC reply. */
export interface CatalogListEntry {
  type: string;
  required_fields: string[];
  optional_fields: string[];
  description: string;
}

/**
 * Returns the list of registered secrets for a group.
 * SECURITY: must never return secret values — only type + field names.
 */
export type ListSecretsFn = (
  group: string,
) => Promise<SecretListEntry[]>;

/**
 * Removes a registered secret by type for a group.
 * Resolves to 'ok' on success, 'not_found' if unknown type.
 */
export type RemoveSecretFn = (
  group: string,
  type: string,
) => Promise<'ok' | 'not_found'>;

/**
 * Returns the credential catalog entries (no secret values).
 */
export type ListCatalogFn = () => Promise<CatalogListEntry[]>;

/**
 * Provisions a credential for a group.
 * Returns { ok: true } on success, { ok: false, error: string } on failure.
 * SECURITY: fields contain secret values — must NEVER be echoed in responses.
 */
export type AddSecretFn = (
  group: string,
  type: string,
  fields: Record<string, string>,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export interface HttpChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /**
   * Override the DB health check for testing.
   * Defaults to running `SELECT 1` on the module-level `db` export.
   */
  checkDb?: () => CheckResult;
  /**
   * Override the Redis health check for testing.
   * Defaults to sending PING with a 2 s timeout on the shared Redis client.
   */
  checkRedis?: () => Promise<CheckResult>;
  /** Maximum number of stored attachments per user. 0 = unlimited. */
  maxAttachmentCount?: number;
  /** Maximum cumulative attachment bytes per user. 0 = unlimited. */
  maxAttachmentBytes?: number;
  /**
   * Return the provisioned per-group capabilities for the given group folder.
   * Called on every GET /capabilities request. Defaults to returning [] when
   * omitted (used in tests that don't exercise this path).
   */
  getCapabilities?: (groupFolder: string) => CapabilityEntry[];
  /**
   * Override the DELETE /jobs/<id> IPC kill for testing.
   * Defaults to sending a job.cancel IPC to the orchestrator via Redis.
   */
  killJobFn?: (
    jobId: string,
    groupFolder: string,
  ) => Promise<{ ok: boolean; status?: string; currentStatus?: string; error?: string }>;
  /** Injectable for listing group secrets. Defaults to IPC-backed implementation. */
  listSecretsFn?: ListSecretsFn;
  /** Injectable for removing a group secret. Defaults to IPC-backed implementation. */
  removeSecretFn?: RemoveSecretFn;
  /** Injectable for listing catalog entries. Defaults to IPC-backed implementation. */
  listCatalogFn?: ListCatalogFn;
  /** Injectable for provisioning a credential. Defaults to IPC-backed implementation. */
  addSecretFn?: AddSecretFn;
}

interface HttpConfig {
  port: number;
  users: Record<string, string>; // username → password (plaintext)
  /** Max POST /message requests per 60-second sliding window, per user. 0 = unlimited. */
  perUserMessagesPerMinute: number;
  /** Maximum number of stored attachments per user. 0 = unlimited. Default: 0. */
  maxAttachmentCount?: number;
  /** Maximum cumulative attachment bytes per user. 0 = unlimited. Default: 0. */
  maxAttachmentBytes?: number;
  /**
   * Value for the Access-Control-Allow-Origin header on all responses.
   * Defaults to "*" (allow all origins). Set via HTTP_CHANNEL_CORS_ORIGIN.
   */
  corsOrigin: string;
}

/** Token-bucket state for a single user. */
interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Returns the count of regular files and total size in bytes of all files in
 * `attachDir`. If the directory does not exist, returns { count: 0, bytes: 0 }.
 * Subdirectories are skipped (they don't consume either quota).
 */
export async function getAttachmentUsage(
  attachDir: string,
): Promise<{ count: number; bytes: number }> {
  let entries: string[];
  try {
    entries = await fsPromises.readdir(attachDir);
  } catch (err: unknown) {
    // Directory does not exist yet — no usage
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
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

// SSE client tracking
interface SseClient {
  username: string;
  res: ServerResponse;
}

const MAX_MULTIPART_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_SECRETS_BODY_SIZE = 64 * 1024; // 64 KiB (Story 76 AC5)
const MAX_MEMORY_BODY_SIZE = 1 * 1024 * 1024; // 1 MiB cap for PUT/PATCH /memory

// Candidate IDs: timestamp-hrtime-slug, e.g. "1714059600000-1a2b3c-my-skill"
// Must allow digits, lowercase letters, hyphens, underscores.  No dots or slashes.
const CANDIDATE_ID_RE = /^[a-z0-9][-a-z0-9_]{0,255}$/;

const MEDIA_MAGIC: Array<{ bytes: number[]; mime: string }> = [
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    mime: 'image/png',
  },
  { bytes: [0x47, 0x49, 0x46], mime: 'image/gif' },
];

export function detectMediaType(buffer: Buffer): string | null {
  // WebP: RIFF????WEBP (12 bytes minimum, byte 4-7 is the file-size field
  // which is don't-care for detection). Checked before MEDIA_MAGIC because
  // the bare RIFF prefix also matches WAV/AVI/etc; we only accept actual WebP.
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

/** Build the JSON payload for GET /version. Exported for unit testing. */
export function buildVersionPayload(): {
  version: string | null;
  model: string | null;
  rateLimitWindowMs: number | null;
  toolJobsRetentionDays: number | null;
} {
  return {
    version: process.env.KUBECLAW_VERSION ?? 'dev',
    model: DEFAULT_DIRECT_MODEL ?? null,
    rateLimitWindowMs: Number.isFinite(RATE_LIMIT_WINDOW_MS)
      ? RATE_LIMIT_WINDOW_MS
      : null,
    toolJobsRetentionDays: Number.isFinite(TOOL_JOBS_RETENTION_DAYS)
      ? TOOL_JOBS_RETENTION_DAYS
      : null,
  };
}

export class HttpChannel implements Channel {
  name = 'http';
  readonly capabilities: ChannelCapabilities = {
    inboundImages: true,
    outboundMedia: true,
  };

  private opts: HttpChannelOpts;
  private config: HttpConfig;
  private server: Server | null = null;
  private sseClients: SseClient[] = [];
  private messageSeq = 0;
  private processStartMs: number;
  private checkDb: () => CheckResult;
  private checkRedis: () => Promise<CheckResult>;
  private killJobFn: (
    jobId: string,
    groupFolder: string,
  ) => Promise<{ ok: boolean; status?: string; currentStatus?: string; error?: string }>;
  /** Per-user token buckets for POST /message rate limiting. */
  private rateBuckets: Map<string, Bucket> = new Map();

  constructor(config: HttpConfig, opts: HttpChannelOpts) {
    this.config = config;
    this.opts = opts;
    this.processStartMs = Date.now();

    this.checkDb =
      opts.checkDb ??
      (() => {
        try {
          db.exec('SELECT 1');
          return 'ok';
        } catch {
          return 'failed';
        }
      });

    this.checkRedis =
      opts.checkRedis ??
      (async () => {
        // Lazy import so tests that mock the module don't pull in ioredis at
        // module load.
        const { getRedisClient } = await import('../k8s/redis-client.js');
        const client = getRedisClient();
        try {
          await Promise.race([
            client.ping(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Redis PING timeout')), 2000),
            ),
          ]);
          return 'ok';
        } catch {
          return 'unreachable';
        }
      });

    this.killJobFn =
      opts.killJobFn ??
      (async (jobId: string, groupFolder: string) => {
        // Lazy import so unit tests that mock the module don't pull in ioredis.
        const { getRedisClient } = await import('../k8s/redis-client.js');
        const { getTaskRequestStream } = await import('../k8s/redis-client.js');
        const { randomBytes } = await import('node:crypto');
        const redis = getRedisClient();
        const resultStream = `kubeclaw:job-kill-result:${Date.now()}-${randomBytes(4).toString('hex')}`;
        await redis.xadd(
          getTaskRequestStream(),
          '*',
          'type', 'job.cancel',
          'jobId', jobId,
          'groupFolder', groupFolder,
          'resultStream', resultStream,
        );
        const deadline = Date.now() + 5000;
        let lastId = '0-0';
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const response = await redis.xread(
            'COUNT', 1, 'BLOCK', Math.min(remaining, 1000),
            'STREAMS', resultStream, lastId,
          );
          if (!response) continue;
          for (const [, messages] of response as [string, [string, string[]][]][]) {
            for (const [, flds] of messages) {
              const obj: Record<string, string> = {};
              for (let i = 0; i < flds.length; i += 2) obj[flds[i]] = flds[i + 1];
              if (obj.result) {
                return JSON.parse(obj.result) as {
                  ok: boolean;
                  status?: string;
                  currentStatus?: string;
                  error?: string;
                };
              }
            }
          }
        }
        throw new Error('DELETE /jobs/<id> kill timed out — orchestrator did not respond');
      });
  }

  /**
   * Token-bucket consume: refills tokens at rate=capacity/60s, then tries to
   * consume 1 token.
   *
   * Returns `{ allowed: true }` when the request is permitted, or
   * `{ allowed: false, retryAfterSeconds: N }` when throttled.
   *
   * @param username - the authenticated username (bucket key)
   * @param nowMs    - current time in milliseconds (injectable for testing)
   */
  consumeRateLimit(
    username: string,
    nowMs: number = Date.now(),
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    // Default to 0 (unlimited) when the field is unset — defends against
    // test configs created before the field was added to HttpConfig.
    const capacity = this.config.perUserMessagesPerMinute ?? 0;
    if (capacity === 0) return { allowed: true }; // unlimited

    const refillRatePerMs = capacity / 60_000; // tokens per millisecond

    let bucket = this.rateBuckets.get(username);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefillMs: nowMs };
      this.rateBuckets.set(username, bucket);
    }

    // Refill based on elapsed time
    const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + elapsed * refillRatePerMs,
    );
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    // Compute how many seconds until the next token is available
    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterSeconds = Math.ceil(tokensNeeded / refillRatePerMs / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  /**
   * Read-only inspection of the current rate-limit state for a user.
   *
   * Returns:
   *   - `{ limit: null, remaining: null, resetInSeconds: null }` when
   *     `perUserMessagesPerMinute === 0` (unlimited)
   *   - Otherwise:
   *     `{ limit: N, remaining: <0..N>, resetInSeconds: <0..60> }`
   *
   * `resetInSeconds` is the number of seconds until the bucket would be
   * completely full again (i.e. elapsed time until it reaches `capacity`).
   * When the bucket is already full, resetInSeconds is 0.
   *
   * @param username - the authenticated username (bucket key)
   * @param nowMs    - current time in milliseconds (injectable for testing)
   */
  peekRateLimit(
    username: string,
    nowMs: number = Date.now(),
  ): { limit: null; remaining: null; resetInSeconds: null } | {
    limit: number;
    remaining: number;
    resetInSeconds: number;
  } {
    const capacity = this.config.perUserMessagesPerMinute ?? 0;
    if (capacity === 0) {
      return { limit: null, remaining: null, resetInSeconds: null };
    }

    const refillRatePerMs = capacity / 60_000; // tokens per millisecond

    const bucket = this.rateBuckets.get(username);
    let currentTokens: number;
    if (!bucket) {
      // No bucket yet → fresh user, full capacity
      currentTokens = capacity;
    } else {
      // Compute refilled tokens WITHOUT mutating the bucket
      const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
      currentTokens = Math.min(
        capacity,
        bucket.tokens + elapsed * refillRatePerMs,
      );
    }

    const remaining = Math.floor(currentTokens);

    // How many seconds until a full bucket (capacity tokens)?
    const tokensNeeded = capacity - currentTokens;
    const resetInSeconds =
      tokensNeeded <= 0
        ? 0
        : Math.ceil(tokensNeeded / refillRatePerMs / 1000);

    return {
      limit: capacity,
      remaining,
      resetInSeconds: Math.min(resetInSeconds, 60),
    };
  }

  private get maxAttachmentCount(): number {
    // opts takes precedence (allows test injection); fall back to parsed config
    return this.opts.maxAttachmentCount ?? this.config.maxAttachmentCount ?? 0;
  }

  private get maxAttachmentBytes(): number {
    return this.opts.maxAttachmentBytes ?? this.config.maxAttachmentBytes ?? 0;
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err }, 'Unhandled error in HTTP request handler');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      });
    });

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

  /**
   * Inject Access-Control-Allow-Origin onto an outgoing response object.
   * Called for every non-OPTIONS response so browsers accept actual responses
   * after a successful preflight.
   */
  private addCorsHeaders(headers: Record<string, string>): Record<string, string> {
    return {
      ...headers,
      // Default to "*" if not configured (matches the helm default + the
      // HTTP_CHANNEL_CORS_ORIGIN env-var fallback). Defends against test
      // configs that omit corsOrigin without disabling the cors path.
      'Access-Control-Allow-Origin': this.config.corsOrigin ?? '*',
    };
  }

  /**
   * Map from path (or path prefix key) to the HTTP methods that are valid
   * for the OPTIONS preflight Allow header.
   * OPTIONS is intentionally excluded from each list because it is handled
   * by the early dispatch block — it must not appear in the pathMethods 405
   * table.
   */
  private static readonly CORS_PATH_METHODS: Record<string, string[]> = {
    '/': ['GET'],
    '/healthz': ['GET', 'HEAD'],
    '/readyz': ['GET', 'HEAD'],
    '/version': ['GET', 'HEAD'],
    '/whoami': ['GET', 'HEAD'],
    '/stream': ['GET'],
    '/message/rate-limit': ['GET', 'HEAD'],
    '/message': ['POST'],
    '/history': ['GET', 'DELETE'],
    '/history/': ['GET', 'HEAD', 'DELETE', 'PATCH'], // prefix — dynamic ids
    '/attachments/list': ['GET'],
    '/attachments/raw/': ['GET', 'HEAD', 'DELETE'], // prefix — dynamic filenames
    '/export': ['GET', 'HEAD'],
    '/jobs': ['GET', 'HEAD'],
    '/jobs/': ['GET', 'HEAD', 'DELETE'], // prefix — dynamic ids
    '/schedule': ['GET', 'HEAD', 'POST'],
    '/schedule/': ['DELETE', 'PATCH', 'HEAD', 'GET'], // prefix — dynamic ids + /runs sub-resource
    '/capabilities': ['GET', 'HEAD'],
    '/search': ['GET', 'HEAD'],
    '/secrets': ['GET', 'HEAD', 'POST'],
    '/secrets/': ['DELETE', 'HEAD'], // prefix — dynamic types
    '/secrets/catalog': ['GET', 'HEAD'],
    '/memory': ['GET', 'HEAD', 'PUT', 'PATCH'],
    '/skills': ['GET', 'HEAD'],
    '/skills/': ['POST'], // prefix — candidates/<id>/accept|reject
    '/diag': ['GET', 'HEAD'],
    '/audit': ['GET', 'HEAD'],
  };

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Reject any request whose raw URL contains path-traversal sequences
    // before URL normalisation can resolve them away.
    const rawUrl = req.url ?? '/';
    if (rawUrl.includes('..')) {
      res.writeHead(400, {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': this.config.corsOrigin,
      });
      res.end('Bad Request');
      return;
    }

    const url = new URL(rawUrl, `http://localhost:${this.config.port}`);

    // CORS preflight — must come before auth so browsers can complete the
    // preflight exchange without credentials (OPTIONS never requires auth).
    if (req.method === 'OPTIONS') {
      // Resolve allowed methods for this path
      let allowedMethods: string[] | undefined =
        HttpChannel.CORS_PATH_METHODS[url.pathname];
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
      if (!allowedMethods && /^\/secrets\/[^/]+$/.test(url.pathname) && url.pathname !== '/secrets/catalog') {
        allowedMethods = HttpChannel.CORS_PATH_METHODS['/secrets/'];
      }
      if (!allowedMethods && /^\/skills\/candidates\/[^/]+\/(accept|reject)$/.test(url.pathname)) {
        allowedMethods = HttpChannel.CORS_PATH_METHODS['/skills/'];
      }

      const methodsList = allowedMethods
        ? allowedMethods.join(', ')
        : 'GET, POST, DELETE';

      res.writeHead(204, {
        'Access-Control-Allow-Origin': this.config.corsOrigin,
        'Access-Control-Allow-Methods': methodsList,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // Health check — no auth required (before auth so probes don't need credentials)
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
      // Other methods fall through to pathMethods 405 handler below
    }

    // Readiness check — no auth required; checks DB + Redis reachability
    if (url.pathname === '/readyz') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const dbResult = this.checkDb();
        const redisResult = await this.checkRedis();
        const allOk = dbResult === 'ok' && redisResult === 'ok';
        const statusCode = allOk ? 200 : 503;
        const responseBody: ReadyzBody = {
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
      // Other methods fall through to pathMethods 405 handler below
    }

    // Version info — no auth required (parity with /healthz)
    if (url.pathname === '/version') {
      if (req.method === 'GET') {
        const body = JSON.stringify(buildVersionPayload());
        res.writeHead(200, this.addCorsHeaders({
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'Cache-Control': 'no-store',
        }));
        res.end(body);
        return;
      }
      if (req.method === 'HEAD') {
        const body = JSON.stringify(buildVersionPayload());
        res.writeHead(200, this.addCorsHeaders({
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'Cache-Control': 'no-store',
        }));
        res.end();
        return;
      }
      // Other methods fall through to pathMethods 405 handler below
    }

    // Authenticated identity — requires auth
    if (url.pathname === '/whoami') {
      // Method guard first — reject disallowed methods before auth check
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({
          'Content-Type': 'text/plain',
          Allow: 'GET, HEAD',
        }));
        res.end('Method Not Allowed');
        return;
      }

      // Only after method is allowed, check auth
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      // Build response — exactly 3 fields, no spread
      const group = `http:${username}`;
      const registered = this.opts.registeredGroups()[group];
      const group_folder = registered?.folder ?? '';
      const payload = {
        username,
        group,
        group_folder,
      };
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

    // Serve chat UI without auth (browser will prompt via Basic auth challenge)
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

      res.writeHead(200, this.addCorsHeaders({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // disable nginx buffering
      }));
      res.write(':ok\n\n'); // initial heartbeat

      // Last-Event-ID catch-up (Story 20 AC2/AC4)
      const lastEventIdHeader = req.headers['last-event-id'];
      if (lastEventIdHeader) {
        const lastEventIdMs = Number(lastEventIdHeader);
        const maxAgeMs = 24 * 60 * 60 * 1000; // 24h
        if (
          Number.isFinite(lastEventIdMs) &&
          Date.now() - lastEventIdMs <= maxAgeMs
        ) {
          const jid = `http:${username}`;
          const sinceIso = new Date(lastEventIdMs).toISOString();
          try {
            const missed = getOutboundMessagesSince(jid, sinceIso, 200);
            for (const msg of missed) {
              // id: is the message timestamp in ms for client-side monotonicity
              const msgIdMs = new Date(msg.timestamp).getTime();
              const lines = msg.content.split('\n');
              const payload =
                `id: ${msgIdMs}\n` +
                lines.map((l) => `data: ${l}`).join('\n') +
                '\n\n';
              if (!res.writableEnded) res.write(payload);
            }
          } catch (err) {
            logger.warn({ err, username }, 'SSE catch-up query failed');
          }
        }
      }

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

    // Rate-limit status endpoint — must come BEFORE the generic /message check
    // so the literal path "/message/rate-limit" is not intercepted.
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      url.pathname === '/message/rate-limit'
    ) {
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

    // Inbound message from browser
    if (req.method === 'POST' && url.pathname === '/message') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      // Rate-limit check — BEFORE any DB or LLM work so rejected requests
      // do not consume resources (AC4: no DB row increment on 429 path).
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

      if (
        !contentType.startsWith('application/json') &&
        !contentType.startsWith('multipart/form-data')
      ) {
        res.writeHead(415, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Unsupported Media Type');
        return;
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;

      req.on('data', (chunk: Buffer) => {
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
          // Trigger auto-registration (same as the text path via handleInbound)
          // before checking for the group, so a first-ever image POST from an
          // unregistered user is not silently dropped.
          this.opts.onChatMetadata(
            jid,
            new Date().toISOString(),
            username,
            'http',
            false,
          );
          const group = this.opts.registeredGroups()[jid];
          if (!group) {
            logger.debug({ jid }, 'HTTP image from unregistered user');
            res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ id: null }));
            return;
          }

          const ext = mime.split('/')[1].replace('jpeg', 'jpg');
          const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
          const attachDir = path.join(GROUPS_DIR, jid, 'attachments', 'raw');

          // ── Per-user attachment quota check ───────────────────────────────
          // Re-read the live directory so quota reflects recent DELETEs.
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
          // ─────────────────────────────────────────────────────────────────

          fs.mkdirSync(attachDir, { recursive: true });
          fs.writeFileSync(path.join(attachDir, filename), imagePart.data);

          const caption = textPart?.data.toString('utf8').trim() ?? '';
          const marker = caption
            ? `[ImageAttachment: attachments/raw/${filename} caption="${caption}"]`
            : `[ImageAttachment: attachments/raw/${filename}]`;
          // Write the attachment marker directly to conversation_history so the
          // row is visible immediately (before the LLM pipeline processes the
          // message from the messages table).
          appendConversationMessage(group.folder, 'user', marker);
          const attachMsgId = this.handleInbound(username, marker);

          res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ id: attachMsgId, attachment: filename }));
          return;
        }

        // JSON text message
        try {
          const { text } = JSON.parse(body.toString('utf8')) as {
            text?: string;
          };
          if (!text?.trim()) {
            res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
            res.end('Missing text');
            return;
          }
          // Return the message ID so clients can correlate tool-job
          // interruption notices back to this request (Story 25 establishes
          // the field; Story 37 propagates it to orphan-job notices).
          const msgId = this.handleInbound(username, text.trim());
          res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ id: msgId }));
        } catch {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Invalid JSON');
        }
          } catch (err) {
            // Unhandled error in the multipart or JSON path — e.g. quota
            // helper throwing EACCES on a malconfigured PVC. Without this
            // boundary the void IIFE leaves the response hanging open and
            // produces an unhandled promise rejection.
            logger.error(
              { err },
              'POST /message handler error after body received',
            );
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

    // Attachment list endpoint
    // GET /attachments/list
    if (req.method === 'GET' && url.pathname === '/attachments/list') {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      const jid = `http:${username}`;
      const attachDir = path.join(GROUPS_DIR, jid, 'attachments', 'raw');
      let entries: { filename: string; size: number; modifiedAt: string }[];
      try {
        const names = await fs.promises.readdir(attachDir);
        entries = await Promise.all(
          names.map(async (name) => {
            const st = await fs.promises.stat(path.join(attachDir, name));
            return {
              filename: name,
              size: st.size,
              modifiedAt: st.mtime.toISOString(),
            };
          }),
        );
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          entries = [];
        } else {
          logger.error({ err, attachDir }, 'GET /attachments/list failed');
          res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Internal server error' }));
          return;
        }
      }
      res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify(entries));
      return;
    }

    // Attachment download endpoint
    // GET / HEAD /attachments/raw/<filename>
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      url.pathname.startsWith('/attachments/raw/')
    ) {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const filename = url.pathname.slice('/attachments/raw/'.length);

      // Reject path traversal: no slashes, backslashes, or '..' segments
      if (
        !filename ||
        filename.includes('/') ||
        filename.includes('\\') ||
        filename.includes('..')
      ) {
        res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Bad Request');
        return;
      }

      const jid = `http:${username}`;
      const attachDir = path.join(GROUPS_DIR, jid, 'attachments', 'raw');
      const filePath = path.join(attachDir, filename);

      let fileData: Buffer;
      try {
        fileData = fs.readFileSync(filePath);
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Not Found');
        } else {
          logger.error({ err, filePath }, 'GET /attachments/raw failed');
          res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Internal Server Error');
        }
        return;
      }

      // Derive Content-Type from extension or magic bytes
      const ext = path.extname(filename).toLowerCase();
      const extMime: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      };
      const contentType =
        extMime[ext] ?? detectMediaType(fileData) ?? 'application/octet-stream';

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

    // Attachment delete endpoint
    // DELETE /attachments/raw/<filename>
    if (
      req.method === 'DELETE' &&
      url.pathname.startsWith('/attachments/raw/')
    ) {
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      const filename = url.pathname.slice('/attachments/raw/'.length);

      // Reject path traversal: no slashes, backslashes, or '..' segments
      if (
        !filename ||
        filename.includes('/') ||
        filename.includes('\\') ||
        filename.includes('..')
      ) {
        res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Bad Request');
        return;
      }

      const jid = `http:${username}`;
      const attachDir = path.join(GROUPS_DIR, jid, 'attachments', 'raw');
      const filePath = path.join(attachDir, filename);

      fs.unlink(filePath, (err) => {
        if (!err) {
          res.writeHead(204, this.addCorsHeaders({}));
          res.end();
        } else if (err.code === 'ENOENT') {
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Not Found');
        } else {
          logger.error({ err, filePath }, 'DELETE /attachments/raw failed');
          res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Internal Server Error');
        }
      });
      return;
    }

    // Conversation history endpoint
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
        const messages = getConversationHistoryPage(group.folder, {
          limit,
          before: before ?? undefined,
        });

        res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ messages }));
      } catch (err) {
        logger.error({ err, jid }, 'GET /history failed');
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
        // Story 78: time-bounded purge
        const d = new Date(beforeParam);
        if (!Number.isFinite(d.getTime())) {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(
            JSON.stringify({
              error: 'before must be a valid ISO-8601 timestamp',
            }),
          );
          return;
        }
        try {
          const deleted = deleteConversationHistoryBefore(group.folder, d);
          // Story 81: audit before responding (after op succeeds)
          try {
            writeAuditEntry({
              groupFolder: group.folder,
              actor: username,
              action: 'history.purge',
              detail: `before=${beforeParam}, deleted=${deleted}`,
            });
          } catch (auditErr) {
            logger.error({ err: auditErr, jid }, 'Audit write failed for history.purge');
          }
          res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ deleted }));
        } catch (err) {
          logger.error({ err, jid }, 'DELETE /history?before= failed');
          res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
      }

      // Story 26 full-clear (no ?before param)
      try {
        clearConversationHistory(group.folder);
        // Story 81: audit before responding (after op succeeds)
        try {
          writeAuditEntry({
            groupFolder: group.folder,
            actor: username,
            action: 'history.clear',
          });
        } catch (auditErr) {
          logger.error({ err: auditErr, jid }, 'Audit write failed for history.clear');
        }
        res.writeHead(204, this.addCorsHeaders({}));
        res.end();
      } catch (err) {
        logger.error({ err, jid }, 'DELETE /history failed');
        res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }

    // Stories 56 + 64 + 82: /history/<id> — single-message GET, HEAD, DELETE, PATCH
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

      // Story 82: PATCH /history/<id> — edit/redact a single message
      if (method === 'PATCH') {
        const MAX_PATCH_BODY = 256 * 1024; // 256 KiB
        const chunks: Buffer[] = [];
        let totalSize = 0;
        let tooLarge = false;

        req.on('data', (chunk: Buffer) => {
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
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof (parsed as Record<string, unknown>).content !== 'string'
          ) {
            res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'content must be a string' }));
            return;
          }
          const newContent = (parsed as { content: string }).content;
          const updated = updateConversationMessage(msgId, newContent, group.folder);
          if (!updated) {
            res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
          }
          const row = getMessageById(msgId, group.folder);
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

      // Story 64: GET /history/<id> — fetch single message
      if (method === 'GET' || method === 'HEAD') {
        const row = getMessageById(msgId, group.folder);
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

      // Story 56: DELETE /history/<id>
      const deleted = deleteMessageById(msgId, group.folder);
      if (deleted) {
        // Story 81: audit before responding (after op succeeds)
        try {
          writeAuditEntry({
            groupFolder: group.folder,
            actor: username,
            action: 'history.delete',
            target: msgId,
          });
        } catch (auditErr) {
          logger.error({ err: auditErr, msgId }, 'Audit write failed for history.delete');
        }
        res.writeHead(204, this.addCorsHeaders({}));
        res.end();
        return;
      }
      // Row not found for this group — disambiguate: exists in another group → 403; truly gone → 404
      const unscopedRows = db.exec(
        `SELECT group_folder FROM conversation_history WHERE id = ?`,
        [msgId],
      );
      if (unscopedRows.length > 0 && unscopedRows[0].values.length > 0) {
        res.writeHead(403, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Forbidden' }));
      } else {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Not found' }));
      }
      return;
    }

    // Story 52: GET /export — stream full conversation history as NDJSON.
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      url.pathname === '/export'
    ) {
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
        const rows = getAllConversationHistory(group.folder, username);
        for (const row of rows) {
          res.write(JSON.stringify(row) + '\n');
        }
        res.end();
      } catch (err) {
        // Headers already sent (200), so we can't change status. Log and
        // end the response — the client gets a truncated NDJSON body.
        logger.error({ err, jid }, 'GET /export failed mid-stream');
        res.end();
      }
      return;
    }

    // Story 69: GET/HEAD/DELETE /jobs/<id> — single-job detail and cancel
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

      // Look up the job scoped to this group
      const job = getToolJobByIdForGroup(jobId, groupFolder);

      // GET / HEAD — fetch job detail
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

      // DELETE — cancel the job via IPC
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
        // Story 81: audit before responding (after op succeeds)
        try {
          writeAuditEntry({
            groupFolder,
            actor: username,
            action: 'job.kill',
            target: jobId,
          });
        } catch (auditErr) {
          logger.error({ err: auditErr, jobId }, 'Audit write failed for job.kill');
        }
        res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ status: 'cancelled', job_id: jobId }));
      } catch (err) {
        logger.error({ err, jobId, groupFolder }, 'DELETE /jobs/<id> kill failed');
        res.writeHead(504, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'IPC timeout — orchestrator did not respond' }));
      }
      return;
    }

    // Story 65: GET /jobs — list tool jobs for the authenticated group
    if (url.pathname === '/jobs') {
      // Method check before auth so 405 is returned for unsupported methods
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

      // Validate status query param (must be 'active', 'completed', or absent)
      const statusParam = url.searchParams.get('status');
      if (statusParam !== null && statusParam !== 'active' && statusParam !== 'completed') {
        res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Invalid status parameter. Must be "active" or "completed".' }));
        return;
      }

      // Parse and cap limit
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
        // getActiveToolJobs() returns all active jobs across all groups; filter to this group
        jobs = getActiveToolJobs().filter((j) => j.group_folder === groupFolder);
      } else {
        // getRecentToolJobsForGroup returns non-active rows (completed/interrupted/timeout/oomkill)
        jobs = getRecentToolJobsForGroup(groupFolder, limit);
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

    // Stories 68 + 71: /schedule — list and create scheduled tasks
    if (url.pathname === '/schedule') {
      // Method check before auth so 405 is returned for unsupported methods
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

      // Story 71: POST /schedule — create a new scheduled task
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        await new Promise<void>((resolve) => req.on('end', resolve));
        const rawBody = Buffer.concat(chunks).toString('utf8');

        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Body must be a JSON object' }));
          return;
        }

        const body = parsed as Record<string, unknown>;
        const { schedule_type, schedule_expression, prompt } = body;

        // Validate required fields
        if (
          typeof schedule_type !== 'string' ||
          typeof schedule_expression !== 'string' ||
          typeof prompt !== 'string'
        ) {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'schedule_type, schedule_expression, and prompt are required strings' }));
          return;
        }

        if (!prompt.trim()) {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'prompt must not be empty' }));
          return;
        }

        // Validate schedule_type strictly
        if (
          schedule_type !== 'interval' &&
          schedule_type !== 'cron' &&
          schedule_type !== 'once'
        ) {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'schedule_type must be "interval", "cron", or "once"' }));
          return;
        }

        // Validate schedule_expression semantics and compute next_run
        let next_run: string | null;
        if (schedule_type === 'once') {
          // Must be a valid ISO date
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
          // cron — validate by attempting parse
          try {
            next_run = CronExpressionParser.parse(schedule_expression, {
              tz: TIMEZONE,
            })
              .next()
              .toISOString();
          } catch {
            res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: `Invalid cron expression: '${schedule_expression}'` }));
            return;
          }
        }

        // Generate a UUID-style id
        const id = randomBytes(16)
          .toString('hex')
          .replace(
            /(.{8})(.{4})(.{4})(.{4})(.{12})/,
            '$1-$2-$3-$4-$5',
          );

        const created_at = new Date().toISOString();
        createTask({
          id,
          group_folder: groupFolder,
          chat_jid: jid,
          prompt: prompt.trim(),
          schedule_type: schedule_type as 'interval' | 'cron' | 'once',
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

      // GET / HEAD — list scheduled tasks for the authenticated group
      // Validate status query param (must be 'active', 'paused', or absent)
      const statusParam = url.searchParams.get('status');
      if (statusParam !== null && statusParam !== 'active' && statusParam !== 'paused') {
        res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Invalid status parameter. Must be "active" or "paused".' }));
        return;
      }

      let tasks = getTasksForGroup(groupFolder);

      // Filter by status if provided
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

    // Story 71: /schedule/<id> — DELETE and PATCH individual scheduled tasks
    const scheduleIdMatch = /^\/schedule\/([^/]+)$/.exec(url.pathname);
    if (scheduleIdMatch) {
      const taskId = scheduleIdMatch[1];

      // Method guard before auth so 405 is returned without leaking auth info
      if (
        req.method !== 'DELETE' &&
        req.method !== 'PATCH' &&
        req.method !== 'HEAD'
      ) {
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
        // HEAD mirrors GET existence check — 200 if owned, 404 if not
        const task = getTaskById(taskId);
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
        const deleted = deleteTaskForGroup(taskId, groupFolder);
        if (!deleted) {
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        // Story 81: audit before responding (after op succeeds)
        try {
          writeAuditEntry({
            groupFolder,
            actor: username,
            action: 'schedule.delete',
            target: taskId,
          });
        } catch (auditErr) {
          logger.error({ err: auditErr, taskId }, 'Audit write failed for schedule.delete');
        }
        res.writeHead(204, this.addCorsHeaders({}));
        res.end();
        return;
      }

      if (req.method === 'PATCH') {
        // Read and parse body
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        await new Promise<void>((resolve) => req.on('end', resolve));
        const rawBody = Buffer.concat(chunks).toString('utf8');

        let patchBody: unknown;
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
          typeof (patchBody as Record<string, unknown>).paused !== 'boolean'
        ) {
          res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: '{ paused: boolean } required' }));
          return;
        }

        const { paused } = patchBody as { paused: boolean };

        // Verify the task exists and belongs to this group
        const task = getTaskById(taskId);
        if (!task || task.group_folder !== groupFolder) {
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        const ok = paused
          ? pauseTask(taskId, groupFolder)
          : resumeTask(taskId, groupFolder);

        if (!ok) {
          // Task disappeared between the existence check and the update — treat as 404
          res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        // Story 81: audit before responding (after op succeeds)
        try {
          writeAuditEntry({
            groupFolder,
            actor: username,
            action: paused ? 'schedule.pause' : 'schedule.resume',
            target: taskId,
          });
        } catch (auditErr) {
          logger.error({ err: auditErr, taskId }, 'Audit write failed for schedule.pause/resume');
        }

        // Re-fetch to return the current state
        const updated = getTaskById(taskId)!;
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

    // Story 80: GET /schedule/<id>/runs — run-log history for a single task
    const scheduleRunsMatch = /^\/schedule\/([^/]+)\/runs$/.exec(url.pathname);
    if (scheduleRunsMatch) {
      const taskId = scheduleRunsMatch[1];

      // Method guard before auth so 405 is returned without leaking auth info
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

      // Ownership pre-check: task must exist and belong to this group
      const task = getTaskById(taskId);
      if (!task || task.group_folder !== groupFolder) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      // Parse optional ?limit=N (default 20, cap 100)
      const rawLimit = url.searchParams.get('limit');
      const parsedLimit = rawLimit !== null ? parseInt(rawLimit, 10) : 20;
      const limit = Number.isNaN(parsedLimit) || parsedLimit < 1 ? 20 : Math.min(parsedLimit, 100);

      const runs = getTaskRunLogs(taskId, groupFolder, limit);
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

    // Story 70: GET /capabilities — list provisioned per-group capabilities
    if (url.pathname === '/capabilities') {
      // Method guard before auth so 405 is returned without leaking auth info
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

      const capabilities = this.opts.getCapabilities
        ? this.opts.getCapabilities(groupFolder)
        : [];

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

    // Story 72: GET /search?q= — full-text history search for the authenticated group
    if (url.pathname === '/search') {
      // 405 for methods other than GET and HEAD (before auth)
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

      // Validate q parameter
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

      // Resolve group folder from authenticated user's registered group
      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Group not found' }));
        return;
      }

      // Parse and cap limit
      const DEFAULT_LIMIT = 20;
      const MAX_LIMIT = 100;
      const rawLimit = url.searchParams.get('limit');
      let limit = DEFAULT_LIMIT;
      if (rawLimit !== null) {
        const parsed = Number(rawLimit);
        limit = Number.isFinite(parsed) && parsed > 0
          ? Math.min(Math.floor(parsed), MAX_LIMIT)
          : DEFAULT_LIMIT;
      }

      const results = searchConversations({
        groupFolder: group.folder,
        query: q.trim(),
        limit,
      });

      // Map to wire format: { id, role, content, timestamp }
      const payload = JSON.stringify(
        results.map((r) => ({
          id: r.id,
          role: r.role,
          content: r.content,
          timestamp: r.createdAt,
        })),
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

    // ── GET /secrets/catalog — credential catalog (no auth values) ───────────
    if (url.pathname === '/secrets/catalog') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({
          Allow: 'GET, HEAD',
          'Content-Type': 'text/plain',
        }));
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

    // ── /secrets/<type> — per-type operations ────────────────────────────────
    const secretTypeMatch = url.pathname.match(/^\/secrets\/([^/]+)$/);
    if (secretTypeMatch) {
      if (req.method !== 'DELETE' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({
          Allow: 'DELETE, HEAD',
          'Content-Type': 'text/plain',
        }));
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

    // ── GET/POST /secrets — list group secrets or provision a credential ────────
    if (url.pathname === '/secrets') {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        res.writeHead(405, this.addCorsHeaders({
          Allow: 'GET, HEAD, POST',
          'Content-Type': 'text/plain',
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

    // ── GET /skills — list accepted, candidates, archived ────────────────────
    // Method guard FIRST — 405 before auth so unsupported methods don't leak info
    if (url.pathname === '/skills') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({
          Allow: 'GET, HEAD',
          'Content-Type': 'text/plain',
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

      const accepted = listAcceptedSkills(GROUPS_DIR, group.folder).map((s) => ({
        slug: s.frontmatter.name,
        title: s.frontmatter.name,
        description: s.frontmatter.description,
      }));
      const candidates = listCandidates(GROUPS_DIR, group.folder).map((c) => ({
        slug: c.id,
        title: c.skill.frontmatter.name,
        description: c.skill.frontmatter.description,
      }));
      const archived = listArchived(GROUPS_DIR, group.folder).map((s) => ({
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

    // ── POST /skills/candidates/<id>/accept|reject ────────────────────────────
    const candidateActionMatch = url.pathname.match(
      /^\/skills\/candidates\/([^/]+)\/(accept|reject)$/,
    );
    if (candidateActionMatch) {
      // Method guard FIRST — 405 before auth so unsupported methods don't leak info
      if (req.method !== 'POST') {
        res.writeHead(405, this.addCorsHeaders({
          Allow: 'POST',
          'Content-Type': 'text/plain',
        }));
        res.end('Method Not Allowed');
        return;
      }
      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }
      const candidateId = candidateActionMatch[1];
      const action = candidateActionMatch[2] as 'accept' | 'reject';

      // Validate candidate ID to prevent path traversal
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
          acceptCandidate(GROUPS_DIR, group.folder, candidateId);
        } else {
          rejectCandidate(GROUPS_DIR, group.folder, candidateId);
        }
        // Story 81: audit before responding (after op succeeds)
        try {
          writeAuditEntry({
            groupFolder: group.folder,
            actor: username,
            action: action === 'accept' ? 'skill.accept' : 'skill.reject',
            target: candidateId,
          });
        } catch (auditErr) {
          logger.error({ err: auditErr, candidateId }, `Audit write failed for skill.${action}`);
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

    // ── /memory — per-group CLAUDE.md REST API ────────────────────────────────
    // Method guard FIRST — 405 before auth so unsupported methods don't leak info
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

      // PUT or PATCH — body parsing required
      this.handleMemoryWrite(req, res, method, group.folder);
      return;
    }

    // ── GET/HEAD /diag — operational snapshot (auth required) ────────────────
    if (url.pathname === '/diag') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({
          Allow: 'GET, HEAD',
          'Content-Type': 'text/plain',
        }));
        res.end('Method Not Allowed');
        return;
      }

      const username = this.authenticate(req);
      if (!username) {
        this.sendUnauthorized(res);
        return;
      }

      // Derive the group folder for the authenticated user.
      // JID is http:<username>; folder is derived by the channel runner on
      // registration (jidToFolder), but for the diag endpoint we look up the
      // registered group so we use the correct folder even when the JID mapping
      // is non-trivial.
      const jid = `http:${username}`;
      const group = this.opts.registeredGroups()[jid];
      const groupFolder = group?.folder ?? `http-${username}`;

      const snap = getDiagSnapshot(groupFolder, STORE_DIR, GROUPS_DIR);
      const body = JSON.stringify(snap);

      res.writeHead(200, this.addCorsHeaders({
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      }));
      if (req.method === 'GET') {
        res.end(body);
      } else {
        res.end(); // HEAD: headers only
      }
      return;
    }

    // Story 81: GET/HEAD /audit — audit log for destructive admin actions
    if (url.pathname === '/audit') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, this.addCorsHeaders({
          Allow: 'GET, HEAD',
          'Content-Type': 'text/plain',
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
      const groupFolder = group?.folder ?? `http-${username}`;

      // Parse and cap limit (default 50, max 200)
      const rawLimit = url.searchParams.get('limit');
      let auditLimit = 50;
      if (rawLimit !== null) {
        const parsed = parseInt(rawLimit, 10);
        if (Number.isFinite(parsed) && parsed >= 1) {
          auditLimit = Math.min(parsed, 200);
        }
      }

      const entries = getAuditEntries(groupFolder, auditLimit);
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

    // Per RFC 9110: known paths reached with an unsupported method → 405 + Allow
    const pathMethods: Record<string, string[]> = {
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

    res.writeHead(404, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
    res.end('Not found');
  }

  /**
   * Store an inbound user message and return its generated message ID.
   * The ID is returned to callers so it can be included in the HTTP response
   * body (Story 25) and propagated to any tool jobs spawned while processing
   * this message (Story 37 AC2 — orphan-job interruption notices reference it).
   */
  private handleInbound(username: string, text: string): string {
    const jid = `http:${username}`;
    const timestamp = new Date().toISOString();
    const msgId = `${Date.now()}-${++this.messageSeq}`;

    this.opts.onChatMetadata(jid, timestamp, username, 'http', false);

    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      logger.debug({ jid }, 'HTTP message from unregistered user');
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

    logger.info({ jid }, 'HTTP message stored');
    return msgId;
  }

  /** Handle GET /secrets — list secrets for authenticated user's group. */
  private async handleListSecrets(
    groupFolder: string,
    res: ServerResponse,
  ): Promise<void> {
    const fn = this.opts.listSecretsFn;
    if (!fn) {
      res.writeHead(503, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Secret IPC not configured' }));
      return;
    }
    try {
      const entries = await fn(groupFolder);
      // SECURITY: scrub any accidental value fields — only type and fields_present
      const safe = entries.map((e) => ({
        type: String(e.type),
        fields_present: Array.isArray(e.fields_present)
          ? e.fields_present.map(String)
          : [],
      }));
      res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify(safe));
    } catch (err) {
      logger.error({ err, groupFolder }, 'GET /secrets failed');
      res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  }

  /**
   * Handle POST /secrets — provision a credential for the authenticated group.
   *
   * SECURITY:
   * - Body is capped at MAX_SECRETS_BODY_SIZE (64 KiB).
   * - Secret values from `fields` are NEVER echoed in any response.
   * - The group folder comes from the authenticated session — client-supplied
   *   group params are NOT trusted (cross-group isolation).
   */
  private async handleAddSecret(
    groupFolder: string,
    actor: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const fn = this.opts.addSecretFn;
    if (!fn) {
      res.writeHead(503, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Secret IPC not configured' }));
      return;
    }

    // Collect body with size cap
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let oversized = false;

    await new Promise<void>((resolve) => {
      req.on('data', (chunk: Buffer) => {
        if (oversized) return;
        totalSize += chunk.length;
        if (totalSize > MAX_SECRETS_BODY_SIZE) {
          oversized = true;
          // Write 413 before draining/destroying so the client receives it
          if (!res.writableEnded) {
            res.writeHead(413, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ error: 'Request body too large' }));
          }
          // Drain remaining data without buffering it
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

    // Parse JSON body
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    // Validate shape: { type: string, fields: object }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: '{"type":"<id>","fields":{...}} required' }));
      return;
    }
    const raw = body as Record<string, unknown>;

    if (typeof raw.type !== 'string' || raw.type.trim() === '') {
      res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: '"type" must be a non-empty string' }));
      return;
    }

    if (
      typeof raw.fields !== 'object' ||
      raw.fields === null ||
      Array.isArray(raw.fields)
    ) {
      res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: '"fields" must be a non-null object' }));
      return;
    }

    const secretType = raw.type.trim();
    const fields = raw.fields as Record<string, unknown>;

    // Validate all field values are strings
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v !== 'string') {
        res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: `field "${k}" must be a string` }));
        return;
      }
    }

    // Call the injected fn — group comes from auth, never from client body
    let result: { ok: true } | { ok: false; error: string };
    try {
      result = await Promise.race([
        fn(groupFolder, secretType, fields as Record<string, string>),
        new Promise<{ ok: false; error: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5500),
        ),
      ]);
    } catch (err) {
      logger.error({ err, groupFolder, secretType }, 'POST /secrets IPC error');
      // SECURITY: never echo err message that might contain field values
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
      // SECURITY: sanitize error — redact tokens ≥20 chars that might be secret values
      const sanitized = errMsg.replace(/\b[A-Za-z0-9_\-]{20,}\b/g, '[redacted]');
      res.writeHead(502, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: sanitized }));
      return;
    }

    // Story 81: audit before responding (after op succeeds).
    // SECURITY: only log field NAMES, NEVER values.
    try {
      const fieldNames = Object.keys(fields as Record<string, unknown>);
      writeAuditEntry({
        groupFolder,
        actor,
        action: 'secret.add',
        target: secretType,
        detail: `fields=${fieldNames.join(',')}`,
      });
    } catch (auditErr) {
      logger.error({ err: auditErr, groupFolder, secretType }, 'Audit write failed for secret.add');
    }

    // SECURITY: response contains ONLY status and type — no field values, no echo
    res.writeHead(201, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
    res.end(JSON.stringify({ status: 'ok', type: secretType }));
  }

  /** Handle DELETE /secrets/:type — remove a secret for authenticated user's group. */
  private async handleDeleteSecret(
    groupFolder: string,
    secretType: string,
    actor: string,
    res: ServerResponse,
  ): Promise<void> {
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
      // Story 81: audit before responding (after op succeeds)
      try {
        writeAuditEntry({
          groupFolder,
          actor,
          action: 'secret.remove',
          target: secretType,
        });
      } catch (auditErr) {
        logger.error({ err: auditErr, groupFolder, secretType }, 'Audit write failed for secret.remove');
      }
      res.writeHead(204, this.addCorsHeaders({}));
      res.end();
    } catch (err) {
      logger.error({ err, groupFolder, secretType }, 'DELETE /secrets/:type failed');
      res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  }

  /** Handle GET /secrets/catalog — return catalog entries (no secret values). */
  private async handleGetCatalog(res: ServerResponse): Promise<void> {
    const fn = this.opts.listCatalogFn;
    if (!fn) {
      res.writeHead(503, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Catalog IPC not configured' }));
      return;
    }
    try {
      const entries = await fn();
      // SECURITY: scrub to only the documented fields — no spread
      const safe = entries.map((e) => ({
        type: String(e.type),
        required_fields: Array.isArray(e.required_fields)
          ? e.required_fields.map(String)
          : [],
        optional_fields: Array.isArray(e.optional_fields)
          ? e.optional_fields.map(String)
          : [],
        description: String(e.description ?? ''),
      }));
      res.writeHead(200, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify(safe));
    } catch (err) {
      logger.error({ err }, 'GET /secrets/catalog failed');
      res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  }

  /** Handle GET/HEAD /memory — return per-group CLAUDE.md content. */
  private async handleGetMemory(
    groupFolder: string,
    method: string,
    res: ServerResponse,
  ): Promise<void> {
    const memoryPath = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
    let content = '';
    try {
      content = await fsPromises.readFile(memoryPath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err, groupFolder }, 'GET /memory read error');
        res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
        res.end('Internal Server Error');
        return;
      }
      // ENOENT → empty content per spec (NOT 404)
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

  /** Handle PUT/PATCH /memory — write or append to per-group CLAUDE.md atomically. */
  private handleMemoryWrite(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    groupFolder: string,
  ): void {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let oversized = false;

    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_MEMORY_BODY_SIZE) {
        if (!oversized) {
          oversized = true;
          res.writeHead(413, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Payload Too Large');
          req.resume(); // drain without buffering
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
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
            res.end('Bad Request: invalid JSON');
            return;
          }

          const memoryPath = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');

          if (method === 'PUT') {
            const obj = parsed as Record<string, unknown>;
            if (typeof obj?.content !== 'string') {
              res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
              res.end('Bad Request: content must be a string');
              return;
            }
            await fsPromises.mkdir(path.dirname(memoryPath), { recursive: true });
            // Atomic write: temp file then rename
            const tmpPath = path.join(
              path.dirname(memoryPath),
              `.claude-md-tmp-${Date.now()}-${process.pid}`,
            );
            await fsPromises.writeFile(tmpPath, obj.content, 'utf8');
            await fsPromises.rename(tmpPath, memoryPath);
            res.writeHead(204, this.addCorsHeaders({}));
            res.end();
            return;
          }

          if (method === 'PATCH') {
            const obj = parsed as Record<string, unknown>;
            if (typeof obj?.append !== 'string') {
              res.writeHead(400, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
              res.end('Bad Request: append must be a string');
              return;
            }
            await fsPromises.mkdir(path.dirname(memoryPath), { recursive: true });
            let existing = '';
            try {
              existing = await fsPromises.readFile(memoryPath, 'utf8');
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            }
            const separator = existing.length > 0 ? '\n' : '';
            const newContent = existing + separator + obj.append;
            // Atomic write
            const tmpPath = path.join(
              path.dirname(memoryPath),
              `.claude-md-tmp-${Date.now()}-${process.pid}`,
            );
            await fsPromises.writeFile(tmpPath, newContent, 'utf8');
            await fsPromises.rename(tmpPath, memoryPath);
            res.writeHead(204, this.addCorsHeaders({}));
            res.end();
            return;
          }
        } catch (err) {
          logger.error({ err, groupFolder }, '/memory write error');
          if (!res.writableEnded) {
            res.writeHead(500, this.addCorsHeaders({ 'Content-Type': 'text/plain' }));
            res.end('Internal Server Error');
          }
        }
      })();
    });
  }

  private sendSse(username: string, eventType: string, data: string): void {
    const clients = this.sseClients.filter((c) => c.username === username);
    const payload = `event: ${eventType}\ndata: ${data}\n\n`;
    for (const client of clients) {
      try {
        if (!client.res.writableEnded) {
          client.res.write(payload);
        }
      } catch (err) {
        logger.debug(
          { username, err },
          'SSE write failed — client likely disconnected',
        );
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const username = jid.slice('http:'.length);
    const clients = this.sseClients.filter((c) => c.username === username);

    // Monotonically increasing id: use epoch-ms (Story 20 AC1)
    const nowMs = Date.now();
    const timestamp = new Date(nowMs).toISOString();

    // Persist the outbound message so it can be replayed on reconnect (AC2)
    try {
      storeMessageDirect({
        id: `http-out-${nowMs}-${++this.messageSeq}`,
        chat_jid: jid,
        sender: ASSISTANT_NAME,
        sender_name: ASSISTANT_NAME,
        content: text,
        timestamp,
        is_from_me: true,
        is_bot_message: true,
      });
    } catch (err) {
      logger.warn(
        { err, jid },
        'Failed to persist outbound HTTP message for SSE catch-up',
      );
    }

    if (clients.length === 0) {
      logger.debug({ jid }, 'No SSE client connected for HTTP JID');
      return;
    }

    // Escape newlines for SSE data field; split into multiple data lines
    const lines = text.split('\n');
    const ssePayload =
      `id: ${nowMs}\n` + lines.map((l) => `data: ${l}`).join('\n') + '\n\n';

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

  async sendMedia(
    jid: string,
    buffer: Buffer,
    mediaType: string,
    caption?: string,
  ): Promise<void> {
    const username = jid.slice('http:'.length);
    const clients = this.sseClients.filter((c) => c.username === username);

    if (clients.length === 0) {
      logger.debug({ jid }, 'No SSE client connected for HTTP JID (sendMedia)');
      return;
    }

    const payload: { mediaType: string; data: string; caption?: string } = {
      mediaType,
      data: buffer.toString('base64'),
    };
    if (caption !== undefined) payload.caption = caption;

    this.sendSse(username, 'media', JSON.stringify(payload));
    logger.info(
      { jid, mediaType, clients: clients.length },
      'HTTP media sent via SSE',
    );
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
  const envVars = readEnvFile([
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

  // HTTP_CHANNEL_RATE_LIMIT_PER_USER_MESSAGES_PER_MINUTE: max POST /message
  // requests per user per 60-second window. 0 = unlimited. Default 60.
  const rateLimitRaw =
    process.env.HTTP_CHANNEL_RATE_LIMIT_PER_USER_MESSAGES_PER_MINUTE ||
    envVars.HTTP_CHANNEL_RATE_LIMIT_PER_USER_MESSAGES_PER_MINUTE ||
    '60';
  const parsedRateLimit = parseInt(rateLimitRaw, 10);
  const perUserMessagesPerMinute = Math.max(
    0,
    Number.isNaN(parsedRateLimit) ? 60 : parsedRateLimit,
  );

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

// ── Module-level IPC callbacks for /secrets routes ───────────────────────────
// Set once at startup by channel-runner.ts via configureHttpSecretIpc().
// Using module-level state (same pattern as registerSecretDeps in ipc-redis.ts)
// avoids circular imports while keeping the factory function simple.
let _listSecretsFn: ListSecretsFn | undefined;
let _removeSecretFn: RemoveSecretFn | undefined;
let _listCatalogFn: ListCatalogFn | undefined;
let _addSecretFn: AddSecretFn | undefined;

/**
 * Wire up IPC-backed callbacks for the /secrets REST endpoints.
 * Called once at startup by channel-runner.ts before the channel connects.
 */
export function configureHttpSecretIpc(
  listSecretsFn: ListSecretsFn,
  removeSecretFn: RemoveSecretFn,
  listCatalogFn: ListCatalogFn,
  addSecretFn: AddSecretFn,
): void {
  _listSecretsFn = listSecretsFn;
  _removeSecretFn = removeSecretFn;
  _listCatalogFn = listCatalogFn;
  _addSecretFn = addSecretFn;
}

registerChannel('http', (opts: ChannelOpts) => {
  const config = parseConfig();
  if (!config) return null;
  // Cast to HttpChannelOpts so optional extras (e.g. getCapabilities) passed
  // in by channel-runner are forwarded to the channel.
  return new HttpChannel(config, {
    ...(opts as HttpChannelOpts),
    listSecretsFn: _listSecretsFn,
    removeSecretFn: _removeSecretFn,
    listCatalogFn: _listCatalogFn,
    addSecretFn: _addSecretFn,
  });
});
