import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import register from '../../helm/kubeclaw/files/channel-src/imessage/channel-entry.js';

function fakeSdk(env: Record<string, string>) {
  const factories: Record<string, any> = {};
  return {
    sdk: {
      registerChannel: (name: string, f: any) => {
        factories[name] = f;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      readEnvFile: () => env,
      assistantName: 'Andy',
    },
    factories,
  };
}

function fakeOpts(overrides?: {
  registeredGroups?: () => Record<string, any>;
}) {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'imessage:+61400000000': {
        name: 'Alice',
        folder: 'alice',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'imessage:alice@example.com': {
        name: 'Alice Email',
        folder: 'alice-email',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'imessage:group.iMessage;+;chat-guid-123': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

const BRIDGE_URL = 'http://imessage.test:1234';
const BRIDGE_PW = 'secret-pw';

function buildChannel(env: Record<string, string>, opts?: any) {
  const { sdk, factories } = fakeSdk(env);
  register(sdk);
  const ch = factories['imessage'](opts ?? fakeOpts());
  return { sdk, ch };
}

// ── factory + config ──────────────────────────────────────────────────────────

describe('imessage-adapter: factory + config parsing', () => {
  it('registers an imessage factory that builds a channel with valid creds', () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    expect(ch).not.toBeNull();
    expect(ch.name).toBe('imessage');
  });

  it('returns null when IMESSAGE_BRIDGE_URL is missing', () => {
    const { ch } = buildChannel({ IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW });
    expect(ch).toBeNull();
  });

  it('returns null when IMESSAGE_BRIDGE_PASSWORD is missing', () => {
    const { ch } = buildChannel({ IMESSAGE_BRIDGE_URL: BRIDGE_URL });
    expect(ch).toBeNull();
  });

  it('returns null when both creds are missing', () => {
    const { ch } = buildChannel({});
    expect(ch).toBeNull();
  });

  it('trims trailing slash from IMESSAGE_BRIDGE_URL', () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: 'http://imessage.test:1234/',
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    expect(ch.config.bridgeUrl).toBe('http://imessage.test:1234');
  });

  it('trims multiple trailing slashes from IMESSAGE_BRIDGE_URL', () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: 'http://imessage.test:1234///',
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    expect(ch.config.bridgeUrl).toBe('http://imessage.test:1234');
  });

  it('defaults poll interval to 3000 ms', () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    expect(ch.config.pollMs).toBe(3000);
  });

  it('honours IMESSAGE_POLL_MS', () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
      IMESSAGE_POLL_MS: '5000',
    });
    expect(ch.config.pollMs).toBe(5000);
  });

  it('capabilities is an empty object (text-only v1)', () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    expect(ch.capabilities).toEqual({});
  });
});

// ── ownsJid ───────────────────────────────────────────────────────────────────

describe('imessage-adapter: ownsJid', () => {
  it('owns imessage: JIDs', () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    expect(ch.ownsJid('imessage:+61400000000')).toBe(true);
    expect(ch.ownsJid('imessage:alice@example.com')).toBe(true);
    expect(ch.ownsJid('imessage:group.iMessage;+;chat-guid-123')).toBe(true);
  });

  it('does not own other JIDs', () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    expect(ch.ownsJid('signal:+61400000000')).toBe(false);
    expect(ch.ownsJid('tg:123')).toBe(false);
    expect(ch.ownsJid('irc:#x@irc.test:6697')).toBe(false);
    expect(ch.ownsJid(undefined as any)).toBe(false);
  });
});

// ── JID derivation ────────────────────────────────────────────────────────────

describe('imessage-adapter: jidForMessage', () => {
  it('uses imessage:group.<guid> for group chat GUIDs', () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    const msg = {
      chats: [{ guid: 'iMessage;+;chat-guid-123' }],
      handle: { address: '+61400000000' },
    };
    expect(ch.jidForMessage(msg)).toBe(
      'imessage:group.iMessage;+;chat-guid-123',
    );
  });

  it('uses imessage:<handle> for 1:1 chats via handle.address', () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    const msg = {
      chats: [{ guid: 'iMessage;-;+61400000000' }],
      handle: { address: '+61400000000' },
    };
    expect(ch.jidForMessage(msg)).toBe('imessage:+61400000000');
  });

  it('derives handle from chatGuid for 1:1 when no handle.address', () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    const msg = {
      chats: [{ guid: 'iMessage;-;alice@example.com' }],
    };
    expect(ch.jidForMessage(msg)).toBe('imessage:alice@example.com');
  });
});

