/**
 * Discord Channel End-to-End Tests
 *
 * Drives DiscordChannel through its full lifecycle against a REAL discord.js
 * Client instance. No live Discord gateway is required.
 *
 * Approach: real discord.js Client + event emitter injection
 * ────────────────────────────────────────────────────────────────────────────
 * The adapter's connect() creates a discord.js Client, registers a
 * 'messageCreate' listener via client.on(), and sets connected=true.
 * We inject _makeClient with a factory that returns a real discord.js Client
 * (via new Client(...)) but skips client.login() — which would require a live
 * gateway token.
 *
 * Inbound messages are delivered via client.emit('messageCreate', fakeMessage)
 * which invokes the real discord.js EventEmitter dispatch chain → the adapter's
 * registered handler → handleMessage() → opts.onMessage. This exercises the
 * real event wiring without a live network connection.
 *
 * Outbound (sendMessage) and setTyping are tested against an injected fake
 * channel resolver (client.channels.fetch mock) so the real REST layer is
 * not invoked, matching the behaviour you get in production where the real
 * Client is authenticated.
 *
 * NOTE: A live Discord gateway round-trip (login, receiving messages over the
 * Gateway WebSocket, REST API) requires a real bot token and is NOT CI-able.
 * The minikube-live bootstrap e2e (e2e/minikube-live-channel-discord-bootstrap.test.ts)
 * covers the full steady-state install path for operators who have a real bot token.
 *
 * What is real:
 *   - discord.js Client constructor (real npm package v14, lazy-loaded via _makeClient)
 *   - client.on() / client.emit() — real discord.js EventEmitter dispatch
 *   - adapter's handleMessage() / onMessage / onChatMetadata wiring
 *   - chunk() helper with Discord's 2000-char limit
 *
 * What is faked / skipped:
 *   - client.login() — skipped (requires real token + gateway)
 *   - client.channels.fetch() — injected fake resolving a mock channel
 *   - channel.send() / channel.sendTyping() — mock functions
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
  DiscordChannel,
  parseConfig,
} from '../helm/kubeclaw/files/channel-src/discord/channel-entry.js';

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
    readEnvFile: () => ({ DISCORD_BOT_TOKEN: 'Bot.E2E_TOKEN' }),
    assistantName: 'Andy',
    groupsDir: '/groups',
  };
}

// ── Fake channel for outbound send ────────────────────────────────────────────

function makeFakeDiscordChannel() {
  return {
    send: vi.fn().mockResolvedValue({}),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Discord Channel End-to-End', () => {
  const REGISTERED_CHANNEL_ID = '111222333444';
  const REGISTERED_JID = `discord:${REGISTERED_CHANNEL_ID}`;
  const GROUP_CHANNEL_ID = '555666777888';
  const GROUP_JID = `discord:${GROUP_CHANNEL_ID}`;

  let channel: InstanceType<typeof DiscordChannel> | null = null;
  // The real discord.js Client instance we inject
  let realClient: any = null;
  let fakeDiscordChannel: ReturnType<typeof makeFakeDiscordChannel>;
  let receivedMessages: { chatJid: string; message: NewMessage }[] = [];
  let receivedMetadata: {
    chatJid: string;
    timestamp: string;
    name: string;
    channelType: string;
    isGroup: boolean;
  }[] = [];

  beforeAll(async () => {
    fakeDiscordChannel = makeFakeDiscordChannel();
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
        [REGISTERED_JID]: {
          name: 'E2E Test Channel',
          folder: 'discord-e2e',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
        [GROUP_JID]: {
          name: 'E2E Test Guild Channel',
          folder: 'discord-e2e-guild',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      }),
    };

    channel = new DiscordChannel(cfg!, opts, sdk);

    // Inject _makeClient with a REAL discord.js Client that skips login().
    //
    // We create a real Client with the correct intents so that client.on() and
    // client.emit() exercise the real discord.js EventEmitter chain. We skip
    // client.login() since a live gateway connection requires a real bot token
    // and is not CI-able. The adapter registers its 'messageCreate' handler via
    // client.on() before connect() returns, so client.emit() drives the full
    // inbound path.
    channel._makeClient = async (_token: string) => {
      const { Client, GatewayIntentBits, Partials } =
        await import('discord.js');
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel],
      });

      // Inject fake channel resolver so sendMessage / setTyping work without REST.
      // NOTE: relies on discord.js v14 exposing `channels` as a writable property;
      // a future version could seal it, which would require an alternative approach.
      client.channels = {
        fetch: vi.fn().mockResolvedValue(fakeDiscordChannel),
      } as any;

      realClient = client;
      return client;
    };

    await channel.connect();
  }, 15000);

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
    realClient = null;
  }, 15000);

  beforeEach(() => {
    receivedMessages = [];
    receivedMetadata = [];
    fakeDiscordChannel.send.mockClear();
    fakeDiscordChannel.sendTyping.mockClear();
  });

  // ── Connection Lifecycle ───────────────────────────────────────────────────

  describe('Connection Lifecycle', () => {
    it('should connect successfully using real discord.js Client', () => {
      expect(channel!.isConnected()).toBe(true);
      expect(realClient).not.toBeNull();
    });

    it('should own discord: JIDs', () => {
      expect(channel!.ownsJid(REGISTERED_JID)).toBe(true);
      expect(channel!.ownsJid(GROUP_JID)).toBe(true);
      expect(channel!.ownsJid('telegram:123')).toBe(false);
      expect(channel!.ownsJid(undefined as any)).toBe(false);
    });
  });

  // ── Message Handling (Inbound) ─────────────────────────────────────────────
  //
  // Messages are injected via real client.emit('messageCreate', ...) which
  // dispatches through the real discord.js EventEmitter chain → the adapter's
  // registered handler → handleMessage() → opts.onMessage.

  describe('Message Handling (Inbound via real client.emit)', () => {
    it('should receive and route a message from a registered DM channel', () => {
      realClient!.emit('messageCreate', {
        channelId: REGISTERED_CHANNEL_ID,
        guild: null,
        author: { id: '999', username: 'testuser', bot: false },
        channel: { id: REGISTERED_CHANNEL_ID, name: 'DM' },
        content: 'Hello from e2e!',
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].chatJid).toBe(REGISTERED_JID);
      expect(receivedMessages[0].message.content).toBe('Hello from e2e!');
      expect(receivedMessages[0].message.is_from_me).toBe(false);
      expect(receivedMessages[0].message.sender).toBe('999');
    });

    it('should emit onChatMetadata before onMessage', () => {
      // Drive handleMessage directly for ordering test
      const sdk2 = makeSdk();
      const cfg2 = parseConfig(sdk2);
      const callOrder: string[] = [];
      const opts2 = {
        onMessage: vi.fn(() => callOrder.push('message')),
        onChatMetadata: vi.fn(() => callOrder.push('metadata')),
        registeredGroups: () => ({
          [REGISTERED_JID]: {
            name: 'Test',
            folder: 'test',
            trigger: '@Andy',
            added_at: '',
          },
        }),
      };
      const ch2 = new DiscordChannel(cfg2!, opts2, sdk2);
      ch2.handleMessage({
        channelId: REGISTERED_CHANNEL_ID,
        guild: null,
        author: { id: '1', username: 'u', bot: false },
        channel: { id: REGISTERED_CHANNEL_ID },
        content: 'order test',
      });
      expect(callOrder).toEqual(['metadata', 'message']);
    });

    it('should ignore messages from unregistered channels', () => {
      realClient!.emit('messageCreate', {
        channelId: '99999999',
        guild: null,
        author: { id: '1', username: 'Stranger', bot: false },
        channel: { id: '99999999' },
        content: 'from stranger',
      });
      expect(receivedMessages).toHaveLength(0);
    });

    it('should ignore bot messages (echo guard)', () => {
      realClient!.emit('messageCreate', {
        channelId: REGISTERED_CHANNEL_ID,
        guild: null,
        author: { id: '888', username: 'spambot', bot: true },
        channel: { id: REGISTERED_CHANNEL_ID },
        content: 'spam',
      });
      expect(receivedMessages).toHaveLength(0);
    });

    it('should rewrite bare @Andy group mention to trigger prefix', () => {
      realClient!.emit('messageCreate', {
        channelId: GROUP_CHANNEL_ID,
        guild: { id: '123', name: 'E2E Guild' },
        author: { id: '777', username: 'bob', bot: false },
        channel: { id: GROUP_CHANNEL_ID, name: 'general' },
        content: 'hey @Andy what time is it?',
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].message.content).toBe(
        '@Andy hey @Andy what time is it?',
      );
    });

    it('should NOT rewrite when message already starts with @Andy', () => {
      realClient!.emit('messageCreate', {
        channelId: GROUP_CHANNEL_ID,
        guild: { id: '123', name: 'E2E Guild' },
        author: { id: '777', username: 'bob', bot: false },
        channel: { id: GROUP_CHANNEL_ID, name: 'general' },
        content: '@Andy help me please',
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].message.content).toBe('@Andy help me please');
    });

    it('should deliver a group message without @Andy mention unchanged', () => {
      realClient!.emit('messageCreate', {
        channelId: GROUP_CHANNEL_ID,
        guild: { id: '123', name: 'E2E Guild' },
        author: { id: '777', username: 'bob', bot: false },
        channel: { id: GROUP_CHANNEL_ID, name: 'general' },
        content: 'hello there',
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].chatJid).toBe(GROUP_JID);
      expect(receivedMessages[0].message.content).toBe('hello there');
    });

    it('should set isGroup=false for DM messages and isGroup=true for guild messages', () => {
      // DM
      realClient!.emit('messageCreate', {
        channelId: REGISTERED_CHANNEL_ID,
        guild: null,
        author: { id: '111', username: 'alice', bot: false },
        channel: { id: REGISTERED_CHANNEL_ID },
        content: 'DM message',
      });
      expect(receivedMetadata[0]?.isGroup).toBe(false);

      receivedMetadata = [];

      // Guild
      realClient!.emit('messageCreate', {
        channelId: GROUP_CHANNEL_ID,
        guild: { id: '222', name: 'Guild' },
        author: { id: '222', username: 'alice', bot: false },
        channel: { id: GROUP_CHANNEL_ID, name: 'general' },
        content: 'guild message',
      });
      expect(receivedMetadata[0]?.isGroup).toBe(true);
    });
  });

  // ── Message Sending (Outbound) ─────────────────────────────────────────────

  describe('Message Sending (Outbound via injected fake channel)', () => {
    it('should send a message to a registered channel', async () => {
      await channel!.sendMessage(REGISTERED_JID, 'Hello from KubeClaw!');
      expect(fakeDiscordChannel.send).toHaveBeenCalledTimes(1);
      expect(fakeDiscordChannel.send).toHaveBeenCalledWith(
        'Hello from KubeClaw!',
      );
    });

    it('should chunk long messages at 2000 chars', async () => {
      const longText = 'x'.repeat(5000);
      await channel!.sendMessage(REGISTERED_JID, longText);
      expect(fakeDiscordChannel.send).toHaveBeenCalledTimes(3);
      expect(fakeDiscordChannel.send.mock.calls[0][0].length).toBe(2000);
      expect(fakeDiscordChannel.send.mock.calls[1][0].length).toBe(2000);
      expect(fakeDiscordChannel.send.mock.calls[2][0].length).toBe(1000);
    });

    it('should not send to non-discord JIDs', async () => {
      await channel!.sendMessage('telegram:123', 'nope');
      expect(fakeDiscordChannel.send).not.toHaveBeenCalled();
    });
  });

  // ── setTyping ──────────────────────────────────────────────────────────────

  describe('setTyping', () => {
    it('should call channel.sendTyping when isTyping=true', async () => {
      await channel!.setTyping(REGISTERED_JID, true);
      expect(fakeDiscordChannel.sendTyping).toHaveBeenCalled();
    });

    it('should NOT call sendTyping when isTyping=false', async () => {
      await channel!.setTyping(REGISTERED_JID, false);
      expect(fakeDiscordChannel.sendTyping).not.toHaveBeenCalled();
    });
  });

  // ── Full Round-trip ────────────────────────────────────────────────────────

  describe('Full Roundtrip (real EventEmitter → fake send)', () => {
    it('should complete a full message roundtrip: emit → onMessage → sendMessage → fake channel', async () => {
      // 1. Receive an inbound message via real discord.js EventEmitter
      realClient!.emit('messageCreate', {
        channelId: REGISTERED_CHANNEL_ID,
        guild: null,
        author: { id: '555', username: 'alice', bot: false },
        channel: { id: REGISTERED_CHANNEL_ID },
        content: '@Andy hello there!',
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].message.content).toBe('@Andy hello there!');

      // 2. Send a reply — goes through fake channel.send
      const responseText = 'Hello Alice! How can I help you?';
      await channel!.sendMessage(REGISTERED_JID, responseText);

      expect(fakeDiscordChannel.send).toHaveBeenCalledTimes(1);
      expect(fakeDiscordChannel.send).toHaveBeenCalledWith(responseText);
    });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────

  describe('Disconnect', () => {
    it('should disconnect cleanly in a separate channel instance', async () => {
      const sdk2 = makeSdk();
      const cfg2 = parseConfig(sdk2);
      const ch2 = new DiscordChannel(
        cfg2!,
        {
          onMessage: vi.fn(),
          onChatMetadata: vi.fn(),
          registeredGroups: () => ({}),
        },
        sdk2,
      );

      let client2: any = null;
      ch2._makeClient = async (_token: string) => {
        const { Client, GatewayIntentBits, Partials } =
          await import('discord.js');
        const c = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
          ],
          partials: [Partials.Channel],
        });
        client2 = c;
        return c;
      };

      await ch2.connect();
      expect(ch2.isConnected()).toBe(true);

      await ch2.disconnect();
      expect(ch2.isConnected()).toBe(false);
    }, 10000);
  });
});
