import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MatrixChannel,
  parseConfig,
} from '../../helm/kubeclaw/files/channel-src/matrix/channel-entry.js';

// ── Fake SDK / opts helpers ───────────────────────────────────────────────────

function fakeSdk(env: Record<string, string> = {}) {
  const factories: Record<string, any> = {};
  return {
    sdk: {
      registerChannel: (name: string, f: any) => {
        factories[name] = f;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      readEnvFile: () => env,
      assistantName: 'Andy',
      groupsDir: '/groups',
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
      'matrix:!room1:home.server': {
        name: 'Test Room',
        folder: 'matrix-room1',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'matrix:!room2:home.server': {
        name: 'Group Room',
        folder: 'matrix-room2',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

const VALID_ENV = {
  MATRIX_HOMESERVER_URL: 'https://matrix.org',
  MATRIX_USER_ID: '@mybot:matrix.org',
  MATRIX_ACCESS_TOKEN: 'syt_abc123',
};

function buildChannel(env: Record<string, string>, opts?: any) {
  const { sdk, factories } = fakeSdk(env);
  sdk.registerChannel('matrix', (o: any) => {
    const cfg = parseConfig(sdk);
    if (!cfg) return null;
    return new MatrixChannel(cfg, o, sdk);
  });
  const ch = factories['matrix'](opts ?? fakeOpts());
  return { sdk, ch };
}

// ── Factory / config tests ────────────────────────────────────────────────────

describe('matrix-adapter: factory + config parsing', () => {
  it('builds a channel when all three creds are present', () => {
    const { ch } = buildChannel(VALID_ENV);
    expect(ch).not.toBeNull();
    expect(ch.name).toBe('matrix');
  });

  it('returns null when MATRIX_HOMESERVER_URL is missing', () => {
    const { ch } = buildChannel({
      MATRIX_USER_ID: '@mybot:matrix.org',
      MATRIX_ACCESS_TOKEN: 'syt_abc123',
    });
    expect(ch).toBeNull();
  });

  it('returns null when MATRIX_USER_ID is missing', () => {
    const { ch } = buildChannel({
      MATRIX_HOMESERVER_URL: 'https://matrix.org',
      MATRIX_ACCESS_TOKEN: 'syt_abc123',
    });
    expect(ch).toBeNull();
  });

  it('returns null when MATRIX_ACCESS_TOKEN is missing', () => {
    const { ch } = buildChannel({
      MATRIX_HOMESERVER_URL: 'https://matrix.org',
      MATRIX_USER_ID: '@mybot:matrix.org',
    });
    expect(ch).toBeNull();
  });

  it('parseConfig warns and returns null when any cred missing', () => {
    const { sdk } = fakeSdk({});
    const cfg = parseConfig(sdk);
    expect(cfg).toBeNull();
    expect(sdk.logger.warn).toHaveBeenCalled();
  });

  it('parseConfig returns null and warns when MATRIX_USER_ID is invalid format', () => {
    const { sdk } = fakeSdk({
      MATRIX_HOMESERVER_URL: 'https://matrix.org',
      MATRIX_USER_ID: 'notavaliduserid',
      MATRIX_ACCESS_TOKEN: 'syt_abc123',
    });
    const cfg = parseConfig(sdk);
    expect(cfg).toBeNull();
    expect(sdk.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'notavaliduserid' }),
      expect.stringContaining('MATRIX_USER_ID'),
    );
  });

  it('parseConfig returns null and warns when homeserver URL is invalid', () => {
    const { sdk } = fakeSdk({
      MATRIX_HOMESERVER_URL: 'not-a-url',
      MATRIX_USER_ID: '@mybot:matrix.org',
      MATRIX_ACCESS_TOKEN: 'syt_abc123',
    });
    const cfg = parseConfig(sdk);
    expect(cfg).toBeNull();
    expect(sdk.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ homeserverUrl: 'not-a-url' }),
      expect.stringContaining('MATRIX_HOMESERVER_URL'),
    );
  });

  it('parseConfig returns config with trimmed creds when valid', () => {
    const { sdk } = fakeSdk({
      MATRIX_HOMESERVER_URL: '  https://matrix.org  ',
      MATRIX_USER_ID: '  @mybot:matrix.org  ',
      MATRIX_ACCESS_TOKEN: '  syt_abc123  ',
    });
    const cfg = parseConfig(sdk);
    expect(cfg).not.toBeNull();
    expect(cfg!.homeserverUrl).toBe('https://matrix.org');
    expect(cfg!.userId).toBe('@mybot:matrix.org');
    expect(cfg!.accessToken).toBe('syt_abc123');
  });
});

// ── ownsJid ────────────────────────────────────────────────────────────────────

describe('matrix-adapter: ownsJid', () => {
  it('owns matrix: JIDs', () => {
    const { ch } = buildChannel(VALID_ENV);
    expect(ch.ownsJid('matrix:!room1:home.server')).toBe(true);
    expect(ch.ownsJid('matrix:!room2:another.server')).toBe(true);
  });

  it('does not own other JIDs', () => {
    const { ch } = buildChannel(VALID_ENV);
    expect(ch.ownsJid('telegram:123')).toBe(false);
    expect(ch.ownsJid('discord:111222333')).toBe(false);
    expect(ch.ownsJid('signal:+61400000000')).toBe(false);
  });

  it('returns false for undefined', () => {
    const { ch } = buildChannel(VALID_ENV);
    expect(ch.ownsJid(undefined as any)).toBe(false);
  });

  it('handles JIDs with multiple colons (real room ids)', () => {
    const { ch } = buildChannel(VALID_ENV);
    expect(ch.ownsJid('matrix:!abc123:home.server')).toBe(true);
  });
});

// ── _handleTimelineEvent ──────────────────────────────────────────────────────

describe('matrix-adapter: _handleTimelineEvent', () => {
  function makeEvent(overrides: Record<string, any> = {}) {
    return {
      getType: vi.fn().mockReturnValue('m.room.message'),
      getContent: vi.fn().mockReturnValue({ msgtype: 'm.text', body: 'hello' }),
      getId: vi.fn().mockReturnValue('$event1:home.server'),
      getSender: vi.fn().mockReturnValue('@alice:home.server'),
      ...overrides,
    };
  }

  function makeRoom(roomId: string, name?: string) {
    return { roomId, name: name || roomId };
  }

  it('drops events before sync reaches PREPARED (syncReady=false)', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = false;
    const event = makeEvent();
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server', 'Test Room'));
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('processes events after syncReady=true', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;
    const event = makeEvent();
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server', 'Test Room'));
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
  });

  it('drops non-m.room.message event types', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;
    const event = makeEvent({ getType: vi.fn().mockReturnValue('m.reaction') });
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server'));
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('drops messages with non-m.text msgtype', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;
    const event = makeEvent({
      getContent: vi
        .fn()
        .mockReturnValue({ msgtype: 'm.image', url: 'mxc://...' }),
    });
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server'));
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('deduplicates events by event id', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;
    const event = makeEvent({
      getId: vi.fn().mockReturnValue('$dup-event:server'),
    });
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server', 'Test Room'));
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server', 'Test Room'));
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
  });

  it('echo guard: drops messages from own userId', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;
    const event = makeEvent({
      getSender: vi.fn().mockReturnValue('@mybot:matrix.org'), // same as config.userId
      getId: vi.fn().mockReturnValue('$self-event:server'),
    });
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server'));
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('drops messages from unregistered rooms', () => {
    const opts = fakeOpts({ registeredGroups: () => ({}) });
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;
    const event = makeEvent({
      getId: vi.fn().mockReturnValue('$unregistered:server'),
    });
    ch._handleTimelineEvent(event, makeRoom('!unknown:home.server'));
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('calls onChatMetadata BEFORE onMessage with correct args', () => {
    const callOrder: string[] = [];
    const opts = fakeOpts();
    opts.onChatMetadata = vi.fn(() => callOrder.push('metadata'));
    opts.onMessage = vi.fn(() => callOrder.push('message'));
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;
    const event = makeEvent({
      getId: vi.fn().mockReturnValue('$order-test:server'),
    });
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server', 'Test Room'));
    expect(callOrder).toEqual(['metadata', 'message']);
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'matrix:!room1:home.server',
      expect.any(String),
      'Test Room',
      'matrix',
      true,
    );
  });

  it('onMessage has correct shape with is_from_me: false', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;
    const event = makeEvent({
      getId: vi.fn().mockReturnValue('$msg1:server'),
      getSender: vi.fn().mockReturnValue('@alice:home.server'),
      getContent: vi
        .fn()
        .mockReturnValue({ msgtype: 'm.text', body: 'hello world' }),
    });
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server', 'Test Room'));
    const [jid, msg] = opts.onMessage.mock.calls[0];
    expect(jid).toBe('matrix:!room1:home.server');
    expect(msg.content).toBe('hello world');
    expect(msg.sender).toBe('@alice:home.server');
    expect(msg.sender_name).toBe('@alice:home.server');
    expect(msg.is_from_me).toBe(false);
    expect(msg.chat_jid).toBe('matrix:!room1:home.server');
    expect(typeof msg.id).toBe('string');
    expect(typeof msg.timestamp).toBe('string');
  });

  it('rewrites bare @Andy mention to trigger prefix in a group room', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;
    const event = makeEvent({
      getId: vi.fn().mockReturnValue('$mention-test:server'),
      getContent: vi.fn().mockReturnValue({
        msgtype: 'm.text',
        body: 'hey @Andy what is the time',
      }),
    });
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server', 'Test Room'));
    const [, msg] = opts.onMessage.mock.calls[0];
    expect(msg.content).toBe('@Andy hey @Andy what is the time');
  });

  it('does NOT rewrite when message already starts with @Andy', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;
    const event = makeEvent({
      getId: vi.fn().mockReturnValue('$trigger-already:server'),
      getContent: vi.fn().mockReturnValue({
        msgtype: 'm.text',
        body: '@Andy help me',
      }),
    });
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server', 'Test Room'));
    const [, msg] = opts.onMessage.mock.calls[0];
    expect(msg.content).toBe('@Andy help me');
  });

  it('escapes regex metacharacters in assistantName (e.g. C++Bot)', () => {
    const fac: Record<string, any> = {};
    const s = {
      registerChannel: (name: string, f: any) => {
        fac[name] = f;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      readEnvFile: () => VALID_ENV,
      assistantName: 'C++Bot',
      groupsDir: '/groups',
    };
    const opts = fakeOpts();
    s.registerChannel('matrix', (o: any) => {
      const cfg = parseConfig(s as any);
      if (!cfg) return null;
      return new MatrixChannel(cfg, o, s as any);
    });
    const ch = fac['matrix'](opts);
    ch.syncReady = true;
    const event = {
      getType: vi.fn().mockReturnValue('m.room.message'),
      getContent: vi
        .fn()
        .mockReturnValue({ msgtype: 'm.text', body: 'hey @C++Bot help' }),
      getId: vi.fn().mockReturnValue('$cpp-test:server'),
      getSender: vi.fn().mockReturnValue('@alice:home.server'),
    };
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server', 'Test Room'));
    const [, msg] = opts.onMessage.mock.calls[0];
    expect(msg.content).toBe('@C++Bot hey @C++Bot help');
  });

  it('FIFO bounded dedup: evicted (oldest) id is re-delivered; still-cached recent id is not', () => {
    // Regression for the clear()-on-overflow bug: the old code evicted ALL entries when the
    // cap was hit, which could re-deliver recently-seen events. The new code uses FIFO
    // eviction — only the oldest entry is removed per new unique event added at cap.
    //
    // Strategy: pre-fill _seenEventIds / _seenEventIdQueue to EVENT_ID_CAP-1 entries, then
    // push two real events through _handleTimelineEvent:
    //   1. A genuinely-new event ('new-id') — triggers eviction of 'oldest-id', gets delivered.
    //   2. Re-send 'oldest-id' — now evicted from Set, so delivered again (bounded behaviour).
    //   3. Re-send 'new-id' — still in Set, must NOT re-deliver.
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;

    // Pre-fill to exactly EVENT_ID_CAP entries so that the NEXT unique event triggers
    // FIFO eviction. The eviction path is: size >= EVENT_ID_CAP → shift oldest → delete it.
    // We pre-fill directly on internal state to avoid firing 10000 real events (too slow).
    const REAL_CAP = 10000; // matches EVENT_ID_CAP in the module
    ch._seenEventIds = new Set(['oldest-id']);
    ch._seenEventIdQueue = ['oldest-id'];
    // Fill slots 1..(cap-1) with placeholder ids, making total size = cap.
    // The last fill entry is named 'recent-id' for our cached-entry assertion below.
    const recentId = 'recent-id';
    for (let i = 1; i < REAL_CAP; i++) {
      const id = i === REAL_CAP - 1 ? recentId : `fill-${i}`;
      ch._seenEventIds.add(id);
      ch._seenEventIdQueue.push(id);
    }
    // size should now be exactly cap (eviction fires on the next unique event)
    expect(ch._seenEventIds.size).toBe(REAL_CAP);

    // Step 1: send 'new-id' — size is at cap so eviction fires: 'oldest-id' is removed,
    // 'new-id' is added, and the event is delivered.
    const evNew = makeEvent({ getId: vi.fn().mockReturnValue('new-id') });
    ch._handleTimelineEvent(evNew, makeRoom('!room1:home.server', 'Test Room'));
    expect(opts.onMessage).toHaveBeenCalledTimes(1); // delivered

    // After eviction: 'oldest-id' must have been removed from the Set
    expect(ch._seenEventIds.has('oldest-id')).toBe(false);
    // 'recent-id' and 'new-id' must still be in the Set
    expect(ch._seenEventIds.has(recentId)).toBe(true);
    expect(ch._seenEventIds.has('new-id')).toBe(true);

    // Step 2: re-send 'oldest-id' — now evicted, so it IS re-delivered (correct bounded behaviour)
    opts.onMessage.mockClear();
    const evOldest = makeEvent({ getId: vi.fn().mockReturnValue('oldest-id') });
    ch._handleTimelineEvent(
      evOldest,
      makeRoom('!room1:home.server', 'Test Room'),
    );
    expect(opts.onMessage).toHaveBeenCalledTimes(1); // re-delivered exactly once

    // Step 3: re-send 'new-id' — still in Set → must NOT re-deliver
    opts.onMessage.mockClear();
    const evNewAgain = makeEvent({ getId: vi.fn().mockReturnValue('new-id') });
    ch._handleTimelineEvent(
      evNewAgain,
      makeRoom('!room1:home.server', 'Test Room'),
    );
    expect(opts.onMessage).not.toHaveBeenCalled(); // still cached → suppressed
  });

  it('echo guard runs BEFORE dedup: self-message does not consume a dedup slot', () => {
    // If the echo guard ran AFTER dedup, a self-echo would occupy a slot in the Set
    // and then — if the same event id were somehow re-sent by another user — it would
    // be incorrectly suppressed. With the guard BEFORE dedup, self-events never touch
    // the Set at all.
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;
    const selfEventId = '$self-before-dedup:server';

    // Fire a self-echo (from own userId)
    const selfEvent = makeEvent({
      getId: vi.fn().mockReturnValue(selfEventId),
      getSender: vi.fn().mockReturnValue('@mybot:matrix.org'), // own userId
    });
    ch._handleTimelineEvent(
      selfEvent,
      makeRoom('!room1:home.server', 'Test Room'),
    );
    expect(opts.onMessage).not.toHaveBeenCalled(); // echo suppressed

    // The self event id must NOT have been added to the dedup Set
    expect(ch._seenEventIds.has(selfEventId)).toBe(false);

    // Now the same event id arrives from a different user — should deliver (not deduped)
    const realEvent = makeEvent({
      getId: vi.fn().mockReturnValue(selfEventId),
      getSender: vi.fn().mockReturnValue('@alice:home.server'),
    });
    ch._handleTimelineEvent(
      realEvent,
      makeRoom('!room1:home.server', 'Test Room'),
    );
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
  });

  it('isGroup is always true', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    ch.syncReady = true;
    const event = makeEvent({
      getId: vi.fn().mockReturnValue('$group-test:server'),
    });
    ch._handleTimelineEvent(event, makeRoom('!room1:home.server', 'Test Room'));
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      'matrix',
      true, // isGroup always true
    );
  });
});

// ── sendMessage ───────────────────────────────────────────────────────────────

describe('matrix-adapter: sendMessage', () => {
  it('calls client.sendTextMessage with correct roomId and text', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    const sendTextSpy = vi.fn().mockResolvedValue({});
    ch.client = { sendTextMessage: sendTextSpy, stopClient: vi.fn() };

    await ch.sendMessage('matrix:!room1:home.server', 'hello there');
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    expect(sendTextSpy).toHaveBeenCalledWith(
      '!room1:home.server',
      'hello there',
    );
  });

  it('chunks a 65000-char message into 3 sends (chunk size = 32000)', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    const sendTextSpy = vi.fn().mockResolvedValue({});
    ch.client = { sendTextMessage: sendTextSpy, stopClient: vi.fn() };

    await ch.sendMessage('matrix:!room1:home.server', 'x'.repeat(65000));
    // 65000 / 32000 = 3 chunks (32000, 32000, 1000)
    expect(sendTextSpy).toHaveBeenCalledTimes(3);
    expect(sendTextSpy.mock.calls[0][1].length).toBe(32000);
    expect(sendTextSpy.mock.calls[1][1].length).toBe(32000);
    expect(sendTextSpy.mock.calls[2][1].length).toBe(1000);
  });

  it('does nothing for a non-matrix JID', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    const sendTextSpy = vi.fn();
    ch.client = { sendTextMessage: sendTextSpy, stopClient: vi.fn() };
    await ch.sendMessage('telegram:123', 'nope');
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it('logs a warn and returns when client is null (not connected)', async () => {
    const opts = fakeOpts();
    const { sdk, ch } = buildChannel(VALID_ENV, opts);
    // ch.client is null by default — should warn but not throw
    await expect(
      ch.sendMessage('matrix:!room1:home.server', 'hello'),
    ).resolves.toBeUndefined();
    expect(sdk.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'matrix:!room1:home.server' }),
      'matrix: sendMessage called but client not connected',
    );
  });

  it('logs error and continues when sendTextMessage throws', async () => {
    const opts = fakeOpts();
    const { sdk, ch } = buildChannel(VALID_ENV, opts);
    const sendTextSpy = vi.fn().mockRejectedValue(new Error('network error'));
    ch.client = { sendTextMessage: sendTextSpy, stopClient: vi.fn() };

    // Should not throw, but should log error
    await expect(
      ch.sendMessage('matrix:!room1:home.server', 'hello'),
    ).resolves.toBeUndefined();
    expect(sdk.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'matrix:!room1:home.server' }),
      'matrix: send failed',
    );
  });
});

