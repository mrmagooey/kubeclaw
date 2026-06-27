import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DiscordChannel,
  parseConfig,
} from '../../helm/kubeclaw/files/channel-src/discord/channel-entry.js';

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
      'discord:111222333': {
        name: 'general',
        folder: 'discord-111222333',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'discord:999888777': {
        name: 'Test Guild channel',
        folder: 'discord-999888777',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function buildChannel(env: Record<string, string>, opts?: any) {
  const { sdk, factories } = fakeSdk(env);
  sdk.registerChannel('discord', (o: any) => {
    const cfg = parseConfig(sdk);
    if (!cfg) return null;
    return new DiscordChannel(cfg, o, sdk);
  });
  const ch = factories['discord'](opts ?? fakeOpts());
  return { sdk, ch };
}

// ── Factory / config tests ────────────────────────────────────────────────────

describe('discord-adapter: factory + config parsing', () => {
  it('builds a channel when DISCORD_BOT_TOKEN is present', () => {
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'Bot.token123' });
    expect(ch).not.toBeNull();
    expect(ch.name).toBe('discord');
  });

  it('returns null when DISCORD_BOT_TOKEN is missing', () => {
    const { ch } = buildChannel({});
    expect(ch).toBeNull();
  });

  it('parseConfig returns config with token when token present', () => {
    const { sdk } = fakeSdk({ DISCORD_BOT_TOKEN: 'Bot.token123' });
    const cfg = parseConfig(sdk);
    expect(cfg).not.toBeNull();
    expect(cfg!.token).toBe('Bot.token123');
  });

  it('parseConfig warns and returns null when token missing', () => {
    const { sdk } = fakeSdk({});
    const cfg = parseConfig(sdk);
    expect(cfg).toBeNull();
    expect(sdk.logger.warn).toHaveBeenCalled();
  });
});

// ── ownsJid ────────────────────────────────────────────────────────────────────

describe('discord-adapter: ownsJid', () => {
  it('owns discord: JIDs', () => {
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' });
    expect(ch.ownsJid('discord:111222333')).toBe(true);
    expect(ch.ownsJid('discord:999888777')).toBe(true);
  });

  it('does not own other JIDs', () => {
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' });
    expect(ch.ownsJid('telegram:123')).toBe(false);
    expect(ch.ownsJid('signal:+61400000000')).toBe(false);
  });

  it('returns false for undefined', () => {
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' });
    expect(ch.ownsJid(undefined as any)).toBe(false);
  });
});

// ── buildInbound ──────────────────────────────────────────────────────────────

describe('discord-adapter: buildInbound', () => {
  it('maps a DM message to isGroup=false with correct jid', () => {
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' });
    const message = {
      channelId: '111222333',
      guild: null,
      author: { id: '456', username: 'alice', bot: false },
      channel: { id: '111222333', name: 'DM' },
      content: 'hello',
    };
    const result = ch.buildInbound(message);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('discord:111222333');
    expect(result!.isGroup).toBe(false);
    expect(result!.sender).toBe('456');
    expect(result!.senderName).toBe('alice');
  });

  it('maps a guild message to isGroup=true', () => {
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' });
    const message = {
      channelId: '999888777',
      guild: { id: '123', name: 'My Server' },
      author: { id: '789', username: 'bob', bot: false },
      channel: { id: '999888777', name: 'general' },
      content: 'group msg',
    };
    const result = ch.buildInbound(message);
    expect(result!.jid).toBe('discord:999888777');
    expect(result!.isGroup).toBe(true);
    expect(result!.chatName).toBe('general');
    expect(result!.senderName).toBe('bob');
  });

  it('returns null when author.bot is true (echo guard)', () => {
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' });
    const message = {
      channelId: '111222333',
      guild: null,
      author: { id: '999', username: 'botuser', bot: true },
      channel: { id: '111222333' },
      content: 'bot message',
    };
    expect(ch.buildInbound(message)).toBeNull();
  });

  it('returns null when channelId is missing', () => {
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' });
    const message = {
      channelId: null,
      guild: null,
      author: { id: '1', username: 'u', bot: false },
      channel: null,
      content: 'x',
    };
    expect(ch.buildInbound(message)).toBeNull();
  });

  it('returns null for null message', () => {
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' });
    expect(ch.buildInbound(null)).toBeNull();
  });
});

// ── handleMessage → onMessage ─────────────────────────────────────────────────

