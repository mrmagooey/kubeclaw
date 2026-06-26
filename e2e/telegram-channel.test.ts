/**
 * Telegram Channel End-to-End Tests
 *
 * Drives TelegramChannel through its full lifecycle against a REAL Telegraf
 * instance pointed at a local fake Bot API HTTP server. No real Telegram network
 * is required.
 *
 * Approach: `handleUpdate` + detached launch
 * ────────────────────────────────────────────────────────────────────────────
 * The adapter's `connect()` does `await this.bot.launch()`, and telegraf's
 * `launch()` awaits the long-poll loop forever (it only resolves when the loop
 * is stopped via `bot.stop()`). To make `connect()` return while keeping the
 * real Telegraf wiring intact we inject `_makeBot` with a real Telegraf whose
 * `launch()` is wrapped to fire-and-forget the real launch and return
 * immediately. The `bot.on('message', ...)` handler is registered by the
 * adapter before `launch()` is called, so the handler wiring is in place from
 * the first tick. We then drive inbound messages via the real `bot.handleUpdate()`
 * entrypoint, which runs them through real Telegraf middleware. Outbound calls
 * (`bot.telegram.sendMessage`) go to the fake HTTP server via the real
 * Telegraf HTTP client, so the real chunking + network path is exercised.
 *
 * What is real:
 *   - Telegraf constructor (real npm package, lazy-loaded inside connect())
 *   - bot.on() / bot.handleUpdate() — real Telegraf middleware dispatch
 *   - bot.telegram.sendMessage() — real Telegraf HTTP client → fake server
 *   - getMe / deleteWebhook / getUpdates — real HTTP hits to fake server
 *
 * What is faked:
 *   - The Bot API HTTP endpoint (a local node:http server)
 *   - launch() return timing (detached to avoid blocking connect())
 *
 * The minikube-live bootstrap e2e (minikube-live-channel-telegram-bootstrap.test.ts)
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
import * as http from 'node:http';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no TS types; the adapter is pure JS ESM
import {
  TelegramChannel,
  parseConfig,
} from '../helm/kubeclaw/files/channel-src/telegram/channel-entry.js';

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

// ── Fake Bot API HTTP server ──────────────────────────────────────────────────

interface FakeServerState {
  sentMessages: Array<{ chat_id: string; text: string }>;
}

function startFakeBotApiServer(token: string): Promise<{
  server: http.Server;
  port: number;
  state: FakeServerState;
}> {
  const state: FakeServerState = { sentMessages: [] };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';

    // Collect request body
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};

      // Route based on method name in URL: /bot<token>/<method>
      if (url.endsWith('/getMe')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              id: 123456789,
              is_bot: true,
              first_name: 'TestBot',
              username: 'testbot',
            },
          }),
        );
        return;
      }

      if (url.endsWith('/deleteWebhook')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }

      if (url.endsWith('/getUpdates')) {
        // Return empty array immediately — the polling loop will keep calling
        // this, but since launch() is detached and we stop the bot in afterAll,
        // this just keeps the loop running cheaply until bot.stop() is called.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: [] }));
        return;
      }

      if (url.endsWith('/sendMessage')) {
        state.sentMessages.push({
          chat_id: String(parsed.chat_id),
          text: parsed.text,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 1,
              chat: { id: parsed.chat_id, type: 'private' },
              text: parsed.text,
              date: Math.floor(Date.now() / 1000),
            },
          }),
        );
        return;
      }

      if (url.endsWith('/sendChatAction')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }

      // Catch-all: return ok for any unhandled Bot API method so telegraf
      // internals don't throw unexpected errors during setup/teardown.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, state });
    });
    server.once('error', reject);
  });
}

// ── SDK / opts helpers ────────────────────────────────────────────────────────

function makeSdk() {
  return {
    registerChannel: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readEnvFile: () => ({ TELEGRAM_BOT_TOKEN: 'tok:E2E' }),
    assistantName: 'Andy',
    groupsDir: '/groups',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Telegram Channel End-to-End', () => {
  const REGISTERED_CHAT_ID = 12345;
  const REGISTERED_JID = `telegram:${REGISTERED_CHAT_ID}`;
  const GROUP_CHAT_ID = -1001234567890;
  const GROUP_JID = `telegram:${GROUP_CHAT_ID}`;

  let channel: InstanceType<typeof TelegramChannel> | null = null;
  let realBot: import('telegraf').Telegraf | null = null;
  let fakeServer: http.Server | null = null;
  let fakeState: FakeServerState;
  let fakePort: number;
  let receivedMessages: { chatJid: string; message: NewMessage }[] = [];
  let receivedMetadata: {
    chatJid: string;
    timestamp: string;
    name: string;
    channelType: string;
    isGroup: boolean;
  }[] = [];

  beforeAll(async () => {
    // Start fake Bot API server
    const fake = await startFakeBotApiServer('tok:E2E');
    fakeServer = fake.server;
    fakePort = fake.port;
    fakeState = fake.state;

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

    // Inject _makeBot with a REAL Telegraf pointed at the fake server.
    //
    // We wrap launch() to fire-and-forget the real polling loop: telegraf's
    // launch() awaits its long-poll loop forever (it only resolves when
    // bot.stop() is called), so awaiting it directly would block connect()
    // forever. By detaching launch() we let connect() return immediately while
    // keeping all real wiring (bot.on middleware dispatch, Telegram HTTP client)
    // intact. Updates are injected via bot.handleUpdate() which calls the same
    // real middleware chain as the live poll path.
    channel._makeBot = async (token: string) => {
      const { Telegraf } = await import('telegraf');
      const bot = new Telegraf(token, {
        telegram: { apiRoot: `http://127.0.0.1:${fakePort}` },
      });

      realBot = bot as unknown as typeof realBot;

      // Detach the real launch so connect() returns without blocking.
      const origLaunch = bot.launch.bind(bot);
      (bot as any).launch = () => {
        origLaunch().catch(() => {
          // Expected: launch rejects when bot.stop() is called from disconnect()
        });
        return Promise.resolve();
      };

      return bot;
    };

    await channel.connect();
  }, 15000);

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
    // Close the fake Bot API server
    await new Promise<void>((resolve) => {
      if (fakeServer) {
        fakeServer.close(() => resolve());
      } else {
        resolve();
      }
    });
    fakeServer = null;
    realBot = null;
  }, 15000);

  beforeEach(() => {
    receivedMessages = [];
    receivedMetadata = [];
    fakeState.sentMessages = [];
  });

  // ── Connection Lifecycle ───────────────────────────────────────────────────

  describe('Connection Lifecycle', () => {
    it('should connect successfully using real Telegraf', () => {
      expect(channel!.isConnected()).toBe(true);
      // Verify getMe was called (fake server tracked it via the route hit)
      // We indirectly verify by asserting connect() resolved and isConnected()
      expect(realBot).not.toBeNull();
    });

    it('should own telegram: JIDs', () => {
      expect(channel!.ownsJid(REGISTERED_JID)).toBe(true);
      expect(channel!.ownsJid(GROUP_JID)).toBe(true);
      expect(channel!.ownsJid('signal:+61400000000')).toBe(false);
      expect(channel!.ownsJid(undefined as any)).toBe(false);
    });
  });

  // ── Message Handling (Inbound) ─────────────────────────────────────────────
  //
  // Updates are injected via the real bot.handleUpdate() which dispatches
  // through telegraf's real middleware chain → the adapter's bot.on('message')
  // handler → the adapter's handleCtx() → opts.onMessage.

  describe('Message Handling (Inbound via real bot.handleUpdate)', () => {
    it('should receive and route a message from a registered private chat', async () => {
      // Inject a real Telegram update through the real Telegraf middleware chain
      await realBot!.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: REGISTERED_CHAT_ID, type: 'private' },
          from: {
            id: 999,
            is_bot: false,
            first_name: 'Test',
            username: 'testuser',
          },
          text: 'Hello from e2e!',
        },
      } as any);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].chatJid).toBe(REGISTERED_JID);
      expect(receivedMessages[0].message.content).toBe('Hello from e2e!');
      expect(receivedMessages[0].message.is_from_me).toBe(false);
      expect(receivedMessages[0].message.sender).toBe('999');
    });

    it('should emit onChatMetadata before onMessage', () => {
      // Call adapter's handleCtx directly (metadata-order test doesn't need
      // the full Telegraf dispatch path)
      const callOrder: string[] = [];
      const sdk2 = makeSdk();
      const cfg2 = parseConfig(sdk2);
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
      const ch2 = new TelegramChannel(cfg2!, opts2, sdk2);

      ch2.handleCtx({
        chat: { id: REGISTERED_CHAT_ID, type: 'private' },
        from: { id: 1, username: 'u', is_bot: false },
        message: { text: 'order test' },
      });
      expect(callOrder).toEqual(['metadata', 'message']);
    });

    it('should ignore messages from unregistered chats', async () => {
      await realBot!.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 99999, type: 'private' },
          from: {
            id: 1,
            is_bot: false,
            first_name: 'Stranger',
            username: 'stranger',
          },
          text: 'from stranger',
        },
      } as any);
      expect(receivedMessages).toHaveLength(0);
    });

    it('should ignore bot messages (echo guard)', async () => {
      await realBot!.handleUpdate({
        update_id: 3,
        message: {
          message_id: 3,
          date: Math.floor(Date.now() / 1000),
          chat: { id: REGISTERED_CHAT_ID, type: 'private' },
          from: {
            id: 888,
            is_bot: true,
            first_name: 'Spam',
            username: 'spambot',
          },
          text: 'spam',
        },
      } as any);
      expect(receivedMessages).toHaveLength(0);
    });

    it('should rewrite bare @Andy group mention to trigger prefix', async () => {
      await realBot!.handleUpdate({
        update_id: 4,
        message: {
          message_id: 4,
          date: Math.floor(Date.now() / 1000),
          chat: { id: GROUP_CHAT_ID, type: 'group', title: 'E2E Group' },
          from: { id: 777, is_bot: false, first_name: 'Bob', username: 'bob' },
          text: 'hey @Andy what time is it?',
        },
      } as any);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].message.content).toBe(
        '@Andy hey @Andy what time is it?',
      );
    });

    it('should NOT rewrite when message already starts with @Andy', async () => {
      await realBot!.handleUpdate({
        update_id: 5,
        message: {
          message_id: 5,
          date: Math.floor(Date.now() / 1000),
          chat: { id: GROUP_CHAT_ID, type: 'group', title: 'E2E Group' },
          from: { id: 777, is_bot: false, first_name: 'Bob', username: 'bob' },
          text: '@Andy help me please',
        },
      } as any);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].message.content).toBe('@Andy help me please');
    });
  });

  // ── Message Sending (Outbound) ─────────────────────────────────────────────
  //
  // sendMessage() uses the real bot.telegram.sendMessage() which sends a
  // real HTTP POST to the fake server. We assert on fakeState.sentMessages
  // which the fake server populates.

  describe('Message Sending (Outbound via real Telegraf HTTP client)', () => {
    it('should send a message to a registered chat via real HTTP to fake server', async () => {
      await channel!.sendMessage(REGISTERED_JID, 'Hello from KubeClaw!');

      expect(fakeState.sentMessages).toHaveLength(1);
      expect(fakeState.sentMessages[0].chat_id).toBe(
        String(REGISTERED_CHAT_ID),
      );
      expect(fakeState.sentMessages[0].text).toBe('Hello from KubeClaw!');
    });

    it('should chunk long messages at 4096 chars (real HTTP to fake server)', async () => {
      const longText = 'x'.repeat(9000);
      await channel!.sendMessage(REGISTERED_JID, longText);

      expect(fakeState.sentMessages).toHaveLength(3);
      expect(fakeState.sentMessages[0].text.length).toBe(4096);
      expect(fakeState.sentMessages[1].text.length).toBe(4096);
      expect(fakeState.sentMessages[2].text.length).toBe(9000 - 4096 - 4096);
    });

    it('should not send to non-telegram JIDs', async () => {
      await channel!.sendMessage('signal:+61400000000', 'nope');
      expect(fakeState.sentMessages).toHaveLength(0);
    });
  });

  // ── Full Round-trip ────────────────────────────────────────────────────────

  describe('Full Roundtrip (real Telegraf end-to-end)', () => {
    it('should complete a full message roundtrip: inbound handleUpdate → onMessage → sendMessage → fake server', async () => {
      // 1. Receive an inbound message via real Telegraf handleUpdate
      await realBot!.handleUpdate({
        update_id: 10,
        message: {
          message_id: 10,
          date: Math.floor(Date.now() / 1000),
          chat: { id: REGISTERED_CHAT_ID, type: 'private' },
          from: {
            id: 555,
            is_bot: false,
            first_name: 'Alice',
            username: 'alice',
          },
          text: '@Andy hello there!',
        },
      } as any);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].message.content).toBe('@Andy hello there!');

      // 2. Send a reply — goes through real Telegraf HTTP client → fake server
      const responseText = 'Hello Alice! How can I help you?';
      await channel!.sendMessage(REGISTERED_JID, responseText);

      expect(fakeState.sentMessages).toHaveLength(1);
      expect(fakeState.sentMessages[0].chat_id).toBe(
        String(REGISTERED_CHAT_ID),
      );
      expect(fakeState.sentMessages[0].text).toBe(responseText);
    });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────

  describe('Disconnect', () => {
    it('should disconnect cleanly in a separate channel instance (own fake server)', async () => {
      // Spin up a second fake server for this isolated instance
      const fake2 = await startFakeBotApiServer('tok:E2E2');
      const sdk2 = makeSdk();
      // Override readEnvFile so parseConfig gives a non-null config
      (sdk2 as any).readEnvFile = () => ({ TELEGRAM_BOT_TOKEN: 'tok:E2E2' });
      const cfg2 = parseConfig(sdk2);

      const ch2 = new TelegramChannel(
        cfg2!,
        {
          onMessage: vi.fn(),
          onChatMetadata: vi.fn(),
          registeredGroups: () => ({}),
        },
        sdk2,
      );

      ch2._makeBot = async (token: string) => {
        const { Telegraf } = await import('telegraf');
        const bot = new Telegraf(token, {
          telegram: { apiRoot: `http://127.0.0.1:${fake2.port}` },
        });
        const origLaunch = bot.launch.bind(bot);
        (bot as any).launch = () => {
          origLaunch().catch(() => {});
          return Promise.resolve();
        };
        return bot;
      };

      await ch2.connect();
      expect(ch2.isConnected()).toBe(true);

      await ch2.disconnect();
      expect(ch2.isConnected()).toBe(false);

      // Clean up isolated fake server
      await new Promise<void>((resolve) => fake2.server.close(() => resolve()));
    }, 10000);
  });
});