// ── handleMessage → onMessage ─────────────────────────────────────────────────

describe('imessage-adapter: handleMessage → onMessage', () => {
  it('routes a 1:1 text message to onMessage with the right JID', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );
    await ch.handleMessage({
      chats: [{ guid: 'iMessage;-;+61400000000' }],
      handle: { address: '+61400000000', displayName: 'Alice' },
      text: 'hello bot',
      dateCreated: 1700000000000,
      isFromMe: false,
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'imessage:+61400000000',
      expect.objectContaining({
        content: 'hello bot',
        sender: '+61400000000',
        sender_name: 'Alice',
        is_from_me: false,
      }),
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'imessage:+61400000000',
      expect.any(String),
      'Alice',
      'imessage',
      false,
    );
  });

  it('ignores messages where isFromMe is true (echo guard)', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );
    await ch.handleMessage({
      chats: [{ guid: 'iMessage;-;+61400000000' }],
      handle: { address: '+61400000000' },
      text: 'my own reply',
      dateCreated: 1700000000000,
      isFromMe: true,
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('ignores messages from unregistered chats', async () => {
    const opts = fakeOpts({ registeredGroups: () => ({}) });
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );
    await ch.handleMessage({
      chats: [{ guid: 'iMessage;-;+61400000000' }],
      handle: { address: '+61400000000' },
      text: 'hello',
      dateCreated: 1700000000000,
      isFromMe: false,
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('ignores messages with no text and no attachments', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );
    await ch.handleMessage({
      chats: [{ guid: 'iMessage;-;+61400000000' }],
      handle: { address: '+61400000000' },
      text: '',
      dateCreated: 1700000000000,
      isFromMe: false,
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('rewrites a bare assistant mention into a trigger prefix in groups', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );
    await ch.handleMessage({
      chats: [{ guid: 'iMessage;+;chat-guid-123' }],
      handle: { address: '+61400000000', displayName: 'Bob' },
      text: 'hey @Andy what time is it',
      dateCreated: 1700000000000,
      isFromMe: false,
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'imessage:group.iMessage;+;chat-guid-123',
      expect.objectContaining({ content: '@Andy hey @Andy what time is it' }),
    );
  });

  it('does not double-prepend if message already starts with @AssistantName', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );
    await ch.handleMessage({
      chats: [{ guid: 'iMessage;+;chat-guid-123' }],
      handle: { address: '+61400000000', displayName: 'Bob' },
      text: '@Andy how are you',
      dateCreated: 1700000000000,
      isFromMe: false,
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'imessage:group.iMessage;+;chat-guid-123',
      expect.objectContaining({ content: '@Andy how are you' }),
    );
  });

  it('adds [Attachment: unsupported in v1] marker for messages with attachments', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );
    await ch.handleMessage({
      chats: [{ guid: 'iMessage;-;+61400000000' }],
      handle: { address: '+61400000000', displayName: 'Alice' },
      text: 'check this out',
      attachments: [{ transferName: 'photo.jpg', mimeType: 'image/jpeg' }],
      dateCreated: 1700000000000,
      isFromMe: false,
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'imessage:+61400000000',
      expect.objectContaining({
        content: '[Attachment: unsupported in v1]\ncheck this out',
      }),
    );
  });

  it('delivers attachment-only message (no text) with just the marker', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );
    await ch.handleMessage({
      chats: [{ guid: 'iMessage;-;+61400000000' }],
      handle: { address: '+61400000000', displayName: 'Alice' },
      text: '',
      attachments: [{ transferName: 'photo.jpg', mimeType: 'image/jpeg' }],
      dateCreated: 1700000000000,
      isFromMe: false,
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'imessage:+61400000000',
      expect.objectContaining({ content: '[Attachment: unsupported in v1]' }),
    );
  });
});

// ── pollOnce cursor advancement ───────────────────────────────────────────────

describe('imessage-adapter: pollOnce advances cursor, no re-delivery', () => {
  let fetchMock: any;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a BlueBubbles response, routes messages, advances lastSeen cursor', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );

    // Use a ts far in the future so it's guaranteed > Date.now() at test start
    const ts1 = Date.now() + 999_999_999;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 200,
        data: [
          {
            chats: [{ guid: 'iMessage;-;+61400000000' }],
            handle: { address: '+61400000000', displayName: 'Alice' },
            text: 'hello',
            dateCreated: ts1,
            isFromMe: false,
          },
        ],
      }),
    });

    const prevLastSeen = ch.lastSeen;
    await ch.pollOnce();

    expect(opts.onMessage).toHaveBeenCalledOnce();
    expect(opts.onMessage).toHaveBeenCalledWith(
      'imessage:+61400000000',
      expect.objectContaining({ content: 'hello' }),
    );
    // Cursor advanced to the message's ts (which is beyond prevLastSeen)
    expect(ch.lastSeen).toBeGreaterThan(prevLastSeen);
    expect(ch.lastSeen).toBe(ts1);
  });

  it('second poll with same data (cursor advanced) returns nothing new', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );
    const ts1 = 1700000001000;

    // First poll: one message
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 200,
        data: [
          {
            chats: [{ guid: 'iMessage;-;+61400000000' }],
            handle: { address: '+61400000000', displayName: 'Alice' },
            text: 'hello',
            dateCreated: ts1,
            isFromMe: false,
          },
        ],
      }),
    });
    await ch.pollOnce();
    expect(opts.onMessage).toHaveBeenCalledTimes(1);

    // Second poll: empty (server returns nothing newer than cursor)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 200, data: [] }),
    });
    await ch.pollOnce();
    // No additional calls
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores isFromMe messages in pollOnce', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 200,
        data: [
          {
            chats: [{ guid: 'iMessage;-;+61400000000' }],
            handle: { address: '+61400000000' },
            text: 'my own message',
            dateCreated: 1700000001000,
            isFromMe: true,
          },
        ],
      }),
    });

    await ch.pollOnce();
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('does nothing on a non-200 poll response', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await ch.pollOnce();
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('propagates fetch throw (ECONNREFUSED) — loop catch handles it', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(ch.pollOnce()).rejects.toThrow('ECONNREFUSED');
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('sends the `after` cursor in the POST body to BlueBubbles', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(
      { IMESSAGE_BRIDGE_URL: BRIDGE_URL, IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW },
      opts,
    );
    ch.lastSeen = 1700000000000;

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 200, data: [] }),
    });

    await ch.pollOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/message/query');
    expect(url).toContain('password=');
    const body = JSON.parse(init.body);
    expect(body.after).toBe(1700000000000);
  });
});

