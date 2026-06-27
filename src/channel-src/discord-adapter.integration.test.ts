/**
 * Discord adapter integration test — fake transport.
 *
 * Exercises the full connect → on('messageCreate') → handleMessage → onMessage
 * and sendMessage → channel.send wiring using a fake client
 * injected via ch._makeClient. No network access; no discord.js import.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DiscordChannel,
  parseConfig,
} from '../../helm/kubeclaw/files/channel-src/discord/channel-entry.js';

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

/** Build a DiscordChannel pre-wired with the fake client factory. */
function buildIntegrationChannel(clientFactory: (token: string) => any) {
  const sdk = makeSdk({ DISCORD_BOT_TOKEN: 'Bot.INTEGRATION' });
  const opts = makeOpts({
    'discord:100200300': {
      name: 'IntegrationChannel',
      folder: 'discord-100200300',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    },
    'discord:400500600': {
      name: 'IntegrationGuild',
      folder: 'discord-400500600',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    },
  });
  const cfg = parseConfig(sdk);
  const ch = new DiscordChannel(cfg!, opts, sdk);
  ch._makeClient = vi
    .fn()
    .mockImplementation(async (token: string) => clientFactory(token));
  return { ch, sdk, opts };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('discord-adapter: integration (fake client)', () => {
  it('connect → on(messageCreate) → handleMessage → onMessage (full wiring)', async () => {
    let capturedHandler: ((msg: any) => void) | null = null;
    const sendSpy = vi.fn().mockResolvedValue({});
    const fetchSpy = vi.fn().mockResolvedValue({ send: sendSpy });

    const fakeClient = {
      on: vi.fn((event: string, handler: (msg: any) => void) => {
        if (event === 'messageCreate') capturedHandler = handler;
      }),
      destroy: vi.fn(),
      channels: { fetch: fetchSpy },
    };

    const { ch, opts } = buildIntegrationChannel(() => fakeClient);

    // Connect wires up the handler
    await ch.connect();
    expect(ch.isConnected()).toBe(true);
    expect(capturedHandler).not.toBeNull();

    // Deliver a fake message through the captured handler
    const fakeMsg = {
      channelId: '100200300',
      guild: null,
      author: { id: '999', username: 'testuser', bot: false },
      channel: { id: '100200300', name: 'DM' },
      content: 'hello integration',
    };
    capturedHandler!(fakeMsg);

    // onMessage should have fired
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = opts.onMessage.mock.calls[0];
    expect(jid).toBe('discord:100200300');
    expect(msg.content).toBe('hello integration');
    expect(msg.is_from_me).toBe(false);
    expect(msg.sender).toBe('999');

    // onChatMetadata must have fired BEFORE onMessage
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'discord:100200300',
      expect.any(String),
      expect.any(String),
      'discord',
      false,
    );
  });

  it('sendMessage → chunks and calls channel.send', async () => {
    const sendSpy = vi.fn().mockResolvedValue({});
    const fakeClient = {
      on: vi.fn(),
      destroy: vi.fn(),
      channels: { fetch: vi.fn().mockResolvedValue({ send: sendSpy }) },
    };

    const { ch } = buildIntegrationChannel(() => fakeClient);
    await ch.connect();

    // Send a 5000-char message — should produce 3 chunks (2000, 2000, 1000)
    const text = 'x'.repeat(5000);
    await ch.sendMessage('discord:100200300', text);

    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(sendSpy.mock.calls[0][0].length).toBe(2000);
    expect(sendSpy.mock.calls[1][0].length).toBe(2000);
    expect(sendSpy.mock.calls[2][0].length).toBe(1000);
  });

  it('disconnect → connected=false and client.destroy called', async () => {
    const destroySpy = vi.fn();
    const fakeClient = {
      on: vi.fn(),
      destroy: destroySpy,
      channels: { fetch: vi.fn() },
    };

    const { ch } = buildIntegrationChannel(() => fakeClient);
    await ch.connect();
    expect(ch.isConnected()).toBe(true);

    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
    expect(destroySpy).toHaveBeenCalled();
  });

  it('unregistered channel does NOT trigger onMessage', async () => {
    let capturedHandler: ((msg: any) => void) | null = null;
    const fakeClient = {
      on: vi.fn((event: string, handler: (msg: any) => void) => {
        if (event === 'messageCreate') capturedHandler = handler;
      }),
      destroy: vi.fn(),
      channels: { fetch: vi.fn() },
    };

    // Empty registered groups
    const sdk = makeSdk({ DISCORD_BOT_TOKEN: 'Bot.INTEGRATION' });
    const opts = makeOpts({}); // no registered channels
    const cfg = parseConfig(sdk);
    const ch = new DiscordChannel(cfg!, opts, sdk);
    ch._makeClient = vi.fn().mockResolvedValue(fakeClient);

    await ch.connect();
    capturedHandler!({
      channelId: '9999999',
      guild: null,
      author: { id: '1', username: 'stranger', bot: false },
      channel: { id: '9999999' },
      content: 'hello from stranger',
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('bot message (author.bot=true) is ignored — no onMessage', async () => {
    let capturedHandler: ((msg: any) => void) | null = null;
    const fakeClient = {
      on: vi.fn((event: string, handler: (msg: any) => void) => {
        if (event === 'messageCreate') capturedHandler = handler;
      }),
      destroy: vi.fn(),
      channels: { fetch: vi.fn() },
    };

    const { ch, opts } = buildIntegrationChannel(() => fakeClient);
    await ch.connect();

    capturedHandler!({
      channelId: '100200300',
      guild: null,
      author: { id: '888', username: 'spambot', bot: true },
      channel: { id: '100200300' },
      content: 'spam',
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('guild message with empty content triggers the MessageContent intent warning', async () => {
    let capturedHandler: ((msg: any) => void) | null = null;
    const fakeClient = {
      on: vi.fn((event: string, handler: (msg: any) => void) => {
        if (event === 'messageCreate') capturedHandler = handler;
      }),
      destroy: vi.fn(),
      channels: { fetch: vi.fn() },
    };

    const { ch, sdk, opts } = buildIntegrationChannel(() => fakeClient);
    await ch.connect();

    capturedHandler!({
      channelId: '400500600',
      guild: { id: '123', name: 'My Server' },
      author: { id: '777', username: 'user', bot: false },
      channel: { id: '400500600', name: 'general' },
      content: '', // empty due to missing MessageContent intent
    });

    expect(sdk.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '400500600' }),
      expect.stringContaining('MessageContent'),
    );
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('setTyping calls channel.sendTyping when client is connected', async () => {
    const sendTypingSpy = vi.fn().mockResolvedValue(undefined);
    const fakeClient = {
      on: vi.fn(),
      destroy: vi.fn(),
      channels: {
        fetch: vi
          .fn()
          .mockResolvedValue({ send: vi.fn(), sendTyping: sendTypingSpy }),
      },
    };

    const { ch } = buildIntegrationChannel(() => fakeClient);
    await ch.connect();

    await ch.setTyping('discord:100200300', true);
    expect(sendTypingSpy).toHaveBeenCalled();
  });
});
