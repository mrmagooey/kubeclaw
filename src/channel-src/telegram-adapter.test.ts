import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramChannel, parseConfig } from '../../helm/kubeclaw/files/channel-src/telegram/channel-entry.js';

// ── Fake SDK / opts helpers (mirror signal-adapter.test.ts) ──────────────────

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

function fakeOpts(overrides?: { registeredGroups?: () => Record<string, any> }) {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'telegram:123': {
        name: 'Alice',
        folder: 'tg-123',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'telegram:-1001234567890': {
        name: 'Test Group',
        folder: 'tg--1001234567890',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function buildChannel(env: Record<string, string>, opts?: any) {
  const { sdk, factories } = fakeSdk(env);
  const { default: register } = (globalThis as any).__telegramRegister__
    ? { default: (globalThis as any).__telegramRegister__ }
    : { default: null };

  // Dynamically import the default export already loaded by the named imports above
  // We need the factory; use parseConfig + TelegramChannel directly for most tests.
  // For factory tests we use the register function via a second import trick.
  sdk.registerChannel('telegram', (o: any) => {
    const cfg = parseConfig(sdk);
    if (!cfg) return null;
    return new TelegramChannel(cfg, o, sdk);
  });
  const ch = factories['telegram'](opts ?? fakeOpts());
  return { sdk, ch };
}

// ── Factory / config tests ────────────────────────────────────────────────────

describe('telegram-adapter: factory + config parsing', () => {
  it('builds a channel when TELEGRAM_BOT_TOKEN is present', () => {
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' });
    expect(ch).not.toBeNull();
    expect(ch.name).toBe('telegram');
  });

  it('returns null when TELEGRAM_BOT_TOKEN is missing', () => {
    const { ch } = buildChannel({});
    expect(ch).toBeNull();
  });

  it('parseConfig honours optional TELEGRAM_BOT_USERNAME', () => {
    const { sdk } = fakeSdk({
      TELEGRAM_BOT_TOKEN: 'tok:ABC',
      TELEGRAM_BOT_USERNAME: 'mybot',
    });
    const cfg = parseConfig(sdk);
    expect(cfg).not.toBeNull();
    expect(cfg!.botUsername).toBe('mybot');
  });

  it('parseConfig warns and returns null when token missing', () => {
    const { sdk } = fakeSdk({});
    const cfg = parseConfig(sdk);
    expect(cfg).toBeNull();
    expect(sdk.logger.warn).toHaveBeenCalled();
  });
});

// ── ownsJid ────────────────────────────────────────────────────────────────────

describe('telegram-adapter: ownsJid', () => {
  it('owns telegram: JIDs', () => {
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' });
    expect(ch.ownsJid('telegram:123')).toBe(true);
    expect(ch.ownsJid('telegram:-1001234567890')).toBe(true);
  });

  it('does not own other JIDs', () => {
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' });
    expect(ch.ownsJid('irc:#x@irc.test:6697')).toBe(false);
    expect(ch.ownsJid('signal:+61400000000')).toBe(false);
  });

  it('returns false for undefined', () => {
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' });
    expect(ch.ownsJid(undefined as any)).toBe(false);
  });
});

// ── buildInbound ──────────────────────────────────────────────────────────────

describe('telegram-adapter: buildInbound', () => {
  it('maps a private-chat update to isGroup=false with correct jid', () => {
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' });
    const ctx = {
      chat: { id: 123, type: 'private', title: undefined },
      from: { id: 456, username: 'alice', first_name: 'Alice', last_name: undefined, is_bot: false },
      message: { text: 'hello' },
    };
    const result = ch.buildInbound(ctx);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('telegram:123');
    expect(result!.isGroup).toBe(false);
    expect(result!.sender).toBe('456');
    expect(result!.senderName).toBe('alice');
  });

  it('maps a group update with negative id to isGroup=true', () => {
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' });
    const ctx = {
      chat: { id: -1001234567890, type: 'group', title: 'My Group' },
      from: { id: 789, username: undefined, first_name: 'Bob', last_name: 'Smith', is_bot: false },
      message: { text: 'group msg' },
    };
    const result = ch.buildInbound(ctx);
    expect(result!.jid).toBe('telegram:-1001234567890');
    expect(result!.isGroup).toBe(true);
    expect(result!.chatName).toBe('My Group');
    expect(result!.senderName).toBe('Bob Smith');
  });

  it('returns null when from.is_bot is true (echo guard)', () => {
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' });
    const ctx = {
      chat: { id: 123, type: 'private' },
      from: { id: 999, username: 'anotherbot', is_bot: true },
      message: { text: 'bot message' },
    };
    expect(ch.buildInbound(ctx)).toBeNull();
  });

  it('returns null when chat is missing', () => {
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' });
    expect(ch.buildInbound({ from: { id: 1, is_bot: false }, message: { text: 'x' } })).toBeNull();
  });
});

// ── handleCtx → onMessage ─────────────────────────────────────────────────────

describe('telegram-adapter: handleCtx → onMessage', () => {
  it('routes a registered private message to onMessage with correct JID', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);
    ch.handleCtx({
      chat: { id: 123, type: 'private' },
      from: { id: 456, username: 'alice', is_bot: false },
      message: { text: 'hello bot' },
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'telegram:123',
      expect.objectContaining({
        content: 'hello bot',
        sender: '456',
        is_from_me: false,
        chat_jid: 'telegram:123',
      }),
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'telegram:123',
      expect.any(String),
      expect.any(String),
      'telegram',
      false,
    );
  });

  it('calls onChatMetadata BEFORE onMessage', () => {
    const callOrder: string[] = [];
    const opts = fakeOpts();
    opts.onChatMetadata = vi.fn(() => callOrder.push('metadata'));
    opts.onMessage = vi.fn(() => callOrder.push('message'));
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);
    ch.handleCtx({
      chat: { id: 123, type: 'private' },
      from: { id: 456, username: 'alice', is_bot: false },
      message: { text: 'hello' },
    });
    expect(callOrder).toEqual(['metadata', 'message']);
  });

  it('rewrites a bare @Andy mention in a group to a trigger prefix', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);
    ch.handleCtx({
      chat: { id: -1001234567890, type: 'group', title: 'Test Group' },
      from: { id: 789, username: 'bob', is_bot: false },
      message: { text: 'hey @Andy what time is it' },
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'telegram:-1001234567890',
      expect.objectContaining({ content: '@Andy hey @Andy what time is it' }),
    );
  });

  it('does NOT rewrite when message already starts with @Andy', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);
    ch.handleCtx({
      chat: { id: -1001234567890, type: 'group', title: 'Test Group' },
      from: { id: 789, username: 'bob', is_bot: false },
      message: { text: '@Andy help me' },
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'telegram:-1001234567890',
      expect.objectContaining({ content: '@Andy help me' }),
    );
  });

  it('drops messages from unregistered chats', () => {
    const opts = fakeOpts({ registeredGroups: () => ({}) });
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);
    ch.handleCtx({
      chat: { id: 999, type: 'private' },
      from: { id: 1, username: 'stranger', is_bot: false },
      message: { text: 'hello' },
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('drops bot messages (echo guard via is_bot)', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);
    ch.handleCtx({
      chat: { id: 123, type: 'private' },
      from: { id: 999, username: 'otherbot', is_bot: true },
      message: { text: 'bot reply' },
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('drops media-only messages with no text content', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);
    ch.handleCtx({
      chat: { id: 123, type: 'private' },
      from: { id: 456, username: 'alice', is_bot: false },
      message: {}, // no text, no caption
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });
});

// ── sendMessage ───────────────────────────────────────────────────────────────

describe('telegram-adapter: sendMessage', () => {
  it('calls bot.telegram.sendMessage with chatId and text', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);

    const sendMessageSpy = vi.fn().mockResolvedValue({});
    ch.bot = { telegram: { sendMessage: sendMessageSpy, sendChatAction: vi.fn() } };

    await ch.sendMessage('telegram:123', 'hello there');
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledWith('123', 'hello there');
  });

  it('chunks a 9000-char message into 3 sends (chunk size = 4096)', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);

    const sendMessageSpy = vi.fn().mockResolvedValue({});
    ch.bot = { telegram: { sendMessage: sendMessageSpy, sendChatAction: vi.fn() } };

    await ch.sendMessage('telegram:123', 'x'.repeat(9000));
    // 9000 / 4096 = ceil(9000/4096) = 3 chunks
    expect(sendMessageSpy).toHaveBeenCalledTimes(3);
    const calls = sendMessageSpy.mock.calls;
    expect(calls[0][1].length).toBe(4096);
    expect(calls[1][1].length).toBe(4096);
    expect(calls[2][1].length).toBe(9000 - 4096 - 4096);
  });

  it('does nothing for a non-telegram JID', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);
    const sendMessageSpy = vi.fn();
    ch.bot = { telegram: { sendMessage: sendMessageSpy } };
    await ch.sendMessage('signal:+61400000000', 'nope');
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('does nothing when bot is null (not connected)', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);
    // ch.bot is null by default
    await expect(ch.sendMessage('telegram:123', 'hello')).resolves.toBeUndefined();
  });
});

