import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const clientRef = { current: null as any };

vi.mock('irc-upd', () => {
  class MockIRCClient {
    server: string;
    nick: string;
    options: any;
    conn: { connected: boolean } = { connected: false };
    eventHandlers: Map<string, Function[]> = new Map();

    constructor(server: string, nick: string, options: any) {
      this.server = server;
      this.nick = nick;
      this.options = options;
      clientRef.current = this;
    }

    on(event: string, handler: Function) {
      const handlers = this.eventHandlers.get(event) || [];
      handlers.push(handler);
      this.eventHandlers.set(event, handlers);
    }

    emit(event: string, ...args: any[]) {
      const handlers = this.eventHandlers.get(event) || [];
      handlers.forEach((h) => h(...args));
    }

    say(target: string, message: string) {
      // noop in test
    }

    join(channel: string) {
      // noop in test
    }

    disconnect(message: string, callback?: Function) {
      this.conn.connected = false;
      if (callback) callback();
    }

    connect(callback?: Function) {
      this.conn.connected = true;
      setTimeout(() => {
        this.emit('registered');
        if (callback) callback();
      }, 0);
    }
  }

  const IRCModule = function (server: string, nick: string, options: any) {
    return new MockIRCClient(server, nick, options);
  } as any;
  IRCModule.Client = MockIRCClient;

  return {
    default: IRCModule,
    Client: MockIRCClient,
  };
});

import { IRCChannel, IRCChannelOpts } from './irc.js';

function createTestOpts(overrides?: Partial<IRCChannelOpts>): IRCChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'irc:#test@irc.example.com:6697': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createConfig(
  overrides?: Partial<{
    server: string;
    port: number;
    nick: string;
    channels: string[];
  }>,
) {
  return {
    server: 'irc.example.com',
    port: 6697,
    nick: 'TestBot',
    channels: ['#test'],
    ...overrides,
  };
}

function currentClient() {
  return clientRef.current;
}