// ── lifecycle ─────────────────────────────────────────────────────────────────

describe('matrix-adapter: lifecycle', () => {
  it('isConnected returns false initially', () => {
    const { ch } = buildChannel(VALID_ENV);
    expect(ch.isConnected()).toBe(false);
  });

  it('connect calls _makeClient with credentials and sets connected', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);

    const fakeClient = {
      on: vi.fn(),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
      sendTextMessage: vi.fn(),
    };
    ch._makeClient = vi.fn().mockResolvedValue(fakeClient);

    await ch.connect();
    expect(ch._makeClient).toHaveBeenCalledWith({
      baseUrl: 'https://matrix.org',
      userId: '@mybot:matrix.org',
      accessToken: 'syt_abc123',
    });
    expect(ch.isConnected()).toBe(true);
    expect(fakeClient.on).toHaveBeenCalledWith('sync', expect.any(Function));
    expect(fakeClient.on).toHaveBeenCalledWith(
      'Room.timeline',
      expect.any(Function),
    );
    expect(fakeClient.startClient).toHaveBeenCalled();
  });

  it('sync PREPARED event sets syncReady to true', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);

    let syncHandler: ((state: string) => void) | null = null;
    const fakeClient = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'sync') syncHandler = handler;
      }),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
    };
    ch._makeClient = vi.fn().mockResolvedValue(fakeClient);

    await ch.connect();
    expect(ch.syncReady).toBe(false);

    // Fire PREPARED state
    syncHandler!('PREPARED');
    expect(ch.syncReady).toBe(true);
  });

  it('sync non-PREPARED state does NOT set syncReady', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);

    let syncHandler: ((state: string) => void) | null = null;
    const fakeClient = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'sync') syncHandler = handler;
      }),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
    };
    ch._makeClient = vi.fn().mockResolvedValue(fakeClient);

    await ch.connect();
    syncHandler!('SYNCING');
    expect(ch.syncReady).toBe(false);
  });

  it('disconnect sets connected=false and calls client.stopClient()', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    const stopSpy = vi.fn();
    const fakeClient = {
      on: vi.fn(),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: stopSpy,
    };
    ch._makeClient = vi.fn().mockResolvedValue(fakeClient);
    await ch.connect();
    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
    expect(stopSpy).toHaveBeenCalled();
    expect(ch.client).toBeNull();
  });

  it('disconnect is idempotent (no throw when called twice)', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    const fakeClient = {
      on: vi.fn(),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
    };
    ch._makeClient = vi.fn().mockResolvedValue(fakeClient);
    await ch.connect();
    await ch.disconnect();
    await expect(ch.disconnect()).resolves.toBeUndefined();
    expect(ch.isConnected()).toBe(false);
  });
});

