/**
 * Unit + integration tests for the GET /diag endpoint (Story 79).
 *
 * Uses the same mock pattern as http.test.ts — the HTTP server is never
 * actually bound; requests are dispatched directly through the handler.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../db.js', () => ({
  appendConversationMessage: vi.fn(),
  getDiagSnapshot: vi.fn(() => ({
    conversation_history_rows: 42,
    scheduled_tasks_active: 3,
    tool_jobs_recent_24h: 7,
    attachment_count: 5,
    attachment_bytes: 1024,
    db_size_bytes: 204800,
    uptime_seconds: 300,
  })),
}));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  GROUPS_DIR: '/tmp/test-groups',
  STORE_DIR: '/tmp/test-store',
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

// Mock the http module to avoid binding ports
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
import { getDiagSnapshot } from '../db.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

function makeConfig() {
  return {
    port: 4090,
    users: { alice: 'secret', bob: 'hunter2' },
  };
}

function makeOpts(overrides?: Partial<HttpChannelOpts>): HttpChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'http:alice': {
        name: 'alice',
        folder: 'http-alice',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function makeReq(overrides: {
  method?: string;
  url?: string;
  auth?: string | null;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (overrides.auth !== null) {
    if (overrides.auth !== undefined) {
      headers.authorization = `Basic ${b64(overrides.auth)}`;
    }
  }
  return {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/diag',
    headers,
    on: vi.fn(),
    destroy: vi.fn(),
  } as unknown as IncomingMessage;
}

function makeRes(): ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
  _ended: boolean;
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
    _ended: boolean;
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
  await new Promise((r) => setTimeout(r, 0));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('HttpChannel /diag endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverListeners.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── AC1: all 7 fields present ─────────────────────────────────────────────

  it('GET /diag with valid auth returns 200 JSON with all 7 fields', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ method: 'GET', url: '/diag', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(res._body);
    expect(body).toHaveProperty('conversation_history_rows');
    expect(body).toHaveProperty('scheduled_tasks_active');
    expect(body).toHaveProperty('tool_jobs_recent_24h');
    expect(body).toHaveProperty('attachment_count');
    expect(body).toHaveProperty('attachment_bytes');
    expect(body).toHaveProperty('db_size_bytes');
    expect(body).toHaveProperty('uptime_seconds');

    await channel.disconnect();
  });

  it('GET /diag returns all fields as numbers (from mock)', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ method: 'GET', url: '/diag', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    const body = JSON.parse(res._body);
    expect(body.conversation_history_rows).toBe(42);
    expect(body.scheduled_tasks_active).toBe(3);
    expect(body.tool_jobs_recent_24h).toBe(7);
    expect(body.attachment_count).toBe(5);
    expect(body.attachment_bytes).toBe(1024);
    expect(body.db_size_bytes).toBe(204800);
    expect(body.uptime_seconds).toBe(300);

    await channel.disconnect();
  });

  // ── AC2: group-scoped — calls getDiagSnapshot with authenticated user's folder

  it('GET /diag passes the authenticated user group folder to getDiagSnapshot', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ method: 'GET', url: '/diag', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(getDiagSnapshot).toHaveBeenCalledWith(
      'http-alice', // groupFolder from registered groups
      '/tmp/test-store',
      '/tmp/test-groups',
    );

    await channel.disconnect();
  });

  it('GET /diag falls back to derived folder when group not registered', async () => {
    const opts = makeOpts({
      registeredGroups: vi.fn(() => ({})), // no registered groups
    });
    const channel = new HttpChannel(makeConfig(), opts);
    await channel.connect();

    const req = makeReq({ method: 'GET', url: '/diag', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(getDiagSnapshot).toHaveBeenCalledWith(
      'http-alice', // fallback: http-<username>
      '/tmp/test-store',
      '/tmp/test-groups',
    );

    await channel.disconnect();
  });

  // ── AC3: unauthenticated → 401 ────────────────────────────────────────────

  it('GET /diag without auth returns 401', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ method: 'GET', url: '/diag', auth: null });
    (req as any).headers = {}; // no auth header
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);

    await channel.disconnect();
  });

  it('GET /diag with wrong password returns 401', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ method: 'GET', url: '/diag', auth: 'alice:wrongpassword' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(401);

    await channel.disconnect();
  });

  // ── AC4: POST /diag → 405 with Allow: GET, HEAD ───────────────────────────

  it('POST /diag returns 405 with Allow: GET, HEAD', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ method: 'POST', url: '/diag', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);
    expect(res._headers['Allow']).toBe('GET, HEAD');

    await channel.disconnect();
  });

  it('DELETE /diag returns 405', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ method: 'DELETE', url: '/diag', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(405);

    await channel.disconnect();
  });

  // ── AC4: HEAD /diag → same headers as GET, no body ───────────────────────

  it('HEAD /diag returns 200 with same headers as GET but no body', async () => {
    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ method: 'HEAD', url: '/diag', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');
    expect(res._headers['Content-Length']).toBeDefined();
    // Body should be empty for HEAD
    expect(res._body).toBe('');

    await channel.disconnect();
  });

  // ── null fields: snapshot with all null values still returns 200 ──────────

  it('GET /diag returns 200 even when all sub-reads return null', async () => {
    vi.mocked(getDiagSnapshot).mockReturnValueOnce({
      conversation_history_rows: null,
      scheduled_tasks_active: null,
      tool_jobs_recent_24h: null,
      attachment_count: null,
      attachment_bytes: null,
      db_size_bytes: null,
      uptime_seconds: 0,
    });

    const channel = new HttpChannel(makeConfig(), makeOpts());
    await channel.connect();

    const req = makeReq({ method: 'GET', url: '/diag', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(channel, req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.conversation_history_rows).toBeNull();
    expect(body.db_size_bytes).toBeNull();
    expect(body.uptime_seconds).toBe(0);

    await channel.disconnect();
  });
});
