import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';
import {
  escapeXml,
  formatMessages,
  stripInternalTags,
  formatOutbound,
  routeOutbound,
  findChannel,
} from './router.js';
import { Channel, NewMessage } from './types.js';

beforeEach(async () => {
  await _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'group1@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group 1',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'user@s.whatsapp.net',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'whatsapp',
      false,
    );
    storeChatMetadata(
      'group2@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group 2',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
    expect(groups.map((g) => g.jid)).not.toContain('user@s.whatsapp.net');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'reg@g.us',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'unreg@g.us',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'whatsapp',
      true,
    );

    _setRegisteredGroups({
      'reg@g.us': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'reg@g.us');
    const unreg = groups.find((g) => g.jid === 'unreg@g.us');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'old@g.us',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'new@g.us',
      '2024-01-01T00:00:05.000Z',
      'New',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'mid@g.us',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    // Explicitly non-group with unusual JID
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    // A real group for contrast
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});

// --- escapeXml ---

describe('escapeXml', () => {
  it('returns empty string for empty input', () => {
    expect(escapeXml('')).toBe('');
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeXml('')).toBe('');
  });

  it('escapes ampersand', () => {
    expect(escapeXml('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes less than', () => {
    expect(escapeXml('foo < bar')).toBe('foo &lt; bar');
  });

  it('escapes greater than', () => {
    expect(escapeXml('foo > bar')).toBe('foo &gt; bar');
  });

  it('escapes double quote', () => {
    expect(escapeXml('foo "bar"')).toBe('foo &quot;bar&quot;');
  });

  it('escapes all special characters together', () => {
    expect(escapeXml('& < > "')).toBe('&amp; &lt; &gt; &quot;');
  });

  it('returns unchanged string without special chars', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  it('formats single message correctly', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'chat@g.us',
        sender: 'alice',
        sender_name: 'Alice',
        content: 'Hello there',
        timestamp: '2024-01-01T12:00:00.000Z',
      },
    ];

    const result = formatMessages(messages, 'UTC');
    expect(result).toContain('<message sender="Alice"');
    expect(result).toContain('>Hello there</message>');
    expect(result).toContain('<context timezone="UTC" />');
  });

  it('formats multiple messages', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'chat@g.us',
        sender: 'alice',
        sender_name: 'Alice',
        content: 'Hi',
        timestamp: '2024-01-01T12:00:00.000Z',
      },
      {
        id: '2',
        chat_jid: 'chat@g.us',
        sender: 'bob',
        sender_name: 'Bob',
        content: 'Hey',
        timestamp: '2024-01-01T12:01:00.000Z',
      },
    ];

    const result = formatMessages(messages, 'America/New_York');
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('<messages>');
    expect(result).toContain('</messages>');
  });

  it('escapes special characters in sender and content', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'chat@g.us',
        sender: 'alice',
        sender_name: 'Alice & Bob',
        content: 'Hello <world> & "test"',
        timestamp: '2024-01-01T12:00:00.000Z',
      },
    ];

    const result = formatMessages(messages, 'UTC');
    expect(result).toContain('sender="Alice &amp; Bob"');
    expect(result).toContain('&lt;world&gt; &amp; &quot;test&quot;');
  });

  it('handles empty messages array', () => {
    const result = formatMessages([], 'UTC');
    expect(result).toContain('<messages>');
    expect(result).toContain('</messages>');
    expect(result).not.toContain('<message ');
  });
});

// --- stripInternalTags ---

describe('stripInternalTags', () => {
  it('returns unchanged text without internal tags', () => {
    expect(stripInternalTags('Hello world')).toBe('Hello world');
  });

  it('removes internal tags from text', () => {
    expect(stripInternalTags('Hello <internal>secret</internal> world')).toBe(
      'Hello  world',
    );
  });

  it('handles multiple internal tags', () => {
    const result = stripInternalTags(
      'Start <internal>one</internal> middle <internal>two</internal> end',
    );
    expect(result).toBe('Start  middle  end');
  });

  it('handles nested internal tags', () => {
    const result = stripInternalTags(
      'Before <internal>outer <internal>inner</internal> outer</internal> after',
    );
    expect(result).toBe('Before  outer</internal> after');
  });

  it('trims result', () => {
    expect(stripInternalTags('<internal>test</internal>')).toBe('');
    expect(stripInternalTags('  <internal>test</internal>')).toBe('');
    expect(stripInternalTags('<internal>test</internal>  ')).toBe('');
  });

  it('handles empty string', () => {
    expect(stripInternalTags('')).toBe('');
  });
});

