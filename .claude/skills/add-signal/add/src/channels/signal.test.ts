import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
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

import { SignalChannel, SignalChannelOpts } from './signal.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides?: { pollIntervalMs?: number; cliUrl?: string }) {
  return {
    cliUrl: overrides?.cliUrl ?? 'http://signal-cli:8080',
    phoneNumber: '+10000000000',
    pollIntervalMs: overrides?.pollIntervalMs ?? 60_000,
  };
}

function makeOpts(
  overrides?: Partial<SignalChannelOpts>,
): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:+19991112222': {
        name: 'Alice',
        folder: 'alice',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'signal:g.ABC123==': {
        name: 'Family',
        folder: 'family',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function makeDmEnvelope(overrides?: {
  sourceNumber?: string;
  sourceName?: string;
  message?: string;
  timestamp?: number;
}) {
  return {
    sourceNumber: overrides?.sourceNumber ?? '+19991112222',
    sourceName: overrides?.sourceName ?? 'Alice',
    dataMessage: {
      timestamp: overrides?.timestamp ?? 1700000000000,
      message: overrides?.message ?? 'Hello!',
    },
  };
}

function makeGroupEnvelope(overrides?: {
  sourceNumber?: string;
  sourceName?: string;
  message?: string;
  groupId?: string;
  timestamp?: number;
}) {
  return {
    sourceNumber: overrides?.sourceNumber ?? '+19991112222',
    sourceName: overrides?.sourceName ?? 'Alice',
    dataMessage: {
      timestamp: overrides?.timestamp ?? 1700000000000,
      message: overrides?.message ?? 'Group hello!',
      groupInfo: {
        groupId: overrides?.groupId ?? 'ABC123==',
        type: 'DELIVER',
      },
    },
  };
}

function stubFetch(response: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: async () => response,
      text: async () => (typeof response === 'string' ? response : JSON.stringify(response)),
    }),
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Connection lifecycle ────────────────────────────────────────────────

  describe('connection lifecycle', () => {
    it('resolves connect() immediately', async () => {
      const channel = new SignalChannel(makeConfig(), makeOpts());
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      await channel.disconnect();
    });

    it('isConnected() returns false before connect', () => {
      const channel = new SignalChannel(makeConfig(), makeOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false after disconnect', async () => {
      const channel = new SignalChannel(makeConfig(), makeOpts());
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnect() stops further polling', async () => {
      vi.useFakeTimers();
      stubFetch([]);
      const channel = new SignalChannel(
        makeConfig({ pollIntervalMs: 100 }),
        makeOpts(),
      );
      await channel.connect();
      await channel.disconnect();
      vi.advanceTimersByTime(500);
      // fetch should not have been called (poll never ran because interval > connect time)
      expect(fetch).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('has name "signal"', () => {
      const channel = new SignalChannel(makeConfig(), makeOpts());
      expect(channel.name).toBe('signal');
    });
  });

  // ── poll() ─────────────────────────────────────────────────────────────

  describe('poll()', () => {
    it('fetches from correct receive URL', async () => {
      stubFetch([]);
      const channel = new SignalChannel(
        makeConfig({ cliUrl: 'http://signal-cli:8080' }),
        makeOpts(),
      );
      await channel.poll();

      expect(fetch).toHaveBeenCalledWith(
        'http://signal-cli:8080/v1/receive/%2B10000000000',
      );
    });

    it('processes DM messages from the receive response', async () => {
      const envelope = makeDmEnvelope();
      stubFetch([{ envelope }]);
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      await channel.poll();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+19991112222',
        expect.objectContaining({
          chat_jid: 'signal:+19991112222',
          sender: '+19991112222',
          sender_name: 'Alice',
          content: 'Hello!',
          is_from_me: false,
        }),
      );
    });

    it('handles empty response gracefully', async () => {
      stubFetch([]);
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      await channel.poll();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles non-ok response gracefully', async () => {
      stubFetch('Error', false);
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      await expect(channel.poll()).resolves.toBeUndefined();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles fetch error gracefully', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      await expect(channel.poll()).resolves.toBeUndefined();
    });

    it('handles non-array response gracefully', async () => {
      stubFetch({ unexpected: true });
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      await channel.poll();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // ── handleEnvelope() ───────────────────────────────────────────────────

  describe('handleEnvelope()', () => {
    it('delivers DM to registered JID', () => {
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      channel.handleEnvelope(makeDmEnvelope());

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:+19991112222',
        expect.any(String),
        'Alice',
        'signal',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+19991112222',
        expect.objectContaining({
          chat_jid: 'signal:+19991112222',
          content: 'Hello!',
          is_from_me: false,
        }),
      );
    });

    it('delivers group message to registered group JID', () => {
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      channel.handleEnvelope(makeGroupEnvelope());

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:g.ABC123==',
        expect.any(String),
        'Alice',
        'signal',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:g.ABC123==',
        expect.objectContaining({
          chat_jid: 'signal:g.ABC123==',
          content: 'Group hello!',
        }),
      );
    });

    it('emits metadata but not message for unregistered DM', () => {
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      channel.handleEnvelope(makeDmEnvelope({ sourceNumber: '+19990000000' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:+19990000000',
        expect.any(String),
        expect.any(String),
        'signal',
        false,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('emits metadata but not message for unregistered group', () => {
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      channel.handleEnvelope(makeGroupEnvelope({ groupId: 'UNKNOWN==' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:g.UNKNOWN==',
        expect.any(String),
        expect.any(String),
        'signal',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores envelopes without dataMessage', () => {
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      channel.handleEnvelope({
        sourceNumber: '+19991112222',
        sourceName: 'Alice',
        // no dataMessage — receipt or sync event
      });
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores dataMessage without text (e.g. read receipts)', () => {
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      channel.handleEnvelope({
        sourceNumber: '+19991112222',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          // no message field
        },
      });
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('converts dataMessage.timestamp to ISO string', () => {
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      const unixMs = 1704067200000; // 2024-01-01T00:00:00.000Z
      channel.handleEnvelope(makeDmEnvelope({ timestamp: unixMs }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+19991112222',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('falls back to source when sourceNumber is absent', () => {
      const opts = makeOpts({
        registeredGroups: vi.fn(() => ({
          'signal:uuid-abc': {
            name: 'UUID Contact',
            folder: 'uuid-contact',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SignalChannel(makeConfig(), opts);
      channel.handleEnvelope({
        source: 'uuid-abc',
        sourceName: 'UUID Person',
        dataMessage: { timestamp: 1700000000000, message: 'Hi' },
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:uuid-abc',
        expect.objectContaining({ sender: 'uuid-abc' }),
      );
    });

    it('uses source as sender_name when sourceName is absent', () => {
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      channel.handleEnvelope({
        sourceNumber: '+19991112222',
        dataMessage: { timestamp: 1700000000000, message: 'Anon msg' },
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+19991112222',
        expect.objectContaining({ sender_name: '+19991112222' }),
      );
    });

    it('generates unique message IDs for sequential messages', () => {
      const opts = makeOpts();
      const channel = new SignalChannel(makeConfig(), opts);
      channel.handleEnvelope(makeDmEnvelope({ timestamp: 1000 }));
      channel.handleEnvelope(makeDmEnvelope({ timestamp: 1000 }));

      const ids = (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls.map(
        ([, msg]: [string, { id: string }]) => msg.id,
      );
      expect(ids[0]).not.toBe(ids[1]);
    });
  });

  // ── sendMessage() ──────────────────────────────────────────────────────

  describe('sendMessage()', () => {
    it('sends DM to correct recipient via POST /v2/send', async () => {
      stubFetch({ timestamp: 123 });
      const channel = new SignalChannel(makeConfig(), makeOpts());
      await channel.connect();
      await channel.sendMessage('signal:+19991112222', 'Hello Alice');
      await channel.disconnect();

      expect(fetch).toHaveBeenCalledWith(
        'http://signal-cli:8080/v2/send',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('+19991112222'),
        }),
      );

      const body = JSON.parse(
        (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.recipients).toContain('+19991112222');
      expect(body.message).toBe('Hello Alice');
      expect(body.number).toBe('+10000000000');
    });

    it('sends group message using group_id, not recipients', async () => {
      stubFetch({ timestamp: 123 });
      const channel = new SignalChannel(makeConfig(), makeOpts());
      await channel.connect();
      await channel.sendMessage('signal:g.ABC123==', 'Hello group');
      await channel.disconnect();

      const body = JSON.parse(
        (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.group_id).toBe('ABC123==');
      expect(body.recipients).toEqual([]);
      expect(body.message).toBe('Hello group');
    });

    it('splits message longer than 4000 characters', async () => {
      stubFetch({ timestamp: 123 });
      const channel = new SignalChannel(makeConfig(), makeOpts());
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('signal:+19991112222', longText);
      await channel.disconnect();

      // Two chunks: 4000 + 1000
      expect(fetch).toHaveBeenCalledTimes(2);
      const bodies = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
        ([, opts]: [string, RequestInit]) => JSON.parse(opts.body as string),
      );
      expect(bodies[0].message).toHaveLength(4000);
      expect(bodies[1].message).toHaveLength(1000);
    });

    it('sends exactly one request for message at 4000 chars', async () => {
      stubFetch({ timestamp: 123 });
      const channel = new SignalChannel(makeConfig(), makeOpts());
      await channel.connect();
      await channel.sendMessage('signal:+19991112222', 'y'.repeat(4000));
      await channel.disconnect();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does nothing when not connected', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const channel = new SignalChannel(makeConfig(), makeOpts());
      // Don't connect
      await channel.sendMessage('signal:+19991112222', 'Hello');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('handles send failure gracefully', async () => {
      stubFetch('Server error', false);
      const channel = new SignalChannel(makeConfig(), makeOpts());
      await channel.connect();
      // Should not throw
      await expect(
        channel.sendMessage('signal:+19991112222', 'Will fail'),
      ).resolves.toBeUndefined();
      await channel.disconnect();
    });

    it('handles fetch network error gracefully', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
      const channel = new SignalChannel(makeConfig(), makeOpts());
      await channel.connect();
      await expect(
        channel.sendMessage('signal:+19991112222', 'Will fail'),
      ).resolves.toBeUndefined();
      await channel.disconnect();
    });
  });

  // ── ownsJid() ──────────────────────────────────────────────────────────

  describe('ownsJid()', () => {
    it('owns DM JIDs with signal: prefix', () => {
      const channel = new SignalChannel(makeConfig(), makeOpts());
      expect(channel.ownsJid('signal:+19991112222')).toBe(true);
    });

    it('owns group JIDs with signal:g. prefix', () => {
      const channel = new SignalChannel(makeConfig(), makeOpts());
      expect(channel.ownsJid('signal:g.ABC123==')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SignalChannel(makeConfig(), makeOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel(makeConfig(), makeOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own IRC JIDs', () => {
      const channel = new SignalChannel(makeConfig(), makeOpts());
      expect(channel.ownsJid('irc:#general@irc.example.com:6697')).toBe(false);
    });
  });
});
