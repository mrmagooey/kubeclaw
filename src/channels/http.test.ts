import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
// Mutable flag read by the config mock — set per-test to override DEBUG_ENDPOINTS_ENABLED.
let _debugEndpointsEnabled = false;

vi.mock('../db.js', () => {
  const dbExec = vi.fn(() => []);
  return {
    appendConversationMessage: vi.fn(),
    clearConversationHistory: vi.fn(),
    createTask: vi.fn(),
    deleteConversationHistoryBefore: vi.fn(() => 0),
    deleteMessageById: vi.fn(() => false),
    deleteTaskForGroup: vi.fn(() => false),
    getAuditEntries: vi.fn(() => []),
    getConversationHistory: vi.fn(() => []),
    getConversationHistoryPage: vi.fn(() => []),
    getMessageById: vi.fn(() => null),
    updateConversationMessage: vi.fn(() => false),
    getRecentToolJobsForGroup: vi.fn(() => []),
    getActiveToolJobs: vi.fn(() => []),
    getTaskById: vi.fn(() => null),
    getTaskRunLogs: vi.fn(() => []),
    getTasksForGroup: vi.fn(() => []),
    getToolJobByIdForGroup: vi.fn(() => null),
    pauseTask: vi.fn(() => false),
    resumeTask: vi.fn(() => false),
    searchConversations: vi.fn(() => []),
    insertToolJobForDebug: vi.fn(),
    writeAuditEntry: vi.fn(),
    db: { exec: dbExec },
  };
});
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => {
  return {
    ASSISTANT_NAME: 'Andy',
    TRIGGER_PATTERN: /^@Andy\b/i,
    GROUPS_DIR: '/tmp/test-groups',
    RATE_LIMIT_WINDOW_MS: 60000,
    TIMEZONE: 'UTC',
    TOOL_JOBS_RETENTION_DAYS: 30,
    get DEBUG_ENDPOINTS_ENABLED() {
      return _debugEndpointsEnabled;
    },
  };
});
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock fs/promises so the quota helper can be controlled in unit tests.
// Default: empty directory (count=0, bytes=0). Override per-test via vi.mocked().
vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(async () => [] as string[]),
    stat: vi.fn(async () => ({ isFile: () => true, size: 0 })),
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
  },
  readdir: vi.fn(async () => [] as string[]),
  stat: vi.fn(async () => ({ isFile: () => true, size: 0 })),
  readFile: vi.fn(async () => ''),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
}));

// Mock the built-in http module so we don't actually bind a port
const serverListeners = new Map<string, (...args: unknown[]) => void>();
const mockServerInstance = {
  listen: vi.fn((_port: number, cb: () => void) => cb()),
  close: vi.fn((cb: () => void) => cb()),
  on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    serverListeners.set(event, cb);
  }),
};

// Mock skill-store so unit tests don't touch the real filesystem
vi.mock('../runtime/skill-store.js', () => ({
  listAcceptedSkills: vi.fn(),
  listCandidates: vi.fn(),
  listArchived: vi.fn(),
  acceptCandidate: vi.fn(),
  rejectCandidate: vi.fn(),
}));

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: vi.fn(
      (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
        (mockServerInstance as any)._handler = handler;
        return mockServerInstance;
      },
    ),
  };
});

import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import {
  HttpChannel,
  HttpChannelOpts,
  CapabilityEntry,
  buildVersionPayload,
  detectMediaType,
  getAttachmentUsage,
  type AddSecretFn,
} from './http.js';
import {
  appendConversationMessage,
  clearConversationHistory,
  createTask,
  deleteConversationHistoryBefore,
  deleteMessageById,
  deleteTaskForGroup,
  getAuditEntries,
  getConversationHistory,
  getConversationHistoryPage,
  getMessageById,
  updateConversationMessage,
  getRecentToolJobsForGroup,
  getActiveToolJobs,
  getTaskById,
  getTaskRunLogs,
  getTasksForGroup,
  getToolJobByIdForGroup,
  pauseTask,
  resumeTask,
  searchConversations,
  writeAuditEntry,
  insertToolJobForDebug,
} from '../db.js';
import type { ConversationHistoryRow } from '../db.js';
import {
  listAcceptedSkills,
  listCandidates,
  listArchived,
  acceptCandidate,
  rejectCandidate,
} from '../runtime/skill-store.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides?: {
  port?: number;
  users?: Record<string, string>;
  perUserMessagesPerMinute?: number;
  corsOrigin?: string;
}) {
  return {
    port: overrides?.port ?? 4080,
    users: overrides?.users ?? { alice: 'secret', bob: 'hunter2' },
    // Default to unlimited so existing tests don't get throttled.
    perUserMessagesPerMinute: overrides?.perUserMessagesPerMinute ?? 0,
    corsOrigin: overrides?.corsOrigin ?? '*',
  };
}

function makeOpts(overrides?: Partial<HttpChannelOpts>): HttpChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'http:alice': {
        name: 'alice',
        folder: 'alice',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    getCapabilities: vi.fn((_groupFolder: string) => []),
    ...overrides,
  };
}

function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

function makeReq(overrides: {
  method?: string;
  url?: string;
  auth?: string | null; // null = no header, string = "user:pass"
  body?: string;
  contentType?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (overrides.auth !== null) {
    headers.authorization = `Basic ${b64(overrides.auth ?? 'alice:secret')}`;
  }
  // Default Content-Type to application/json when a body is provided —
  // matches Story 29's 415 guard so POST /message tests don't need to repeat
  // the header in every test. Pass contentType:'' to force absence.
  if (overrides.body !== undefined && overrides.contentType !== '') {
    headers['content-type'] = overrides.contentType ?? 'application/json';
  } else if (overrides.contentType) {
    headers['content-type'] = overrides.contentType;
  }
  const req = {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/',
    headers,
    on: vi.fn(),
    destroy: vi.fn(),
    resume: vi.fn(),
  } as unknown as IncomingMessage;

  // Simulate body streaming
  if (overrides.body !== undefined) {
    (req.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'data') cb(Buffer.from(overrides.body!));
        if (event === 'end') cb();
      },
    );
  }

  return req;
}

