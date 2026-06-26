/**
 * Telegram Channel End-to-End Tests
 *
 * Drives TelegramChannel through its full lifecycle: connect → receive → route
 * → sendMessage → disconnect. A fake Telegram Bot API is injected via
 * ch._makeBot (the same injectable factory used in unit/integration tests)
 * because telegraf is not installed as a dev dependency — the adapter lazy-loads
 * it only in the channel-runner pod's runtime PVC after `npm ci`.
 *
 * Note: A live Telegram round-trip (real botToken → real Bot API) requires a
 * Telegram bot token and cannot run in CI without credentials. The
 * minikube-live bootstrap e2e (minikube-live-channel-telegram-bootstrap.test.ts)
 * covers the full steady-state install path in an 8 GiB cluster.
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
  TelegramChannel,
  parseConfig,
} from '../helm/kubeclaw/files/channel-src/telegram/channel-entry.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
}

function makeSdk() {
  return {
    registerChannel: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readEnvFile: () => ({ TELEGRAM_BOT_TOKEN: 'tok:E2E' }),
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

// ── Fake bot factory ──────────────────────────────────────────────────────────

interface FakeBotState {
  messageHandler: ((ctx: any) => void) | null;
  sentMessages: Array<{ chatId: string; text: string }>;
  launched: boolean;
  stopped: boolean;
}

function createFakeBot(state: FakeBotState) {
  return {
    on: vi.fn((event: string, handler: (ctx: any) => void) => {
      if (event === 'message') state.messageHandler = handler;
    }),
    launch: vi.fn(async () => {
      state.launched = true;
    }),
    stop: vi.fn(() => {
      state.stopped = true;
    }),
    telegram: {
      sendMessage: vi.fn(async (chatId: string, text: string) => {
        state.sentMessages.push({ chatId, text });
        return {};
      }),
      sendChatAction: vi.fn().mockResolvedValue({}),
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Telegram Channel End-to-End', () => {
  const REGISTERED_CHAT_ID = 12345;
  const REGISTERED_JID = `telegram:${REGISTERED_CHAT_ID}`;
  const GROUP_CHAT_ID = -1001234567890;
  const GROUP_JID = `telegram:${GROUP_CHAT_ID}`;

  let channel: InstanceType<typeof TelegramChannel> | null = null;
  let botState: FakeBotState;
  let receivedMessages: { chatJid: string; message: NewMessage }[] = [];
  let receivedMetadata: {
    chatJid: string;
    timestamp: string;
    name: string;
    channelType: string;
    isGroup: boolean;
  }[] = [];

  function createTestOpts() {
    return makeOpts({
      [REGISTERED_JID]: {
        name: 'E2E Test Chat',
        folder: 'tg-e2e',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      [GROUP_JID]: {
        name: 'E2E Test Group',
        folder: 'tg-e2e-group',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
    });
  }

  beforeAll(async () => {
    botState = {
      messageHandler: null,
      sentMessages: [],
      launched: false,
      stopped: false,
    };

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
        receivedMetadata.push({ chatJid, timestamp, name, channelType, isGroup });
      },
      registeredGroups: () => ({
        [REGISTERED_JID]: {
          name: 'E2E Test Chat',
          folder: 'tg-e2e',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
        [GROUP_JID]: {
          name: 'E2E Test Group',
          folder: 'tg-e2e-group',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      }),
    };

    channel = new TelegramChannel(cfg!, opts, sdk);
    channel._makeBot = vi.fn().mockResolvedValue(createFakeBot(botState));
    await channel.connect();
  }, 10000);

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  }, 10000);

  beforeEach(() => {
    receivedMessages = [];
    receivedMetadata = [];
    botState.sentMessages = [];
  });

  describe('Connection Lifecycle', () => {
    it('should connect successfully', () => {
      expect(channel!.isConnected()).toBe(true);
      expect(botState.launched).toBe(true);
    });

    it('should own telegram: JIDs', () => {
      expect(channel!.ownsJid(REGISTERED_JID)).toBe(true);
      expect(channel!.ownsJid(GROUP_JID)).toBe(true);
      expect(channel!.ownsJid('signal:+61400000000')).toBe(false);
      expect(channel!.ownsJid(undefined as any)).toBe(false);
    });
  });

  describe('Message Handling (Inbound)', () => {
    it('should receive and route a message from a registered private chat', () => {
      expect(botState.messageHandler).not.toBeNull();

      botState.messageHandler!({
        chat: { id: REGISTERED_CHAT_ID, type: 'private' },
        from: { id: 999, username: 'testuser', is_bot: false },
        message: { text: 'Hello from e2e!' },
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].chatJid).toBe(REGISTERED_JID);
      expect(receivedMessages[0].message.content).toBe('Hello from e2e!');
      expect(receivedMessages[0].message.is_from_me).toBe(false);
      expect(receivedMessages[0].message.sender).toBe('999');
    });

    it('should emit onChatMetadata before onMessage', () => {
      const callOrder: string[] = [];
      const sdk2 = makeSdk();
      const cfg2 = parseConfig(sdk2);
      const opts2 = {
        onMessage: vi.fn(() => callOrder.push('message')),
        onChatMetadata: vi.fn(() => callOrder.push('metadata')),
        registeredGroups: () => ({
          [REGISTERED_JID]: { name: 'Test', folder: 'test', trigger: '@Andy', added_at: '' },
        }),
      };
      const botState2: FakeBotState = { messageHandler: null, sentMessages: [], launched: false, stopped: false };
      const ch2 = new TelegramChannel(cfg2!, opts2, sdk2);
      ch2._makeBot = vi.fn().mockResolvedValue(createFakeBot(botState2));

      // Synchronously handle without awaiting connect (we test the order logic directly)
      ch2.handleCtx({
        chat: { id: REGISTERED_CHAT_ID, type: 'private' },
        from: { id: 1, username: 'u', is_bot: false },
        message: { text: 'order test' },
      });
      expect(callOrder).toEqual(['metadata', 'message']);
    });

    it('should ignore messages from unregistered chats', () => {
      botState.messageHandler!({
        chat: { id: 99999, type: 'private' },
        from: { id: 1, username: 'stranger', is_bot: false },
        message: { text: 'from stranger' },
      });
      expect(receivedMessages).toHaveLength(0);
    });

    it('should ignore bot messages (echo guard)', () => {
      botState.messageHandler!({
        chat: { id: REGISTERED_CHAT_ID, type: 'private' },
        from: { id: 888, username: 'spambot', is_bot: true },
        message: { text: 'spam' },
      });
      expect(receivedMessages).toHaveLength(0);
    });

    it('should rewrite bare @Andy group mention to trigger prefix', () => {
      botState.messageHandler!({
        chat: { id: GROUP_CHAT_ID, type: 'group', title: 'E2E Group' },
        from: { id: 777, username: 'bob', is_bot: false },
        message: { text: 'hey @Andy what time is it?' },
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].message.content).toBe('@Andy hey @Andy what time is it?');
    });

    it('should NOT rewrite when message already starts with @Andy', () => {
      botState.messageHandler!({
        chat: { id: GROUP_CHAT_ID, type: 'group', title: 'E2E Group' },
        from: { id: 777, username: 'bob', is_bot: false },
        message: { text: '@Andy help me please' },
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].message.content).toBe('@Andy help me please');
    });
  });

  describe('Message Sending (Outbound)', () => {
    it('should send a message to a registered chat', async () => {
      await channel!.sendMessage(REGISTERED_JID, 'Hello from KubeClaw!');

      expect(botState.sentMessages).toHaveLength(1);
      expect(botState.sentMessages[0].chatId).toBe(String(REGISTERED_CHAT_ID));
      expect(botState.sentMessages[0].text).toBe('Hello from KubeClaw!');
    });

    it('should chunk long messages at 4096 chars', async () => {
      const longText = 'x'.repeat(9000);
      await channel!.sendMessage(REGISTERED_JID, longText);

      expect(botState.sentMessages).toHaveLength(3);
      expect(botState.sentMessages[0].text.length).toBe(4096);
      expect(botState.sentMessages[1].text.length).toBe(4096);
      expect(botState.sentMessages[2].text.length).toBe(9000 - 4096 - 4096);
    });

    it('should not send to non-telegram JIDs', async () => {
      await channel!.sendMessage('signal:+61400000000', 'nope');
      expect(botState.sentMessages).toHaveLength(0);
    });
  });

  describe('Full Roundtrip', () => {
    it('should complete a full message roundtrip: inbound → receive → reply', async () => {
      // 1. Receive an inbound message
      botState.messageHandler!({
        chat: { id: REGISTERED_CHAT_ID, type: 'private' },
        from: { id: 555, username: 'alice', is_bot: false },
        message: { text: '@Andy hello there!' },
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].message.content).toBe('@Andy hello there!');

      // 2. Send a reply
      const responseText = 'Hello Alice! How can I help you?';
      await channel!.sendMessage(REGISTERED_JID, responseText);

      expect(botState.sentMessages).toHaveLength(1);
      expect(botState.sentMessages[0].text).toBe(responseText);
    });
  });

  describe('Disconnect', () => {
    it('should disconnect cleanly in a separate channel instance', async () => {
      const sdk2 = makeSdk();
      const cfg2 = parseConfig(sdk2);
      const bs2: FakeBotState = { messageHandler: null, sentMessages: [], launched: false, stopped: false };
      const ch2 = new TelegramChannel(cfg2!, makeOpts(), sdk2);
      ch2._makeBot = vi.fn().mockResolvedValue(createFakeBot(bs2));

      await ch2.connect();
      expect(ch2.isConnected()).toBe(true);

      await ch2.disconnect();
      expect(ch2.isConnected()).toBe(false);
      expect(bs2.stopped).toBe(true);
    });
  });
});