// ── lifecycle ─────────────────────────────────────────────────────────────────

describe('telegram-adapter: lifecycle', () => {
  it('isConnected returns false initially', () => {
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' });
    expect(ch.isConnected()).toBe(false);
  });

  it('connect calls _makeBot with the token and sets connected', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);

    const fakeBot = {
      on: vi.fn(),
      launch: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      telegram: { sendMessage: vi.fn(), sendChatAction: vi.fn() },
    };
    ch._makeBot = vi.fn().mockResolvedValue(fakeBot);

    await ch.connect();
    expect(ch._makeBot).toHaveBeenCalledWith('tok:ABC');
    expect(ch.isConnected()).toBe(true);
    expect(fakeBot.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(fakeBot.launch).toHaveBeenCalled();
  });

  it('disconnect sets connected=false and calls bot.stop()', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' }, opts);
    const fakeBot = {
      on: vi.fn(),
      launch: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      telegram: { sendMessage: vi.fn(), sendChatAction: vi.fn() },
    };
    ch._makeBot = vi.fn().mockResolvedValue(fakeBot);
    await ch.connect();
    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
    expect(fakeBot.stop).toHaveBeenCalled();
  });
});

// ── capabilities ──────────────────────────────────────────────────────────────

describe('telegram-adapter: capabilities', () => {
  it('declares the correct capability flags (no markdownOutput)', () => {
    const { ch } = buildChannel({ TELEGRAM_BOT_TOKEN: 'tok:ABC' });
    expect(ch.capabilities.typing).toBe(true);
    expect(ch.capabilities.inboundImages).toBe(true);
    expect(ch.capabilities.inboundPdfs).toBe(true);
    expect(ch.capabilities.inboundVoice).toBe(true);
    expect(ch.capabilities.outboundMedia).toBe(false);
    expect(ch.capabilities.markdownOutput).toBeUndefined();
  });
});