// ── sendMessage ───────────────────────────────────────────────────────────────

describe('imessage-adapter: sendMessage', () => {
  let fetchMock: any;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to /api/v1/message/text with chatGuid for a 1:1 phone JID', async () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    await ch.sendMessage('imessage:+61400000000', 'hi there');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`${BRIDGE_URL}/api/v1/message/text`);
    expect(url).toContain('password=');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.chatGuid).toBe('iMessage;-;+61400000000');
    expect(body.message).toBe('hi there');
    expect(body.tempGuid).toBeDefined();
  });

  it('uses the raw chatGuid from group JID', async () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    await ch.sendMessage(
      'imessage:group.iMessage;+;chat-guid-123',
      'team update',
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.chatGuid).toBe('iMessage;+;chat-guid-123');
  });

  it('chunks messages longer than 10000 chars', async () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    // 25000 chars → 3 chunks (10000 + 10000 + 5000)
    await ch.sendMessage('imessage:+61400000000', 'x'.repeat(25000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message.length).toBe(
      10000,
    );
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).message.length).toBe(
      5000,
    );
  });

  it('ignores a non-imessage JID', async () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    await ch.sendMessage('signal:+61400000000', 'nope');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends email handle in chatGuid for email 1:1 JID', async () => {
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    await ch.sendMessage('imessage:alice@example.com', 'hello alice');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.chatGuid).toBe('iMessage;-;alice@example.com');
  });
});

// ── lifecycle ─────────────────────────────────────────────────────────────────

describe('imessage-adapter: lifecycle', () => {
  it('connect sets connected and disconnect clears it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    expect(ch.isConnected()).toBe(false);
    await ch.connect();
    expect(ch.isConnected()).toBe(true);
    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('disconnect is idempotent (double disconnect)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const { ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    await ch.connect();
    await ch.disconnect();
    await expect(ch.disconnect()).resolves.not.toThrow();
    expect(ch.isConnected()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('connect logs warn and keeps polling when ping returns non-200', async () => {
    const { sdk, ch } = buildChannel({
      IMESSAGE_BRIDGE_URL: BRIDGE_URL,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    await ch.connect();
    expect(ch.isConnected()).toBe(false);
    expect(sdk.logger.warn).toHaveBeenCalled();
    await ch.disconnect();
    vi.unstubAllGlobals();
  });
});