// ── setTyping ─────────────────────────────────────────────────────────────────

describe('matrix-adapter: setTyping', () => {
  it('calls client.sendTyping with roomId, isTyping=true, timeout=20000', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    const sendTypingSpy = vi.fn().mockResolvedValue(undefined);
    ch.client = { sendTyping: sendTypingSpy, stopClient: vi.fn() };

    await ch.setTyping('matrix:!room1:home.server', true);
    expect(sendTypingSpy).toHaveBeenCalledWith(
      '!room1:home.server',
      true,
      20000,
    );
  });

  it('calls client.sendTyping with roomId, isTyping=false, timeout=0 (stop typing)', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    const sendTypingSpy = vi.fn().mockResolvedValue(undefined);
    ch.client = { sendTyping: sendTypingSpy, stopClient: vi.fn() };

    await ch.setTyping('matrix:!room1:home.server', false);
    expect(sendTypingSpy).toHaveBeenCalledWith('!room1:home.server', false, 0);
  });

  it('does nothing for non-matrix JID', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    const sendTypingSpy = vi.fn();
    ch.client = { sendTyping: sendTypingSpy, stopClient: vi.fn() };
    await ch.setTyping('telegram:123', true);
    expect(sendTypingSpy).not.toHaveBeenCalled();
  });

  it('does nothing when client is null', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel(VALID_ENV, opts);
    // ch.client is null
    await expect(
      ch.setTyping('matrix:!room1:home.server', true),
    ).resolves.toBeUndefined();
  });
});

// ── capabilities ──────────────────────────────────────────────────────────────

describe('matrix-adapter: capabilities', () => {
  it('declares typing=true, inboundImages=false (v1: m.image dropped), outboundMedia=false, no markdownOutput', () => {
    const { ch } = buildChannel(VALID_ENV);
    expect(ch.capabilities.typing).toBe(true);
    // v1 only processes m.text — m.image events are dropped; capability is false
    expect(ch.capabilities.inboundImages).toBe(false);
    expect(ch.capabilities.outboundMedia).toBe(false);
    expect(ch.capabilities.markdownOutput).toBeUndefined();
  });
});
