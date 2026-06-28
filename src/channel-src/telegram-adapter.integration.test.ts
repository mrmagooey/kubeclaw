/**
 * Telegram adapter integration test — fake transport.
 *
 * Exercises the full connect → on('message') → handleCtx → onMessage
 * and sendMessage → bot.telegram.sendMessage wiring using a fake bot
 * injected via ch._makeBot. No network access; no telegraf import.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TelegramChannel,
  parseConfig,
} from '../../helm/kubeclaw/files/channel-src/telegram/channel-entry.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Build a TelegramChannel pre-wired with the fake bot factory. */
function buildIntegrationChannel(botFactory: (token: string) => any) {
  const sdk = makeSdk({ TELEGRAM_BOT_TOKEN: 'tok:INTEGRATION' });
  const opts = makeOpts({
    'telegram:100': {
      name: 'IntegrationGroup',
      folder: 'tg-100',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    },
  });
  const cfg = parseConfig(sdk);
  const ch = new TelegramChannel(cfg!, opts, sdk);
  ch._makeBot = vi
    .fn()
    .mockImplementation(async (token: string) => botFactory(token));
  return { ch, sdk, opts };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('telegram-adapter: integration (fake bot)', () => {
  it('connect → on(message) → handleCtx → onMessage (full wiring)', async () => {
    let capturedHandler: ((ctx: any) => void) | null = null;
    const sendMessageSpy = vi.fn().mockResolvedValue({});

    const fakeBot = {
      on: vi.fn((event: string, handler: (ctx: any) => void) => {
        if (event === 'message') capturedHandler = handler;
      }),
      launch: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      telegram: { sendMessage: sendMessageSpy, sendChatAction: vi.fn() },
    };

    const { ch, opts } = buildIntegrationChannel(() => fakeBot);

    // Connect wires up the handler
    await ch.connect();
    expect(ch.isConnected()).toBe(true);
    expect(fakeBot.launch).toHaveBeenCalled();
    expect(capturedHandler).not.toBeNull();

    // Deliver a fake ctx through the captured handler
    const fakeCtx = {
      chat: { id: 100, type: 'private' },
      from: { id: 999, username: 'testuser', is_bot: false },
      message: { text: 'hello integration' },
    };
    capturedHandler!(fakeCtx);

    // onMessage should have fired
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = opts.onMessage.mock.calls[0];
    expect(jid).toBe('telegram:100');
    expect(msg.content).toBe('hello integration');
    expect(msg.is_from_me).toBe(false);
    expect(msg.sender).toBe('999');

    // onChatMetadata must have fired BEFORE onMessage (already verified by call count)
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'telegram:100',
      expect.any(String),
      expect.any(String),
      'telegram',
      false,
    );
  });

  it('sendMessage → chunks and calls bot.telegram.sendMessage', async () => {
    const sendMessageSpy = vi.fn().mockResolvedValue({});
    const fakeBot = {
      on: vi.fn(),
      launch: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      telegram: { sendMessage: sendMessageSpy, sendChatAction: vi.fn() },
    };

    const { ch } = buildIntegrationChannel(() => fakeBot);
    await ch.connect();

    // Send a 9000-char message — should produce 3 chunks of 4096, 4096, 808
    const text = 'x'.repeat(9000);
    await ch.sendMessage('telegram:100', text);

    expect(sendMessageSpy).toHaveBeenCalledTimes(3);
    expect(sendMessageSpy.mock.calls[0][0]).toBe('100');
    expect(sendMessageSpy.mock.calls[0][1].length).toBe(4096);
    expect(sendMessageSpy.mock.calls[1][1].length).toBe(4096);
    expect(sendMessageSpy.mock.calls[2][1].length).toBe(9000 - 4096 - 4096);
  });

  it('disconnect → connected=false and bot.stop called', async () => {
    const stopSpy = vi.fn();
    const fakeBot = {
      on: vi.fn(),
      launch: vi.fn().mockResolvedValue(undefined),
      stop: stopSpy,
      telegram: { sendMessage: vi.fn(), sendChatAction: vi.fn() },
    };

    const { ch } = buildIntegrationChannel(() => fakeBot);
    await ch.connect();
    expect(ch.isConnected()).toBe(true);

    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
    expect(stopSpy).toHaveBeenCalled();
  });

  it('unregistered chat does NOT trigger onMessage', async () => {
    let capturedHandler: ((ctx: any) => void) | null = null;
    const fakeBot = {
      on: vi.fn((event: string, handler: (ctx: any) => void) => {
        if (event === 'message') capturedHandler = handler;
      }),
      launch: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      telegram: { sendMessage: vi.fn(), sendChatAction: vi.fn() },
    };

    // Empty registered groups
    const sdk = makeSdk({ TELEGRAM_BOT_TOKEN: 'tok:INTEGRATION' });
    const opts = makeOpts({}); // no registered chats
    const cfg = parseConfig(sdk);
    const ch = new TelegramChannel(cfg!, opts, sdk);
    ch._makeBot = vi.fn().mockResolvedValue(fakeBot);

    await ch.connect();
    capturedHandler!({
      chat: { id: 9999, type: 'private' },
      from: { id: 1, username: 'stranger', is_bot: false },
      message: { text: 'hello from stranger' },
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('bot message (is_bot=true) is ignored — no onMessage', async () => {
    let capturedHandler: ((ctx: any) => void) | null = null;
    const fakeBot = {
      on: vi.fn((event: string, handler: (ctx: any) => void) => {
        if (event === 'message') capturedHandler = handler;
      }),
      launch: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      telegram: { sendMessage: vi.fn(), sendChatAction: vi.fn() },
    };

    const { ch, opts } = buildIntegrationChannel(() => fakeBot);
    await ch.connect();

    capturedHandler!({
      chat: { id: 100, type: 'private' },
      from: { id: 888, username: 'spambot', is_bot: true },
      message: { text: 'spam' },
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });
});
