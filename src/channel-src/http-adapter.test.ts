import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// All vi.mock calls must appear before imports — Vitest hoists them.

const serverListeners = new Map<string, (...args: unknown[]) => void>();
const mockServerInstance = {
  _handler: null as any,
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
        mockServerInstance._handler = handler;
        return mockServerInstance;
      },
    ),
  };
});

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.from('')),
    unlink: vi.fn((_p: string, cb: (err: null) => void) => cb(null)),
  },
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => Buffer.from('')),
  unlink: vi.fn((_p: string, cb: (err: null) => void) => cb(null)),
}));

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

import register from '../../helm/kubeclaw/files/channel-src/http/channel-entry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeSdk(readEnvFileReturn: Record<string, string> = {}) {
  return {
    registerChannel: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    readEnvFile: vi.fn(() => readEnvFileReturn),
    assistantName: 'Andy',
    groupsDir: '/tmp/test-groups',
    config: {
      timezone: 'UTC',
      rateLimitWindowMs: 60000,
      storeDir: '/tmp/store',
      toolJobsRetentionDays: 30,
      defaultModel: 'claude-opus-4-5',
      debugEndpointsEnabled: false,
    },
    history: {
      append: vi.fn(),
      getPage: vi.fn(() => []),
      getAll: vi.fn(() => []),
      getById: vi.fn(() => null),
      update: vi.fn(() => false),
      deleteById: vi.fn(() => false),
      deleteBefore: vi.fn(() => 0),
      clear: vi.fn(),
      search: vi.fn(() => []),
      getOutboundSince: vi.fn(() => []),
      storeOutbound: vi.fn(),
      groupFolderForMessage: vi.fn(() => null),
    },
    tasks: {
      create: vi.fn(),
      getForGroup: vi.fn(() => []),
      getById: vi.fn(() => null),
      deleteForGroup: vi.fn(() => false),
      pause: vi.fn(() => false),
      resume: vi.fn(() => false),
      getRunLogs: vi.fn(() => []),
    },
    jobs: {
      active: vi.fn(() => []),
      recentForGroup: vi.fn(() => []),
      byIdForGroup: vi.fn(() => null),
      insertForDebug: vi.fn(),
    },
    audit: {
      write: vi.fn(),
      entries: vi.fn(() => []),
    },
    diag: vi.fn(() => ({})),
    skills: {
      listAccepted: vi.fn(() => []),
      listCandidates: vi.fn(() => []),
      listArchived: vi.fn(() => []),
      accept: vi.fn(),
      reject: vi.fn(),
    },
  };
}

function makeOpts(overrides?: Record<string, unknown>) {
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
  auth?: string | null;
  body?: string;
  contentType?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (overrides.auth !== null) {
    headers.authorization = `Basic ${b64(overrides.auth ?? 'alice:secret')}`;
  }
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

function makeRes(): ServerResponse {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writableEnded: false,
    headersSent: false,
    writeHead: vi.fn(),
    end: vi.fn(),
    write: vi.fn(),
  } as unknown as ServerResponse;
  (res.writeHead as any) = vi.fn(
    (code: number, headers?: Record<string, string>) => {
      (res as any).statusCode = code;
      if (headers) Object.assign((res as any).headers, headers);
      (res as any).headersSent = true;
    },
  );
  (res.end as any) = vi.fn((body?: string) => {
    if (body) (res as any).body = body;
    (res as any).writableEnded = true;
  });
  return res;
}

async function dispatch(
  _ch: any,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await mockServerInstance._handler(req, res);
}

// ---------------------------------------------------------------------------
// Suite 1: Factory registration
// ---------------------------------------------------------------------------