/** Minimal JPEG magic bytes for media-type detection */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function buildMultipartBody(
  boundary: string,
  parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    data: Buffer | string;
  }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let header = `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) header += `; filename="${part.filename}"`;
    header += '\r\n';
    if (part.contentType) header += `Content-Type: ${part.contentType}\r\n`;
    header += '\r\n';
    chunks.push(Buffer.from(header));
    chunks.push(
      typeof part.data === 'string' ? Buffer.from(part.data) : part.data,
    );
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function makeMultipartReq(opts: {
  auth?: string;
  boundary: string;
  body: Buffer;
}): IncomingMessage {
  const boundary = opts.boundary;
  const auth = opts.auth ?? 'alice:secret';
  const headers: Record<string, string> = {
    authorization: `Basic ${b64(auth)}`,
    'content-type': `multipart/form-data; boundary=${boundary}`,
  };
  const body = opts.body;
  const req = {
    method: 'POST',
    url: '/message',
    headers,
    on: vi.fn(),
    destroy: vi.fn(),
  } as unknown as IncomingMessage;
  (req.on as ReturnType<typeof vi.fn>).mockImplementation(
    (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'data') cb(body);
      if (event === 'end') cb();
    },
  );
  return req;
}

function makeRes(): ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
} {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: '',
    _ended: false,
    writableEnded: false,
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
    }),
    write: vi.fn((data: string) => {
      res._body += data;
    }),
    end: vi.fn((data?: string) => {
      if (data) res._body += data;
      res._ended = true;
      res.writableEnded = true;
    }),
    on: vi.fn(),
  } as unknown as ServerResponse & {
    _status: number;
    _headers: Record<string, string>;
    _body: string;
  };
  return res;
}

async function dispatch(
  channel: HttpChannel,
  req: IncomingMessage,
  res: ReturnType<typeof makeRes>,
): Promise<void> {
  const handler = (mockServerInstance as any)._handler;
  await handler(req, res);
  // Let microtasks settle (body parsing is async)
  await new Promise((r) => setTimeout(r, 0));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('HttpChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverListeners.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  // ── connection lifecycle ─────────────────────────────────────────────────

  describe('connection lifecycle', () => {
    it('resolves connect() after server starts listening', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      await channel.disconnect();
    });

    it('isConnected() returns false before connect', () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false after disconnect', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('listens on configured port', async () => {
      const channel = new HttpChannel(makeConfig({ port: 9999 }), makeOpts());
      await channel.connect();
      expect(mockServerInstance.listen).toHaveBeenCalledWith(
        9999,
        expect.any(Function),
      );
      await channel.disconnect();
    });

    it('has name "http"', () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      expect(channel.name).toBe('http');
    });
  });

  // ── authentication ───────────────────────────────────────────────────────

  describe('authentication', () => {
    it('accepts valid Basic auth credentials', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/', auth: 'alice:secret' });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      await channel.disconnect();
    });

    it('rejects request with no Authorization header', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('Basic realm=');
      await channel.disconnect();
    });

    it('rejects wrong password', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/', auth: 'alice:wrongpass' });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(401);
      await channel.disconnect();
    });

    it('rejects unknown user', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/', auth: 'eve:hacked' });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(401);
      await channel.disconnect();
    });

    it('accepts second configured user', async () => {
      const channel = new HttpChannel(
        makeConfig({ users: { alice: 'secret', bob: 'hunter2' } }),
        makeOpts({
          registeredGroups: vi.fn(() => ({
            'http:bob': {
              name: 'bob',
              folder: 'bob',
              trigger: '@Andy',
              added_at: '2024-01-01T00:00:00.000Z',
            },
          })),
        }),
      );
      await channel.connect();

      const req = makeReq({
        url: '/message',
        method: 'POST',
        auth: 'bob:hunter2',
        body: '{"text":"hi"}',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      await channel.disconnect();
    });
  });

  // ── GET / — chat UI ──────────────────────────────────────────────────────

  describe('GET /', () => {
    it('serves HTML with 200', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/', auth: 'alice:secret' });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(res._headers['Content-Type']).toContain('text/html');
      expect(res._body).toContain('<!DOCTYPE html>');
      await channel.disconnect();
    });

    it('includes SSE stream connection in HTML', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/', auth: 'alice:secret' });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._body).toContain('/stream');
      await channel.disconnect();
    });
  });

  // ── GET /stream — SSE ────────────────────────────────────────────────────

  describe('GET /stream', () => {
    it('opens SSE stream with correct headers', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/stream', auth: 'alice:secret' });
      // Simulate close event
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

      // Clean up
      closeHandlers.forEach((h) => h());
      await channel.disconnect();
    });

    it('removes SSE client on request close', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/stream', auth: 'alice:secret' });
      let onClose: () => void = () => {};
      (req.on as ReturnType<typeof vi.fn>).mockImplementation(
        (event: string, cb: () => void) => {
          if (event === 'close') onClose = cb;
        },
      );

      const res = makeRes();
      await dispatch(channel, req, res);

      // Now close
      onClose();

      // sendMessage should find no clients
      const opts = channel['opts'];
      (opts as HttpChannelOpts).onMessage = vi.fn();
      await channel.sendMessage('http:alice', 'test');
      expect(res.write).toHaveBeenCalledTimes(1); // only the initial :ok\n\n

      await channel.disconnect();
    });
  });

  // ── POST /message — inbound messages ─────────────────────────────────────

  describe('POST /message', () => {
    it('delivers message for registered user', async () => {
      const opts = makeOpts();
      const channel = new HttpChannel(makeConfig(), opts);
      await channel.connect();

      const req = makeReq({
        method: 'POST',
        url: '/message',
        auth: 'alice:secret',
        body: '{"text":"Hello agent!"}',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'http:alice',
        expect.any(String),
        'alice',
        'http',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'http:alice',
        expect.objectContaining({
          chat_jid: 'http:alice',
          sender: 'alice',
          sender_name: 'alice',
          content: 'Hello agent!',
          is_from_me: false,
        }),
      );
      await channel.disconnect();
    });

    it('emits metadata but not message for unregistered user', async () => {
      const opts = makeOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = new HttpChannel(makeConfig(), opts);
      await channel.connect();

      const req = makeReq({
        method: 'POST',
        url: '/message',
        auth: 'alice:secret',
        body: '{"text":"hi"}',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
      await channel.disconnect();
    });

    it('returns 400 for missing text field', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'POST',
        url: '/message',
        auth: 'alice:secret',
        body: '{}',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(400);
      await channel.disconnect();
    });

    it('returns 400 for empty text', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'POST',
        url: '/message',
        auth: 'alice:secret',
        body: '{"text":"   "}',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(400);
      await channel.disconnect();
    });

    it('returns 400 for invalid JSON', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'POST',
        url: '/message',
        auth: 'alice:secret',
        body: 'not-json',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(400);
      await channel.disconnect();
    });

    it('trims whitespace from message content', async () => {
      const opts = makeOpts();
      const channel = new HttpChannel(makeConfig(), opts);
      await channel.connect();

      const req = makeReq({
        method: 'POST',
        url: '/message',
        auth: 'alice:secret',
        body: '{"text":"  hello  "}',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'http:alice',
        expect.objectContaining({ content: 'hello' }),
      );
      await channel.disconnect();
    });
  });

  // ── sendMessage() via SSE ────────────────────────────────────────────────

  describe('sendMessage()', () => {
    it('writes SSE data to connected client', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      // Register SSE client
      const req = makeReq({ url: '/stream', auth: 'alice:secret' });
      const closeHandlers: Array<() => void> = [];
      (req.on as ReturnType<typeof vi.fn>).mockImplementation(
        (event: string, cb: () => void) => {
          if (event === 'close') closeHandlers.push(cb);
        },
      );
      const streamRes = makeRes();
      await dispatch(channel, req, streamRes);

      // Send a message
      await channel.sendMessage('http:alice', 'Hello from agent');

      const calls = (streamRes.write as ReturnType<typeof vi.fn>).mock.calls;
      const dataWritten = calls.map(([d]: [string]) => d).join('');
      expect(dataWritten).toContain('data: Hello from agent');

      closeHandlers.forEach((h) => h());
      await channel.disconnect();
    });

    it('encodes multi-line messages as multiple data: lines', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/stream', auth: 'alice:secret' });
      const closeHandlers: Array<() => void> = [];
      (req.on as ReturnType<typeof vi.fn>).mockImplementation(
        (event: string, cb: () => void) => {
          if (event === 'close') closeHandlers.push(cb);
        },
      );
      const streamRes = makeRes();
      await dispatch(channel, req, streamRes);

      await channel.sendMessage('http:alice', 'line one\nline two');

      const dataWritten = (
        streamRes.write as ReturnType<typeof vi.fn>
      ).mock.calls
        .map(([d]: [string]) => d)
        .join('');
      expect(dataWritten).toContain('data: line one\ndata: line two');

      closeHandlers.forEach((h) => h());
      await channel.disconnect();
    });

    it('does nothing when no SSE client is connected', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();
      // No SSE client registered — should not throw
      await expect(
        channel.sendMessage('http:alice', 'no client'),
      ).resolves.toBeUndefined();
      await channel.disconnect();
    });

    it('only sends to the correct user', async () => {
      const channel = new HttpChannel(
        makeConfig({ users: { alice: 'secret', bob: 'hunter2' } }),
        makeOpts({
          registeredGroups: vi.fn(() => ({
            'http:alice': {
              name: 'alice',
              folder: 'alice',
              trigger: '',
              added_at: '',
            },
            'http:bob': {
              name: 'bob',
              folder: 'bob',
              trigger: '',
              added_at: '',
            },
          })),
        }),
      );
      await channel.connect();

      // Register both SSE clients
      const registerSse = (auth: string) => {
        const req = makeReq({ url: '/stream', auth });
        const closeHandlers: Array<() => void> = [];
        (req.on as ReturnType<typeof vi.fn>).mockImplementation(
          (event: string, cb: () => void) => {
            if (event === 'close') closeHandlers.push(cb);
          },
        );
        const res = makeRes();
        return { req, res, closeHandlers };
      };

      const alice = registerSse('alice:secret');
      const bob = registerSse('bob:hunter2');
      await dispatch(channel, alice.req, alice.res);
      await dispatch(channel, bob.req, bob.res);

      // Send only to alice
      await channel.sendMessage('http:alice', 'For Alice only');

      const aliceData = (alice.res.write as ReturnType<typeof vi.fn>).mock.calls
        .map(([d]: [string]) => d)
        .join('');
      const bobData = (bob.res.write as ReturnType<typeof vi.fn>).mock.calls
        .map(([d]: [string]) => d)
        .join('');

      expect(aliceData).toContain('For Alice only');
      expect(bobData).not.toContain('For Alice only');

      alice.closeHandlers.forEach((h) => h());
      bob.closeHandlers.forEach((h) => h());
      await channel.disconnect();
    });
  });

  // ── sendMedia() via SSE ──────────────────────────────────────────────────

  describe('sendMedia()', () => {
    async function openSseClient(
      channel: HttpChannel,
      auth: string,
    ): Promise<{
      res: ReturnType<typeof makeRes>;
      close: () => void;
    }> {
      const req = makeReq({ url: '/stream', auth });
      const closeHandlers: Array<() => void> = [];
      (req.on as ReturnType<typeof vi.fn>).mockImplementation(
        (event: string, cb: () => void) => {
          if (event === 'close') closeHandlers.push(cb);
        },
      );
      const res = makeRes();
      await dispatch(channel, req, res);
      return { res, close: () => closeHandlers.forEach((h) => h()) };
    }

    it('sends SSE event with type "media" and base64 data', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const { res, close } = await openSseClient(channel, 'alice:secret');

      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      await channel.sendMedia('http:alice', buf, 'image/png', 'A chart');

      const written = (res.write as ReturnType<typeof vi.fn>).mock.calls
        .map(([d]: [string]) => d)
        .join('');

      expect(written).toContain('event: media');
      const dataLine = written.split('\n').find((l) => l.startsWith('data:'));
      expect(dataLine).toBeDefined();
      const parsed = JSON.parse(dataLine!.slice('data: '.length));
      expect(parsed.mediaType).toBe('image/png');
      expect(parsed.caption).toBe('A chart');
      expect(parsed.data).toBe(buf.toString('base64'));

      close();
      await channel.disconnect();
    });

    it('omits caption field when not provided', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const { res, close } = await openSseClient(channel, 'alice:secret');

      const buf = Buffer.from('pdf bytes');
      await channel.sendMedia('http:alice', buf, 'application/pdf');

      const written = (res.write as ReturnType<typeof vi.fn>).mock.calls
        .map(([d]: [string]) => d)
        .join('');

      const dataLine = written.split('\n').find((l) => l.startsWith('data:'));
      const parsed = JSON.parse(dataLine!.slice('data: '.length));
      expect(parsed.mediaType).toBe('application/pdf');
      expect(parsed.caption).toBeUndefined();

      close();
      await channel.disconnect();
    });

    it('does nothing when no SSE client is connected', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const buf = Buffer.from('data');
      await expect(
        channel.sendMedia('http:alice', buf, 'image/jpeg'),
      ).resolves.toBeUndefined();

      await channel.disconnect();
    });

    it('only sends to the correct user', async () => {
      const channel = new HttpChannel(
        makeConfig({ users: { alice: 'secret', bob: 'hunter2' } }),
        makeOpts({
          registeredGroups: vi.fn(() => ({
            'http:alice': {
              name: 'alice',
              folder: 'alice',
              trigger: '',
              added_at: '',
            },
            'http:bob': {
              name: 'bob',
              folder: 'bob',
              trigger: '',
              added_at: '',
            },
          })),
        }),
      );
      await channel.connect();

      const alice = await (async () => {
        const req = makeReq({ url: '/stream', auth: 'alice:secret' });
        const closeHandlers: Array<() => void> = [];
        (req.on as ReturnType<typeof vi.fn>).mockImplementation(
          (event: string, cb: () => void) => {
            if (event === 'close') closeHandlers.push(cb);
          },
        );
        const res = makeRes();
        await dispatch(channel, req, res);
        return { res, close: () => closeHandlers.forEach((h) => h()) };
      })();

      const bob = await (async () => {
        const req = makeReq({ url: '/stream', auth: 'bob:hunter2' });
        const closeHandlers: Array<() => void> = [];
        (req.on as ReturnType<typeof vi.fn>).mockImplementation(
          (event: string, cb: () => void) => {
            if (event === 'close') closeHandlers.push(cb);
          },
        );
        const res = makeRes();
        await dispatch(channel, req, res);
        return { res, close: () => closeHandlers.forEach((h) => h()) };
      })();

      await channel.sendMedia('http:alice', Buffer.from('img'), 'image/png');

      const aliceData = (alice.res.write as ReturnType<typeof vi.fn>).mock.calls
        .map(([d]: [string]) => d)
        .join('');
      const bobData = (bob.res.write as ReturnType<typeof vi.fn>).mock.calls
        .map(([d]: [string]) => d)
        .join('');

      expect(aliceData).toContain('event: media');
      expect(bobData).not.toContain('event: media');

      alice.close();
      bob.close();
      await channel.disconnect();
    });

    it('declares outboundMedia capability', () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      expect(channel.capabilities?.outboundMedia).toBe(true);
    });
  });

  // ── ownsJid() ────────────────────────────────────────────────────────────

  describe('ownsJid()', () => {
    it('owns http: prefixed JIDs', () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      expect(channel.ownsJid('http:alice')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own Signal JIDs', () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      expect(channel.ownsJid('signal:+14155552671')).toBe(false);
    });

    it('does not own IRC JIDs', () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      expect(channel.ownsJid('irc:#general@irc.example.com:6697')).toBe(false);
    });
  });

  // ── POST /message — multipart image upload ───────────────────────────────

  describe('POST /message multipart image upload', () => {
    it('delivers ImageAttachment marker for registered user', async () => {
      const opts = makeOpts();
      const channel = new HttpChannel(makeConfig(), opts);
      await channel.connect();

      const boundary = 'testboundary123';
      const body = buildMultipartBody(boundary, [
        {
          name: 'image',
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
          data: JPEG_MAGIC,
        },
      ]);
      const req = makeMultipartReq({ boundary, body });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'http:alice',
        expect.objectContaining({
          content: expect.stringMatching(
            /^\[ImageAttachment: attachments\/raw\//,
          ),
        }),
      );
      await channel.disconnect();
    });

    it('calls onChatMetadata before group check for first-ever image POST (regression: unregistered user silently dropped)', async () => {
      // This is the core regression: before the fix, the multipart handler
      // returned early without calling onChatMetadata, so auto-registration
      // never fired and the image was silently dropped.
      const groups: Record<string, unknown> = {};
      const opts = makeOpts({
        registeredGroups: vi.fn(() => groups as any),
        onChatMetadata: vi.fn((_jid: string) => {
          // Simulate what channel-runner's onChatMetadata does: auto-register the group
          groups['http:alice'] = {
            name: 'alice',
            folder: 'alice',
            trigger: '',
            added_at: new Date().toISOString(),
          };
        }),
      });
      const channel = new HttpChannel(makeConfig(), opts);
      await channel.connect();

      const boundary = 'testboundary456';
      const body = buildMultipartBody(boundary, [
        {
          name: 'image',
          filename: 'first.jpg',
          contentType: 'image/jpeg',
          data: JPEG_MAGIC,
        },
      ]);
      const req = makeMultipartReq({ boundary, body });
      const res = makeRes();
      await dispatch(channel, req, res);

      // onChatMetadata must be called even when the group wasn't registered yet
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'http:alice',
        expect.any(String),
        'alice',
        'http',
        false,
      );
      // After auto-registration the message must be delivered
      expect(opts.onMessage).toHaveBeenCalledWith(
        'http:alice',
        expect.objectContaining({
          content: expect.stringMatching(
            /^\[ImageAttachment: attachments\/raw\//,
          ),
        }),
      );
      expect(res._status).toBe(200);
      await channel.disconnect();
    });

    it('includes caption in ImageAttachment marker when text part is present', async () => {
      const opts = makeOpts();
      const channel = new HttpChannel(makeConfig(), opts);
      await channel.connect();

      const boundary = 'captionboundary';
      const body = buildMultipartBody(boundary, [
        { name: 'text', data: 'Look at this' },
        {
          name: 'image',
          filename: 'shot.jpg',
          contentType: 'image/jpeg',
          data: JPEG_MAGIC,
        },
      ]);
      const req = makeMultipartReq({ boundary, body });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'http:alice',
        expect.objectContaining({
          content: expect.stringMatching(/caption="Look at this"/),
        }),
      );
      await channel.disconnect();
    });

    it('returns 415 for unrecognised image format', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const boundary = 'badboundary';
      const body = buildMultipartBody(boundary, [
        {
          name: 'image',
          filename: 'file.bin',
          data: Buffer.from([0x00, 0x01, 0x02]),
        },
      ]);
      const req = makeMultipartReq({ boundary, body });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(415);
      await channel.disconnect();
    });

    it('returns 400 when image part is missing', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const boundary = 'noboundary';
      const body = buildMultipartBody(boundary, [
        { name: 'text', data: 'no image here' },
      ]);
      const req = makeMultipartReq({ boundary, body });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(400);
      await channel.disconnect();
    });

    it('writes ImageAttachment marker directly to conversation_history at upload time', async () => {
      // Regression: the e2e test probes conversation_history within 2 s of the
      // POST — before the async LLM pipeline runs. The multipart handler must
      // call appendConversationMessage synchronously so the row is visible
      // immediately, independent of LLM processing speed.
      const opts = makeOpts();
      const channel = new HttpChannel(makeConfig(), opts);
      await channel.connect();

      const boundary = 'historyboundary';
      const body = buildMultipartBody(boundary, [
        { name: 'text', data: 'my caption' },
        {
          name: 'image',
          filename: 'snap.jpg',
          contentType: 'image/jpeg',
          data: JPEG_MAGIC,
        },
      ]);
      const req = makeMultipartReq({ boundary, body });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      // appendConversationMessage must be called with the group folder and the
      // [ImageAttachment:] marker so the row appears before the LLM runs.
      expect(appendConversationMessage).toHaveBeenCalledWith(
        'alice', // group.folder from makeOpts()
        'user',
        expect.stringMatching(/^\[ImageAttachment: attachments\/raw\//),
      );
      // The caption must also be present in the stored marker.
      const calls = (appendConversationMessage as ReturnType<typeof vi.fn>).mock
        .calls;
      const [, , content] = calls[0];
      expect(content).toContain('caption="my caption"');
      await channel.disconnect();
    });
  });

  // ── 404 for unknown routes ────────────────────────────────────────────────

  describe('unknown routes', () => {
    it('returns 404 for unknown path', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/does-not-exist', auth: 'alice:secret' });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(404);
      await channel.disconnect();
    });
  });

  // ── GET /healthz ─────────────────────────────────────────────────────────

  describe('GET /healthz', () => {
    it('returns 200 with JSON body containing status and uptime_ms (no auth)', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/healthz', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(res._headers['Content-Type']).toMatch(/application\/json/);
      const parsed = JSON.parse(res._body) as {
        status: string;
        uptime_ms: number;
      };
      expect(parsed.status).toBe('ok');
      expect(typeof parsed.uptime_ms).toBe('number');
      await channel.disconnect();
    });

    it('HEAD /healthz → 200, no body', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/healthz', method: 'HEAD', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(res._body).toBe('');
      await channel.disconnect();
    });

    it('POST /healthz → 405 with Allow: GET, HEAD', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/healthz', method: 'POST', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(405);
      expect(res._headers['Allow']).toMatch(/\bGET\b/);
      expect(res._headers['Allow']).toMatch(/\bHEAD\b/);
      await channel.disconnect();
    });

    it('GET /healthz/anything → 404 (exact-match only)', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/healthz/anything', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(404);
      await channel.disconnect();
    });
  });

  // ── GET /readyz ───────────────────────────────────────────────────────────

  describe('GET /readyz', () => {
    it('AC1: returns 200 with ready JSON when DB and Redis are healthy (no auth)', async () => {
      const channel = new HttpChannel(
        makeConfig(),
        makeOpts({
          checkDb: () => 'ok',
          checkRedis: async () => 'ok',
        }),
      );
      await channel.connect();

      const req = makeReq({ url: '/readyz', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(res._headers['Content-Type']).toMatch(/application\/json/);
      const body = JSON.parse(res._body) as {
        status: string;
        checks: { db: string; redis: string };
      };
      expect(body.status).toBe('ready');
      expect(body.checks.db).toBe('ok');
      expect(body.checks.redis).toBe('ok');
      await channel.disconnect();
    });

    it('AC2: returns 503 with not_ready JSON when Redis is unreachable', async () => {
      const channel = new HttpChannel(
        makeConfig(),
        makeOpts({
          checkDb: () => 'ok',
          checkRedis: async () => 'unreachable',
        }),
      );
      await channel.connect();

      const req = makeReq({ url: '/readyz', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(503);
      const body = JSON.parse(res._body) as {
        status: string;
        checks: { db: string; redis: string };
      };
      expect(body.status).toBe('not_ready');
      expect(body.checks.db).toBe('ok');
      expect(body.checks.redis).toBe('unreachable');
      await channel.disconnect();
    });

    it('returns 503 when DB fails', async () => {
      const channel = new HttpChannel(
        makeConfig(),
        makeOpts({
          checkDb: () => 'failed',
          checkRedis: async () => 'ok',
        }),
      );
      await channel.connect();

      const req = makeReq({ url: '/readyz', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(503);
      const body = JSON.parse(res._body) as {
        status: string;
        checks: { db: string; redis: string };
      };
      expect(body.status).toBe('not_ready');
      expect(body.checks.db).toBe('failed');
      await channel.disconnect();
    });

    it('AC4 HEAD /readyz → mirrors GET status code, no body', async () => {
      const channel = new HttpChannel(
        makeConfig(),
        makeOpts({
          checkDb: () => 'ok',
          checkRedis: async () => 'ok',
        }),
      );
      await channel.connect();

      const req = makeReq({ url: '/readyz', method: 'HEAD', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(res._body).toBe('');
      await channel.disconnect();
    });

    it('AC4 HEAD /readyz → 503 with no body when not ready', async () => {
      const channel = new HttpChannel(
        makeConfig(),
        makeOpts({
          checkDb: () => 'ok',
          checkRedis: async () => 'unreachable',
        }),
      );
      await channel.connect();

      const req = makeReq({ url: '/readyz', method: 'HEAD', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(503);
      expect(res._body).toBe('');
      await channel.disconnect();
    });

    it('AC4 POST /readyz → 405 + Allow: GET, HEAD', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/readyz', method: 'POST', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(405);
      expect(res._headers['Allow']).toMatch(/\bGET\b/);
      expect(res._headers['Allow']).toMatch(/\bHEAD\b/);
      await channel.disconnect();
    });

    it('GET /readyz/sub-path → 404 (exact-match only)', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/readyz/foo', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(404);
      await channel.disconnect();
    });

    it('does not require auth credentials', async () => {
      const channel = new HttpChannel(
        makeConfig(),
        makeOpts({
          checkDb: () => 'ok',
          checkRedis: async () => 'ok',
        }),
      );
      await channel.connect();

      // No Authorization header
      const req = makeReq({ url: '/readyz', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      // Should NOT return 401
      expect(res._status).not.toBe(401);
      expect(res._status).toBe(200);
      await channel.disconnect();
    });
  });

  // ── 405 Method Not Allowed (pathMethods table) ────────────────────────────

  describe('405 Method Not Allowed', () => {
    it('DELETE / → 405 with Allow header listing GET', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/', method: 'DELETE', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(405);
      expect(res._headers['Allow']).toContain('GET');
      await channel.disconnect();
    });

    it('GET /message → 405 with Allow header listing POST', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/message', method: 'GET', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(405);
      expect(res._headers['Allow']).toContain('POST');
      await channel.disconnect();
    });

    it('unknown path → 404 (not 405)', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        url: '/unknown-path-xyz',
        method: 'DELETE',
        auth: null,
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(404);
      await channel.disconnect();
    });
  });
  // ── Rate limiter unit tests ───────────────────────────────────────────────
  //
  // These exercise consumeRateLimit() directly with an injectable nowMs so no
  // real time passes and results are deterministic.

  describe('consumeRateLimit() — token-bucket unit tests', () => {
    it('allows requests when capacity is 0 (unlimited)', () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 0 }),
        makeOpts(),
      );
      for (let i = 0; i < 100; i++) {
        expect(channel.consumeRateLimit('alice', 0)).toEqual({ allowed: true });
      }
    });

    it('allows up to capacity requests in a fresh bucket', () => {
      const capacity = 5;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const t0 = 0;
      for (let i = 0; i < capacity; i++) {
        expect(channel.consumeRateLimit('alice', t0)).toEqual({
          allowed: true,
        });
      }
    });

    it('returns 429-path result after capacity is exhausted', () => {
      const capacity = 5;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const t0 = 0;
      for (let i = 0; i < capacity; i++) {
        channel.consumeRateLimit('alice', t0);
      }
      // 6th call at the same instant — bucket empty
      const result = channel.consumeRateLimit('alice', t0);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.retryAfterSeconds).toBeGreaterThan(0);
        expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
      }
    });

    it('Retry-After is a positive integer ≤ 60', () => {
      const capacity = 5;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const t0 = 0;
      for (let i = 0; i < capacity; i++) {
        channel.consumeRateLimit('alice', t0);
      }
      const result = channel.consumeRateLimit('alice', t0);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(Number.isInteger(result.retryAfterSeconds)).toBe(true);
        expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
      }
    });

    it('refills tokens over time — allows request after waiting Retry-After', () => {
      const capacity = 5;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const t0 = 0;
      // Drain the bucket
      for (let i = 0; i < capacity; i++) {
        channel.consumeRateLimit('alice', t0);
      }
      const throttled = channel.consumeRateLimit('alice', t0);
      expect(throttled.allowed).toBe(false);
      if (!throttled.allowed) {
        // Advance time by retryAfterSeconds seconds
        const tAfter = t0 + throttled.retryAfterSeconds * 1000;
        const result = channel.consumeRateLimit('alice', tAfter);
        expect(result.allowed).toBe(true);
      }
    });

    it('buckets are keyed per user — alice throttled does not affect bob', () => {
      const capacity = 5;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const t0 = 0;
      // Drain alice's bucket
      for (let i = 0; i < capacity; i++) {
        channel.consumeRateLimit('alice', t0);
      }
      expect(channel.consumeRateLimit('alice', t0).allowed).toBe(false);
      // Bob has a fresh bucket
      expect(channel.consumeRateLimit('bob', t0)).toEqual({ allowed: true });
    });

    it('partial refill: does not allow more than capacity from full refill', () => {
      const capacity = 5;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      // Consume all tokens at t=0
      for (let i = 0; i < capacity; i++) {
        channel.consumeRateLimit('alice', 0);
      }
      // Advance far past one minute — bucket should refill to full capacity only
      const t1 = 120_000; // 2 minutes later
      for (let i = 0; i < capacity; i++) {
        expect(channel.consumeRateLimit('alice', t1)).toEqual({
          allowed: true,
        });
      }
      // One more should be throttled
      expect(channel.consumeRateLimit('alice', t1).allowed).toBe(false);
    });
  });

  // ── Rate limiting integration tests ──────────────────────────────────────
  //
  // Full HttpChannel with a limit of 5, sending 6 POST /message requests.
  // Verifies AC1–AC5 at the in-process level (no kind cluster required).

  describe('POST /message rate limiting — integration', () => {
    it('AC1: first 5 POSTs return 200; 6th returns 429 with Retry-After', async () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 5 }),
        makeOpts(),
      );
      await channel.connect();

      for (let i = 0; i < 5; i++) {
        const req = makeReq({
          method: 'POST',
          url: '/message',
          auth: 'alice:secret',
          body: '{"text":"msg"}',
        });
        const res = makeRes();
        await dispatch(channel, req, res);
        expect(res._status).toBe(200);
      }

      // 6th request — should be rate-limited
      const req6 = makeReq({
        method: 'POST',
        url: '/message',
        auth: 'alice:secret',
        body: '{"text":"msg6"}',
      });
      const res6 = makeRes();
      await dispatch(channel, req6, res6);

      expect(res6._status).toBe(429);
      const retryAfter = parseInt(res6._headers['Retry-After'] ?? '0', 10);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);

      await channel.disconnect();
    });

    it('AC2: Retry-After is a positive integer ≤ 60 on the header', async () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 5 }),
        makeOpts(),
      );
      await channel.connect();

      for (let i = 0; i < 5; i++) {
        const req = makeReq({
          method: 'POST',
          url: '/message',
          auth: 'alice:secret',
          body: '{"text":"msg"}',
        });
        await dispatch(channel, req, makeRes());
      }

      const req = makeReq({
        method: 'POST',
        url: '/message',
        auth: 'alice:secret',
        body: '{"text":"throttled"}',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      const retryAfter = res._headers['Retry-After'];
      expect(retryAfter).toBeDefined();
      const seconds = parseInt(retryAfter, 10);
      expect(Number.isInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThanOrEqual(60);

      await channel.disconnect();
    });

    it('AC3: alice throttled, bob can POST normally', async () => {
      const channel = new HttpChannel(
        makeConfig({
          perUserMessagesPerMinute: 5,
          users: { alice: 'secret', bob: 'hunter2' },
        }),
        makeOpts({
          registeredGroups: vi.fn(() => ({
            'http:alice': {
              name: 'alice',
              folder: 'alice',
              trigger: '@Andy',
              added_at: '2024-01-01T00:00:00.000Z',
            },
            'http:bob': {
              name: 'bob',
              folder: 'bob',
              trigger: '@Andy',
              added_at: '2024-01-01T00:00:00.000Z',
            },
          })),
        }),
      );
      await channel.connect();

      // Drain alice's bucket
      for (let i = 0; i < 5; i++) {
        await dispatch(
          channel,
          makeReq({
            method: 'POST',
            url: '/message',
            auth: 'alice:secret',
            body: '{"text":"msg"}',
          }),
          makeRes(),
        );
      }
      const aliceRes = makeRes();
      await dispatch(
        channel,
        makeReq({
          method: 'POST',
          url: '/message',
          auth: 'alice:secret',
          body: '{"text":"throttled"}',
        }),
        aliceRes,
      );
      expect(aliceRes._status).toBe(429);

      // Bob has an independent bucket — first POST returns 200
      const bobRes = makeRes();
      await dispatch(
        channel,
        makeReq({
          method: 'POST',
          url: '/message',
          auth: 'bob:hunter2',
          body: '{"text":"hello"}',
        }),
        bobRes,
      );
      expect(bobRes._status).toBe(200);

      await channel.disconnect();
    });

    it('AC4: throttled requests do NOT invoke onMessage (no DB write)', async () => {
      const opts = makeOpts();
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 5 }),
        opts,
      );
      await channel.connect();

      for (let i = 0; i < 5; i++) {
        await dispatch(
          channel,
          makeReq({
            method: 'POST',
            url: '/message',
            auth: 'alice:secret',
            body: '{"text":"msg"}',
          }),
          makeRes(),
        );
      }

      const callsBefore = (opts.onMessage as ReturnType<typeof vi.fn>).mock
        .calls.length;

      const res = makeRes();
      await dispatch(
        channel,
        makeReq({
          method: 'POST',
          url: '/message',
          auth: 'alice:secret',
          body: '{"text":"throttled"}',
        }),
        res,
      );

      expect(res._status).toBe(429);
      // onMessage must NOT have been called for the throttled request
      expect(
        (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(callsBefore);

      await channel.disconnect();
    });

    it('AC5: GET /history is NOT throttled by the message limiter', async () => {
      // The GET /history endpoint does not exist in the core http.ts (it's a
      // separate addon), so we test a representative read-only path: GET /stream
      // (no auth needed path-wise, same assertion applies to any non-POST route).
      // We verify that 20 rapid dispatches to GET / all return 200, confirming
      // the limiter only applies to POST /message.
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 5 }),
        makeOpts(),
      );
      await channel.connect();

      for (let i = 0; i < 20; i++) {
        const req = makeReq({ method: 'GET', url: '/', auth: 'alice:secret' });
        const res = makeRes();
        await dispatch(channel, req, res);
        expect(res._status).toBe(200);
      }

      await channel.disconnect();
    });

    it('AC5b: POST /message from alice is still throttled while GET / is free', async () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 5 }),
        makeOpts(),
      );
      await channel.connect();

      // Drain alice's bucket
      for (let i = 0; i < 5; i++) {
        await dispatch(
          channel,
          makeReq({
            method: 'POST',
            url: '/message',
            auth: 'alice:secret',
            body: '{"text":"msg"}',
          }),
          makeRes(),
        );
      }

      // GET / still works
      const getRes = makeRes();
      await dispatch(
        channel,
        makeReq({ method: 'GET', url: '/', auth: 'alice:secret' }),
        getRes,
      );
      expect(getRes._status).toBe(200);

      // POST /message is throttled
      const postRes = makeRes();
      await dispatch(
        channel,
        makeReq({
          method: 'POST',
          url: '/message',
          auth: 'alice:secret',
          body: '{"text":"throttled"}',
        }),
        postRes,
      );
      expect(postRes._status).toBe(429);

      await channel.disconnect();
    });
  });

  // ── CORS preflight (OPTIONS) ──────────────────────────────────────────────

  describe('CORS preflight (OPTIONS)', () => {
    it('OPTIONS /message → 204 with CORS headers (AC1)', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ method: 'OPTIONS', url: '/message', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(204);
      expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
      expect(res._headers['Access-Control-Allow-Methods']).toBe('POST');
      expect(res._headers['Access-Control-Allow-Headers']).toBe(
        'Authorization, Content-Type',
      );
      expect(res._headers['Access-Control-Max-Age']).toBe('86400');
      await channel.disconnect();
    });

    it('OPTIONS /stream → 204 with Access-Control-Allow-Methods: GET (AC2)', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ method: 'OPTIONS', url: '/stream', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(204);
      expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
      expect(res._headers['Access-Control-Allow-Methods']).toBe('GET');
      await channel.disconnect();
    });

    it('OPTIONS /healthz → 204 with Access-Control-Allow-Origin (AC3)', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ method: 'OPTIONS', url: '/healthz', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(204);
      expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
      await channel.disconnect();
    });

    it('OPTIONS /history → 204 with correct allowed methods', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ method: 'OPTIONS', url: '/history', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(204);
      expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
      expect(res._headers['Access-Control-Allow-Methods']).toBe('GET, DELETE');
      await channel.disconnect();
    });

    it('OPTIONS /attachments/list → 204 with Access-Control-Allow-Methods: GET', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'OPTIONS',
        url: '/attachments/list',
        auth: null,
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(204);
      expect(res._headers['Access-Control-Allow-Methods']).toBe('GET');
      await channel.disconnect();
    });

    it('OPTIONS /attachments/raw/<file> → 204 with GET, HEAD, DELETE', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'OPTIONS',
        url: '/attachments/raw/img-123.jpg',
        auth: null,
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(204);
      expect(res._headers['Access-Control-Allow-Methods']).toBe(
        'GET, HEAD, DELETE',
      );
      await channel.disconnect();
    });

    it('OPTIONS does not require authentication', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      // No auth header — OPTIONS must still return 204
      const req = makeReq({ method: 'OPTIONS', url: '/message', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(204);
      expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
      await channel.disconnect();
    });

    it('respects HTTP_CHANNEL_CORS_ORIGIN config', async () => {
      const channel = new HttpChannel(
        makeConfig({ corsOrigin: 'https://app.example.com' }),
        makeOpts(),
      );
      await channel.connect();

      const req = makeReq({ method: 'OPTIONS', url: '/message', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(204);
      expect(res._headers['Access-Control-Allow-Origin']).toBe(
        'https://app.example.com',
      );
      await channel.disconnect();
    });
  });

  // ── CORS headers on non-OPTIONS authenticated responses (AC4) ─────────────

  describe('CORS headers on authenticated responses', () => {
    it('GET /healthz carries Access-Control-Allow-Origin', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/healthz', auth: null });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
      await channel.disconnect();
    });

    it('POST /message carries Access-Control-Allow-Origin', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'POST',
        url: '/message',
        auth: 'alice:secret',
        body: '{"text":"Hello"}',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
      await channel.disconnect();
    });

    it('GET /stream carries Access-Control-Allow-Origin', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({ url: '/stream', auth: 'alice:secret' });
      const closeHandlers: Array<() => void> = [];
      (req.on as ReturnType<typeof vi.fn>).mockImplementation(
        (event: string, cb: () => void) => {
          if (event === 'close') closeHandlers.push(cb);
        },
      );
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
      closeHandlers.forEach((h) => h());
      await channel.disconnect();
    });
  });

  // ── DELETE /history — full-clear and time-bounded purge (Story 26 + 78) ────

  describe('DELETE /history', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      (
        deleteConversationHistoryBefore as ReturnType<typeof vi.fn>
      ).mockReturnValue(0);
    });

    it('AC2: no ?before → full-clear returns 204', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'DELETE',
        url: '/history',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(204);
      expect(clearConversationHistory).toHaveBeenCalledWith('alice');
      expect(deleteConversationHistoryBefore).not.toHaveBeenCalled();
      await channel.disconnect();
    });

    it('AC1: ?before=<valid ISO> calls deleteConversationHistoryBefore and returns 200 {deleted:N}', async () => {
      (
        deleteConversationHistoryBefore as ReturnType<typeof vi.fn>
      ).mockReturnValue(3);
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const iso = '2025-01-01T00:00:00.000Z';
      const req = makeReq({
        method: 'DELETE',
        url: `/history?before=${encodeURIComponent(iso)}`,
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.deleted).toBe(3);
      expect(deleteConversationHistoryBefore).toHaveBeenCalledWith(
        'alice',
        expect.any(Date),
      );
      expect(clearConversationHistory).not.toHaveBeenCalled();
      await channel.disconnect();
    });

    it('AC1: no rows match returns 200 {deleted:0}', async () => {
      (
        deleteConversationHistoryBefore as ReturnType<typeof vi.fn>
      ).mockReturnValue(0);
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const iso = '2020-01-01T00:00:00.000Z';
      const req = makeReq({
        method: 'DELETE',
        url: `/history?before=${encodeURIComponent(iso)}`,
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.deleted).toBe(0);
      await channel.disconnect();
    });

    it('AC3: unparseable before → 400 with error message', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'DELETE',
        url: '/history?before=not-a-date',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(400);
      const body = JSON.parse(res._body);
      expect(body.error).toContain('ISO-8601');
      await channel.disconnect();
    });

    it('AC4: before in future is accepted (deletes all)', async () => {
      (
        deleteConversationHistoryBefore as ReturnType<typeof vi.fn>
      ).mockReturnValue(5);
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const futureIso = new Date(Date.now() + 86_400_000).toISOString();
      const req = makeReq({
        method: 'DELETE',
        url: `/history?before=${encodeURIComponent(futureIso)}`,
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.deleted).toBe(5);
      await channel.disconnect();
    });

    it('returns 401 for unauthenticated request', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'DELETE',
        url: '/history?before=2025-01-01T00:00:00.000Z',
        auth: null,
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(401);
      await channel.disconnect();
    });

    it('returns 404 when group not registered', async () => {
      const channel = new HttpChannel(
        makeConfig(),
        makeOpts({ registeredGroups: vi.fn(() => ({})) }),
      );
      await channel.connect();

      const req = makeReq({
        method: 'DELETE',
        url: '/history?before=2025-01-01T00:00:00.000Z',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(404);
      await channel.disconnect();
    });
  });

  // ── DELETE /history/<id> — single message delete ──────────────────────────

  describe('DELETE /history/<id>', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      serverListeners.clear();
    });

    // AC1: authenticated delete with matching id → 204; row gone from history
    it('returns 204 when id exists in the user group', async () => {
      (deleteMessageById as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'DELETE',
        url: '/history/msg-42',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(204);
      expect(deleteMessageById).toHaveBeenCalledWith('msg-42', 'alice');
      await channel.disconnect();
    });

    // AC2: id exists but belongs to a different group → 403, row preserved
    it('returns 403 when id exists in a different group', async () => {
      (deleteMessageById as ReturnType<typeof vi.fn>).mockReturnValue(false);
      // Simulate unscoped SELECT finding the row (belongs to another group)
      const { db: mockDbRef } = await import('../db.js');
      (mockDbRef.exec as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { columns: ['group_folder'], values: [['other-group']] },
      ]);

      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'DELETE',
        url: '/history/msg-foreign',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(403);
      await channel.disconnect();
    });

    // AC3: nonexistent id → 404
    it('returns 404 when id does not exist anywhere', async () => {
      (deleteMessageById as ReturnType<typeof vi.fn>).mockReturnValue(false);
      // mockDb.exec returns [] by default (no rows found)

      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'DELETE',
        url: '/history/msg-ghost',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(404);
      await channel.disconnect();
    });

    // AC4: unauthenticated → 401
    it('returns 401 when not authenticated', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'DELETE',
        url: '/history/msg-42',
        auth: null,
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(401);
      await channel.disconnect();
    });

    // AC5: POST /history/<id> → 405 with Allow: GET, HEAD, DELETE, PATCH (updated by Story 82)
    it('returns 405 with Allow: GET, HEAD, DELETE, PATCH for POST /history/<id>', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'POST',
        url: '/history/msg-42',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(405);
      expect(res._headers['Allow']).toBe('GET, HEAD, DELETE, PATCH');
      await channel.disconnect();
    });
  });

  // ── GET/HEAD /history/<id> — single message fetch (Story 64) ───────────────

  describe('GET /history/<id>', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      serverListeners.clear();
    });

    // AC1: authenticated GET with matching id → 200 + JSON body
    it('returns 200 with JSON body when id exists in the user group', async () => {
      const mockRow = {
        id: 'msg-abc',
        role: 'user' as const,
        content: 'hello',
        created_at: '2026-01-01T00:00:00.000Z',
      };
      (getMessageById as ReturnType<typeof vi.fn>).mockReturnValue(mockRow);

      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'GET',
        url: '/history/msg-abc',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(res._headers['Content-Type']).toContain('application/json');
      const body = JSON.parse(res._body);
      expect(body.id).toBe('msg-abc');
      expect(body.role).toBe('user');
      expect(body.content).toBe('hello');
      expect(body.created_at).toBe('2026-01-01T00:00:00.000Z');
      expect(getMessageById).toHaveBeenCalledWith('msg-abc', 'alice');
      await channel.disconnect();
    });

    // AC2: unknown id → 404
    it('returns 404 when id does not exist', async () => {
      (getMessageById as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'GET',
        url: '/history/no-such-id',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(404);
      const body = JSON.parse(res._body);
      expect(body.error).toBe('Not found');
      await channel.disconnect();
    });

    // AC3: id from another group → same 404 (no enumeration)
    it('returns 404 for cross-group id (same wording as unknown id)', async () => {
      // getMessageById returns null for cross-group (no enumeration at db level)
      (getMessageById as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'GET',
        url: '/history/other-group-id',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(404);
      const body = JSON.parse(res._body);
      expect(body.error).toBe('Not found');
      await channel.disconnect();
    });

    // AC4: unauthenticated → 401
    it('returns 401 when not authenticated', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'GET',
        url: '/history/msg-abc',
        auth: null,
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(401);
      await channel.disconnect();
    });

    // AC5: HEAD /history/<id> — same headers as GET, no body
    it('HEAD returns 200 with same headers as GET but empty body for existing id', async () => {
      const mockRow = {
        id: 'msg-head',
        role: 'assistant' as const,
        content: 'a response',
        created_at: '2026-01-02T00:00:00.000Z',
      };
      (getMessageById as ReturnType<typeof vi.fn>).mockReturnValue(mockRow);

      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'HEAD',
        url: '/history/msg-head',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(res._headers['Content-Type']).toContain('application/json');
      expect(res._headers['Content-Length']).toBeDefined();
      // HEAD must send no body
      expect(res._body).toBe('');
      await channel.disconnect();
    });

    // AC5: HEAD returns 404 with no body for missing id
    it('HEAD returns 404 with no body for missing id', async () => {
      (getMessageById as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'HEAD',
        url: '/history/msg-gone',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(404);
      expect(res._body).toBe('');
      await channel.disconnect();
    });

    // AC5: POST /history/<id> → 405 with Allow: GET, HEAD, DELETE, PATCH (updated by Story 82)
    it('returns 405 with Allow: GET, HEAD, DELETE, PATCH for POST /history/<id>', async () => {
      const channel = new HttpChannel(makeConfig(), makeOpts());
      await channel.connect();

      const req = makeReq({
        method: 'POST',
        url: '/history/msg-abc',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(405);
      expect(res._headers['Allow']).toBe('GET, HEAD, DELETE, PATCH');
      await channel.disconnect();
    });
  });

  // ── peekRateLimit() — read-only unit tests ───────────────────────────────
  //
  // These exercise peekRateLimit() directly with an injectable nowMs so no
  // real time passes and results are deterministic. Key invariant: calling
  // peekRateLimit any number of times MUST NOT change the bucket state.

  describe('peekRateLimit() — read-only unit tests', () => {
    it('returns null fields when capacity is 0 (unlimited)', () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 0 }),
        makeOpts(),
      );
      const result = channel.peekRateLimit('alice', 0);
      expect(result).toEqual({
        limit: null,
        remaining: null,
        resetInSeconds: null,
      });
    });

    it('is idempotent — calling 5 times does not change remaining', () => {
      const capacity = 10;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const t0 = 0;
      // Consume 3 tokens via consumeRateLimit
      channel.consumeRateLimit('alice', t0);
      channel.consumeRateLimit('alice', t0);
      channel.consumeRateLimit('alice', t0);

      // Now peek 5 times at the same instant — remaining must not change
      const first = channel.peekRateLimit('alice', t0);
      for (let i = 0; i < 4; i++) {
        expect(channel.peekRateLimit('alice', t0)).toEqual(first);
      }
    });

    it('peekRateLimit does not consume — consumeRateLimit still allowed after 10 peeks', () => {
      const capacity = 1;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const t0 = 0;
      // Peek 10 times — bucket must remain full
      for (let i = 0; i < 10; i++) {
        channel.peekRateLimit('alice', t0);
      }
      // One consume must still succeed
      expect(channel.consumeRateLimit('alice', t0)).toEqual({ allowed: true });
    });

    it('returns remaining = capacity for a fresh bucket', () => {
      const capacity = 10;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const result = channel.peekRateLimit('alice', 0);
      expect(result).toMatchObject({ limit: capacity, remaining: capacity });
    });

    it('remaining decreases after consumeRateLimit calls', () => {
      const capacity = 10;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const t0 = 0;
      // Consume 3 tokens
      channel.consumeRateLimit('alice', t0);
      channel.consumeRateLimit('alice', t0);
      channel.consumeRateLimit('alice', t0);

      const peek = channel.peekRateLimit('alice', t0);
      expect(peek).toMatchObject({ limit: capacity, remaining: 7 });
    });

    it('remaining is 0 when bucket is exhausted', () => {
      const capacity = 5;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const t0 = 0;
      for (let i = 0; i < capacity; i++) {
        channel.consumeRateLimit('alice', t0);
      }
      const peek = channel.peekRateLimit('alice', t0);
      expect(peek).toMatchObject({ limit: capacity, remaining: 0 });
    });

    it('resetInSeconds is 0 when bucket is full', () => {
      const capacity = 10;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const peek = channel.peekRateLimit('alice', 0);
      expect(peek).toMatchObject({ resetInSeconds: 0 });
    });

    it('resetInSeconds is ≤ 60 when bucket is partially exhausted', () => {
      const capacity = 5;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const t0 = 0;
      for (let i = 0; i < capacity; i++) {
        channel.consumeRateLimit('alice', t0);
      }
      const peek = channel.peekRateLimit('alice', t0);
      if (peek.resetInSeconds !== null) {
        expect(peek.resetInSeconds).toBeGreaterThan(0);
        expect(peek.resetInSeconds).toBeLessThanOrEqual(60);
      }
    });

    it('buckets are keyed per user — alice and bob have independent views', () => {
      const capacity = 5;
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: capacity }),
        makeOpts(),
      );
      const t0 = 0;
      // Drain alice
      for (let i = 0; i < capacity; i++) {
        channel.consumeRateLimit('alice', t0);
      }
      // Alice is exhausted; bob has full bucket
      const alicePeek = channel.peekRateLimit('alice', t0);
      const bobPeek = channel.peekRateLimit('bob', t0);
      expect(alicePeek).toMatchObject({ remaining: 0 });
      expect(bobPeek).toMatchObject({ remaining: capacity });
    });
  });

  // ── GET /message/rate-limit — integration tests ───────────────────────────

  describe('GET /message/rate-limit', () => {
    it('AC1: returns 200 with JSON { limit, remaining, resetInSeconds } when limit is set', async () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 10 }),
        makeOpts(),
      );
      await channel.connect();

      const req = makeReq({
        method: 'GET',
        url: '/message/rate-limit',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      expect(res._headers['Content-Type']).toContain('application/json');
      const body = JSON.parse(res._body);
      expect(body).toMatchObject({
        limit: 10,
        remaining: 10,
        resetInSeconds: 0,
      });
      await channel.disconnect();
    });

    it('AC2: remaining decreases after 3 POST /message calls', async () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 10 }),
        makeOpts(),
      );
      await channel.connect();

      // Consume 3 tokens via the rate limiter directly (deterministic)
      channel.consumeRateLimit('alice', 0);
      channel.consumeRateLimit('alice', 0);
      channel.consumeRateLimit('alice', 0);

      // Peek via the endpoint (uses Date.now() internally, but bucket is at t=0)
      // We cannot inject nowMs through the HTTP route, so instead inject via
      // peekRateLimit directly to verify the integration, then test the HTTP
      // endpoint returns valid JSON with remaining < 10.
      const peek = channel.peekRateLimit('alice', 0);
      expect(peek).toMatchObject({ limit: 10, remaining: 7 });

      await channel.disconnect();
    });

    it('AC2 (HTTP): GET /message/rate-limit after consuming messages returns remaining < limit', async () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 10 }),
        makeOpts(),
      );
      await channel.connect();

      // Send 3 POST /message requests (makeReq auto-sets content-type: application/json)
      for (let i = 0; i < 3; i++) {
        const postReq = makeReq({
          method: 'POST',
          url: '/message',
          auth: 'alice:secret',
          body: '{"text":"hello"}',
        });
        const postRes = makeRes();
        await dispatch(channel, postReq, postRes);
        expect(postRes._status).toBe(200);
      }

      // Now GET /message/rate-limit
      const req = makeReq({
        method: 'GET',
        url: '/message/rate-limit',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.limit).toBe(10);
      expect(body.remaining).toBeLessThan(10);
      expect(body.remaining).toBeGreaterThanOrEqual(0);

      // Verify next POST /message is still allowed (remaining > 0)
      const postReq4 = makeReq({
        method: 'POST',
        url: '/message',
        auth: 'alice:secret',
        body: '{"text":"still allowed"}',
      });
      const postRes4 = makeRes();
      await dispatch(channel, postReq4, postRes4);
      expect(postRes4._status).toBe(200);

      await channel.disconnect();
    });

    it('AC3: with perUserMessagesPerMinute=0 (unlimited), returns { limit: null, remaining: null, resetInSeconds: null }', async () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 0 }),
        makeOpts(),
      );
      await channel.connect();

      const req = makeReq({
        method: 'GET',
        url: '/message/rate-limit',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toEqual({
        limit: null,
        remaining: null,
        resetInSeconds: null,
      });

      await channel.disconnect();
    });

    it('AC4: unauthenticated GET /message/rate-limit returns 401', async () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 10 }),
        makeOpts(),
      );
      await channel.connect();

      const req = makeReq({
        method: 'GET',
        url: '/message/rate-limit',
        auth: null,
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('Basic realm=');

      await channel.disconnect();
    });

    it('AC5: POST /message/rate-limit returns 405 with Allow: GET, HEAD', async () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 10 }),
        makeOpts(),
      );
      await channel.connect();

      const req = makeReq({
        method: 'POST',
        url: '/message/rate-limit',
        auth: 'alice:secret',
      });
      const res = makeRes();
      await dispatch(channel, req, res);

      expect(res._status).toBe(405);
      expect(res._headers['Allow']).toContain('GET');
      expect(res._headers['Allow']).toContain('HEAD');

      await channel.disconnect();
    });

    it('AC5: HEAD /message/rate-limit returns same headers as GET but no body', async () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 10 }),
        makeOpts(),
      );
      await channel.connect();

      const getReq = makeReq({
        method: 'GET',
        url: '/message/rate-limit',
        auth: 'alice:secret',
      });
      const getRes = makeRes();
      await dispatch(channel, getReq, getRes);

      const headReq = makeReq({
        method: 'HEAD',
        url: '/message/rate-limit',
        auth: 'alice:secret',
      });
      const headRes = makeRes();
      await dispatch(channel, headReq, headRes);

      expect(headRes._status).toBe(200);
      // Same Content-Type header
      expect(headRes._headers['Content-Type']).toBe(
        getRes._headers['Content-Type'],
      );
      // HEAD has no body
      expect(headRes._body).toBe('');

      await channel.disconnect();
    });

    it('peekRateLimit does not consume — remaining is identical on back-to-back GETs', async () => {
      const channel = new HttpChannel(
        makeConfig({ perUserMessagesPerMinute: 10 }),
        makeOpts(),
      );
      await channel.connect();

      const makeRateLimitReq = () =>
        makeReq({
          method: 'GET',
          url: '/message/rate-limit',
          auth: 'alice:secret',
        });

      const res1 = makeRes();
      await dispatch(channel, makeRateLimitReq(), res1);
      const body1 = JSON.parse(res1._body);

      const res2 = makeRes();
      await dispatch(channel, makeRateLimitReq(), res2);
      const body2 = JSON.parse(res2._body);

      // Remaining must not change between the two reads (no consumption)
      expect(body2.remaining).toBe(body1.remaining);

      await channel.disconnect();
    });
  });
});

// ── detectMediaType — unit tests ──────────────────────────────────────────────

describe('detectMediaType', () => {
  it('detects GIF from magic prefix [47 49 46]', () => {
    expect(detectMediaType(Buffer.from([0x47, 0x49, 0x46]))).toBe('image/gif');
  });

  it('detects GIF with additional bytes (animated GIF prefix)', () => {
    // Animated GIFs still start with 47 49 46; the check is prefix-only
    const animatedGifPrefix = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x01,
    ]);
    expect(detectMediaType(animatedGifPrefix)).toBe('image/gif');
  });

  it('detects WebP from full RIFF????WEBP signature', () => {
    const webpBuf = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x00,
      0x00,
      0x00,
      0x00, // file size (don't-care)
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
    ]);
    expect(detectMediaType(webpBuf)).toBe('image/webp');
  });

  it('rejects RIFF container that is not WebP (e.g. WAV — 52 49 46 46 but no WEBP at [8-11])', () => {
    // WAV: RIFF at [0-3], then file size, then "WAVE" at [8-11]
    const wavBuf = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x24,
      0x00,
      0x00,
      0x00, // file size
      0x57,
      0x41,
      0x56,
      0x45, // WAVE  ← not WEBP
    ]);
    expect(detectMediaType(wavBuf)).toBeNull();
  });

  it('returns null for a buffer shorter than 12 bytes starting with RIFF', () => {
    const shortRiff = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]);
    expect(detectMediaType(shortRiff)).toBeNull();
  });

  it('detects JPEG from FF D8 FF magic bytes', () => {
    expect(detectMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      'image/jpeg',
    );
  });

  it('detects PNG from 8-byte magic prefix', () => {
    expect(
      detectMediaType(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe('image/png');
  });

  it('returns null for unknown bytes', () => {
    expect(detectMediaType(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
  });
});

// ── getAttachmentUsage() helper ───────────────────────────────────────────

describe('getAttachmentUsage()', () => {
  it('returns {count:0, bytes:0} when directory does not exist', async () => {
    vi.mocked(fsPromises.readdir).mockRejectedValueOnce(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    const result = await getAttachmentUsage('/nonexistent/path');
    expect(result).toEqual({ count: 0, bytes: 0 });
  });

  it('returns correct count and byte sum for files in directory', async () => {
    vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
      'a.jpg',
      'b.png',
    ] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat)
      .mockResolvedValueOnce({
        isFile: () => true,
        size: 10000,
      } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>)
      .mockResolvedValueOnce({
        isFile: () => true,
        size: 20000,
      } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);
    const result = await getAttachmentUsage('/some/dir');
    expect(result).toEqual({ count: 2, bytes: 30000 });
  });

  it('skips non-file entries (directories) for both bytes AND count', async () => {
    vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
      'subdir',
    ] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat).mockResolvedValueOnce({
      isFile: () => false,
      size: 0,
    } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);
    const result = await getAttachmentUsage('/some/dir');
    expect(result.bytes).toBe(0);
    expect(result.count).toBe(0);
  });

  it('propagates unexpected errors from readdir', async () => {
    vi.mocked(fsPromises.readdir).mockRejectedValueOnce(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );
    await expect(getAttachmentUsage('/locked')).rejects.toThrow('EACCES');
  });
});

// ── Per-user attachment quota (unit — mocked fs) ──────────────────────────

describe('POST /message multipart attachment quota', () => {
  it('returns 413 with count message when attachment count quota is exceeded', async () => {
    // Simulate: 3 existing files already present — at the max of 3
    vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
      'a.jpg',
      'b.jpg',
      'c.jpg',
    ] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat)
      .mockResolvedValueOnce({
        isFile: () => true,
        size: 1000,
      } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>)
      .mockResolvedValueOnce({
        isFile: () => true,
        size: 1000,
      } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>)
      .mockResolvedValueOnce({
        isFile: () => true,
        size: 1000,
      } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);

    const opts = makeOpts({ maxAttachmentCount: 3 });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const boundary = 'quotaboundary1';
    const body = buildMultipartBody(boundary, [
      {
        name: 'image',
        filename: 'new.jpg',
        contentType: 'image/jpeg',
        data: JPEG_MAGIC,
      },
    ]);
    const req = makeMultipartReq({ boundary, body });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(413);
    expect(res._body).toBe('Attachment limit reached (max 3)');
    // writeFileSync must NOT have been called
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();

    await channel.disconnect();
  });

  it('returns 413 with size message when cumulative byte quota would be exceeded', async () => {
    // 45 KB already stored; new file is 10 KB; limit is 50 KB
    vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
      'big.jpg',
    ] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat).mockResolvedValueOnce({
      isFile: () => true,
      size: 46080,
    } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);

    const opts = makeOpts({ maxAttachmentBytes: 50000 });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    // Build a body whose image part is ~10 KB (larger than available space)
    const largeImage = Buffer.concat([JPEG_MAGIC, Buffer.alloc(10000)]);
    const boundary = 'quotaboundary2';
    const body = buildMultipartBody(boundary, [
      {
        name: 'image',
        filename: 'big2.jpg',
        contentType: 'image/jpeg',
        data: largeImage,
      },
    ]);
    const req = makeMultipartReq({ boundary, body });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(413);
    expect(res._body).toBe('Attachment storage limit reached');
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();

    await channel.disconnect();
  });

  it('allows upload when both limits are 0 (unlimited)', async () => {
    // No files yet — readdir returns empty
    vi.mocked(fsPromises.readdir).mockResolvedValueOnce(
      [] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>,
    );

    const opts = makeOpts({ maxAttachmentCount: 0, maxAttachmentBytes: 0 });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const boundary = 'quotaboundary3';
    const body = buildMultipartBody(boundary, [
      {
        name: 'image',
        filename: 'ok.jpg',
        contentType: 'image/jpeg',
        data: JPEG_MAGIC,
      },
    ]);
    const req = makeMultipartReq({ boundary, body });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledOnce();

    await channel.disconnect();
  });

  it('allows upload when below count limit', async () => {
    // 2 files stored; limit is 3 → still 1 slot left
    vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
      'a.jpg',
      'b.jpg',
    ] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat)
      .mockResolvedValueOnce({
        isFile: () => true,
        size: 1000,
      } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>)
      .mockResolvedValueOnce({
        isFile: () => true,
        size: 1000,
      } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);

    const opts = makeOpts({ maxAttachmentCount: 3 });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const boundary = 'quotaboundary4';
    const body = buildMultipartBody(boundary, [
      {
        name: 'image',
        filename: 'third.jpg',
        contentType: 'image/jpeg',
        data: JPEG_MAGIC,
      },
    ]);
    const req = makeMultipartReq({ boundary, body });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);

    await channel.disconnect();
  });

  it('alice quota rejection does not affect bob uploads', async () => {
    // alice: 3 files at limit of 3
    vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
      'a.jpg',
      'b.jpg',
      'c.jpg',
    ] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat)
      .mockResolvedValueOnce({
        isFile: () => true,
        size: 1000,
      } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>)
      .mockResolvedValueOnce({
        isFile: () => true,
        size: 1000,
      } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>)
      .mockResolvedValueOnce({
        isFile: () => true,
        size: 1000,
      } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);

    // bob: 0 files
    vi.mocked(fsPromises.readdir).mockResolvedValueOnce(
      [] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>,
    );

    const opts = makeOpts({
      maxAttachmentCount: 3,
      registeredGroups: vi.fn(() => ({
        'http:alice': {
          name: 'alice',
          folder: 'alice',
          trigger: '',
          added_at: '',
        },
        'http:bob': { name: 'bob', folder: 'bob', trigger: '', added_at: '' },
      })),
    });
    const channel = new HttpChannel(
      makeConfig({ users: { alice: 'secret', bob: 'hunter2' } }),
      opts,
    );
    await channel.connect();

    // alice → should get 413
    const aliceBoundary = 'alice-boundary';
    const aliceBody = buildMultipartBody(aliceBoundary, [
      {
        name: 'image',
        filename: 'new.jpg',
        contentType: 'image/jpeg',
        data: JPEG_MAGIC,
      },
    ]);
    const aliceReq = makeMultipartReq({
      auth: 'alice:secret',
      boundary: aliceBoundary,
      body: aliceBody,
    });
    const aliceRes = makeRes();
    await dispatch(channel, aliceReq, aliceRes);
    expect(aliceRes._status).toBe(413);

    // bob → should succeed (different directory, readdir returned empty)
    const bobBoundary = 'bob-boundary';
    const bobBody = buildMultipartBody(bobBoundary, [
      {
        name: 'image',
        filename: 'first.jpg',
        contentType: 'image/jpeg',
        data: JPEG_MAGIC,
      },
    ]);
    const bobReq = makeMultipartReq({
      auth: 'bob:hunter2',
      boundary: bobBoundary,
      body: bobBody,
    });
    const bobRes = makeRes();
    await dispatch(channel, bobReq, bobRes);
    expect(bobRes._status).toBe(200);

    await channel.disconnect();
  });
});

// ── GET /version — build info ─────────────────────────────────────────────

describe('GET /version', () => {
  it('returns 200 with Content-Type application/json', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/version', method: 'GET', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');
    await channel.disconnect();
  });

  it('requires no authentication (auth: null still returns 200)', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/version', method: 'GET', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    await channel.disconnect();
  });

  it('response body contains all 4 required keys', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/version', method: 'GET', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    const parsed = JSON.parse(res._body);
    expect(parsed).toHaveProperty('version');
    expect(parsed).toHaveProperty('model');
    expect(parsed).toHaveProperty('rateLimitWindowMs');
    expect(parsed).toHaveProperty('toolJobsRetentionDays');
    await channel.disconnect();
  });

  it('returns 405 with Allow: GET, HEAD for POST /version', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/version', method: 'POST', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD');
    await channel.disconnect();
  });

  it('HEAD /version returns 200 with no body but correct headers', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/version', method: 'HEAD', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');
    // HEAD must not send a body — only writeHead called, not end(body)
    // The mock captures body via end(data?) — body should be empty string
    expect(res._body).toBe('');
    await channel.disconnect();
  });
});

// ── buildVersionPayload() unit tests ─────────────────────────────────────

describe('buildVersionPayload()', () => {
  it('returns "dev" when KUBECLAW_VERSION env var is absent', () => {
    const saved = process.env.KUBECLAW_VERSION;
    delete process.env.KUBECLAW_VERSION;
    try {
      const payload = buildVersionPayload();
      expect(payload.version).toBe('dev');
    } finally {
      if (saved !== undefined) process.env.KUBECLAW_VERSION = saved;
    }
  });

  it('returns env var value when KUBECLAW_VERSION is set', () => {
    const saved = process.env.KUBECLAW_VERSION;
    process.env.KUBECLAW_VERSION = '1.2.3-abc';
    try {
      const payload = buildVersionPayload();
      expect(payload.version).toBe('1.2.3-abc');
    } finally {
      if (saved !== undefined) {
        process.env.KUBECLAW_VERSION = saved;
      } else {
        delete process.env.KUBECLAW_VERSION;
      }
    }
  });

  it('returns model from DEFAULT_DIRECT_MODEL', () => {
    const payload = buildVersionPayload();
    expect(payload.model).toBe('gpt-4o');
  });

  it('returns rateLimitWindowMs as number', () => {
    const payload = buildVersionPayload();
    expect(payload.rateLimitWindowMs).toBe(60000);
  });

  it('returns toolJobsRetentionDays as number', () => {
    const payload = buildVersionPayload();
    expect(payload.toolJobsRetentionDays).toBe(30);
  });

  it('all required keys are present', () => {
    const payload = buildVersionPayload();
    expect(Object.keys(payload)).toEqual(
      expect.arrayContaining([
        'version',
        'model',
        'rateLimitWindowMs',
        'toolJobsRetentionDays',
      ]),
    );
  });
});

// ── GET /jobs — tool job listing (Story 65) ───────────────────────────────

describe('GET /jobs', () => {
  const sampleJobs = [
    {
      job_id: 'nc-alice-abc123',
      group_folder: 'alice',
      chat_jid: 'http:alice',
      specialist_name: 'search',
      status: 'completed' as const,
      created_at: '2024-06-01T10:00:00.000Z',
      resolved_at: '2024-06-01T10:05:00.000Z',
      message_id: null,
    },
    {
      job_id: 'nc-alice-def456',
      group_folder: 'alice',
      chat_jid: 'http:alice',
      specialist_name: '',
      status: 'active' as const,
      created_at: '2024-06-01T11:00:00.000Z',
      resolved_at: null,
      message_id: null,
    },
  ];

  beforeEach(() => {
    vi.mocked(getRecentToolJobsForGroup).mockReset();
    vi.mocked(getActiveToolJobs).mockReset();
    vi.mocked(getRecentToolJobsForGroup).mockReturnValue(sampleJobs);
    vi.mocked(getActiveToolJobs).mockReturnValue([sampleJobs[1]]);
  });

  // AC1: authenticated GET → 200 JSON array
  it('returns 200 JSON array for authenticated user', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/jobs', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
    const parsed = JSON.parse(res._body);
    expect(Array.isArray(parsed)).toBe(true);
    await channel.disconnect();
  });

  // AC5: stub returns 2 rows; assert JSON has both job_id values
  it('returns both job_id values from stubbed getRecentToolJobsForGroup', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/jobs', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    const parsed = JSON.parse(res._body);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].job_id).toBe('nc-alice-abc123');
    expect(parsed[1].job_id).toBe('nc-alice-def456');
    await channel.disconnect();
  });

  // AC2: ?status=active — calls getActiveToolJobs and filters by group
  it('returns 200 and calls getActiveToolJobs for status=active', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/jobs?status=active', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(getActiveToolJobs).toHaveBeenCalled();
    await channel.disconnect();
  });

  // AC2: ?status=completed — calls getRecentToolJobsForGroup
  it('returns 200 and calls getRecentToolJobsForGroup for status=completed', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/jobs?status=completed',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(getRecentToolJobsForGroup).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
    );
    await channel.disconnect();
  });

  it('returns 400 for invalid status value', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/jobs?status=invalid', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    const parsed = JSON.parse(res._body);
    expect(parsed).toHaveProperty('error');
    await channel.disconnect();
  });

  // AC3: unauthenticated → 401
  it('returns 401 for unauthenticated request', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/jobs', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  // AC4: POST → 405 with Allow header
  it('returns 405 for POST /jobs with Allow: GET, HEAD header', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ method: 'POST', url: '/jobs', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD');
    await channel.disconnect();
  });

  // AC4: HEAD /jobs → same headers as GET, no body
  it('returns 200 for HEAD /jobs with Content-Length set but no body', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ method: 'HEAD', url: '/jobs', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
    expect(res._headers['Content-Length']).toBeDefined();
    expect(res._body).toBe('');
    await channel.disconnect();
  });

  it('defaults to limit=20 and calls getRecentToolJobsForGroup', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/jobs', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(getRecentToolJobsForGroup).toHaveBeenCalledWith(
      expect.any(String),
      20,
    );
    await channel.disconnect();
  });

  it('caps limit at 100', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/jobs?limit=999', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(getRecentToolJobsForGroup).toHaveBeenCalledWith(
      expect.any(String),
      100,
    );
    await channel.disconnect();
  });
});

// ── GET /capabilities — per-group capability list (Story 70) ──────────────

describe('GET /capabilities', () => {
  it('returns 401 when unauthenticated', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/capabilities', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 200 with application/json content-type for authenticated GET', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/capabilities', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
    await channel.disconnect();
  });

  it('returns empty array when no capabilities provisioned', async () => {
    const opts = makeOpts({
      getCapabilities: vi.fn(() => []),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({ url: '/capabilities', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([]);
    await channel.disconnect();
  });

  it('returns JSON array with both provisioned capability entries', async () => {
    const opts = makeOpts({
      getCapabilities: vi.fn((_groupFolder: string): CapabilityEntry[] => [
        {
          type: 'memory',
          state: 'running',
          provisioned_at: '2024-06-01T10:00:00.000Z',
          scale: 1,
        },
        {
          type: 'rag',
          state: 'scaled_down',
          provisioned_at: '2024-06-02T12:00:00.000Z',
          scale: 0,
        },
      ]),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({ url: '/capabilities', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      type: 'memory',
      state: 'running',
      scale: 1,
    });
    expect(body[1]).toMatchObject({
      type: 'rag',
      state: 'scaled_down',
      scale: 0,
    });
    await channel.disconnect();
  });

  it('calls getCapabilities with the authenticated user group folder', async () => {
    const getCapabilities = vi.fn(
      (_groupFolder: string): CapabilityEntry[] => [],
    );
    const opts = makeOpts({ getCapabilities });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({ url: '/capabilities', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    // group folder for 'alice' is 'alice' (from makeOpts registeredGroups)
    expect(getCapabilities).toHaveBeenCalledWith('alice');
    await channel.disconnect();
  });

  it('HEAD /capabilities returns same headers as GET but no body', async () => {
    const opts = makeOpts({
      getCapabilities: vi.fn((): CapabilityEntry[] => [
        {
          type: 'memory',
          state: 'running',
          provisioned_at: '2024-06-01T10:00:00.000Z',
          scale: 1,
        },
      ]),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      method: 'HEAD',
      url: '/capabilities',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
    // HEAD must not send a body
    expect(res._body).toBe('');
    await channel.disconnect();
  });

  it('POST /capabilities returns 405 with Allow: GET, HEAD', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/capabilities',
      auth: 'alice:secret',
      body: '{}',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD');
    await channel.disconnect();
  });
});

// ── GET /schedule — scheduled task listing (Story 68) ────────────────────

describe('GET /schedule', () => {
  const sampleTasks = [
    {
      id: 'task-active-001',
      group_folder: 'alice',
      chat_jid: 'http:alice',
      prompt: 'Send daily digest',
      schedule_type: 'cron' as const,
      schedule_value: '0 9 * * *',
      context_mode: 'isolated' as const,
      next_run: '2024-06-02T09:00:00.000Z',
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2024-06-01T10:00:00.000Z',
    },
    {
      id: 'task-paused-002',
      group_folder: 'alice',
      chat_jid: 'http:alice',
      prompt: 'Weekly report',
      schedule_type: 'cron' as const,
      schedule_value: '0 8 * * 1',
      context_mode: 'isolated' as const,
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'paused' as const,
      created_at: '2024-05-15T08:00:00.000Z',
    },
  ];

  beforeEach(() => {
    vi.mocked(getTasksForGroup).mockReset();
    vi.mocked(getTasksForGroup).mockReturnValue(sampleTasks);
  });

  // AC1: authenticated GET → 200 JSON array with required fields
  it('returns 200 JSON array for authenticated user', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/schedule', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
    const parsed = JSON.parse(res._body);
    expect(Array.isArray(parsed)).toBe(true);
    await channel.disconnect();
  });

  // AC5: stub returns 2 tasks (1 active, 1 paused); assert JSON has both ids + correct status
  it('returns both ids and correct status fields from stubbed getTasksForGroup', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/schedule', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    const parsed = JSON.parse(res._body) as Array<{
      id: string;
      status: string;
    }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('task-active-001');
    expect(parsed[0].status).toBe('active');
    expect(parsed[1].id).toBe('task-paused-002');
    expect(parsed[1].status).toBe('paused');
    await channel.disconnect();
  });

  // AC1: response rows have the required shape
  it('response rows include required fields: id, schedule_type, schedule_expression, prompt, status, next_run, created_at', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/schedule', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    const parsed = JSON.parse(res._body) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    const row = parsed[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('schedule_type');
    expect(row).toHaveProperty('schedule_expression');
    expect(row).toHaveProperty('prompt');
    expect(row).toHaveProperty('status');
    expect(row).toHaveProperty('next_run');
    expect(row).toHaveProperty('created_at');
    // schedule_expression maps from schedule_value
    expect(row.schedule_expression).toBe('0 9 * * *');
    await channel.disconnect();
  });

  // AC2: ?status=active filters to active only
  it('returns only active tasks for ?status=active', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/schedule?status=active',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body) as Array<{
      id: string;
      status: string;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('task-active-001');
    expect(parsed[0].status).toBe('active');
    await channel.disconnect();
  });

  // AC2: ?status=paused filters to paused only
  it('returns only paused tasks for ?status=paused', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/schedule?status=paused',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body) as Array<{
      id: string;
      status: string;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('task-paused-002');
    expect(parsed[0].status).toBe('paused');
    await channel.disconnect();
  });

  // AC2: invalid status → 400
  it('returns 400 for invalid status value', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/schedule?status=invalid',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    const parsed = JSON.parse(res._body);
    expect(parsed).toHaveProperty('error');
    await channel.disconnect();
  });

  // AC3: unauthenticated → 401
  it('returns 401 for unauthenticated request', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/schedule', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  // AC4: DELETE → 405 with Allow: GET, HEAD, POST (POST is now valid per Story 71)
  it('returns 405 for DELETE /schedule with Allow: GET, HEAD, POST header', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'DELETE',
      url: '/schedule',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toMatch(/GET/);
    expect(res._headers['Allow']).toMatch(/HEAD/);
    expect(res._headers['Allow']).toMatch(/POST/);
    await channel.disconnect();
  });

  // AC4: HEAD /schedule → same headers as GET, no body
  it('returns 200 for HEAD /schedule with Content-Length set but no body', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'HEAD',
      url: '/schedule',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
    expect(res._headers['Content-Length']).toBeDefined();
    expect(res._body).toBe('');
    await channel.disconnect();
  });
});

// ── POST /schedule — create scheduled task (Story 71) ────────────────────

describe('POST /schedule', () => {
  const sampleTask = {
    id: 'task-unit-001',
    group_folder: 'alice',
    chat_jid: 'http:alice',
    prompt: 'Say hello',
    schedule_type: 'cron' as const,
    schedule_value: '0 9 * * *',
    context_mode: 'isolated' as const,
    next_run: '2024-06-02T09:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active' as const,
    created_at: '2024-06-01T10:00:00.000Z',
  };

  beforeEach(() => {
    vi.mocked(createTask).mockReset();
    vi.mocked(getTaskById).mockReset();
  });

  // AC1: valid cron body → 201 JSON
  it('returns 201 with task JSON for valid cron body', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/schedule',
      auth: 'alice:secret',
      body: JSON.stringify({
        schedule_type: 'cron',
        schedule_expression: '0 9 * * *',
        prompt: 'Say hello',
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(201);
    expect(res._headers['Content-Type']).toContain('application/json');
    const parsed = JSON.parse(res._body);
    expect(parsed).toHaveProperty('id');
    expect(parsed.status).toBe('active');
    expect(parsed.schedule_type).toBe('cron');
    expect(parsed.schedule_expression).toBe('0 9 * * *');
    expect(parsed.prompt).toBe('Say hello');
    expect(parsed).toHaveProperty('next_run');
    expect(parsed).toHaveProperty('created_at');
    expect(vi.mocked(createTask)).toHaveBeenCalledOnce();
    await channel.disconnect();
  });

  // AC1: valid interval body → 201
  it('returns 201 for valid interval body', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/schedule',
      auth: 'alice:secret',
      body: JSON.stringify({
        schedule_type: 'interval',
        schedule_expression: '60000',
        prompt: 'Ping',
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(201);
    const parsed = JSON.parse(res._body);
    expect(parsed.schedule_type).toBe('interval');
    await channel.disconnect();
  });

  // AC1: valid once body → 201
  it('returns 201 for valid once body with ISO date', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/schedule',
      auth: 'alice:secret',
      body: JSON.stringify({
        schedule_type: 'once',
        schedule_expression: '2099-01-01T00:00:00.000Z',
        prompt: 'One-shot',
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(201);
    await channel.disconnect();
  });

  // AC1: invalid body — missing fields → 400
  it('returns 400 when required fields are missing', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/schedule',
      auth: 'alice:secret',
      body: JSON.stringify({ schedule_type: 'cron' }), // missing schedule_expression and prompt
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  // AC1: invalid schedule_type → 400
  it('returns 400 for unrecognised schedule_type', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/schedule',
      auth: 'alice:secret',
      body: JSON.stringify({
        schedule_type: 'weekly',
        schedule_expression: '0 9 * * *',
        prompt: 'Hi',
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    const parsed = JSON.parse(res._body);
    expect(parsed.error).toMatch(/schedule_type/i);
    await channel.disconnect();
  });

  // AC1: invalid cron expression → 400
  it('returns 400 for invalid cron expression', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/schedule',
      auth: 'alice:secret',
      body: JSON.stringify({
        schedule_type: 'cron',
        schedule_expression: 'not-a-cron',
        prompt: 'Hi',
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  // AC1: invalid interval (non-integer) → 400
  it('returns 400 for non-integer interval value', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/schedule',
      auth: 'alice:secret',
      body: JSON.stringify({
        schedule_type: 'interval',
        schedule_expression: 'abc',
        prompt: 'Hi',
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  // AC5: unauthenticated POST → 401
  it('returns 401 for unauthenticated POST /schedule', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/schedule',
      auth: null,
      body: JSON.stringify({
        schedule_type: 'cron',
        schedule_expression: '0 9 * * *',
        prompt: 'Hi',
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  // POST /schedule with empty/whitespace prompt returns 400
  it('POST /schedule with empty/whitespace prompt returns 400', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/schedule',
      auth: 'alice:secret',
      body: JSON.stringify({
        schedule_type: 'interval',
        schedule_expression: '60000',
        prompt: '   ',
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    const responseBody = res._body;
    expect(responseBody).toBeTruthy(); // Should contain error
    await channel.disconnect();
  });

  // POST /schedule with schedule_type=once and invalid ISO date returns 400
  it('POST /schedule with schedule_type=once and invalid ISO date returns 400', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/schedule',
      auth: 'alice:secret',
      body: JSON.stringify({
        schedule_type: 'once',
        schedule_expression: 'not-a-date',
        prompt: 'hi',
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    const responseBody = res._body;
    expect(responseBody).toBeTruthy(); // Should contain error
    await channel.disconnect();
  });

  void sampleTask; // suppress unused variable warning
});

// ── DELETE /schedule/<id> (Story 71) ─────────────────────────────────────

describe('DELETE /schedule/<id>', () => {
  beforeEach(() => {
    vi.mocked(deleteTaskForGroup).mockReset();
  });

  // AC2: authenticated DELETE for own group → 204 no body
  it('returns 204 for authenticated DELETE of owned task', async () => {
    vi.mocked(deleteTaskForGroup).mockReturnValue(true);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'DELETE',
      url: '/schedule/task-id-001',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(204);
    expect(res._body).toBe('');
    expect(vi.mocked(deleteTaskForGroup)).toHaveBeenCalledWith(
      'task-id-001',
      'alice',
    );
    await channel.disconnect();
  });

  // AC3: unknown id → 404
  it('returns 404 for unknown task id', async () => {
    vi.mocked(deleteTaskForGroup).mockReturnValue(false);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'DELETE',
      url: '/schedule/no-such-task',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    await channel.disconnect();
  });

  // AC3: cross-group id → same 404 wording
  it('returns 404 (same wording) for cross-group task id', async () => {
    vi.mocked(deleteTaskForGroup).mockReturnValue(false);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'DELETE',
      url: '/schedule/other-group-task',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    const body = JSON.parse(res._body);
    expect(body.error).toBe('Not found');
    await channel.disconnect();
  });

  // AC5: unauthenticated → 401
  it('returns 401 for unauthenticated DELETE /schedule/<id>', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'DELETE',
      url: '/schedule/task-id-001',
      auth: null,
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });
});

// ── PATCH /schedule/<id> (Story 71) ──────────────────────────────────────

describe('PATCH /schedule/<id>', () => {
  const activeTask = {
    id: 'task-patch-001',
    group_folder: 'alice',
    chat_jid: 'http:alice',
    prompt: 'Say hello',
    schedule_type: 'cron' as const,
    schedule_value: '0 9 * * *',
    context_mode: 'isolated' as const,
    next_run: '2024-06-02T09:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active' as const,
    created_at: '2024-06-01T10:00:00.000Z',
  };
  const pausedTask = { ...activeTask, status: 'paused' as const };

  beforeEach(() => {
    vi.mocked(getTaskById).mockReset();
    vi.mocked(pauseTask).mockReset();
    vi.mocked(resumeTask).mockReset();
  });

  // AC4: PATCH { paused: true } → 200 status "paused"
  it('returns 200 with status "paused" when pausing an active task', async () => {
    vi.mocked(getTaskById)
      .mockReturnValueOnce(activeTask) // existence check
      .mockReturnValueOnce(pausedTask); // re-fetch after update
    vi.mocked(pauseTask).mockReturnValue(true);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'PATCH',
      url: '/schedule/task-patch-001',
      auth: 'alice:secret',
      body: JSON.stringify({ paused: true }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body);
    expect(parsed.status).toBe('paused');
    expect(vi.mocked(pauseTask)).toHaveBeenCalledWith(
      'task-patch-001',
      'alice',
    );
    await channel.disconnect();
  });

  // AC4: PATCH { paused: false } → 200 status "active"
  it('returns 200 with status "active" when resuming a paused task', async () => {
    vi.mocked(getTaskById)
      .mockReturnValueOnce(pausedTask)
      .mockReturnValueOnce(activeTask);
    vi.mocked(resumeTask).mockReturnValue(true);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'PATCH',
      url: '/schedule/task-patch-001',
      auth: 'alice:secret',
      body: JSON.stringify({ paused: false }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body);
    expect(parsed.status).toBe('active');
    expect(vi.mocked(resumeTask)).toHaveBeenCalledWith(
      'task-patch-001',
      'alice',
    );
    await channel.disconnect();
  });

  // AC4: unknown/cross-group → 404
  it('returns 404 for unknown task id', async () => {
    vi.mocked(getTaskById).mockReturnValue(undefined);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'PATCH',
      url: '/schedule/no-such-task',
      auth: 'alice:secret',
      body: JSON.stringify({ paused: true }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    const parsed = JSON.parse(res._body);
    expect(parsed.error).toBe('Not found');
    await channel.disconnect();
  });

  it('returns 404 for cross-group task id (same wording)', async () => {
    // Task exists but for a different group
    vi.mocked(getTaskById).mockReturnValue({
      ...activeTask,
      group_folder: 'other-group',
    });
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'PATCH',
      url: '/schedule/other-task',
      auth: 'alice:secret',
      body: JSON.stringify({ paused: true }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    const parsed = JSON.parse(res._body);
    expect(parsed.error).toBe('Not found');
    await channel.disconnect();
  });

  // AC4: bad PATCH body → 400
  it('returns 400 for PATCH body without paused field', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'PATCH',
      url: '/schedule/task-patch-001',
      auth: 'alice:secret',
      body: JSON.stringify({ status: 'paused' }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  // AC5: POST /schedule/<id> → 405 Allow: DELETE, PATCH, HEAD
  it('returns 405 for POST /schedule/<id> with Allow: DELETE, PATCH, HEAD', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/schedule/task-id-001',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('DELETE, PATCH, HEAD');
    await channel.disconnect();
  });

  // AC5: unauthenticated → 401
  it('returns 401 for unauthenticated PATCH /schedule/<id>', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'PATCH',
      url: '/schedule/task-patch-001',
      auth: null,
      body: JSON.stringify({ paused: true }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  // AC5: HEAD /schedule/<id> → 200/404 same headers as GET, no body
  it('returns 200 for HEAD /schedule/<id> when task exists and belongs to group', async () => {
    vi.mocked(getTaskById).mockReturnValue(activeTask);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'HEAD',
      url: '/schedule/task-patch-001',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._body).toBe('');
    await channel.disconnect();
  });

  it('returns 404 for HEAD /schedule/<id> when task does not exist', async () => {
    vi.mocked(getTaskById).mockReturnValue(undefined);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'HEAD',
      url: '/schedule/no-such-task',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    expect(res._body).toBe('');
    await channel.disconnect();
  });

  void pausedTask; // suppress unused variable warning
});

// ── GET /jobs/<id> and DELETE /jobs/<id> (Story 69) ──────────────────────

describe('GET /jobs/<id>', () => {
  const sampleJob = {
    job_id: 'nc-alice-abc123',
    group_folder: 'alice',
    chat_jid: 'http:alice',
    specialist_name: 'search',
    status: 'completed' as const,
    created_at: '2024-06-01T10:00:00.000Z',
    resolved_at: '2024-06-01T10:05:00.000Z',
    message_id: null,
  };

  beforeEach(() => {
    vi.mocked(getToolJobByIdForGroup).mockReset();
  });

  // AC1: authenticated GET happy path → 200 JSON
  it('returns 200 JSON with job fields for authenticated user', async () => {
    vi.mocked(getToolJobByIdForGroup).mockReturnValue(sampleJob);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/jobs/nc-alice-abc123', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
    const parsed = JSON.parse(res._body);
    expect(parsed.job_id).toBe('nc-alice-abc123');
    expect(parsed.specialist_name).toBe('search');
    expect(parsed.status).toBe('completed');
    expect(parsed).toHaveProperty('created_at');
    expect(parsed).toHaveProperty('resolved_at');
    await channel.disconnect();
  });

  // AC2: unknown id → 404 (same wording as cross-group)
  it('returns 404 for unknown job id', async () => {
    vi.mocked(getToolJobByIdForGroup).mockReturnValue(null);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/jobs/no-such-job', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    await channel.disconnect();
  });

  // AC5: HEAD → same headers as GET, no body
  it('returns 200 for HEAD /jobs/<id> with no body', async () => {
    vi.mocked(getToolJobByIdForGroup).mockReturnValue(sampleJob);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'HEAD',
      url: '/jobs/nc-alice-abc123',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
    expect(res._headers['Content-Length']).toBeDefined();
    expect(res._body).toBe('');
    await channel.disconnect();
  });

  // AC5: POST → 405 Allow: GET, HEAD, DELETE
  it('returns 405 for POST /jobs/<id> with Allow: GET, HEAD, DELETE', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/jobs/nc-alice-abc123',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD, DELETE');
    await channel.disconnect();
  });

  // AC5: unauthenticated → 401
  it('returns 401 for unauthenticated GET /jobs/<id>', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/jobs/nc-alice-abc123', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });
});

describe('DELETE /jobs/<id>', () => {
  const activeJob = {
    job_id: 'nc-alice-active01',
    group_folder: 'alice',
    chat_jid: 'http:alice',
    specialist_name: 'search',
    status: 'active' as const,
    created_at: '2024-06-01T10:00:00.000Z',
    resolved_at: null,
    message_id: null,
  };
  const completedJob = {
    ...activeJob,
    job_id: 'nc-alice-done01',
    status: 'completed' as const,
    resolved_at: '2024-06-01T10:05:00.000Z',
  };

  beforeEach(() => {
    vi.mocked(getToolJobByIdForGroup).mockReset();
  });

  // AC3: DELETE active job → 200 { status: "cancelled", job_id }
  it('returns 200 cancelled for active job', async () => {
    vi.mocked(getToolJobByIdForGroup).mockReturnValue(activeJob);
    const killJobFn = vi.fn(async () => ({
      ok: true as const,
      status: 'cancelled',
    }));
    const channel = new HttpChannel(makeConfig(), makeOpts({ killJobFn }));
    await channel.connect();

    const req = makeReq({
      method: 'DELETE',
      url: '/jobs/nc-alice-active01',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body);
    expect(parsed.status).toBe('cancelled');
    expect(parsed.job_id).toBe('nc-alice-active01');
    expect(killJobFn).toHaveBeenCalledWith('nc-alice-active01', 'alice');
    await channel.disconnect();
  });

  // AC4: DELETE resolved job → 409 not_active
  it('returns 409 for resolved (non-active) job', async () => {
    vi.mocked(getToolJobByIdForGroup).mockReturnValue(completedJob);
    const killJobFn = vi.fn();
    const channel = new HttpChannel(makeConfig(), makeOpts({ killJobFn }));
    await channel.connect();

    const req = makeReq({
      method: 'DELETE',
      url: '/jobs/nc-alice-done01',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(409);
    const parsed = JSON.parse(res._body);
    expect(parsed.error).toBe('not_active');
    expect(parsed.current_status).toBe('completed');
    // killJobFn should not be called for non-active jobs
    expect(killJobFn).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  // AC4: DELETE unknown id → 404
  it('returns 404 for unknown job id', async () => {
    vi.mocked(getToolJobByIdForGroup).mockReturnValue(null);
    const killJobFn = vi.fn();
    const channel = new HttpChannel(makeConfig(), makeOpts({ killJobFn }));
    await channel.connect();

    const req = makeReq({
      method: 'DELETE',
      url: '/jobs/no-such-job',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    expect(killJobFn).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  // AC3: IPC returns not_found → 404
  it('returns 404 when IPC replies not_found', async () => {
    vi.mocked(getToolJobByIdForGroup).mockReturnValue(activeJob);
    const killJobFn = vi.fn(async () => ({
      ok: false as const,
      status: 'not_found',
    }));
    const channel = new HttpChannel(makeConfig(), makeOpts({ killJobFn }));
    await channel.connect();

    const req = makeReq({
      method: 'DELETE',
      url: '/jobs/nc-alice-active01',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    await channel.disconnect();
  });

  // AC3: IPC returns not_active → 409
  it('returns 409 when IPC replies not_active', async () => {
    vi.mocked(getToolJobByIdForGroup).mockReturnValue(activeJob);
    const killJobFn = vi.fn(async () => ({
      ok: false as const,
      status: 'not_active',
      currentStatus: 'interrupted',
    }));
    const channel = new HttpChannel(makeConfig(), makeOpts({ killJobFn }));
    await channel.connect();

    const req = makeReq({
      method: 'DELETE',
      url: '/jobs/nc-alice-active01',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(409);
    const parsed = JSON.parse(res._body);
    expect(parsed.error).toBe('not_active');
    expect(parsed.current_status).toBe('interrupted');
    await channel.disconnect();
  });

  // AC5: unauthenticated DELETE → 401
  it('returns 401 for unauthenticated DELETE /jobs/<id>', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'DELETE',
      url: '/jobs/nc-alice-active01',
      auth: null,
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  // IPC timeout → 504
  it('returns 504 when IPC times out', async () => {
    vi.mocked(getToolJobByIdForGroup).mockReturnValue(activeJob);
    const killJobFn = vi.fn(async () => {
      throw new Error('timeout');
    });
    const channel = new HttpChannel(makeConfig(), makeOpts({ killJobFn }));
    await channel.connect();

    const req = makeReq({
      method: 'DELETE',
      url: '/jobs/nc-alice-active01',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(504);
    await channel.disconnect();
  });
});

// ── GET /search ──────────────────────────────────────────────────────────

describe('GET /search', () => {
  const SAMPLE_ROWS = [
    {
      id: 'row-2',
      groupFolder: 'alice',
      role: 'assistant' as const,
      content: 'The sidecar handles TLS.',
      createdAt: '2026-05-21T12:00:00.000Z',
      snippet: 'The [sidecar] handles TLS.',
    },
    {
      id: 'row-1',
      groupFolder: 'alice',
      role: 'user' as const,
      content: 'What does the sidecar do?',
      createdAt: '2026-05-21T11:00:00.000Z',
      snippet: 'What does the [sidecar] do?',
    },
  ];

  it('returns 401 when not authenticated', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/search?q=sidecar', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 400 when q is missing', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/search', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/q required/i);
    await channel.disconnect();
  });

  it('returns 400 when q is empty string', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/search?q=', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/q required/i);
    await channel.disconnect();
  });

  it('returns 400 when q exceeds 500 chars', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const longQ = 'a'.repeat(501);
    const req = makeReq({ url: `/search?q=${longQ}`, auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('returns 200 JSON array with both rows in order (AC5: unit stub)', async () => {
    (searchConversations as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      SAMPLE_ROWS,
    );

    const opts = makeOpts();
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({ url: '/search?q=sidecar', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
    const body = JSON.parse(res._body);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    // newest-first: row-2 before row-1
    expect(body[0].id).toBe('row-2');
    expect(body[1].id).toBe('row-1');
    // Response fields match spec
    expect(body[0]).toMatchObject({
      id: 'row-2',
      role: 'assistant',
      content: 'The sidecar handles TLS.',
      timestamp: '2026-05-21T12:00:00.000Z',
    });
    await channel.disconnect();
  });

  it('passes limit parameter capped at 100', async () => {
    (searchConversations as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);

    const opts = makeOpts();
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/search?q=foo&limit=200',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(searchConversations).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
    await channel.disconnect();
  });

  it('uses default limit of 20 when limit not specified', async () => {
    (searchConversations as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);

    const opts = makeOpts();
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({ url: '/search?q=foo', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(searchConversations).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
    await channel.disconnect();
  });

  it('scopes query to the authenticated user group folder', async () => {
    (searchConversations as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);

    const opts = makeOpts();
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({ url: '/search?q=test', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(searchConversations).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'alice' }),
    );
    await channel.disconnect();
  });

  it('returns 405 with Allow: GET, HEAD for POST /search', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'POST',
      url: '/search',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD');
    await channel.disconnect();
  });

  it('HEAD /search returns same headers as GET but no body, with Content-Length', async () => {
    (searchConversations as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      SAMPLE_ROWS,
    );

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'HEAD',
      url: '/search?q=sidecar',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
    // HEAD must send no body
    expect(res._body).toBe('');
    // HEAD must include Content-Length matching the body that GET would return
    expect(res._headers['Content-Length']).toBeDefined();
    expect(Number(res._headers['Content-Length'])).toBeGreaterThan(0);
    await channel.disconnect();
  });

  it('returns 404 when user group is not registered', async () => {
    const opts = makeOpts({ registeredGroups: vi.fn(() => ({})) });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({ url: '/search?q=test', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    // Unregistered group → cannot determine folder → 404
    expect([404, 400]).toContain(res._status);
    await channel.disconnect();
  });
});

// ── GET /secrets — list group secrets ─────────────────────────────────────

describe('GET /secrets', () => {
  it('returns 401 when unauthenticated', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/secrets', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 200 JSON array with type and fields_present for two types', async () => {
    const listSecretsFn = vi.fn().mockResolvedValue([
      { type: 'replicate', fields_present: ['token'] },
      { type: 'openai', fields_present: ['api_key', 'org_id'] },
    ]);
    const channel = new HttpChannel(makeConfig(), makeOpts({ listSecretsFn }));
    await channel.connect();

    const req = makeReq({ url: '/secrets', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(res._body);
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({ type: 'replicate', fields_present: ['token'] });
    expect(body[1]).toEqual({
      type: 'openai',
      fields_present: ['api_key', 'org_id'],
    });
    await channel.disconnect();
  });

  it('returns empty array when no secrets registered', async () => {
    const listSecretsFn = vi.fn().mockResolvedValue([]);
    const channel = new HttpChannel(makeConfig(), makeOpts({ listSecretsFn }));
    await channel.connect();

    const req = makeReq({ url: '/secrets', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual([]);
    await channel.disconnect();
  });

  it('SECURITY: secret values in IPC reply are NEVER returned', async () => {
    // Even if stub provides extra fields, they must be scrubbed
    const listSecretsFn = vi.fn().mockResolvedValue([
      {
        type: 'replicate',
        fields_present: ['token'],
        // These extra fields must be scrubbed:
        value: 'r8_secret_value',
        token: 'r8_secret_value',
        fields: {
          token: { value: 'r8_secret_value', placeholder: 'KC_PH_token_abc' },
        },
      },
    ]);
    const channel = new HttpChannel(makeConfig(), makeOpts({ listSecretsFn }));
    await channel.connect();

    const req = makeReq({ url: '/secrets', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(JSON.stringify(body)).not.toContain('r8_secret_value');
    expect(JSON.stringify(body)).not.toContain('KC_PH_token_abc');
    // Only type and fields_present must be present
    expect(body[0]).toEqual({ type: 'replicate', fields_present: ['token'] });
    await channel.disconnect();
  });

  it('listSecretsFn is called with the authenticated user group folder', async () => {
    const listSecretsFn = vi.fn().mockResolvedValue([]);
    const channel = new HttpChannel(makeConfig(), makeOpts({ listSecretsFn }));
    await channel.connect();

    const req = makeReq({ url: '/secrets', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    // alice's folder is 'alice' per makeOpts()
    expect(listSecretsFn).toHaveBeenCalledWith('alice');
    await channel.disconnect();
  });

  it('returns 503 when listSecretsFn is not configured', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/secrets', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(503);
    await channel.disconnect();
  });

  it('HEAD /secrets returns 200 without body', async () => {
    const listSecretsFn = vi.fn().mockResolvedValue([]);
    const channel = new HttpChannel(makeConfig(), makeOpts({ listSecretsFn }));
    await channel.connect();

    const req = makeReq({
      url: '/secrets',
      method: 'HEAD',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    await channel.disconnect();
  });

  it('PUT /secrets returns 405 with Allow: GET, HEAD, POST', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/secrets',
      method: 'PUT',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD, POST');
    await channel.disconnect();
  });
});

// ── DELETE /secrets/:type — remove a secret ───────────────────────────────

describe('DELETE /secrets/:type', () => {
  it('returns 401 when unauthenticated', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/secrets/replicate',
      method: 'DELETE',
      auth: null,
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 204 on successful delete', async () => {
    const removeSecretFn = vi.fn().mockResolvedValue('ok');
    const channel = new HttpChannel(makeConfig(), makeOpts({ removeSecretFn }));
    await channel.connect();

    const req = makeReq({
      url: '/secrets/replicate',
      method: 'DELETE',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(204);
    await channel.disconnect();
  });

  it('returns 404 for unknown type', async () => {
    const removeSecretFn = vi.fn().mockResolvedValue('not_found');
    const channel = new HttpChannel(makeConfig(), makeOpts({ removeSecretFn }));
    await channel.connect();

    const req = makeReq({
      url: '/secrets/unknown-type',
      method: 'DELETE',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    const body = JSON.parse(res._body);
    expect(body.error).toBe('Not found');
    await channel.disconnect();
  });

  it('returns 404 with identical wording for cross-group type (not_found)', async () => {
    // Cross-group is treated as not_found — identical response
    const removeSecretFn = vi.fn().mockResolvedValue('not_found');
    const channel = new HttpChannel(makeConfig(), makeOpts({ removeSecretFn }));
    await channel.connect();

    const req = makeReq({
      url: '/secrets/other-group-type',
      method: 'DELETE',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    const body = JSON.parse(res._body);
    expect(body.error).toBe('Not found');
    await channel.disconnect();
  });

  it('removeSecretFn is called with the correct group folder and type', async () => {
    const removeSecretFn = vi.fn().mockResolvedValue('ok');
    const channel = new HttpChannel(makeConfig(), makeOpts({ removeSecretFn }));
    await channel.connect();

    const req = makeReq({
      url: '/secrets/replicate',
      method: 'DELETE',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(removeSecretFn).toHaveBeenCalledWith('alice', 'replicate');
    await channel.disconnect();
  });

  it('POST /secrets/:type returns 405 with Allow: DELETE, HEAD', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/secrets/replicate',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('DELETE, HEAD');
    await channel.disconnect();
  });

  it('HEAD /secrets/:type returns 200 without body', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/secrets/replicate',
      method: 'HEAD',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    await channel.disconnect();
  });
});

// ── GET /secrets/catalog — credential catalog ─────────────────────────────

describe('GET /secrets/catalog', () => {
  it('returns 401 when unauthenticated', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/secrets/catalog', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 200 JSON array of catalog entries', async () => {
    const listCatalogFn = vi.fn().mockResolvedValue([
      {
        type: 'replicate',
        required_fields: ['token'],
        optional_fields: [],
        description: 'api.replicate.com',
      },
      {
        type: 'jenkins',
        required_fields: ['user', 'password'],
        optional_fields: [],
        description: 'jenkins.example.com',
      },
    ]);
    const channel = new HttpChannel(makeConfig(), makeOpts({ listCatalogFn }));
    await channel.connect();

    const req = makeReq({ url: '/secrets/catalog', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(res._body);
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({
      type: 'replicate',
      required_fields: ['token'],
      optional_fields: [],
      description: 'api.replicate.com',
    });
    await channel.disconnect();
  });

  it('returns 503 when listCatalogFn is not configured', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/secrets/catalog', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(503);
    await channel.disconnect();
  });

  it('HEAD /secrets/catalog returns 200 without body', async () => {
    const listCatalogFn = vi.fn().mockResolvedValue([]);
    const channel = new HttpChannel(makeConfig(), makeOpts({ listCatalogFn }));
    await channel.connect();

    const req = makeReq({
      url: '/secrets/catalog',
      method: 'HEAD',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    await channel.disconnect();
  });

  it('POST /secrets/catalog returns 405 with Allow: GET, HEAD', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/secrets/catalog',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD');
    await channel.disconnect();
  });

  it('SECURITY: catalog response does not expose secret values', async () => {
    const listCatalogFn = vi.fn().mockResolvedValue([
      {
        type: 'replicate',
        required_fields: ['token'],
        optional_fields: [],
        description: 'api.replicate.com',
        // These extra fields must be scrubbed
        secretValues: { token: 'r8_actual_secret' },
        internalData: 'some_internal',
      },
    ]);
    const channel = new HttpChannel(makeConfig(), makeOpts({ listCatalogFn }));
    await channel.connect();

    const req = makeReq({ url: '/secrets/catalog', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(JSON.stringify(body)).not.toContain('r8_actual_secret');
    expect(JSON.stringify(body)).not.toContain('some_internal');
    expect(body[0]).toEqual({
      type: 'replicate',
      required_fields: ['token'],
      optional_fields: [],
      description: 'api.replicate.com',
    });
    await channel.disconnect();
  });
});

// ── GET /whoami — authenticated identity (Story 75) ───────────────────────

describe('GET /whoami', () => {
  it('AC1: authenticated GET returns 200 with Content-Type application/json', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/whoami',
      method: 'GET',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');
    await channel.disconnect();
  });

  it('AC1: response body has exactly 3 fields: username, group, group_folder', async () => {
    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({
        'http:alice': {
          name: 'alice',
          folder: 'groups/http-alice',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      })),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/whoami',
      method: 'GET',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    const body = JSON.parse(res._body) as Record<string, unknown>;
    expect(body.username).toBe('alice');
    expect(body.group).toBe('http:alice');
    expect(body.group_folder).toBe('groups/http-alice');
    // AC4: EXACTLY 3 fields — no extras
    expect(Object.keys(body)).toHaveLength(3);
    await channel.disconnect();
  });

  it('AC1+AC4: group is http:<username> and group_folder comes from registeredGroups()', async () => {
    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({
        'http:alice': {
          name: 'alice',
          folder: 'custom-folder',
          trigger: '',
          added_at: '',
        },
      })),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/whoami',
      method: 'GET',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    const body = JSON.parse(res._body) as Record<string, unknown>;
    expect(body.group).toBe('http:alice');
    expect(body.group_folder).toBe('custom-folder');
    await channel.disconnect();
  });

  it('AC2: unauthenticated request returns 401', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/whoami', method: 'GET', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('AC3: POST /whoami returns 405 with Allow: GET, HEAD', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/whoami',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD');
    await channel.disconnect();
  });

  it('AC3: HEAD /whoami returns 200 with same headers as GET but no body', async () => {
    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({
        'http:alice': {
          name: 'alice',
          folder: 'alice-folder',
          trigger: '',
          added_at: '',
        },
      })),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/whoami',
      method: 'HEAD',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');
    // HEAD must not send a body
    expect(res._body).toBe('');
    await channel.disconnect();
  });

  it('AC4: response contains EXACTLY the 3 documented fields, no extras', async () => {
    const opts = makeOpts();
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/whoami',
      method: 'GET',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    const body = JSON.parse(res._body) as Record<string, unknown>;
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(['group', 'group_folder', 'username']);
    await channel.disconnect();
  });

  it('AC5: response contains no sensitive material (no token/password/auth-secret/session)', async () => {
    const opts = makeOpts();
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/whoami',
      method: 'GET',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    const raw = res._body.toLowerCase();
    // Must not leak any credential-adjacent fields
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('session');
    await channel.disconnect();
  });

  it('AC1: group_folder is empty string when group is not yet registered', async () => {
    // User authenticated but no registered group yet
    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({})),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/whoami',
      method: 'GET',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as Record<string, unknown>;
    expect(body.username).toBe('alice');
    expect(body.group).toBe('http:alice');
    expect(body.group_folder).toBe('');
    await channel.disconnect();
  });

  it('unauthenticated POST /whoami returns 405 not 401', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/whoami', method: 'POST', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD');
    await channel.disconnect();
  });
});

// ── /memory REST API ──────────────────────────────────────────────────────

describe('GET /memory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverListeners.clear();
  });

  it('returns 200 JSON with content when file exists', async () => {
    vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
      '# My notes\nSome memory' as never,
    );
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/memory',
      method: 'GET',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body);
    expect(parsed.content).toBe('# My notes\nSome memory');
    await channel.disconnect();
  });

  it('returns 200 with empty content when file does not exist', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(fsPromises.readFile).mockRejectedValueOnce(enoent as never);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/memory',
      method: 'GET',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body);
    expect(parsed.content).toBe('');
    await channel.disconnect();
  });

  it('returns 401 without auth', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/memory', method: 'GET', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('HEAD returns same headers as GET but no body', async () => {
    vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
      '# Memory content' as never,
    );
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const reqHead = makeReq({
      url: '/memory',
      method: 'HEAD',
      auth: 'alice:secret',
    });
    const resHead = makeRes();
    await dispatch(channel, reqHead, resHead);

    expect(resHead._status).toBe(200);
    expect(resHead._headers['Content-Type']).toBe('application/json');
    expect(resHead._headers['Content-Length']).toBeDefined();
    // HEAD should have no body written via end() with data
    const endCalls = (resHead.end as ReturnType<typeof vi.fn>).mock.calls;
    expect(endCalls[0][0]).toBeUndefined();
    await channel.disconnect();
  });
});

describe('PUT /memory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverListeners.clear();
  });

  function makePutReq(
    body: string,
    auth: string | null = 'alice:secret',
  ): IncomingMessage {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (auth !== null) {
      headers.authorization = `Basic ${b64(auth)}`;
    }
    const req = {
      method: 'PUT',
      url: '/memory',
      headers,
      on: vi.fn(),
      destroy: vi.fn(),
      resume: vi.fn(),
    } as unknown as IncomingMessage;
    (req.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'data') cb(Buffer.from(body));
        if (event === 'end') cb();
      },
    );
    return req;
  }

  it('returns 204 for valid PUT', async () => {
    vi.mocked(fsPromises.mkdir).mockResolvedValueOnce(undefined as never);
    vi.mocked(fsPromises.writeFile).mockResolvedValueOnce(undefined as never);
    vi.mocked(fsPromises.rename).mockResolvedValueOnce(undefined as never);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makePutReq(JSON.stringify({ content: 'New memory content' }));
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(204);
    expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
      expect.stringContaining('.claude-md-tmp-'),
      'New memory content',
      'utf8',
    );
    expect(vi.mocked(fsPromises.rename)).toHaveBeenCalledWith(
      expect.stringContaining('.claude-md-tmp-'),
      expect.stringContaining('CLAUDE.md'),
    );
    await channel.disconnect();
  });

  it('returns 400 when content field is missing', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makePutReq(JSON.stringify({ other: 'field' }));
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('returns 400 when content is not a string', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makePutReq(JSON.stringify({ content: 42 }));
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('returns 400 for invalid JSON body', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makePutReq('not-json');
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('returns 401 without auth', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makePutReq(JSON.stringify({ content: 'hello' }), null);
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 413 for oversized body', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const oversizedBody = 'x'.repeat(2 * 1024 * 1024); // 2 MiB
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Basic ${b64('alice:secret')}`,
    };
    const req = {
      method: 'PUT',
      url: '/memory',
      headers,
      on: vi.fn(),
      destroy: vi.fn(),
      resume: vi.fn(),
    } as unknown as IncomingMessage;
    (req.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'data') cb(Buffer.from(oversizedBody));
        if (event === 'end') cb();
      },
    );
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(413);
    await channel.disconnect();
  });
});