describe('discord-adapter: handleMessage → onMessage', () => {
  it('routes a registered DM message to onMessage with correct JID', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' }, opts);
    ch.handleMessage({
      channelId: '111222333',
      guild: null,
      author: { id: '456', username: 'alice', bot: false },
      channel: { id: '111222333', name: 'DM' },
      content: 'hello bot',
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'discord:111222333',
      expect.objectContaining({
        content: 'hello bot',
        sender: '456',
        is_from_me: false,
        chat_jid: 'discord:111222333',
      }),
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'discord:111222333',
      expect.any(String),
      expect.any(String),
      'discord',
      false,
    );
  });

  it('calls onChatMetadata BEFORE onMessage', () => {
    const callOrder: string[] = [];
    const opts = fakeOpts();
    opts.onChatMetadata = vi.fn(() => callOrder.push('metadata'));
    opts.onMessage = vi.fn(() => callOrder.push('message'));
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' }, opts);
    ch.handleMessage({
      channelId: '111222333',
      guild: null,
      author: { id: '456', username: 'alice', bot: false },
      channel: { id: '111222333' },
      content: 'hello',
    });
    expect(callOrder).toEqual(['metadata', 'message']);
  });

  it('rewrites a bare @Andy mention in a guild to a trigger prefix', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' }, opts);
    ch.handleMessage({
      channelId: '999888777',
      guild: { id: '123', name: 'My Server' },
      author: { id: '789', username: 'bob', bot: false },
      channel: { id: '999888777', name: 'general' },
      content: 'hey @Andy what time is it',
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'discord:999888777',
      expect.objectContaining({ content: '@Andy hey @Andy what time is it' }),
    );
  });

  it('does NOT rewrite when message already starts with @Andy', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' }, opts);
    ch.handleMessage({
      channelId: '999888777',
      guild: { id: '123', name: 'My Server' },
      author: { id: '789', username: 'bob', bot: false },
      channel: { id: '999888777', name: 'general' },
      content: '@Andy help me',
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'discord:999888777',
      expect.objectContaining({ content: '@Andy help me' }),
    );
  });

  it('drops messages from unregistered channels', () => {
    const opts = fakeOpts({ registeredGroups: () => ({}) });
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' }, opts);
    ch.handleMessage({
      channelId: '000000000',
      guild: null,
      author: { id: '1', username: 'stranger', bot: false },
      channel: { id: '000000000' },
      content: 'hello',
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('drops bot messages (echo guard via author.bot)', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' }, opts);
    ch.handleMessage({
      channelId: '111222333',
      guild: null,
      author: { id: '999', username: 'otherbot', bot: true },
      channel: { id: '111222333' },
      content: 'bot reply',
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('warns and returns early when guild message has empty content (MessageContent intent)', () => {
    const opts = fakeOpts();
    const { sdk, ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' }, opts);
    ch.handleMessage({
      channelId: '999888777',
      guild: { id: '123', name: 'My Server' },
      author: { id: '789', username: 'bob', bot: false },
      channel: { id: '999888777', name: 'general' },
      content: '', // empty — MessageContent intent not enabled
    });
    expect(sdk.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '999888777' }),
      expect.stringContaining('MessageContent'),
    );
    expect(opts.onMessage).not.toHaveBeenCalled();
  });
});

// ── sendMessage ───────────────────────────────────────────────────────────────

describe('discord-adapter: sendMessage', () => {
  it('calls channel.send with text', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' }, opts);

    const sendSpy = vi.fn().mockResolvedValue({});
    const fetchSpy = vi.fn().mockResolvedValue({ send: sendSpy });
    ch.client = { channels: { fetch: fetchSpy } };

    await ch.sendMessage('discord:111222333', 'hello there');
    expect(fetchSpy).toHaveBeenCalledWith('111222333');
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith('hello there');
  });

  it('chunks a 5000-char message into 3 sends (chunk size = 2000)', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' }, opts);

    const sendSpy = vi.fn().mockResolvedValue({});
    ch.client = {
      channels: { fetch: vi.fn().mockResolvedValue({ send: sendSpy }) },
    };

    await ch.sendMessage('discord:111222333', 'x'.repeat(5000));
    // 5000 / 2000 = 3 chunks (2000, 2000, 1000)
    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(sendSpy.mock.calls[0][0].length).toBe(2000);
    expect(sendSpy.mock.calls[1][0].length).toBe(2000);
    expect(sendSpy.mock.calls[2][0].length).toBe(1000);
  });

  it('does nothing for a non-discord JID', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' }, opts);
    const fetchSpy = vi.fn();
    ch.client = { channels: { fetch: fetchSpy } };
    await ch.sendMessage('telegram:123', 'nope');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs a warn and returns when client is null (not connected)', async () => {
    const opts = fakeOpts();
    const { sdk, ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' }, opts);
    // ch.client is null by default — should warn but not throw
    await expect(
      ch.sendMessage('discord:111222333', 'hello'),
    ).resolves.toBeUndefined();
    expect(sdk.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'discord:111222333' }),
      'discord: sendMessage called but client not connected',
    );
  });
});

// ── lifecycle ─────────────────────────────────────────────────────────────────

describe('discord-adapter: lifecycle', () => {
  it('isConnected returns false initially', () => {
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' });
    expect(ch.isConnected()).toBe(false);
  });

  it('connect calls _makeClient with the token and sets connected', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'Bot.tok' }, opts);

    const fakeClient = {
      on: vi.fn(),
      destroy: vi.fn(),
      channels: { fetch: vi.fn() },
    };
    ch._makeClient = vi.fn().mockResolvedValue(fakeClient);

    await ch.connect();
    expect(ch._makeClient).toHaveBeenCalledWith('Bot.tok');
    expect(ch.isConnected()).toBe(true);
    expect(fakeClient.on).toHaveBeenCalledWith(
      'messageCreate',
      expect.any(Function),
    );
  });

  it('disconnect sets connected=false and calls client.destroy()', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' }, opts);
    const fakeClient = {
      on: vi.fn(),
      destroy: vi.fn(),
      channels: { fetch: vi.fn() },
    };
    ch._makeClient = vi.fn().mockResolvedValue(fakeClient);
    await ch.connect();
    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
    expect(fakeClient.destroy).toHaveBeenCalled();
  });
});

// ── capabilities ──────────────────────────────────────────────────────────────

describe('discord-adapter: capabilities', () => {
  it('declares the correct capability flags (markdownOutput=true, outboundMedia=false)', () => {
    const { ch } = buildChannel({ DISCORD_BOT_TOKEN: 'tok' });
    expect(ch.capabilities.typing).toBe(true);
    expect(ch.capabilities.inboundImages).toBe(true);
    expect(ch.capabilities.inboundPdfs).toBe(true);
    expect(ch.capabilities.markdownOutput).toBe(true);
    expect(ch.capabilities.outboundMedia).toBe(false);
  });
});
