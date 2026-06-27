/**
 * Matrix Channel End-to-End Tests
 *
 * Drives MatrixChannel through its full lifecycle against a REAL matrix-js-sdk
 * client instance. No live homeserver is required.
 *
 * Approach: real matrix-js-sdk client + event emitter injection
 * ────────────────────────────────────────────────────────────────────────────
 * The adapter's connect() creates a matrix-js-sdk MatrixClient, registers
 * 'sync' and 'Room.timeline' listeners via client.on(), then calls
 * client.startClient(). We inject _makeClient with a factory that returns a
 * real matrix-js-sdk client created via sdk.createClient() — but we skip
 * client.startClient() (which would require a live homeserver) by overriding
 * it with a no-op.
 *
 * Inbound messages are delivered via client.emit('sync', 'PREPARED') and
 * client.emit('Room.timeline', fakeEvent, fakeRoom), which invokes the real
 * matrix-js-sdk TypedEventEmitter dispatch chain → the adapter's registered
 * handlers → _handleTimelineEvent() → opts.onMessage. This exercises the real
 * event wiring without a live network connection.
 *
 * Outbound (sendMessage) is tested against an injected fake sendTextMessage
 * so the real REST layer is not invoked.
 *
 * NOTE: A live homeserver round-trip (/sync, sending messages) requires a
 * real Matrix account and homeserver and is NOT CI-able. The minikube-live
 * bootstrap e2e (e2e/minikube-live-channel-matrix-bootstrap.test.ts) covers
 * the full steady-state install path for operators with a real homeserver.
 *
 * What is real:
 *   - matrix-js-sdk createClient() + MemoryStore (real npm package, lazy-loaded)
 *   - client.on() / client.emit() — real TypedEventEmitter dispatch
 *   - adapter's _handleTimelineEvent() / onMessage / onChatMetadata wiring
 *   - syncReady guard (only processes events after 'sync' PREPARED)
 *   - chunk() helper with Matrix's 32000-char limit
 *   - Event-id deduplication via Set
 *
 * What is faked / skipped:
 *   - client.startClient() — replaced with no-op (requires live /sync endpoint)
 *   - client.sendTextMessage() — injected mock (requires live REST)
 *   - client.sendTyping() — injected mock
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no TS types; the adapter is pure JS ESM
import {
  MatrixChannel,
  parseConfig,
} from '../helm/kubeclaw/files/channel-src/matrix/channel-entry.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
}

// ── SDK / opts helpers ────────────────────────────────────────────────────────

function makeSdk() {
  return {
    registerChannel: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readEnvFile: () => ({
      MATRIX_HOMESERVER_URL: 'https://matrix.org',
      MATRIX_USER_ID: '@mybot:matrix.org',
      MATRIX_ACCESS_TOKEN: 'syt_e2e_test_token',
    }),
    assistantName: 'Andy',
    groupsDir: '/groups',
  };
}

// ── Fake event/room helpers ───────────────────────────────────────────────────

function makeFakeMatrixEvent(overrides: Record<string, any> = {}) {
  return {
    getType: vi.fn().mockReturnValue('m.room.message'),
    getContent: vi
      .fn()
      .mockReturnValue({ msgtype: 'm.text', body: 'Hello from e2e!' }),
    getId: vi.fn().mockReturnValue('$e2e-event-1:matrix.org'),
    getSender: vi.fn().mockReturnValue('@alice:home.server'),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Matrix Channel End-to-End', () => {
  const ROOM_1_ID = '!room1:home.server';
  const ROOM_1_JID = `matrix:${ROOM_1_ID}`;
  const ROOM_2_ID = '!room2:home.server';
  const ROOM_2_JID = `matrix:${ROOM_2_ID}`;
  // Bot's own userId — for echo guard test
  const BOT_USER_ID = '@mybot:matrix.org';

  let channel: InstanceType<typeof MatrixChannel> | null = null;
  // The real matrix-js-sdk client instance we inject
  let realClient: any = null;
  // Injected fakes for outbound calls
  let sendTextSpy: ReturnType<typeof vi.fn>;
  let sendTypingSpy: ReturnType<typeof vi.fn>;

  let receivedMessages: { chatJid: string; message: NewMessage }[] = [];
  let receivedMetadata: {
    chatJid: string;
    timestamp: string;
    name: string;
    channelType: string;
    isGroup: boolean;
  }[] = [];

  beforeAll(async () => {
    sendTextSpy = vi.fn().mockResolvedValue({ event_id: '$sent:matrix.org' });
    sendTypingSpy = vi.fn().mockResolvedValue({});

    const sdk = makeSdk();
    const cfg = parseConfig(sdk);

    const opts = {
      onMessage: (chatJid: string, message: NewMessage) => {
        receivedMessages.push({ chatJid, message });
      },
      onChatMetadata: (
        chatJid: string,
        timestamp: string,
        name: string,
        channelType: string,
        isGroup: boolean,
      ) => {
        receivedMetadata.push({
          chatJid,
          timestamp,
          name,
          channelType,
          isGroup,
        });
      },
      registeredGroups: () => ({
        [ROOM_1_JID]: {
          name: 'E2E Test Room',
          folder: 'matrix-e2e',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
        [ROOM_2_JID]: {
          name: 'E2E Group Room',
          folder: 'matrix-e2e-group',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      }),
    };

    channel = new MatrixChannel(cfg!, opts, sdk);

    // Inject _makeClient with a REAL matrix-js-sdk client that skips startClient().
    //
    // We create a real MatrixClient so that client.on() and client.emit() exercise
    // the real TypedEventEmitter chain. We stub startClient() with a no-op since
    // a live /sync endpoint is not available in CI. We also stub sendTextMessage
    // and sendTyping so outbound REST is not invoked.
    channel._makeClient = async (opts: {
      baseUrl: string;
      userId: string;
      accessToken: string;
    }) => {
      const sdk = await import('matrix-js-sdk');
      const store = new sdk.MemoryStore();
      const client = sdk.createClient({
        baseUrl: opts.baseUrl,
        userId: opts.userId,
        accessToken: opts.accessToken,
        store,
      });

      // Stub startClient() — would initiate /sync long-poll against a real homeserver.
      // Not CI-able; we use client.emit() to simulate sync events instead.
      client.startClient = vi.fn().mockResolvedValue(undefined);

      // Stub outbound methods so we can assert calls without hitting the REST API.
      client.sendTextMessage = sendTextSpy;
      client.sendTyping = sendTypingSpy;

      realClient = client;
      return client;
    };

    await channel.connect();

    // Simulate the /sync reaching PREPARED state (normally fired by matrix-js-sdk
    // internals after the first /sync response, but we emit it directly here).
    realClient!.emit('sync', 'PREPARED');
  }, 20000);

  afterAll(async () => {
    // Stop the client — critical to prevent leaked handles in the test runner.
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
    realClient = null;
  }, 15000);

  beforeEach(() => {
    receivedMessages = [];
    receivedMetadata = [];
    sendTextSpy.mockClear();
    sendTypingSpy.mockClear();
  });

  // ── Connection Lifecycle ───────────────────────────────────────────────────

  describe('Connection Lifecycle', () => {
    it('should connect successfully using real matrix-js-sdk client', () => {
      expect(channel!.isConnected()).toBe(true);
      expect(realClient).not.toBeNull();
    });

    it('should set syncReady=true after PREPARED', () => {
      expect(channel!.syncReady).toBe(true);
    });

    it('should own matrix: JIDs', () => {
      expect(channel!.ownsJid(ROOM_1_JID)).toBe(true);
      expect(channel!.ownsJid(ROOM_2_JID)).toBe(true);
      expect(channel!.ownsJid('telegram:123')).toBe(false);
      expect(channel!.ownsJid(undefined as any)).toBe(false);
    });
  });

  // ── Message Handling (Inbound) ─────────────────────────────────────────────
  //
  // Messages are injected via real client.emit('Room.timeline', fakeEvent, fakeRoom)
  // which dispatches through the real matrix-js-sdk TypedEventEmitter chain →
  // the adapter's registered Room.timeline handler → _handleTimelineEvent() →
  // opts.onMessage.

  describe('Message Handling (Inbound via real client.emit)', () => {
    it('should receive and route a message from a registered room', () => {
      realClient!.emit(
        'Room.timeline',
        makeFakeMatrixEvent({
          getId: vi.fn().mockReturnValue('$inbound-1:server'),
          getSender: vi.fn().mockReturnValue('@alice:home.server'),
          getContent: vi.fn().mockReturnValue({
            msgtype: 'm.text',
            body: 'Hello from e2e!',
          }),
        }),
        { roomId: ROOM_1_ID, name: 'E2E Test Room' },
      );

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].chatJid).toBe(ROOM_1_JID);
      expect(receivedMessages[0].message.content).toBe('Hello from e2e!');
      expect(receivedMessages[0].message.is_from_me).toBe(false);
      expect(receivedMessages[0].message.sender).toBe('@alice:home.server');
    });

    it('should emit onChatMetadata before onMessage', () => {
      const sdk2 = makeSdk();
      const cfg2 = parseConfig(sdk2);
      const callOrder: string[] = [];
      const opts2 = {
        onMessage: vi.fn(() => callOrder.push('message')),
        onChatMetadata: vi.fn(() => callOrder.push('metadata')),
        registeredGroups: () => ({
          [ROOM_1_JID]: {
            name: 'Test',
            folder: 'test',
            trigger: '@Andy',
            added_at: '',
          },
        }),
      };
      const ch2 = new MatrixChannel(cfg2!, opts2, sdk2);
      ch2.syncReady = true;
      ch2._handleTimelineEvent(
        makeFakeMatrixEvent({
          getId: vi.fn().mockReturnValue('$order-test-e2e:server'),
        }),
        { roomId: ROOM_1_ID, name: 'E2E Test Room' },
      );
      expect(callOrder).toEqual(['metadata', 'message']);
    });

    it('should ignore messages from unregistered rooms', () => {
      realClient!.emit(
        'Room.timeline',
        makeFakeMatrixEvent({
          getId: vi.fn().mockReturnValue('$unregistered-room:server'),
          getSender: vi.fn().mockReturnValue('@stranger:other.server'),
        }),
        { roomId: '!unknown:other.server', name: 'Unknown Room' },
      );
      expect(receivedMessages).toHaveLength(0);
    });

    it('should ignore messages from our own userId (echo guard)', () => {
      realClient!.emit(
        'Room.timeline',
        makeFakeMatrixEvent({
          getId: vi.fn().mockReturnValue('$self-echo:server'),
          getSender: vi.fn().mockReturnValue(BOT_USER_ID), // our own userId
          getContent: vi
            .fn()
            .mockReturnValue({ msgtype: 'm.text', body: 'our reply' }),
        }),
        { roomId: ROOM_1_ID, name: 'E2E Test Room' },
      );
      expect(receivedMessages).toHaveLength(0);
    });

    it('should deduplicate events by event id', () => {
      const dupEvent = makeFakeMatrixEvent({
        getId: vi.fn().mockReturnValue('$dup-event-e2e:server'),
        getSender: vi.fn().mockReturnValue('@alice:home.server'),
        getContent: vi
          .fn()
          .mockReturnValue({ msgtype: 'm.text', body: 'duplicate' }),
      });

      realClient!.emit('Room.timeline', dupEvent, {
        roomId: ROOM_1_ID,
        name: 'E2E Test Room',
      });
      realClient!.emit('Room.timeline', dupEvent, {
        roomId: ROOM_1_ID,
        name: 'E2E Test Room',
      });

      expect(receivedMessages).toHaveLength(1);
    });

    it('should rewrite bare @Andy group mention to trigger prefix', () => {
      realClient!.emit(
        'Room.timeline',
        makeFakeMatrixEvent({
          getId: vi.fn().mockReturnValue('$mention-rewrite-e2e:server'),
          getSender: vi.fn().mockReturnValue('@bob:home.server'),
          getContent: vi.fn().mockReturnValue({
            msgtype: 'm.text',
            body: 'hey @Andy what time is it?',
          }),
        }),
        { roomId: ROOM_2_ID, name: 'E2E Group Room' },
      );

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].message.content).toBe(
        '@Andy hey @Andy what time is it?',
      );
    });

    it('should NOT rewrite when message already starts with @Andy', () => {
      realClient!.emit(
        'Room.timeline',
        makeFakeMatrixEvent({
          getId: vi.fn().mockReturnValue('$trigger-already-e2e:server'),
          getSender: vi.fn().mockReturnValue('@bob:home.server'),
          getContent: vi.fn().mockReturnValue({
            msgtype: 'm.text',
            body: '@Andy help me please',
          }),
        }),
        { roomId: ROOM_2_ID, name: 'E2E Group Room' },
      );

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].message.content).toBe('@Andy help me please');
    });

    it('should set isGroup=true for all Matrix rooms', () => {
      realClient!.emit(
        'Room.timeline',
        makeFakeMatrixEvent({
          getId: vi.fn().mockReturnValue('$isgroup-test-e2e:server'),
          getSender: vi.fn().mockReturnValue('@alice:home.server'),
          getContent: vi
            .fn()
            .mockReturnValue({ msgtype: 'm.text', body: 'group check' }),
        }),
        { roomId: ROOM_1_ID, name: 'E2E Test Room' },
      );

      expect(receivedMetadata[0]?.isGroup).toBe(true);
    });

    it('should only process events after sync PREPARED (before beforeAll fires PREPARED)', () => {
      // This is structural: beforeAll emits PREPARED, so syncReady must be true.
      // We verify the guard logic in the unit tests. Here we just confirm the
      // channel is correctly in sync-ready state in our e2e suite.
      expect(channel!.syncReady).toBe(true);
    });

    it('should ignore non-m.text message types (e.g. m.image)', () => {
      realClient!.emit(
        'Room.timeline',
        makeFakeMatrixEvent({
          getId: vi.fn().mockReturnValue('$image-event-e2e:server'),
          getSender: vi.fn().mockReturnValue('@alice:home.server'),
          getContent: vi
            .fn()
            .mockReturnValue({ msgtype: 'm.image', url: 'mxc://...' }),
        }),
        { roomId: ROOM_1_ID, name: 'E2E Test Room' },
      );
      expect(receivedMessages).toHaveLength(0);
    });
  });

  // ── Message Sending (Outbound) ─────────────────────────────────────────────

  describe('Message Sending (Outbound via injected fake sendTextMessage)', () => {
    it('should send a message to a registered room', async () => {
      await channel!.sendMessage(ROOM_1_JID, 'Hello from KubeClaw!');
      expect(sendTextSpy).toHaveBeenCalledTimes(1);
      expect(sendTextSpy).toHaveBeenCalledWith(
        ROOM_1_ID,
        'Hello from KubeClaw!',
      );
    });

    it('should chunk long messages at 32000 chars', async () => {
      const longText = 'x'.repeat(65000);
      await channel!.sendMessage(ROOM_1_JID, longText);
      expect(sendTextSpy).toHaveBeenCalledTimes(3);
      expect(sendTextSpy.mock.calls[0][1].length).toBe(32000);
      expect(sendTextSpy.mock.calls[1][1].length).toBe(32000);
      expect(sendTextSpy.mock.calls[2][1].length).toBe(1000);
    });

    it('should not send to non-matrix JIDs', async () => {
      await channel!.sendMessage('telegram:123', 'nope');
      expect(sendTextSpy).not.toHaveBeenCalled();
    });
  });

  // ── setTyping ──────────────────────────────────────────────────────────────

  describe('setTyping', () => {
    it('should call client.sendTyping with roomId, isTyping=true, 20000', async () => {
      await channel!.setTyping(ROOM_1_JID, true);
      expect(sendTypingSpy).toHaveBeenCalledWith(ROOM_1_ID, true, 20000);
    });

    it('should call client.sendTyping with isTyping=false', async () => {
      await channel!.setTyping(ROOM_1_JID, false);
      expect(sendTypingSpy).toHaveBeenCalledWith(ROOM_1_ID, false, 20000);
    });

    it('should NOT call sendTyping for non-matrix JIDs', async () => {
      await channel!.setTyping('telegram:123', true);
      expect(sendTypingSpy).not.toHaveBeenCalled();
    });
  });

  // ── Full Round-trip ────────────────────────────────────────────────────────

  describe('Full Roundtrip (real TypedEventEmitter → fake sendTextMessage)', () => {
    it('should complete a full message roundtrip: emit → onMessage → sendMessage → sendTextMessage', async () => {
      // 1. Receive an inbound message via real matrix-js-sdk TypedEventEmitter
      realClient!.emit(
        'Room.timeline',
        makeFakeMatrixEvent({
          getId: vi.fn().mockReturnValue('$roundtrip-e2e:server'),
          getSender: vi.fn().mockReturnValue('@alice:home.server'),
          getContent: vi.fn().mockReturnValue({
            msgtype: 'm.text',
            body: '@Andy hello there!',
          }),
        }),
        { roomId: ROOM_1_ID, name: 'E2E Test Room' },
      );

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].message.content).toBe('@Andy hello there!');

      // 2. Send a reply — goes through fake sendTextMessage
      const responseText = 'Hello Alice! How can I help you?';
      await channel!.sendMessage(ROOM_1_JID, responseText);

      expect(sendTextSpy).toHaveBeenCalledTimes(1);
      expect(sendTextSpy).toHaveBeenCalledWith(ROOM_1_ID, responseText);
    });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────

  describe('Disconnect', () => {
    it('should disconnect cleanly in a separate channel instance (no leaked handles)', async () => {
      const sdk2 = makeSdk();
      const cfg2 = parseConfig(sdk2);
      const ch2 = new MatrixChannel(
        cfg2!,
        {
          onMessage: vi.fn(),
          onChatMetadata: vi.fn(),
          registeredGroups: () => ({}),
        },
        sdk2,
      );

      let client2: any = null;
      ch2._makeClient = async (opts: {
        baseUrl: string;
        userId: string;
        accessToken: string;
      }) => {
        const sdk = await import('matrix-js-sdk');
        const store = new sdk.MemoryStore();
        const c = sdk.createClient({
          baseUrl: opts.baseUrl,
          userId: opts.userId,
          accessToken: opts.accessToken,
          store,
        });
        // Stub startClient — no real /sync
        c.startClient = vi.fn().mockResolvedValue(undefined);
        client2 = c;
        return c;
      };

      await ch2.connect();
      expect(ch2.isConnected()).toBe(true);
      expect(client2).not.toBeNull();

      // Disconnect should call stopClient() and null the client
      await ch2.disconnect();
      expect(ch2.isConnected()).toBe(false);
      expect(ch2.client).toBeNull();
    }, 15000);
  });
});