describe('PATCH /memory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverListeners.clear();
  });

  function makePatchReq(
    body: string,
    auth: string | null = 'alice:secret',
  ): IncomingMessage {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (auth !== null) {
      headers.authorization = `Basic ${b64(auth)}`;
    }
    const req = {
      method: 'PATCH',
      url: '/memory',
      headers,
      on: vi.fn(),
      destroy: vi.fn(),
      resume: vi.fn(),
    } as unknown as IncomingMessage;
    (req.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'data') cb(Buffer.from(body));
        if (event === 'end') cb();
      },
    );
    return req;
  }

  it('returns 204 and appends with newline when file has existing content', async () => {
    vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
      'Existing content' as never,
    );
    vi.mocked(fsPromises.mkdir).mockResolvedValueOnce(undefined as never);
    vi.mocked(fsPromises.writeFile).mockResolvedValueOnce(undefined as never);
    vi.mocked(fsPromises.rename).mockResolvedValueOnce(undefined as never);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makePatchReq(JSON.stringify({ append: 'New paragraph' }));
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(204);
    expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
      expect.stringContaining('.claude-md-tmp-'),
      'Existing content\nNew paragraph',
      'utf8',
    );
    await channel.disconnect();
  });

  it('returns 204 and writes directly when file does not exist', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(fsPromises.readFile).mockRejectedValueOnce(enoent as never);
    vi.mocked(fsPromises.mkdir).mockResolvedValueOnce(undefined as never);
    vi.mocked(fsPromises.writeFile).mockResolvedValueOnce(undefined as never);
    vi.mocked(fsPromises.rename).mockResolvedValueOnce(undefined as never);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makePatchReq(JSON.stringify({ append: 'First line' }));
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(204);
    expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
      expect.stringContaining('.claude-md-tmp-'),
      'First line',
      'utf8',
    );
    await channel.disconnect();
  });

  it('returns 400 when append field is missing', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makePatchReq(JSON.stringify({ other: 'field' }));
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('returns 400 when append is not a string', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makePatchReq(JSON.stringify({ append: true }));
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('returns 401 without auth', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makePatchReq(JSON.stringify({ append: 'text' }), null);
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });
});

