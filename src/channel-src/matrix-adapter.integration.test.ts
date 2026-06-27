/**
 * Matrix adapter integration test — fake transport.
 *
 * Exercises the full connect → on('sync') → on('Room.timeline') → _handleTimelineEvent → onMessage
 * and sendMessage → client.sendTextMessage wiring using a fake client
 * injected via ch._makeClient. No network access; no matrix-js-sdk import.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MatrixChannel,
  parseConfig,
} from '../../helm/kubeclaw/files/channel-src/matrix/channel-entry.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_ENV = {
  MATRIX_HOMESERVER_URL: 'https://matrix.org',
  MATRIX_USER_ID: '@mybot:matrix.org',
  MATRIX_ACCESS_TOKEN: 'syt_abc123',
};

function makeSdk(env: Record<string, string> = {}) {
  return {
    registerChannel: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readEnvFile: () => env,
    assistantName: 'Andy',
    groupsDir: '/groups',
  };
}

function makeOpts(registeredMap: Record<string, any> = {}) {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => registeredMap),
  };
}

const REGISTERED_MAP = {
  'matrix:!room1:home.server': {
    name: 'Test Room',
    folder: 'matrix-room1',
    trigger: '@Andy',
    added_at: '2026-01-01T00:00:00.000Z',
  },
  'matrix:!group1:home.server': {
    name: 'Group Room',
    folder: 'matrix-group1',
    trigger: '@Andy',
    added_at: '2026-01-01T00:00:00.000Z',
  },
};

/** Build a MatrixChannel pre-wired with the fake client factory. */
function buildIntegrationChannel(
  clientFactory: (opts: {
    baseUrl: string;
    userId: string;
    accessToken: string;
  }) => any,
) {
  const sdk = makeSdk(VALID_ENV);
  const opts = makeOpts(REGISTERED_MAP);
  const cfg = parseConfig(sdk);
  const ch = new MatrixChannel(cfg!, opts, sdk);
  ch._makeClient = vi
    .fn()
    .mockImplementation(
      async (o: { baseUrl: string; userId: string; accessToken: string }) =>
        clientFactory(o),
    );
  return { ch, sdk, opts };
}

/** Helper to build a fake Matrix event */
function makeEvent(overrides: Record<string, any> = {}) {
  return {
    getType: vi.fn().mockReturnValue('m.room.message'),
    getContent: vi
      .fn()
      .mockReturnValue({ msgtype: 'm.text', body: 'hello integration' }),
    getId: vi.fn().mockReturnValue('$ev1:server'),
    getSender: vi.fn().mockReturnValue('@alice:home.server'),
    ...overrides,
  };
}