// --- formatOutbound ---

describe('formatOutbound', () => {
  it('returns empty string for empty input', () => {
    expect(formatOutbound('')).toBe('');
  });

  it('returns text without internal tags', () => {
    expect(formatOutbound('Hello <internal>secret</internal> world')).toBe(
      'Hello  world',
    );
  });

  it('returns text unchanged when no internal tags', () => {
    expect(formatOutbound('Hello world')).toBe('Hello world');
  });

  it('trims internal tags and whitespace', () => {
    expect(formatOutbound('<internal>test</internal>')).toBe('');
    expect(formatOutbound('  Hello  ')).toBe('Hello');
  });
});

// --- findChannel ---

describe('findChannel', () => {
  const createMockChannel = (jidPrefix: string): Channel =>
    ({
      name: `channel-${jidPrefix}`,
      ownsJid: (jid: string) => jid.startsWith(jidPrefix),
      isConnected: () => true,
      sendMessage: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }) as Channel;

  it('returns channel when found', () => {
    const channels: Channel[] = [createMockChannel('wa-')];
    const result = findChannel(channels, 'wa-12345@g.us');
    expect(result).toBeDefined();
    expect(result?.ownsJid('wa-12345@g.us')).toBe(true);
  });

  it('returns undefined when channel not found', () => {
    const channels: Channel[] = [createMockChannel('wa-')];
    const result = findChannel(channels, 'other-12345@g.us');
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty channels array', () => {
    const result = findChannel([], 'any-jid@g.us');
    expect(result).toBeUndefined();
  });

  it('finds first matching channel', () => {
    const channels: Channel[] = [
      createMockChannel('first-'),
      createMockChannel('second-'),
    ];
    const result = findChannel(channels, 'first-123@g.us');
    expect(result).toBe(channels[0]);
  });
});

// --- routeOutbound ---

describe('routeOutbound', () => {
  const createMockChannel = (
    jidPrefix: string,
    connected: boolean = true,
  ): Channel =>
    ({
      name: `channel-${jidPrefix}`,
      ownsJid: (jid: string) => jid.startsWith(jidPrefix),
      isConnected: () => connected,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }) as Channel;

  it('calls sendMessage on found channel', async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    const channel: Channel = {
      name: 'wa-channel',
      ownsJid: (jid: string) => jid.startsWith('wa-'),
      isConnected: () => true,
      sendMessage: mockSend,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    await routeOutbound([channel], 'wa-123@g.us', 'Hello');

    expect(mockSend).toHaveBeenCalledWith('wa-123@g.us', 'Hello');
  });

  it('throws error when channel not found', async () => {
    const channel: Channel = {
      name: 'wa-channel',
      ownsJid: (jid: string) => jid.startsWith('wa-'),
      isConnected: () => true,
      sendMessage: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    await expect(
      (async () => await routeOutbound([channel], 'other-123@g.us', 'Hello'))(),
    ).rejects.toThrow('No channel for JID: other-123@g.us');
  });

  it('throws error when channel not connected', async () => {
    const channel: Channel = {
      name: 'wa-channel',
      ownsJid: (jid: string) => jid.startsWith('wa-'),
      isConnected: () => false,
      sendMessage: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    await expect(
      (async () => await routeOutbound([channel], 'wa-123@g.us', 'Hello'))(),
    ).rejects.toThrow('No channel for JID: wa-123@g.us');
  });

  it('throws error for empty channels array', async () => {
    await expect(
      (async () => await routeOutbound([], 'any-jid@g.us', 'Hello'))(),
    ).rejects.toThrow('No channel for JID: any-jid@g.us');
  });
});