describe('http-adapter: factory registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockServerInstance._handler = null;
  });

  it('registers an http factory that builds a channel when HTTP_CHANNEL_USERS is set', () => {
    const sdk = makeFakeSdk({ HTTP_CHANNEL_USERS: 'alice:secret' });
    register(sdk);
    expect(sdk.registerChannel).toHaveBeenCalledWith(
      'http',
      expect.any(Function),
    );
    const factory = sdk.registerChannel.mock.calls[0][1];
    const ch = factory(makeOpts());
    expect(ch).not.toBeNull();
    expect(ch.name).toBe('http');
  });

  it('factory returns null when HTTP_CHANNEL_USERS is missing', () => {
    const sdk = makeFakeSdk({});
    register(sdk);
    const factory = sdk.registerChannel.mock.calls[0][1];
    const ch = factory(makeOpts());
    expect(ch).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Channel observable properties
// ---------------------------------------------------------------------------

describe('http-adapter: channel observable properties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockServerInstance._handler = null;
  });

  it('channel.name is "http"', () => {
    const sdk = makeFakeSdk({ HTTP_CHANNEL_USERS: 'alice:secret' });
    register(sdk);
    const factory = sdk.registerChannel.mock.calls[0][1];
    const ch = factory(makeOpts());
    expect(ch.name).toBe('http');
  });

  it('channel.isConnected() is false before connect()', () => {
    const sdk = makeFakeSdk({ HTTP_CHANNEL_USERS: 'alice:secret' });
    register(sdk);
    const factory = sdk.registerChannel.mock.calls[0][1];
    const ch = factory(makeOpts());
    expect(ch.isConnected()).toBe(false);
  });

  it('channel.ownsJid returns true for http: prefix', () => {
    const sdk = makeFakeSdk({ HTTP_CHANNEL_USERS: 'alice:secret' });
    register(sdk);
    const factory = sdk.registerChannel.mock.calls[0][1];
    const ch = factory(makeOpts());
    expect(ch.ownsJid('http:alice')).toBe(true);
  });

  it('channel.ownsJid returns false for other prefixes', () => {
    const sdk = makeFakeSdk({ HTTP_CHANNEL_USERS: 'alice:secret' });
    register(sdk);
    const factory = sdk.registerChannel.mock.calls[0][1];
    const ch = factory(makeOpts());
    expect(ch.ownsJid('telegram:123')).toBe(false);
    expect(ch.ownsJid('irc:#x@irc.test:6697')).toBe(false);
  });

  it('channel.capabilities has inboundImages and outboundMedia', () => {
    const sdk = makeFakeSdk({ HTTP_CHANNEL_USERS: 'alice:secret' });
    register(sdk);
    const factory = sdk.registerChannel.mock.calls[0][1];
    const ch = factory(makeOpts());
    expect(ch.capabilities?.inboundImages).toBe(true);
    expect(ch.capabilities?.outboundMedia).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Authentication
// ---------------------------------------------------------------------------

describe('http-adapter: authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockServerInstance._handler = null;
  });

  async function makeChannel(sdkOverrides?: Record<string, unknown>) {
    const sdk = makeFakeSdk({ HTTP_CHANNEL_USERS: 'alice:secret' });
    Object.assign(sdk, sdkOverrides);
    register(sdk);
    const factory = sdk.registerChannel.mock.calls[0][1];
    const ch = factory(makeOpts());
    await ch.connect();
    return { ch, sdk };
  }

  it('returns 401 on missing Authorization header', async () => {
    const { ch } = await makeChannel();
    const req = makeReq({ url: '/', auth: null });
    const res = makeRes();
    await dispatch(ch, req, res);
    expect((res as any).statusCode).toBe(401);
  });

  it('returns 401 on wrong password', async () => {
    const { ch } = await makeChannel();
    const req = makeReq({ url: '/', auth: 'alice:wrongpass' });
    const res = makeRes();
    await dispatch(ch, req, res);
    expect((res as any).statusCode).toBe(401);
  });

  it('returns 200 on valid credentials', async () => {
    const { ch } = await makeChannel();
    const req = makeReq({ url: '/', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(ch, req, res);
    expect((res as any).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Rate limiting
// ---------------------------------------------------------------------------

describe('http-adapter: rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockServerInstance._handler = null;
  });

  it('returns 429 on second POST /message when perUserMessagesPerMinute=1', async () => {
    const sdk = makeFakeSdk({
      HTTP_CHANNEL_USERS: 'alice:secret',
      HTTP_CHANNEL_RATE_LIMIT_PER_USER_MESSAGES_PER_MINUTE: '1',
    });
    register(sdk);
    const factory = sdk.registerChannel.mock.calls[0][1];
    const ch = factory(makeOpts());
    await ch.connect();

    // First message — allowed
    const req1 = makeReq({
      method: 'POST',
      url: '/message',
      auth: 'alice:secret',
      body: JSON.stringify({ text: 'hello' }),
    });
    const res1 = makeRes();
    await dispatch(ch, req1, res1);
    expect((res1 as any).statusCode).toBe(200);

    // Second message — rate limited
    const req2 = makeReq({
      method: 'POST',
      url: '/message',
      auth: 'alice:secret',
      body: JSON.stringify({ text: 'hello2' }),
    });
    const res2 = makeRes();
    await dispatch(ch, req2, res2);
    expect((res2 as any).statusCode).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: SDK facade integration
// ---------------------------------------------------------------------------

describe('http-adapter: SDK facade integration', () => {
  let ch: any;
  let sdk: ReturnType<typeof makeFakeSdk>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockServerInstance._handler = null;
    sdk = makeFakeSdk({ HTTP_CHANNEL_USERS: 'alice:secret' });
    register(sdk);
    const factory = sdk.registerChannel.mock.calls[0][1];
    ch = factory(makeOpts());
    await ch.connect();
  });

  it('GET /history calls sdk.history.getPage', async () => {
    const req = makeReq({ url: '/history', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(ch, req, res);
    expect(sdk.history.getPage).toHaveBeenCalled();
  });

  it('POST /schedule calls sdk.tasks.create', async () => {
    const body = JSON.stringify({
      schedule_type: 'interval',
      schedule_expression: '60000',
      prompt: 'do something',
    });
    const req = makeReq({
      method: 'POST',
      url: '/schedule',
      auth: 'alice:secret',
      body,
    });
    const res = makeRes();
    await dispatch(ch, req, res);
    expect(sdk.tasks.create).toHaveBeenCalled();
  });

  it('GET /jobs?status=active calls sdk.jobs.active', async () => {
    const req = makeReq({ url: '/jobs?status=active', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(ch, req, res);
    expect(sdk.jobs.active).toHaveBeenCalled();
  });

  it('GET /audit calls sdk.audit.entries', async () => {
    const req = makeReq({ url: '/audit', auth: 'alice:secret' });
    const res = makeRes();
    await dispatch(ch, req, res);
    expect(sdk.audit.entries).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite 6: opts pass-through — secret fns reach handlers (Fix 1 regression)
// ---------------------------------------------------------------------------

describe('http-adapter: opts secret fns pass-through', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockServerInstance._handler = null;
  });

  it('GET /secrets calls opts.listSecretsFn injected via opts (not clobbered)', async () => {
    const listSecretsFn = vi.fn(async () => []);
    const addSecretFn = vi.fn(async () => ({ ok: true }));
    const sdk = makeFakeSdk({ HTTP_CHANNEL_USERS: 'alice:secret' });
    register(sdk);
    const factory = sdk.registerChannel.mock.calls[0][1];
    const ch = factory(makeOpts({ listSecretsFn, addSecretFn }));
    await ch.connect();

    const req = makeReq({
      method: 'GET',
      url: '/secrets',
      auth: 'alice:secret',
    });
    const res = makeRes();
    await dispatch(ch, req, res);

    expect(listSecretsFn).toHaveBeenCalled();
    expect((res as any).statusCode).toBe(200);
  });
});