function makeRoom(roomId: string, name?: string) {
  return { roomId, name: name || roomId };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('matrix-adapter: integration (fake client)', () => {
  it('connect → sync PREPARED → Room.timeline → _handleTimelineEvent → onMessage (full wiring)', async () => {
    const syncHandlers: ((state: string) => void)[] = [];
    const timelineHandlers: ((event: any, room: any) => void)[] = [];
    const sendTextSpy = vi.fn().mockResolvedValue({});

    const fakeClient = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'sync') syncHandlers.push(handler);
        if (event === 'Room.timeline') timelineHandlers.push(handler);
      }),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
      sendTextMessage: sendTextSpy,
    };

    const { ch, opts } = buildIntegrationChannel(() => fakeClient);

    // Connect wires up the handlers
    await ch.connect();
    expect(ch.isConnected()).toBe(true);
    expect(syncHandlers.length).toBeGreaterThan(0);
    expect(timelineHandlers.length).toBeGreaterThan(0);

    // Before PREPARED: events must be dropped
    const ev = makeEvent({
      getId: vi.fn().mockReturnValue('$pre-prepared:server'),
    });
    timelineHandlers[0]!(ev, makeRoom('!room1:home.server', 'Test Room'));
    expect(opts.onMessage).not.toHaveBeenCalled();

    // Fire PREPARED
    syncHandlers[0]!('PREPARED');
    expect(ch.syncReady).toBe(true);

    // After PREPARED: event should be delivered
    const ev2 = makeEvent({
      getId: vi.fn().mockReturnValue('$post-prepared:server'),
    });
    timelineHandlers[0]!(ev2, makeRoom('!room1:home.server', 'Test Room'));

    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = opts.onMessage.mock.calls[0];
    expect(jid).toBe('matrix:!room1:home.server');
    expect(msg.content).toBe('hello integration');
    expect(msg.is_from_me).toBe(false);
    expect(msg.sender).toBe('@alice:home.server');

    // onChatMetadata must have fired BEFORE onMessage
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'matrix:!room1:home.server',
      expect.any(String),
      'Test Room',
      'matrix',
      true,
    );
  });

  it('sendMessage → chunks and calls client.sendTextMessage', async () => {
    const sendTextSpy = vi.fn().mockResolvedValue({});
    const fakeClient = {
      on: vi.fn(),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
      sendTextMessage: sendTextSpy,
    };

    const { ch } = buildIntegrationChannel(() => fakeClient);
    await ch.connect();

    // Send a 65000-char message — should produce 3 chunks (32000, 32000, 1000)
    const text = 'x'.repeat(65000);
    await ch.sendMessage('matrix:!room1:home.server', text);

    expect(sendTextSpy).toHaveBeenCalledTimes(3);
    expect(sendTextSpy.mock.calls[0][1].length).toBe(32000);
    expect(sendTextSpy.mock.calls[1][1].length).toBe(32000);
    expect(sendTextSpy.mock.calls[2][1].length).toBe(1000);
  });

  it('disconnect → connected=false and client.stopClient called, client nulled', async () => {
    const stopSpy = vi.fn();
    const fakeClient = {
      on: vi.fn(),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: stopSpy,
    };

    const { ch } = buildIntegrationChannel(() => fakeClient);
    await ch.connect();
    expect(ch.isConnected()).toBe(true);

    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
    expect(stopSpy).toHaveBeenCalled();
    expect(ch.client).toBeNull();
  });

  it('unregistered room does NOT trigger onMessage', async () => {
    const timelineHandlers: ((event: any, room: any) => void)[] = [];
    const syncHandlers: ((state: string) => void)[] = [];
    const fakeClient = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'sync') syncHandlers.push(handler);
        if (event === 'Room.timeline') timelineHandlers.push(handler);
      }),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
    };

    // Empty registered groups
    const sdk = makeSdk(VALID_ENV);
    const opts = makeOpts({}); // no registered rooms
    const cfg = parseConfig(sdk);
    const ch = new MatrixChannel(cfg!, opts, sdk);
    ch._makeClient = vi.fn().mockResolvedValue(fakeClient);

    await ch.connect();
    syncHandlers[0]!('PREPARED');

    timelineHandlers[0]!(
      makeEvent({ getId: vi.fn().mockReturnValue('$unknown-room:server') }),
      makeRoom('!unknown:home.server'),
    );

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('echo guard: own userId messages are ignored', async () => {
    const timelineHandlers: ((event: any, room: any) => void)[] = [];
    const syncHandlers: ((state: string) => void)[] = [];
    const fakeClient = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'sync') syncHandlers.push(handler);
        if (event === 'Room.timeline') timelineHandlers.push(handler);
      }),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
    };

    const { ch, opts } = buildIntegrationChannel(() => fakeClient);
    await ch.connect();
    syncHandlers[0]!('PREPARED');

    const selfEvent = makeEvent({
      getSender: vi.fn().mockReturnValue('@mybot:matrix.org'), // own userId
      getId: vi.fn().mockReturnValue('$self-msg:server'),
    });
    timelineHandlers[0]!(
      selfEvent,
      makeRoom('!room1:home.server', 'Test Room'),
    );

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('deduplication: same event id fires onMessage only once', async () => {
    const timelineHandlers: ((event: any, room: any) => void)[] = [];
    const syncHandlers: ((state: string) => void)[] = [];
    const fakeClient = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'sync') syncHandlers.push(handler);
        if (event === 'Room.timeline') timelineHandlers.push(handler);
      }),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
    };

    const { ch, opts } = buildIntegrationChannel(() => fakeClient);
    await ch.connect();
    syncHandlers[0]!('PREPARED');

    const dupEvent = makeEvent({
      getId: vi.fn().mockReturnValue('$dup:server'),
    });
    timelineHandlers[0]!(dupEvent, makeRoom('!room1:home.server', 'Test Room'));
    timelineHandlers[0]!(dupEvent, makeRoom('!room1:home.server', 'Test Room'));

    expect(opts.onMessage).toHaveBeenCalledTimes(1);
  });

  it('setTyping(true) calls client.sendTyping with timeout=20000', async () => {
    const sendTypingSpy = vi.fn().mockResolvedValue(undefined);
    const fakeClient = {
      on: vi.fn(),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
      sendTyping: sendTypingSpy,
    };

    const { ch } = buildIntegrationChannel(() => fakeClient);
    await ch.connect();

    await ch.setTyping('matrix:!room1:home.server', true);
    expect(sendTypingSpy).toHaveBeenCalledWith(
      '!room1:home.server',
      true,
      20000,
    );
  });

  it('setTyping(false) calls client.sendTyping with timeout=0 (stop typing)', async () => {
    const sendTypingSpy = vi.fn().mockResolvedValue(undefined);
    const fakeClient = {
      on: vi.fn(),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
      sendTyping: sendTypingSpy,
    };

    const { ch } = buildIntegrationChannel(() => fakeClient);
    await ch.connect();

    await ch.setTyping('matrix:!room1:home.server', false);
    expect(sendTypingSpy).toHaveBeenCalledWith('!room1:home.server', false, 0);
  });

  it('non-m.text event types in Room.timeline are silently ignored', async () => {
    const timelineHandlers: ((event: any, room: any) => void)[] = [];
    const syncHandlers: ((state: string) => void)[] = [];
    const fakeClient = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'sync') syncHandlers.push(handler);
        if (event === 'Room.timeline') timelineHandlers.push(handler);
      }),
      startClient: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
    };

    const { ch, opts } = buildIntegrationChannel(() => fakeClient);
    await ch.connect();
    syncHandlers[0]!('PREPARED');

    // m.image event
    const imageEvent = makeEvent({
      getType: vi.fn().mockReturnValue('m.room.message'),
      getContent: vi
        .fn()
        .mockReturnValue({ msgtype: 'm.image', url: 'mxc://...' }),
      getId: vi.fn().mockReturnValue('$image1:server'),
    });
    timelineHandlers[0]!(
      imageEvent,
      makeRoom('!room1:home.server', 'Test Room'),
    );

    // m.reaction event
    const reactionEvent = makeEvent({
      getType: vi.fn().mockReturnValue('m.reaction'),
      getId: vi.fn().mockReturnValue('$react1:server'),
    });
    timelineHandlers[0]!(
      reactionEvent,
      makeRoom('!room1:home.server', 'Test Room'),
    );

    expect(opts.onMessage).not.toHaveBeenCalled();
  });
});
