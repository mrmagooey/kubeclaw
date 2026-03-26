import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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
    createServer: vi.fn((handler: (req: IncomingMessage, res: ServerResponse) => void) => {
      (mockServerInstance as any)._handler = handler;
      return mockServerInstance;
    }),
  };
});

import { HttpChannel, HttpChannelOpts } from './http.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides?: { port?: number; users?: Record<string, string> }) {
  return {
    port: overrides?.port ?? 4080,
    users: overrides?.users ?? { alice: 'secret', bob: 'hunter2' },
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
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (overrides.auth !== null) {
    headers.authorization = `Basic ${b64(overrides.auth ?? 'alice:secret')}`;
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

function makeRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
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
  } as unknown as ServerResponse & { _status: number; _headers: Record<string, string>; _body: string };
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
      expect(mockServerInstance.listen).toHaveBeenCalledWith(9999, expect.any(Function));
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

      const req = makeReq({ url: '/message', method: 'POST', auth: 'bob:hunter2', body: '{"text":"hi"}' });
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

      const dataWritten = (streamRes.write as ReturnType<typeof vi.fn>).mock.calls
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
      await expect(channel.sendMessage('http:alice', 'no client')).resolves.toBeUndefined();
      await channel.disconnect();
    });

    it('only sends to the correct user', async () => {
      const channel = new HttpChannel(
        makeConfig({ users: { alice: 'secret', bob: 'hunter2' } }),
        makeOpts({
          registeredGroups: vi.fn(() => ({
            'http:alice': { name: 'alice', folder: 'alice', trigger: '', added_at: '' },
            'http:bob': { name: 'bob', folder: 'bob', trigger: '', added_at: '' },
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
});