describe('POST /memory — 405 Method Not Allowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverListeners.clear();
  });

  it('returns 405 with Allow header for POST /memory', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/memory',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toContain('GET');
    expect(res._headers['Allow']).toContain('PUT');
    expect(res._headers['Allow']).toContain('PATCH');
    await channel.disconnect();
  });

  it('returns 405 for DELETE /memory (before auth — no info leak)', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/memory', method: 'DELETE', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    await channel.disconnect();
  });
});

// ── POST /secrets — Story 76 ──────────────────────────────────────────────

describe('POST /secrets', () => {
  function makeAddSecretOpts(addSecretFn: AddSecretFn): HttpChannelOpts {
    return makeOpts({ addSecretFn });
  }

  function makePostReq(overrides: {
    auth?: string | null;
    body?: string;
  }): ReturnType<typeof makeReq> {
    const req = makeReq({
      method: 'POST',
      url: '/secrets',
      auth: overrides.auth !== undefined ? overrides.auth : 'alice:secret',
      body: overrides.body,
    });
    return req;
  }

  it('returns 201 { status: ok, type: <id> } on success', async () => {
    const addFn: AddSecretFn = vi.fn(async () => ({ ok: true }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const req = makePostReq({
      body: JSON.stringify({ type: 'openai', fields: { api_key: 'sk-test' } }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(201);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ status: 'ok', type: 'openai' });

    // SECURITY: response must NOT contain the secret value
    expect(res._body).not.toContain('sk-test');

    await channel.disconnect();
  });

  it('calls addSecretFn with authenticated group — not client-supplied group', async () => {
    let capturedGroup: string | undefined;
    const addFn: AddSecretFn = vi.fn(async (group) => {
      capturedGroup = group;
      return { ok: true };
    });
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    // Body includes a "group" field that should be IGNORED
    const req = makePostReq({
      body: JSON.stringify({
        type: 'openai',
        fields: { api_key: 'sk-x' },
        group: 'hacker-group', // must be ignored
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(201);
    // Group comes from auth session ('alice'), not from client body
    expect(capturedGroup).toBe('alice'); // folder from makeOpts
    await channel.disconnect();
  });

  it('returns 400 when fields is missing', async () => {
    const addFn: AddSecretFn = vi.fn(async () => ({ ok: true }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const req = makePostReq({
      body: JSON.stringify({ type: 'openai' }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.error).toBeDefined();
    await channel.disconnect();
  });

  it('returns 400 when fields is not an object (array)', async () => {
    const addFn: AddSecretFn = vi.fn(async () => ({ ok: true }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const req = makePostReq({
      body: JSON.stringify({ type: 'openai', fields: ['bad'] }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('returns 400 when fields is null', async () => {
    const addFn: AddSecretFn = vi.fn(async () => ({ ok: true }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const req = makePostReq({
      body: JSON.stringify({ type: 'openai', fields: null }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('returns 400 when type is missing', async () => {
    const addFn: AddSecretFn = vi.fn(async () => ({ ok: true }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const req = makePostReq({
      body: JSON.stringify({ fields: { api_key: 'sk-x' } }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('returns 400 when type is not a string', async () => {
    const addFn: AddSecretFn = vi.fn(async () => ({ ok: true }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const req = makePostReq({
      body: JSON.stringify({ type: 42, fields: { api_key: 'sk-x' } }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('returns 413 when body exceeds 64 KiB', async () => {
    const addFn: AddSecretFn = vi.fn(async () => ({ ok: true }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const bigValue = 'x'.repeat(70 * 1024);
    const req = makePostReq({
      body: JSON.stringify({ type: 'openai', fields: { api_key: bigValue } }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(413);
    await channel.disconnect();
  });

  it('returns 401 without credentials', async () => {
    const addFn: AddSecretFn = vi.fn(async () => ({ ok: true }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const req = makePostReq({
      auth: null,
      body: JSON.stringify({ type: 'openai', fields: { api_key: 'sk-x' } }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 502 when addSecretFn rejects with error', async () => {
    const addFn: AddSecretFn = vi.fn(async () => ({
      ok: false,
      error: 'k8s_error',
    }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const req = makePostReq({
      body: JSON.stringify({ type: 'openai', fields: { api_key: 'sk-test' } }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(502);
    const body = JSON.parse(res._body);
    expect(body.error).toBeDefined();
    // SECURITY: error body must NOT contain the secret value
    expect(res._body).not.toContain('sk-test');
    await channel.disconnect();
  });

  it('returns 504 when addSecretFn returns timeout error', async () => {
    const addFn: AddSecretFn = vi.fn(async () => ({
      ok: false,
      error: 'timeout',
    }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const req = makePostReq({
      body: JSON.stringify({ type: 'openai', fields: { api_key: 'sk-test' } }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(504);
    // SECURITY: response must NOT contain the secret value
    expect(res._body).not.toContain('sk-test');
    await channel.disconnect();
  });

  it('SECURITY: secret values never appear in 201 response body', async () => {
    const secretValue = 'sk-supersecretkey12345678';
    const addFn: AddSecretFn = vi.fn(async () => ({ ok: true }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const req = makePostReq({
      body: JSON.stringify({
        type: 'openai',
        fields: { api_key: secretValue },
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(201);
    expect(res._body).not.toContain(secretValue);
    await channel.disconnect();
  });

  it('SECURITY: secret values never appear in 502 error response body', async () => {
    const secretValue = 'r8_supersecrettoken123456789';
    const addFn: AddSecretFn = vi.fn(async () => ({
      ok: false,
      error: `storage failed for value ${secretValue}`, // deliberately leaky error
    }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const req = makePostReq({
      body: JSON.stringify({
        type: 'replicate',
        fields: { token: secretValue },
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(502);
    // The response must NOT echo back the secret value even if it appeared in the error
    expect(res._body).not.toContain(secretValue);
    await channel.disconnect();
  });

  it('PUT /secrets returns 405 with Allow: GET, HEAD, POST', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      method: 'PUT',
      url: '/secrets',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD, POST');
    await channel.disconnect();
  });

  it('returns 400 for invalid JSON body', async () => {
    const addFn: AddSecretFn = vi.fn(async () => ({ ok: true }));
    const channel = new HttpChannel(makeConfig(), makeAddSecretOpts(addFn));
    await channel.connect();

    const req = makePostReq({ body: 'not-json' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });
});

// ── GET /skills ──────────────────────────────────────────────────────────

describe('GET /skills', () => {
  it('returns 401 when unauthenticated', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/skills', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 405 with Allow: GET, HEAD for non-GET/HEAD method (POST)', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/skills',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD');
    await channel.disconnect();
  });

  it('returns 200 JSON with accepted, candidates, archived arrays', async () => {
    vi.mocked(listAcceptedSkills).mockReturnValue([
      {
        frontmatter: {
          name: 'accepted-skill',
          description: 'Accepted desc',
          created: '2026-01-01',
          source: 'manual',
        },
        body: 'body',
      },
    ]);
    vi.mocked(listCandidates).mockReturnValue([
      {
        id: '111-abc-candidate-skill',
        skill: {
          frontmatter: {
            name: 'candidate-skill',
            description: 'Candidate desc',
            created: '2026-01-02',
            source: 'harvest',
          },
          body: 'cbody',
        },
      },
    ]);
    vi.mocked(listArchived).mockReturnValue([
      {
        frontmatter: {
          name: 'archived-skill',
          description: 'Archived desc',
          created: '2026-01-03',
          source: 'manual',
        },
        body: 'abody',
      },
    ]);

    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({
        'http:alice': {
          name: 'alice',
          folder: 'alice-group',
          trigger: '',
          added_at: '',
        },
      })),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({ url: '/skills', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
    const body = JSON.parse(res._body);
    expect(body.accepted).toHaveLength(1);
    expect(body.accepted[0].slug).toBe('accepted-skill');
    expect(body.accepted[0].description).toBe('Accepted desc');
    expect(body.accepted[0]).not.toHaveProperty('body');
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].slug).toBe('111-abc-candidate-skill');
    expect(body.candidates[0]).not.toHaveProperty('body');
    expect(body.archived).toHaveLength(1);
    expect(body.archived[0].slug).toBe('archived-skill');
    expect(body.archived[0]).not.toHaveProperty('body');
    await channel.disconnect();
  });

  it('returns 404 if user has no registered group', async () => {
    const opts = makeOpts({ registeredGroups: vi.fn(() => ({})) });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({ url: '/skills', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    await channel.disconnect();
  });

  it('HEAD /skills returns 200 with no body', async () => {
    vi.mocked(listAcceptedSkills).mockReturnValue([]);
    vi.mocked(listCandidates).mockReturnValue([]);
    vi.mocked(listArchived).mockReturnValue([]);

    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({
        'http:alice': {
          name: 'alice',
          folder: 'alice-group',
          trigger: '',
          added_at: '',
        },
      })),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/skills',
      method: 'HEAD',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    // HEAD must not include a body
    expect(res._body).toBe('');
    await channel.disconnect();
  });
});

// ── POST /skills/candidates/<id>/accept ──────────────────────────────────

describe('POST /skills/candidates/<id>/accept', () => {
  it('returns 401 when unauthenticated', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/my-skill/accept',
      method: 'POST',
      auth: null,
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 405 with Allow: POST for wrong method (GET)', async () => {
    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({
        'http:alice': {
          name: 'alice',
          folder: 'alice-group',
          trigger: '',
          added_at: '',
        },
      })),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/my-skill/accept',
      method: 'GET',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('POST');
    await channel.disconnect();
  });

  it('returns 404 for unknown candidate id', async () => {
    vi.mocked(acceptCandidate).mockImplementation(() => {
      throw new Error('candidate not found: no-such-id');
    });

    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({
        'http:alice': {
          name: 'alice',
          folder: 'alice-group',
          trigger: '',
          added_at: '',
        },
      })),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/no-such-id/accept',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    expect(res._body).toContain('Not found');
    await channel.disconnect();
  });

  it('returns 404 for invalid slug (path traversal attempt)', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/../evil/accept',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    // 400 when the early path-traversal guard fires; 404 from CANDIDATE_ID_RE
    expect([400, 404]).toContain(res._status);
    await channel.disconnect();
  });

  it('returns 200 { status: "accepted", slug } on success', async () => {
    vi.mocked(acceptCandidate).mockReturnValue(undefined);

    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({
        'http:alice': {
          name: 'alice',
          folder: 'alice-group',
          trigger: '',
          added_at: '',
        },
      })),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/111-abc-my-skill/accept',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.status).toBe('accepted');
    expect(body.slug).toBe('111-abc-my-skill');
    await channel.disconnect();
  });

  it('returns 404 for user with no registered group (cross-group denial)', async () => {
    const opts = makeOpts({ registeredGroups: vi.fn(() => ({})) });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/some-skill/accept',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    expect(res._body).toContain('Not found');
    await channel.disconnect();
  });
});

// ── POST /skills/candidates/<id>/reject ──────────────────────────────────

describe('POST /skills/candidates/<id>/reject', () => {
  it('returns 401 when unauthenticated', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/my-skill/reject',
      method: 'POST',
      auth: null,
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 405 with Allow: POST for wrong method (DELETE)', async () => {
    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({
        'http:alice': {
          name: 'alice',
          folder: 'alice-group',
          trigger: '',
          added_at: '',
        },
      })),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/my-skill/reject',
      method: 'DELETE',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('POST');
    await channel.disconnect();
  });

  it('unauthenticated GET /skills/candidates/xxx/accept returns 405 not 401', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/xxx/accept',
      method: 'GET',
      auth: null,
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('POST');
    await channel.disconnect();
  });

  it('returns 404 for unknown candidate id', async () => {
    vi.mocked(rejectCandidate).mockImplementation(() => {
      throw new Error('candidate not found: no-such-id');
    });

    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({
        'http:alice': {
          name: 'alice',
          folder: 'alice-group',
          trigger: '',
          added_at: '',
        },
      })),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/no-such-id/reject',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    expect(res._body).toContain('Not found');
    await channel.disconnect();
  });

  it('returns 404 for invalid slug (path traversal attempt)', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/../evil/reject',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    // 400 when the early path-traversal guard fires; 404 from CANDIDATE_ID_RE
    expect([400, 404]).toContain(res._status);
    await channel.disconnect();
  });

  it('returns 200 { status: "rejected", slug } on success', async () => {
    vi.mocked(rejectCandidate).mockReturnValue(undefined);

    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({
        'http:alice': {
          name: 'alice',
          folder: 'alice-group',
          trigger: '',
          added_at: '',
        },
      })),
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/111-abc-my-skill/reject',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.status).toBe('rejected');
    expect(body.slug).toBe('111-abc-my-skill');
    await channel.disconnect();
  });

  it('returns 404 for user with no registered group (cross-group denial)', async () => {
    const opts = makeOpts({ registeredGroups: vi.fn(() => ({})) });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/some-skill/reject',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    expect(res._body).toContain('Not found');
    await channel.disconnect();
  });
});

// ── GET /schedule/<id>/runs — Story 80 ──────────────────────────────────

describe('GET /schedule/<id>/runs', () => {
  const TASK_ID = 'task-abc-123';
  const GROUP_FOLDER = 'alice';
  const MOCK_TASK = {
    id: TASK_ID,
    group_folder: GROUP_FOLDER,
    chat_jid: 'http:alice',
    prompt: 'Test prompt',
    schedule_type: 'cron' as const,
    schedule_value: '0 9 * * *',
    context_mode: 'isolated' as const,
    next_run: null,
    status: 'active' as const,
    created_at: '2024-01-01T00:00:00.000Z',
  };
  const MOCK_RUNS = [
    {
      run_at: '2024-01-02T09:00:00.000Z',
      status: 'error' as const,
      duration_ms: 50,
      result: null,
      error: 'Agent timed out',
    },
    {
      run_at: '2024-01-01T09:00:00.000Z',
      status: 'success' as const,
      duration_ms: 300,
      result: 'Done',
      error: null,
    },
  ];

  it('AC1: returns 200 JSON { runs: [...] } with both rows (newest-first)', async () => {
    vi.mocked(getTaskById).mockReturnValue(MOCK_TASK as any);
    vi.mocked(getTaskRunLogs).mockReturnValue(MOCK_RUNS as any);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: `/schedule/${TASK_ID}/runs`,
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
    const body = JSON.parse(res._body) as { runs: typeof MOCK_RUNS };
    expect(body.runs).toHaveLength(2);
    // Newest first: error row at index 0, success at index 1
    expect(body.runs[0].status).toBe('error');
    expect(body.runs[0].error).toBe('Agent timed out');
    expect(body.runs[0].result).toBeNull();
    expect(body.runs[1].status).toBe('success');
    expect(body.runs[1].result).toBe('Done');
    expect(body.runs[1].error).toBeNull();
    await channel.disconnect();
  });

  it('AC2: passes ?limit=N to getTaskRunLogs (capped at 100)', async () => {
    vi.mocked(getTaskById).mockReturnValue(MOCK_TASK as any);
    vi.mocked(getTaskRunLogs).mockReturnValue([]);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: `/schedule/${TASK_ID}/runs?limit=5`,
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(vi.mocked(getTaskRunLogs)).toHaveBeenCalledWith(
      TASK_ID,
      GROUP_FOLDER,
      5,
    );
    await channel.disconnect();
  });

  it('AC2: ?limit=200 is capped to 100', async () => {
    vi.mocked(getTaskById).mockReturnValue(MOCK_TASK as any);
    vi.mocked(getTaskRunLogs).mockReturnValue([]);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: `/schedule/${TASK_ID}/runs?limit=200`,
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(vi.mocked(getTaskRunLogs)).toHaveBeenCalledWith(
      TASK_ID,
      GROUP_FOLDER,
      100,
    );
    await channel.disconnect();
  });

  it('AC3: unknown id → 404 "Not found"', async () => {
    vi.mocked(getTaskById).mockReturnValue(undefined);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: `/schedule/nonexistent/runs`,
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe('Not found');
    await channel.disconnect();
  });

  it('AC3: cross-group id → 404 (same wording)', async () => {
    vi.mocked(getTaskById).mockReturnValue({
      ...MOCK_TASK,
      group_folder: 'other-group',
    } as any);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: `/schedule/${TASK_ID}/runs`,
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe('Not found');
    await channel.disconnect();
  });

  it('AC4: unauthenticated → 401', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: `/schedule/${TASK_ID}/runs`, auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('AC4: POST /schedule/<id>/runs → 405 Allow: GET, HEAD', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: `/schedule/${TASK_ID}/runs`,
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD');
    await channel.disconnect();
  });

  it('AC4: HEAD → same headers as GET, no body', async () => {
    vi.mocked(getTaskById).mockReturnValue(MOCK_TASK as any);
    vi.mocked(getTaskRunLogs).mockReturnValue(MOCK_RUNS as any);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const getReq = makeReq({
      url: `/schedule/${TASK_ID}/runs`,
      method: 'GET',
      auth: 'alice:secret',
    });
    const getRes = makeRes();
    await dispatch(channel, getReq, getRes);

    const headReq = makeReq({
      url: `/schedule/${TASK_ID}/runs`,
      method: 'HEAD',
      auth: 'alice:secret',
    });
    const headRes = makeRes();
    await dispatch(channel, headReq, headRes);

    expect(headRes._status).toBe(200);
    expect(headRes._headers['Content-Type']).toBe(
      getRes._headers['Content-Type'],
    );
    expect(headRes._headers['Content-Length']).toBe(
      getRes._headers['Content-Length'],
    );
    expect(headRes._body).toBe('');
    await channel.disconnect();
  });

  it('AC5: unit — 2-row stub returns both status tags and correct result/error fields', async () => {
    vi.mocked(getTaskById).mockReturnValue(MOCK_TASK as any);
    vi.mocked(getTaskRunLogs).mockReturnValue(MOCK_RUNS as any);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: `/schedule/${TASK_ID}/runs`,
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as {
      runs: Array<{
        status: string;
        result: string | null;
        error: string | null;
        run_at: string;
        duration_ms: number;
      }>;
    };
    const statusTags = body.runs.map((r) => r.status);
    expect(statusTags).toContain('success');
    expect(statusTags).toContain('error');
    const successRow = body.runs.find((r) => r.status === 'success')!;
    expect(successRow.result).toBe('Done');
    expect(successRow.error).toBeNull();
    const errorRow = body.runs.find((r) => r.status === 'error')!;
    expect(errorRow.error).toBe('Agent timed out');
    expect(errorRow.result).toBeNull();
    await channel.disconnect();
  });

  it('returns 200 with empty runs array when task exists but has no run history', async () => {
    vi.mocked(getTaskById).mockReturnValue(MOCK_TASK as any);
    vi.mocked(getTaskRunLogs).mockReturnValue([]);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: `/schedule/${TASK_ID}/runs`,
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as { runs: unknown[] };
    expect(body.runs).toHaveLength(0);
    await channel.disconnect();
  });

  it('defaults to limit=20 when no ?limit param', async () => {
    vi.mocked(getTaskById).mockReturnValue(MOCK_TASK as any);
    vi.mocked(getTaskRunLogs).mockReturnValue([]);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: `/schedule/${TASK_ID}/runs`,
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(vi.mocked(getTaskRunLogs)).toHaveBeenCalledWith(
      TASK_ID,
      GROUP_FOLDER,
      20,
    );
    await channel.disconnect();
  });
});

describe('PATCH /history/<id> — Story 82', () => {
  it('AC1: returns 200 with updated JSON on valid PATCH', async () => {
    const updatedRow = {
      id: 'msg-patch',
      role: 'user' as const,
      content: 'redacted',
      created_at: '2026-01-01T00:00:00Z',
    };
    (updateConversationMessage as ReturnType<typeof vi.fn>).mockReturnValue(
      true,
    );
    (getMessageById as ReturnType<typeof vi.fn>).mockReturnValue(updatedRow);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'PATCH',
      url: '/history/msg-patch',
      auth: 'alice:secret',
      body: JSON.stringify({ content: 'redacted' }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.id).toBe('msg-patch');
    expect(body.content).toBe('redacted');
    expect(updateConversationMessage).toHaveBeenCalledWith(
      'msg-patch',
      'redacted',
      'alice',
    );
    await channel.disconnect();
  });

  it('AC1: empty string content is permitted', async () => {
    const updatedRow = {
      id: 'msg-empty',
      role: 'user' as const,
      content: '',
      created_at: '2026-01-01T00:00:00Z',
    };
    (updateConversationMessage as ReturnType<typeof vi.fn>).mockReturnValue(
      true,
    );
    (getMessageById as ReturnType<typeof vi.fn>).mockReturnValue(updatedRow);
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'PATCH',
      url: '/history/msg-empty',
      auth: 'alice:secret',
      body: JSON.stringify({ content: '' }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).content).toBe('');
    await channel.disconnect();
  });

  it('AC2: missing content field → 400 with correct error message', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'PATCH',
      url: '/history/msg-bad',
      auth: 'alice:secret',
      body: JSON.stringify({ something: 'else' }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toBe('content must be a string');
    await channel.disconnect();
  });

  it('AC2: non-string content → 400', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'PATCH',
      url: '/history/msg-bad',
      auth: 'alice:secret',
      body: JSON.stringify({ content: 42 }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toBe('content must be a string');
    await channel.disconnect();
  });

  it('AC3: unknown id → 404', async () => {
    (updateConversationMessage as ReturnType<typeof vi.fn>).mockReturnValue(
      false,
    );
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'PATCH',
      url: '/history/no-such-id',
      auth: 'alice:secret',
      body: JSON.stringify({ content: 'new' }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toBe('Not found');
    await channel.disconnect();
  });

  it('AC4: unauthenticated → 401', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'PATCH',
      url: '/history/msg-patch',
      auth: null,
      body: JSON.stringify({ content: 'redacted' }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('AC4: PUT /history/<id> → 405 with Allow: GET, HEAD, DELETE, PATCH', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'PUT',
      url: '/history/msg-42',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD, DELETE, PATCH');
    await channel.disconnect();
  });

  it('AC4: POST /history/<id> → 405 with Allow: GET, HEAD, DELETE, PATCH', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'POST',
      url: '/history/msg-42',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD, DELETE, PATCH');
    await channel.disconnect();
  });

  it('AC5: PATCH /history/<id> body larger than 256 KiB returns 413', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    // Create a body where the JSON-encoded string is > 256 KiB
    const oversizedContent = 'X'.repeat(256 * 1024 + 1);
    const body = JSON.stringify({ content: oversizedContent });

    const req = makeReq({
      method: 'PATCH',
      url: '/history/msg-large',
      auth: 'alice:secret',
      body,
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(413);
    expect(JSON.parse(res._body).error).toBe('Payload too large');
    await channel.disconnect();
  });
});

// ── Story 81: GET /audit + audit writes from destructive handlers ─────────

describe('GET /audit (Story 81)', () => {
  it('returns 401 for unauthenticated requests', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/audit', method: 'GET', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 405 for POST /audit with Allow: GET, HEAD', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/audit',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toContain('GET');
    await channel.disconnect();
  });

  it('returns 200 with entries array from getAuditEntries', async () => {
    const mockEntry = {
      id: 1,
      ts: '2026-01-01T00:00:00.000Z',
      actor: 'alice',
      action: 'history.clear',
      target: null,
      detail: null,
    };
    vi.mocked(getAuditEntries).mockReturnValueOnce([mockEntry]);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ url: '/audit', method: 'GET', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body).toHaveProperty('entries');
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].action).toBe('history.clear');
    await channel.disconnect();
  });

  it('passes limit query param (capped at 200) to getAuditEntries', async () => {
    vi.mocked(getAuditEntries).mockReturnValueOnce([]);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/audit?limit=10',
      method: 'GET',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(vi.mocked(getAuditEntries)).toHaveBeenCalledWith('alice', 10);
    await channel.disconnect();
  });
});

describe('Audit writes from destructive handlers (Story 81)', () => {
  it('DELETE /history calls writeAuditEntry with action=history.clear', async () => {
    vi.mocked(clearConversationHistory).mockImplementation(() => {});

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/history',
      method: 'DELETE',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(204);
    expect(vi.mocked(writeAuditEntry)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'history.clear', actor: 'alice' }),
    );
    await channel.disconnect();
  });

  it('DELETE /history?before= calls writeAuditEntry with action=history.purge', async () => {
    vi.mocked(deleteConversationHistoryBefore).mockReturnValue(3);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/history?before=2026-01-01T00:00:00.000Z',
      method: 'DELETE',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(vi.mocked(writeAuditEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'history.purge',
        actor: 'alice',
      }),
    );
    // detail should contain the before param and deleted count
    const call = vi.mocked(writeAuditEntry).mock.lastCall![0];
    expect(call.detail).toContain('before=2026-01-01T00:00:00.000Z');
    expect(call.detail).toContain('deleted=3');
    await channel.disconnect();
  });

  it('DELETE /history/<id> calls writeAuditEntry with action=history.delete', async () => {
    vi.mocked(deleteMessageById).mockReturnValue(true);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/history/msg-abc-123',
      method: 'DELETE',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(204);
    expect(vi.mocked(writeAuditEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'history.delete',
        actor: 'alice',
        target: 'msg-abc-123',
      }),
    );
    await channel.disconnect();
  });

  it('DELETE /jobs/<id> calls writeAuditEntry with action=job.kill', async () => {
    vi.mocked(getToolJobByIdForGroup).mockReturnValue({
      job_id: 'job-1',
      group_folder: 'alice',
      chat_jid: 'http:alice',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      resolved_at: null,
      message_id: null,
      specialist_name: '',
    });

    const killJobFn = vi.fn(async () => ({
      ok: true as const,
      status: 'cancelled',
    }));
    const opts = makeOpts({ killJobFn });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/jobs/job-1',
      method: 'DELETE',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(vi.mocked(writeAuditEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'job.kill',
        actor: 'alice',
        target: 'job-1',
      }),
    );
    await channel.disconnect();
  });

  it('DELETE /schedule/<id> calls writeAuditEntry with action=schedule.delete', async () => {
    vi.mocked(deleteTaskForGroup).mockReturnValue(true);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/schedule/task-1',
      method: 'DELETE',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(204);
    expect(vi.mocked(writeAuditEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'schedule.delete',
        actor: 'alice',
        target: 'task-1',
      }),
    );
    await channel.disconnect();
  });

  it('PATCH /schedule/<id> pause calls writeAuditEntry with action=schedule.pause', async () => {
    vi.mocked(getTaskById).mockReturnValue({
      id: 'task-1',
      group_folder: 'alice',
      chat_jid: 'http:alice',
      prompt: 'do stuff',
      schedule_type: 'interval',
      schedule_value: '60000',
      status: 'active',
      next_run: null,
      last_run: null,
      last_result: null,
      created_at: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
    });
    vi.mocked(pauseTask).mockReturnValue(true);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/schedule/task-1',
      method: 'PATCH',
      auth: 'alice:secret',
      body: JSON.stringify({ paused: true }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(vi.mocked(writeAuditEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'schedule.pause',
        actor: 'alice',
        target: 'task-1',
      }),
    );
    await channel.disconnect();
  });

  it('PATCH /schedule/<id> resume calls writeAuditEntry with action=schedule.resume', async () => {
    vi.mocked(getTaskById).mockReturnValue({
      id: 'task-1',
      group_folder: 'alice',
      chat_jid: 'http:alice',
      prompt: 'do stuff',
      schedule_type: 'interval',
      schedule_value: '60000',
      status: 'paused',
      next_run: null,
      last_run: null,
      last_result: null,
      created_at: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
    });
    vi.mocked(resumeTask).mockReturnValue(true);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/schedule/task-1',
      method: 'PATCH',
      auth: 'alice:secret',
      body: JSON.stringify({ paused: false }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(vi.mocked(writeAuditEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'schedule.resume',
        actor: 'alice',
        target: 'task-1',
      }),
    );
    await channel.disconnect();
  });

  it('POST /skills/candidates/<id>/accept calls writeAuditEntry with action=skill.accept', async () => {
    vi.mocked(listAcceptedSkills).mockReturnValue([]);
    vi.mocked(listCandidates).mockReturnValue([]);
    vi.mocked(acceptCandidate).mockImplementation(() => {});

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/111-abc-my-skill/accept',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(vi.mocked(writeAuditEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'skill.accept',
        actor: 'alice',
        target: '111-abc-my-skill',
      }),
    );
    await channel.disconnect();
  });

  it('POST /skills/candidates/<id>/reject calls writeAuditEntry with action=skill.reject', async () => {
    vi.mocked(rejectCandidate).mockImplementation(() => {});

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({
      url: '/skills/candidates/111-abc-my-skill/reject',
      method: 'POST',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(vi.mocked(writeAuditEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'skill.reject',
        actor: 'alice',
        target: '111-abc-my-skill',
      }),
    );
    await channel.disconnect();
  });

  it('DELETE /secrets/<type> calls writeAuditEntry with action=secret.remove', async () => {
    const removeSecretFn = vi.fn(async () => 'ok' as const);
    const opts = makeOpts({ removeSecretFn });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({
      url: '/secrets/openai',
      method: 'DELETE',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(204);
    expect(vi.mocked(writeAuditEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'secret.remove',
        actor: 'alice',
        target: 'openai',
      }),
    );
    await channel.disconnect();
  });

  it('POST /secrets calls writeAuditEntry with action=secret.add — NEVER logs secret values', async () => {
    const addSecretFn = vi.fn(async () => ({ ok: true as const }));
    const opts = makeOpts({ addSecretFn } as Partial<HttpChannelOpts>);
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    // SECURITY critical: token value r8_supersecret_value must NEVER appear in the audit row
    const req = makeReq({
      url: '/secrets',
      method: 'POST',
      auth: 'alice:secret',
      body: JSON.stringify({
        type: 'replicate',
        fields: { token: 'r8_supersecret_value' },
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(201);
    expect(vi.mocked(writeAuditEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'secret.add',
        actor: 'alice',
        target: 'replicate',
      }),
    );

    // CRITICAL: secret value must NEVER reach the audit row
    const auditCall = vi.mocked(writeAuditEntry).mock.lastCall![0];
    expect(JSON.stringify(auditCall)).not.toContain('r8_supersecret_value');
    // detail should contain field NAMES only
    expect(auditCall.detail).toContain('token');
    expect(auditCall.detail).toContain('fields=');
    await channel.disconnect();
  });
});

// ── Story 84: edited_at field on history routes ────────────────────────────

function makeHistoryRow84(
  overrides?: Partial<ConversationHistoryRow>,
): ConversationHistoryRow {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'hello',
    created_at: '2026-01-01T00:00:00.000Z',
    edited_at: null,
    ...overrides,
  };
}

describe('GET /history — edited_at (Story 84)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns paginated history with edited_at per row', async () => {
    const rows = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: 'first',
        created_at: '2026-01-01T00:00:00.000Z',
        edited_at: null,
      },
      {
        id: 'msg-2',
        role: 'user' as const,
        content: 'second',
        created_at: '2026-01-02T00:00:00.000Z',
        edited_at: '2026-01-02T00:00:00.000Z',
      },
    ];
    (getConversationHistoryPage as ReturnType<typeof vi.fn>).mockReturnValue(
      rows,
    );

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({ url: '/history', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as { messages: typeof rows };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].edited_at).toBeNull();
    expect(body.messages[1].edited_at).toBe('2026-01-02T00:00:00.000Z');
    // Confirm null is serialised explicitly (not stripped)
    expect(res._body).toContain('"edited_at":null');
    await channel.disconnect();
  });

  it('returns 401 without auth', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({ url: '/history', auth: null });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 405 for non-GET method on /history', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'POST',
      url: '/history',
      auth: 'alice:secret',
      body: '{}',
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(405);
    await channel.disconnect();
  });
});

describe('GET /history/:id — edited_at (Story 84)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with edited_at: null for unedited message', async () => {
    const row = makeHistoryRow84({ edited_at: null });
    (getMessageById as ReturnType<typeof vi.fn>).mockReturnValue(row);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({ url: '/history/msg-1', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as ConversationHistoryRow;
    expect(body.edited_at).toBeNull();
    // null must be explicit in JSON — not stripped
    expect(res._body).toContain('"edited_at":null');
    await channel.disconnect();
  });

  it('returns 404 when message not found', async () => {
    (getMessageById as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({ url: '/history/no-such-id', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    await channel.disconnect();
  });
});

describe('PATCH /history/:id — edited_at (Story 84)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with edited_at set after successful PATCH', async () => {
    const updated = makeHistoryRow84({
      edited_at: '2026-05-21T10:00:00.000Z',
      content: 'edited',
    });
    // The PATCH handler calls updateConversationMessage then getMessageById once.
    (getMessageById as ReturnType<typeof vi.fn>).mockReturnValue(updated);
    (updateConversationMessage as ReturnType<typeof vi.fn>).mockReturnValue(
      true,
    );

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'PATCH',
      url: '/history/msg-1',
      auth: 'alice:secret',
      body: '{"content":"edited"}',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(updateConversationMessage).toHaveBeenCalledWith(
      'msg-1',
      'edited',
      'alice',
    );
    const body = JSON.parse(res._body) as ConversationHistoryRow;
    expect(body.edited_at).toBe('2026-05-21T10:00:00.000Z');
    expect(body.content).toBe('edited');
    // edited_at must be a non-null ISO string in the JSON
    expect(res._body).toContain('"edited_at":"2026-05-21T10:00:00.000Z"');
    await channel.disconnect();
  });

  it('returns 400 when content is missing', async () => {
    (getMessageById as ReturnType<typeof vi.fn>).mockReturnValue(
      makeHistoryRow84(),
    );

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'PATCH',
      url: '/history/msg-1',
      auth: 'alice:secret',
      body: '{}',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    await channel.disconnect();
  });

  it('returns 404 when message not found on PATCH', async () => {
    // updateConversationMessage returns false → row not found
    (updateConversationMessage as ReturnType<typeof vi.fn>).mockReturnValue(
      false,
    );

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'PATCH',
      url: '/history/no-such',
      auth: 'alice:secret',
      body: '{"content":"new"}',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    await channel.disconnect();
  });

  it('returns 401 without auth on PATCH', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'PATCH',
      url: '/history/msg-1',
      auth: null,
      body: '{"content":"x"}',
    });
    const res = makeRes();
    await dispatch(channel, req, res);
    expect(res._status).toBe(401);
    await channel.disconnect();
  });

  it('returns 405 for unsupported method on /history/:id', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    // PUT is not a permitted method on /history/:id (GET, HEAD, DELETE, PATCH are allowed)
    const req = makeReq({
      method: 'PUT',
      url: '/history/msg-1',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    await channel.disconnect();
  });
});

// ── POST /debug/tool-jobs/inject ──────────────────────────────────────────────

describe('POST /debug/tool-jobs/inject', () => {
  beforeEach(() => {
    _debugEndpointsEnabled = false;
    vi.mocked(insertToolJobForDebug).mockReset();
  });

  afterEach(() => {
    _debugEndpointsEnabled = false;
  });

  it('returns 404 when KUBECLAW_DEBUG_ENDPOINTS is false (default)', async () => {
    _debugEndpointsEnabled = false;
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'POST',
      url: '/debug/tool-jobs/inject',
      auth: 'alice:secret',
      body: JSON.stringify({
        job_id: 'j1',
        group_folder: 'http:alice',
        status: 'completed',
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(404);
    expect(vi.mocked(insertToolJobForDebug)).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('returns 401 when not authenticated (flag on)', async () => {
    _debugEndpointsEnabled = true;
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'POST',
      url: '/debug/tool-jobs/inject',
      auth: null,
      body: JSON.stringify({
        job_id: 'j1',
        group_folder: 'http:alice',
        status: 'completed',
      }),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);
    expect(vi.mocked(insertToolJobForDebug)).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('returns 400 when body is missing required fields (flag on)', async () => {
    _debugEndpointsEnabled = true;
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'POST',
      url: '/debug/tool-jobs/inject',
      auth: 'alice:secret',
      body: '{}',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(400);
    expect(vi.mocked(insertToolJobForDebug)).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('inserts the row and returns 200 for a valid payload (flag on)', async () => {
    _debugEndpointsEnabled = true;
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const payload = {
      job_id: 'test-job-1',
      group_folder: 'http:alice',
      status: 'completed',
      resolved_at: '2026-01-01T00:00:00.000Z',
    };
    const req = makeReq({
      method: 'POST',
      url: '/debug/tool-jobs/inject',
      auth: 'alice:secret',
      body: JSON.stringify(payload),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as { ok: boolean; job_id: string };
    expect(body.ok).toBe(true);
    expect(body.job_id).toBe('test-job-1');
    expect(vi.mocked(insertToolJobForDebug)).toHaveBeenCalledWith({
      jobId: 'test-job-1',
      groupFolder: 'http:alice',
      status: 'completed',
      createdAt: undefined,
      resolvedAt: '2026-01-01T00:00:00.000Z',
    });
    await channel.disconnect();
  });

  it('inserts with created_at override (flag on)', async () => {
    _debugEndpointsEnabled = true;
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const payload = {
      job_id: 'test-job-2',
      group_folder: 'http:bob',
      status: 'active',
      created_at: '2025-01-01T00:00:00.000Z',
    };
    const req = makeReq({
      method: 'POST',
      url: '/debug/tool-jobs/inject',
      auth: 'alice:secret',
      body: JSON.stringify(payload),
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(vi.mocked(insertToolJobForDebug)).toHaveBeenCalledWith({
      jobId: 'test-job-2',
      groupFolder: 'http:bob',
      status: 'active',
      createdAt: '2025-01-01T00:00:00.000Z',
      resolvedAt: null,
    });
    await channel.disconnect();
  });

  it('returns 405 for GET /debug/tool-jobs/inject (flag on)', async () => {
    _debugEndpointsEnabled = true;
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();
    const req = makeReq({
      method: 'GET',
      url: '/debug/tool-jobs/inject',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    await channel.disconnect();
  });
});
