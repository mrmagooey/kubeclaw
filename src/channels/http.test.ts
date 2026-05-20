import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../db.js', () => ({ appendConversationMessage: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  GROUPS_DIR: '/tmp/test-groups',
}));
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

// Mock the built-in http module so we don't actually bind a port
const serverListeners = new Map<string, (...args: unknown[]) => void>();
const mockServerInstance = {
  listen: vi.fn((_port: number, cb: () => void) => cb()),
  close: vi.fn((cb: () => void) => cb()),
  on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    serverListeners.set(event, cb);
  }),
};

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

import { HttpChannel, HttpChannelOpts } from './http.js';
import { appendConversationMessage } from '../db.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides?: {
  port?: number;
  users?: Record<string, string>;
  perUserMessagesPerMinute?: number;
}) {
  return {
    port: overrides?.port ?? 4080,
    users: overrides?.users ?? { alice: 'secret', bob: 'hunter2' },
    // Default to unlimited so existing tests don't get throttled.
    perUserMessagesPerMinute: overrides?.perUserMessagesPerMinute ?? 0,
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
      const parsed = JSON.parse(res._body) as { status: string; uptime_ms: number };
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

      const req = makeReq({ url: '/unknown-path-xyz', method: 'DELETE', auth: null });
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
        expect(channel.consumeRateLimit('alice', t0)).toEqual({ allowed: true });
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
        expect(channel.consumeRateLimit('alice', t1)).toEqual({ allowed: true });
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
          makeReq({ method: 'POST', url: '/message', auth: 'alice:secret', body: '{"text":"msg"}' }),
          makeRes(),
        );
      }
      const aliceRes = makeRes();
      await dispatch(
        channel,
        makeReq({ method: 'POST', url: '/message', auth: 'alice:secret', body: '{"text":"throttled"}' }),
        aliceRes,
      );
      expect(aliceRes._status).toBe(429);

      // Bob has an independent bucket — first POST returns 200
      const bobRes = makeRes();
      await dispatch(
        channel,
        makeReq({ method: 'POST', url: '/message', auth: 'bob:hunter2', body: '{"text":"hello"}' }),
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
          makeReq({ method: 'POST', url: '/message', auth: 'alice:secret', body: '{"text":"msg"}' }),
          makeRes(),
        );
      }

      const callsBefore = (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls.length;

      const res = makeRes();
      await dispatch(
        channel,
        makeReq({ method: 'POST', url: '/message', auth: 'alice:secret', body: '{"text":"throttled"}' }),
        res,
      );

      expect(res._status).toBe(429);
      // onMessage must NOT have been called for the throttled request
      expect((opts.onMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);

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
          makeReq({ method: 'POST', url: '/message', auth: 'alice:secret', body: '{"text":"msg"}' }),
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
        makeReq({ method: 'POST', url: '/message', auth: 'alice:secret', body: '{"text":"throttled"}' }),
        postRes,
      );
      expect(postRes._status).toBe(429);

      await channel.disconnect();
    });
  });
});
