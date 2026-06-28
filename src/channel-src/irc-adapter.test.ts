import { describe, it, expect, vi } from 'vitest';
import register from '../../helm/kubeclaw/files/channel-src/irc/channel-entry.js';

function fakeSdk(env: Record<string, string>) {
  const factories: Record<string, any> = {};
  return {
    sdk: {
      registerChannel: (name: string, f: any) => {
        factories[name] = f;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      readEnvFile: () => env,
      assistantName: 'Andy',
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
      'irc:#x@irc.test:6697': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

describe('irc-adapter: factory registration', () => {
  it('registers an irc factory that builds a channel when creds are present', () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'bot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    const ch = factories['irc'](fakeOpts());
    expect(ch).not.toBeNull();
  });

  it('factory returns null when creds are missing', () => {
    const { sdk, factories } = fakeSdk({});
    register(sdk);
    expect(factories['irc'](fakeOpts())).toBeNull();
  });

  it('factory returns null when IRC_SERVER is missing', () => {
    const { sdk, factories } = fakeSdk({ IRC_NICK: 'bot', IRC_CHANNELS: '#x' });
    register(sdk);
    expect(factories['irc'](fakeOpts())).toBeNull();
  });

  it('factory returns null when IRC_NICK is missing', () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    expect(factories['irc'](fakeOpts())).toBeNull();
  });

  it('factory returns null when IRC_CHANNELS is missing', () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'bot',
    });
    register(sdk);
    expect(factories['irc'](fakeOpts())).toBeNull();
  });
});

describe('irc-adapter: ownsJid', () => {
  it('owns irc: JIDs matching its server and port', () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'bot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    const ch = factories['irc'](fakeOpts());
    expect(ch.ownsJid('irc:#x@irc.test:6697')).toBe(true);
    expect(ch.ownsJid('irc:#other@irc.test:6697')).toBe(true);
  });

  it('does not own non-irc JIDs', () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'bot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    const ch = factories['irc'](fakeOpts());
    expect(ch.ownsJid('http:alice')).toBe(false);
    expect(ch.ownsJid('tg:123456')).toBe(false);
    expect(ch.ownsJid('12345@g.us')).toBe(false);
  });

  it('does not own irc JID for a different server', () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'bot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    const ch = factories['irc'](fakeOpts());
    expect(ch.ownsJid('irc:#x@other.server.com:6697')).toBe(false);
  });

  it('uses default port 6697 when IRC_PORT not in env', () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'bot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    const ch = factories['irc'](fakeOpts());
    expect(ch.ownsJid('irc:#x@irc.test:6697')).toBe(true);
  });
});

describe('irc-adapter: handleMessage trigger rewrite', () => {
  function buildChannel(sdk: any, factories: Record<string, any>, opts?: any) {
    const ch = factories['irc'](opts ?? fakeOpts());
    // Stub the IRC client so we don't attempt real network connections
    ch.client = {
      conn: { connected: true },
      say: vi.fn(),
      on: vi.fn(),
      join: vi.fn(),
      disconnect: vi.fn(),
    };
    return ch;
  }

  it('rewrites @nick mention to @assistantName prefix when not already triggered', () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'TestBot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    const opts = fakeOpts();
    const ch = buildChannel(sdk, factories, opts);

    const mockMsg = { time: Math.floor(Date.now() / 1000) };
    ch.handleMessage('alice', '#x', '@TestBot what time is it?', mockMsg);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'irc:#x@irc.test:6697',
      expect.objectContaining({
        content: '@Andy @TestBot what time is it?',
      }),
    );
  });

  it('does not rewrite when message already starts with @assistantName', () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'TestBot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    const opts = fakeOpts();
    const ch = buildChannel(sdk, factories, opts);

    const mockMsg = { time: Math.floor(Date.now() / 1000) };
    ch.handleMessage('alice', '#x', '@Andy hello', mockMsg);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'irc:#x@irc.test:6697',
      expect.objectContaining({ content: '@Andy hello' }),
    );
  });

  it('ignores messages from self (own nick)', () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'TestBot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    const opts = fakeOpts();
    const ch = buildChannel(sdk, factories, opts);

    const mockMsg = { time: Math.floor(Date.now() / 1000) };
    ch.handleMessage('TestBot', '#x', 'My own message', mockMsg);

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('ignores messages from unregistered channels', () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'bot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    // registeredGroups returns empty — nothing registered
    const opts = fakeOpts({ registeredGroups: () => ({}) });
    const ch = buildChannel(sdk, factories, opts);

    const mockMsg = { time: Math.floor(Date.now() / 1000) };
    ch.handleMessage('alice', '#x', 'Hello', mockMsg);

    expect(opts.onMessage).not.toHaveBeenCalled();
  });
});

describe('irc-adapter: sendMessage chunking', () => {
  function buildConnectedChannel(sdk: any, factories: Record<string, any>) {
    const opts = fakeOpts();
    const ch = factories['irc'](opts);
    const saySpy = vi.fn();
    ch.client = {
      conn: { connected: true },
      say: saySpy,
      on: vi.fn(),
      join: vi.fn(),
      disconnect: vi.fn(),
    };
    return { ch, saySpy, opts };
  }

  it('sends short message in one call', async () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'bot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    const { ch, saySpy } = buildConnectedChannel(sdk, factories);

    await ch.sendMessage('irc:#x@irc.test:6697', 'Hello');
    expect(saySpy).toHaveBeenCalledTimes(1);
    expect(saySpy).toHaveBeenCalledWith('#x', 'Hello');
  });

  it('splits messages exceeding 480 chars into multiple calls', async () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'bot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    const { ch, saySpy } = buildConnectedChannel(sdk, factories);

    const longText = 'x'.repeat(1000);
    await ch.sendMessage('irc:#x@irc.test:6697', longText);
    // 1000 chars / 480 = 3 chunks (480 + 480 + 40)
    expect(saySpy).toHaveBeenCalledTimes(3);
    expect(saySpy.mock.calls[0][1].length).toBe(480);
    expect(saySpy.mock.calls[1][1].length).toBe(480);
    expect(saySpy.mock.calls[2][1].length).toBe(40);
  });

  it('does nothing when client is not initialized', async () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'bot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    const opts = fakeOpts();
    const ch = factories['irc'](opts);
    // client intentionally left null (not connected)
    await expect(
      ch.sendMessage('irc:#x@irc.test:6697', 'hello'),
    ).resolves.toBeUndefined();
    expect(sdk.logger.warn).toHaveBeenCalledWith('IRC client not initialized');
  });

  it('warns on invalid JID format', async () => {
    const { sdk, factories } = fakeSdk({
      IRC_SERVER: 'irc.test',
      IRC_NICK: 'bot',
      IRC_CHANNELS: '#x',
    });
    register(sdk);
    const opts = fakeOpts();
    const ch = factories['irc'](opts);
    const saySpy = vi.fn();
    ch.client = { conn: { connected: true }, say: saySpy };

    await ch.sendMessage('not-a-valid-jid', 'hello');
    expect(saySpy).not.toHaveBeenCalled();
    expect(sdk.logger.warn).toHaveBeenCalledWith(
      { jid: 'not-a-valid-jid' },
      'Invalid IRC JID format',
    );
  });
});