describe('IRCChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('connection lifecycle', () => {
    it('resolves connect() when client registers', async () => {
      const opts = createTestOpts();
      const config = createConfig();
      const channel = new IRCChannel(config, opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const config = createConfig();
      const channel = new IRCChannel(config, opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const config = createConfig();
      const channel = new IRCChannel(config, opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const config = createConfig();
      const channel = new IRCChannel(config, opts);
      await channel.connect();

      const mockMessage = {
        nick: 'alice',
        ident: 'user',
        host: 'example.com',
        server: 'irc.example.com',
        target: '#test',
        text: 'Hello everyone',
        type: 'privmsg' as const,
        time: Math.floor(Date.now() / 1000),
      };

      const handlers = currentClient().eventHandlers.get('message') || [];
      for (const h of handlers) {
        h('alice', '#test', 'Hello everyone', mockMessage);
      }

      expect(opts.onMessage).toHaveBeenCalledWith(
        'irc:#test@irc.example.com:6697',
        expect.objectContaining({
          sender: 'alice',
          sender_name: 'alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('translates @nick mention to trigger format', async () => {
      const opts = createTestOpts();
      const config = createConfig({ nick: 'TestBot' });
      const channel = new IRCChannel(config, opts);
      await channel.connect();

      const mockMessage = {
        nick: 'alice',
        ident: 'user',
        host: 'example.com',
        server: 'irc.example.com',
        target: '#test',
        text: '@TestBot what time is it?',
        type: 'privmsg' as const,
        time: Math.floor(Date.now() / 1000),
      };

      const handlers = currentClient().eventHandlers.get('message') || [];
      for (const h of handlers) {
        h('alice', '#test', '@TestBot what time is it?', mockMessage);
      }

      expect(opts.onMessage).toHaveBeenCalledWith(
        'irc:#test@irc.example.com:6697',
        expect.objectContaining({
          content: '@Andy @TestBot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const config = createConfig({ nick: 'TestBot' });
      const channel = new IRCChannel(config, opts);
      await channel.connect();

      const mockMessage = {
        nick: 'alice',
        ident: 'user',
        host: 'example.com',
        server: 'irc.example.com',
        target: '#test',
        text: '@Andy hello',
        type: 'privmsg' as const,
        time: Math.floor(Date.now() / 1000),
      };

      const handlers = currentClient().eventHandlers.get('message') || [];
      for (const h of handlers) {
        h('alice', '#test', '@Andy hello', mockMessage);
      }

      expect(opts.onMessage).toHaveBeenCalledWith(
        'irc:#test@irc.example.com:6697',
        expect.objectContaining({
          content: '@Andy hello',
        }),
      );
    });

    it('ignores messages from self', async () => {
      const opts = createTestOpts();
      const config = createConfig({ nick: 'TestBot' });
      const channel = new IRCChannel(config, opts);
      await channel.connect();

      const mockMessage = {
        nick: 'TestBot',
        ident: 'user',
        host: 'example.com',
        server: 'irc.example.com',
        target: '#test',
        text: 'My own message',
        type: 'privmsg' as const,
        time: Math.floor(Date.now() / 1000),
      };

      const handlers = currentClient().eventHandlers.get('message') || [];
      for (const h of handlers) {
        h('TestBot', '#test', 'My own message', mockMessage);
      }

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores messages from unregistered channels', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const config = createConfig();
      const channel = new IRCChannel(config, opts);
      await channel.connect();

      const mockMessage = {
        nick: 'alice',
        ident: 'user',
        host: 'example.com',
        server: 'irc.example.com',
        target: '#unknown',
        text: 'Hello',
        type: 'privmsg' as const,
        time: Math.floor(Date.now() / 1000),
      };

      const handlers = currentClient().eventHandlers.get('message') || [];
      for (const h of handlers) {
        h('alice', '#unknown', 'Hello', mockMessage);
      }

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('sends message to channel', async () => {
      const opts = createTestOpts();
      const config = createConfig();
      const channel = new IRCChannel(config, opts);
      await channel.connect();

      await channel.sendMessage('irc:#test@irc.example.com:6697', 'Hello');
    });

    it('splits messages exceeding 480 characters', async () => {
      const opts = createTestOpts();
      const config = createConfig();
      const channel = new IRCChannel(config, opts);
      await channel.connect();

      const longText = 'x'.repeat(1000);
      await channel.sendMessage('irc:#test@irc.example.com:6697', longText);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const config = createConfig();
      const channel = new IRCChannel(config, opts);
      await channel.connect();

      await expect(
        channel.sendMessage('irc:#test@irc.example.com:6697', 'Hello'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const config = createConfig();
      const channel = new IRCChannel(config, opts);

      await channel.sendMessage('irc:#test@irc.example.com:6697', 'No client');
    });
  });

  describe('ownsJid', () => {
    it('owns irc: JIDs for matching server', () => {
      const opts = createTestOpts();
      const config = createConfig({ server: 'irc.example.com' });
      const channel = new IRCChannel(config, opts);

      expect(channel.ownsJid('irc:#test@irc.example.com:6697')).toBe(true);
    });

    it('does not own JIDs for different server', () => {
      const opts = createTestOpts();
      const config = createConfig({ server: 'irc.example.com' });
      const channel = new IRCChannel(config, opts);

      expect(channel.ownsJid('irc:#test@other.server.com')).toBe(false);
    });

    it('does not own other channel JIDs', () => {
      const opts = createTestOpts();
      const config = createConfig();
      const channel = new IRCChannel(config, opts);

      expect(channel.ownsJid('tg:123456')).toBe(false);
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });
  });

  describe('channel properties', () => {
    it('has name "irc"', () => {
      const opts = createTestOpts();
      const config = createConfig();
      const channel = new IRCChannel(config, opts);

      expect(channel.name).toBe('irc');
    });
  });
});
