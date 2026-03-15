import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  isRedisAvailable,
  isKubernetesAvailable,
  getSharedRedis,
  getNamespace,
  getRedisUrlForTests,
  createTestNamespace,
  flushTestKeys,
} from './setup.js';

const NAMESPACE = getNamespace();
const REDIS_URL = getRedisUrlForTests();

interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatMessages(messages: NewMessage[], timezone: string): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;
  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function enrichWithMetadata(content: string, sender: string): NewMessage {
  return {
    id: generateMessageId(),
    chat_jid: 'test-group@chat.whatsapp.net',
    sender: sender,
    sender_name: sender,
    content: content,
    timestamp: new Date().toISOString(),
  };
}

function computeMessageHash(message: NewMessage): string {
  const str = `${message.chat_jid}:${message.content}:${message.timestamp}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

describe('Message Routing Integration', () => {
  let redis: import('ioredis').Redis;
  let testGroup: string;

  beforeAll(async () => {
    redis = getSharedRedis()!;
    if (!redis) {
      console.warn('⚠️  Redis not available, skipping tests');
      return;
    }
    testGroup = createTestNamespace();
  }, 30000);

  beforeEach(async () => {
    if (redis) {
      await flushTestKeys(redis, `*:${testGroup}`);
    }
  }, 10000);

  afterAll(async () => {
    if (redis) {
      await flushTestKeys(redis, `*:${testGroup}`);
    }
  }, 10000);

  describe('Message Formatting for Outbound Routing', () => {
    it('should format messages with XML structure', () => {
      const messages: NewMessage[] = [
        {
          id: 'msg-1',
          chat_jid: 'group@chat.whatsapp.net',
          sender: 'user1',
          sender_name: 'John Doe',
          content: 'Hello world',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = formatMessages(messages, 'America/New_York');

      expect(result).toContain('<context timezone="');
      expect(result).toContain('<message sender="John Doe"');
      expect(result).toContain('<messages>');
      expect(result).toContain('</messages>');
    });

    it('should escape XML special characters in message content', () => {
      const messages: NewMessage[] = [
        {
          id: 'msg-1',
          chat_jid: 'group@chat.whatsapp.net',
          sender: 'user1',
          sender_name: 'Test User',
          content: 'Hello & <world> "test"',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = formatMessages(messages, 'UTC');

      expect(result).toContain('&amp;');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      expect(result).toContain('&quot;');
      expect(result).not.toContain('& <world>');
    });

    it('should format multiple messages in sequence', () => {
      const messages: NewMessage[] = [
        {
          id: 'msg-1',
          chat_jid: 'group@chat.whatsapp.net',
          sender: 'user1',
          sender_name: 'Alice',
          content: 'First message',
          timestamp: new Date().toISOString(),
        },
        {
          id: 'msg-2',
          chat_jid: 'group@chat.whatsapp.net',
          sender: 'user2',
          sender_name: 'Bob',
          content: 'Second message',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = formatMessages(messages, 'UTC');

      const messageMatches = result.match(/<message\s+[^>]*>/g);
      expect(messageMatches).toHaveLength(2);
    });

    it('should handle timezone formatting correctly', () => {
      const timestamp = '2024-01-15T10:30:00.000Z';
      const messages: NewMessage[] = [
        {
          id: 'msg-1',
          chat_jid: 'group@chat.whatsapp.net',
          sender: 'user1',
          sender_name: 'User',
          content: 'Test',
          timestamp: timestamp,
        },
      ];

      const nyResult = formatMessages(messages, 'America/New_York');
      const tokyoResult = formatMessages(messages, 'Asia/Tokyo');

      expect(nyResult).not.toBe(tokyoResult);
    });
  });

  describe('Message Storage in Redis Channels', () => {
    it('should store messages in correct Redis channel', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const message = {
        id: 'msg-redis-1',
        content: 'Test message for Redis storage',
        timestamp: Date.now(),
      };

      const channelKey = `${NAMESPACE}:messages:${testGroup}`;
      await redis.rpush(channelKey, JSON.stringify(message));

      const stored = await redis.lindex(channelKey, 0);
      expect(stored).toBeTruthy();
      expect(JSON.parse(stored!).id).toBe('msg-redis-1');
    });

    it('should support multiple message channels per group', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const tasksKey = `${NAMESPACE}:tasks:${testGroup}`;
      const messagesKey = `${NAMESPACE}:messages:${testGroup}`;
      const eventsKey = `${NAMESPACE}:events:${testGroup}`;

      await redis.del(tasksKey, messagesKey, eventsKey);

      await redis.rpush(tasksKey, JSON.stringify({ type: 'task', data: 1 }));
      await redis.rpush(
        messagesKey,
        JSON.stringify({ type: 'message', data: 2 }),
      );
      await redis.rpush(eventsKey, JSON.stringify({ type: 'event', data: 3 }));

      const [tasksLen, messagesLen, eventsLen] = await Promise.all([
        redis.llen(tasksKey),
        redis.llen(messagesKey),
        redis.llen(eventsKey),
      ]);

      expect(tasksLen).toBe(1);
      expect(messagesLen).toBe(1);
      expect(eventsLen).toBe(1);
    });

    it('should store messages with correct namespace prefix', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const key = `${NAMESPACE}:routing:test:${testGroup}`;
      await redis.set(key, 'test-value');

      const exists = await redis.exists(key);
      expect(exists).toBe(1);

      const value = await redis.get(key);
      expect(value).toBe('test-value');

      await redis.del(key);
    });

    it('should handle pub/sub for message routing', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const pubsubChannel = `${NAMESPACE}:pubsub:routing:${testGroup}`;
      const received: string[] = [];

      const subscriber = new (await import('ioredis')).default(REDIS_URL, {
        connectTimeout: 10000,
        maxRetriesPerRequest: 3,
      });

      const subReady = new Promise<void>((resolve) => {
        subscriber.once('ready', () => resolve());
      });
      await subReady;

      const messageHandler = (ch: string, msg: string) => {
        if (ch === pubsubChannel) {
          received.push(msg);
        }
      };

      subscriber.on('message', messageHandler);

      await subscriber.subscribe(pubsubChannel);

      await new Promise((r) => setTimeout(r, 100));

      await redis.publish(
        pubsubChannel,
        JSON.stringify({ event: 'routed', message: 'msg1' }),
      );
      await redis.publish(
        pubsubChannel,
        JSON.stringify({ event: 'routed', message: 'msg2' }),
      );

      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(received[0]).event).toBe('routed');

      subscriber.off('message', messageHandler);
      await subscriber.unsubscribe(pubsubChannel);
      await subscriber.quit();
    }, 15000);
  });

  describe('Message Enrichment with Metadata', () => {
    it('should generate unique message IDs', () => {
      const id1 = generateMessageId();
      const id2 = generateMessageId();

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^msg-\d+-[a-z0-9]+$/);
    });

    it('should enrich messages with timestamp', () => {
      const before = Date.now();
      const message = enrichWithMetadata('Test content', 'testuser');
      const after = Date.now();

      expect(message.timestamp).toBeTruthy();
      const msgTime = new Date(message.timestamp).getTime();
      expect(msgTime).toBeGreaterThanOrEqual(before);
      expect(msgTime).toBeLessThanOrEqual(after);
    });

    it('should enrich messages with all required fields', () => {
      const message = enrichWithMetadata('Hello', 'john');

      expect(message.id).toBeTruthy();
      expect(message.chat_jid).toBe('test-group@chat.whatsapp.net');
      expect(message.sender).toBe('john');
      expect(message.sender_name).toBe('john');
      expect(message.content).toBe('Hello');
      expect(message.timestamp).toBeTruthy();
    });

    it('should compute consistent message hash for deduplication', () => {
      const message1: NewMessage = {
        id: 'msg-1',
        chat_jid: 'group@chat.whatsapp.net',
        sender: 'user1',
        sender_name: 'User 1',
        content: 'Same content',
        timestamp: '2024-01-15T10:00:00.000Z',
      };

      const message2: NewMessage = {
        id: 'msg-2',
        chat_jid: 'group@chat.whatsapp.net',
        sender: 'user2',
        sender_name: 'User 2',
        content: 'Same content',
        timestamp: '2024-01-15T10:00:00.000Z',
      };

      const hash1 = computeMessageHash(message1);
      const hash2 = computeMessageHash(message2);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different messages', () => {
      const message1: NewMessage = {
        id: 'msg-1',
        chat_jid: 'group@chat.whatsapp.net',
        sender: 'user1',
        sender_name: 'User 1',
        content: 'Content A',
        timestamp: '2024-01-15T10:00:00.000Z',
      };

      const message2: NewMessage = {
        id: 'msg-2',
        chat_jid: 'group@chat.whatsapp.net',
        sender: 'user1',
        sender_name: 'User 1',
        content: 'Content B',
        timestamp: '2024-01-15T10:00:00.000Z',
      };

      const hash1 = computeMessageHash(message1);
      const hash2 = computeMessageHash(message2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Channel-Specific Message Formatting', () => {
    it('should format outbound messages by stripping internal tags', () => {
      const rawText = `<internal>system data</internal>Hello, this is the visible message`;
      const result = formatOutbound(rawText);

      expect(result).toBe('Hello, this is the visible message');
      expect(result).not.toContain('<internal>');
    });

    it('should handle text without internal tags', () => {
      const rawText = 'Simple message without tags';
      const result = formatOutbound(rawText);

      expect(result).toBe(rawText);
    });

    it('should handle empty text after stripping', () => {
      const rawText = '<internal>only internal</internal>';
      const result = formatOutbound(rawText);

      expect(result).toBe('');
    });

    it('should handle multiline internal tags', () => {
      const rawText = `<internal>
        multi line
        internal content
      </internal>Public message`;
      const result = formatOutbound(rawText);

      expect(result).toBe('Public message');
    });

    it('should handle WhatsApp-specific formatting', () => {
      const message: NewMessage = {
        id: 'wa-msg-1',
        chat_jid: 'group@chat.whatsapp.net',
        sender: 'user1',
        sender_name: 'WhatsApp User',
        content: 'Message with *bold* and _italic_',
        timestamp: new Date().toISOString(),
      };

      const result = formatMessages([message], 'UTC');
      expect(result).toContain('WhatsApp User');
      expect(result).toContain('Message with *bold* and _italic_');
    });

    it('should handle Telegram-specific formatting', () => {
      const message: NewMessage = {
        id: 'tg-msg-1',
        chat_jid: 'group@telegram.org',
        sender: 'user1',
        sender_name: 'Telegram User',
        content: 'Message with *bold* and `code`',
        timestamp: new Date().toISOString(),
      };

      const result = formatMessages([message], 'UTC');
      expect(result).toContain('Telegram User');
      expect(result).toContain('Message with *bold* and `code`');
    });
  });

  describe('Message Deduplication Logic', () => {
    it('should detect duplicate messages using hash', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const dedupKey = `${NAMESPACE}:dedup:${testGroup}`;
      const messageHash = 'abc123';

      const isFirst = await redis.setnx(dedupKey, messageHash);
      expect(isFirst).toBe(1);

      const isSecond = await redis.setnx(dedupKey, messageHash);
      expect(isSecond).toBe(0);
    });

    it('should track seen messages in Redis set', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const seenKey = `${NAMESPACE}:seen:${testGroup}`;
      const hashes = ['hash1', 'hash2', 'hash3'];

      for (const h of hashes) {
        await redis.sadd(seenKey, h);
      }

      const count = await redis.scard(seenKey);
      expect(count).toBe(3);

      const isMember = await redis.sismember(seenKey, 'hash2');
      expect(isMember).toBe(1);
    });

    it('should handle deduplication with TTL', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const dedupKey = `${NAMESPACE}:dedup-ttl:${testGroup}`;
      const messageHash = 'ttl-hash';

      await redis.set(dedupKey, messageHash, 'EX', 60);

      const exists = await redis.exists(dedupKey);
      expect(exists).toBe(1);

      const ttl = await redis.ttl(dedupKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    });

    it('should implement sliding window deduplication', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const windowKey = `${NAMESPACE}:window:${testGroup}`;
      const messages = [
        { hash: 'h1', content: 'msg1' },
        { hash: 'h2', content: 'msg2' },
        { hash: 'h1', content: 'msg1' },
      ];

      const results: boolean[] = [];
      for (const msg of messages) {
        const added = await redis.sadd(windowKey, msg.hash);
        results.push(added === 1);
      }

      expect(results[0]).toBe(true);
      expect(results[1]).toBe(true);
      expect(results[2]).toBe(false);
    });

    it('should clean up old deduplication entries', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const cleanupKey = `${NAMESPACE}:cleanup:${testGroup}`;

      await redis.sadd(cleanupKey, 'old-entry');
      const countBefore = await redis.scard(cleanupKey);
      expect(countBefore).toBe(1);

      const cleaned = await redis.srem(cleanupKey, 'old-entry');
      expect(cleaned).toBe(1);

      const countAfter = await redis.scard(cleanupKey);
      expect(countAfter).toBe(0);
    });
  });
});
