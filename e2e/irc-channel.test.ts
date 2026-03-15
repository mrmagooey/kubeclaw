/**
 * IRC Channel End-to-End Tests
 *
 * These tests verify the IRC channel implementation using a real
 * IRC client connecting to a mock IRC server.
 */
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
  startIRCServer,
  stopIRCServer,
  getIRCServer,
} from './lib/irc-server.js';
import { IRCChannel, IRCChannelOpts } from '../src/channels/irc.js';
import { vi } from 'vitest';
import { waitFor } from './setup.js';

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

describe('IRC Channel End-to-End', () => {
  let ircServer: ReturnType<typeof getIRCServer>;
  let channel: IRCChannel | null = null;
  let receivedMessages: { chatJid: string; message: NewMessage }[] = [];
  let receivedMetadata: {
    chatJid: string;
    timestamp: string;
    name?: string;
    channel?: string;
    isGroup?: boolean;
  }[] = [];

  const IRC_PORT = 16667;
  const IRC_SERVER = 'localhost';
  const IRC_NICK = 'NanoClawBot';
  const IRC_CHANNEL = '#test-e2e';

  function createTestOpts(): IRCChannelOpts {
    return {
      onMessage: (chatJid: string, message: NewMessage) => {
        receivedMessages.push({ chatJid, message });
      },
      onChatMetadata: (
        chatJid: string,
        timestamp: string,
        name?: string,
        channel?: string,
        isGroup?: boolean,
      ) => {
        receivedMetadata.push({ chatJid, timestamp, name, channel, isGroup });
      },
      registeredGroups: () => ({
        [`irc:${IRC_CHANNEL.toLowerCase()}@${IRC_SERVER}:${IRC_PORT}`]: {
          name: 'Test IRC Channel',
          folder: 'test-irc',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      }),
    };
  }

  beforeAll(async () => {
    console.log('\n🚀 Starting Mock IRC Server...');
    ircServer = await startIRCServer(IRC_PORT);
    console.log(`✅ Mock IRC Server running on ${IRC_SERVER}:${IRC_PORT}\n`);
  }, 30000);

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
    console.log('\n🧹 Stopping Mock IRC Server...');
    await stopIRCServer();
    console.log('✅ Mock IRC Server stopped\n');
  }, 30000);

  beforeEach(() => {
    receivedMessages = [];
    receivedMetadata = [];
    // Also clear server-side message history so tests don't see each other's messages
    ircServer?.clearMessages();
  });

  describe('Connection Lifecycle', () => {
    it('should connect to IRC server successfully', async () => {
      const config = {
        server: IRC_SERVER,
        port: IRC_PORT,
        nick: IRC_NICK,
        channels: [IRC_CHANNEL],
      };

      channel = new IRCChannel(config, createTestOpts());

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(ircServer?.getConnectedClients()).toContain(IRC_NICK);
    }, 10000);

    it('should join configured channels after connection', async () => {
      // Poll instead of fixed sleep — resolves as soon as the JOIN is processed
      await waitFor(
        () =>
          (ircServer?.getChannels() ?? [])
            .map((c) => c.toLowerCase())
            .includes(IRC_CHANNEL.toLowerCase()),
        3000,
      );

      const channels = ircServer?.getChannels() || [];
      expect(channels.map((c) => c.toLowerCase())).toContain(
        IRC_CHANNEL.toLowerCase(),
      );
    }, 5000);

    it('should disconnect cleanly', async () => {
      if (!channel) {
        console.warn('⚠️  Channel not connected, skipping');
        return;
      }

      await channel.disconnect();

      // Wait for server to process disconnect
      await new Promise((r) => setTimeout(r, 200));

      expect(channel.isConnected()).toBe(false);
      expect(ircServer?.getConnectedClients()).not.toContain(IRC_NICK);
    }, 5000);
  });

  describe('Message Handling', () => {
    beforeAll(async () => {
      // Ensure channel is connected before message tests
      if (!channel || !channel.isConnected()) {
        const config = {
          server: IRC_SERVER,
          port: IRC_PORT,
          nick: IRC_NICK,
          channels: [IRC_CHANNEL],
        };
        channel = new IRCChannel(config, createTestOpts());
        await channel.connect();
        await waitFor(
          () =>
            (ircServer?.getChannels() ?? [])
              .map((c) => c.toLowerCase())
              .includes(IRC_CHANNEL.toLowerCase()),
          3000,
        );
      }
    });

    it('should receive and process messages from IRC channel', async () => {
      const testMessage = 'Hello from IRC test!';
      const senderNick = 'TestUser';

      // Simulate a message from the server
      ircServer?.simulateMessage(senderNick, IRC_CHANNEL, testMessage);

      // Poll until the message arrives
      await waitFor(() => receivedMessages.length > 0, 3000);

      expect(receivedMessages.length).toBeGreaterThan(0);
      expect(receivedMessages[0].message.sender).toBe(senderNick);
      expect(receivedMessages[0].message.content).toBe(testMessage);
      expect(receivedMessages[0].message.is_from_me).toBe(false);
    }, 5000);

    it('should handle @nick mentions by translating to trigger format', async () => {
      const mentionMessage = `@${IRC_NICK} what time is it?`;
      const senderNick = 'Alice';

      receivedMessages = [];

      ircServer?.simulateMessage(senderNick, IRC_CHANNEL, mentionMessage);

      await waitFor(() => receivedMessages.length > 0, 3000);

      expect(receivedMessages.length).toBeGreaterThan(0);
      expect(receivedMessages[0].message.content).toContain('@Andy');
      expect(receivedMessages[0].message.content).toContain(mentionMessage);
    }, 5000);

    it('should ignore messages from itself', async () => {
      const selfMessage = 'My own message';

      receivedMessages = [];

      ircServer?.simulateMessage(IRC_NICK, IRC_CHANNEL, selfMessage);

      // Short fixed wait — we're asserting nothing arrives, so polling isn't applicable
      await new Promise((r) => setTimeout(r, 200));

      expect(receivedMessages.length).toBe(0);
    }, 5000);

    it('should ignore messages from unregistered channels', async () => {
      const unregisteredChannel = '#unregistered';
      const message = 'Message to unregistered channel';

      receivedMessages = [];

      ircServer?.simulateMessage('RandomUser', unregisteredChannel, message);

      // Short fixed wait — asserting nothing arrives, so polling isn't applicable
      await new Promise((r) => setTimeout(r, 200));

      expect(receivedMessages.length).toBe(0);
    }, 5000);
  });

  describe('Message Sending', () => {
    it('should send messages to IRC channel', async () => {
      if (!channel || !channel.isConnected()) {
        console.warn('⚠️  Channel not connected, skipping');
        return;
      }

      const messageText = 'Test message from NanoClaw!';
      const chatJid = `irc:${IRC_CHANNEL.toLowerCase()}@${IRC_SERVER}:${IRC_PORT}`;

      await channel.sendMessage(chatJid, messageText);

      // Poll until the server records the outgoing PRIVMSG
      await waitFor(
        () =>
          (ircServer?.getChannelMessages(IRC_CHANNEL.toLowerCase()) ?? []).some(
            (m) => m.text === messageText,
          ),
        2000,
      );
      const sent = ircServer?.getChannelMessages(IRC_CHANNEL.toLowerCase()) ?? [];
      expect(sent.some((m) => m.text === messageText)).toBe(true);
    }, 5000);

    it('should split long messages into multiple parts', async () => {
      if (!channel || !channel.isConnected()) {
        console.warn('⚠️  Channel not connected, skipping');
        return;
      }

      const longMessage = 'x'.repeat(1000);
      const chatJid = `irc:${IRC_CHANNEL.toLowerCase()}@${IRC_SERVER}:${IRC_PORT}`;

      await channel.sendMessage(chatJid, longMessage);

      // IRC max line length forces the 1000-char message to split into ≥2 PRIVMSGs
      await waitFor(
        () =>
          (ircServer?.getChannelMessages(IRC_CHANNEL.toLowerCase()) ?? [])
            .length >= 2,
        2000,
      );
      const sent = ircServer?.getChannelMessages(IRC_CHANNEL.toLowerCase()) ?? [];
      expect(sent.length).toBeGreaterThanOrEqual(2);
    }, 5000);
  });

  describe('Channel Metadata', () => {
    it('should emit chat metadata on channel join', async () => {
      // Create a dedicated connection so this test captures its own metadata
      // (the outer beforeEach clears receivedMetadata, so we can't rely on earlier tests)
      const localMetadata: typeof receivedMetadata = [];
      const metaConfig = {
        server: IRC_SERVER,
        port: IRC_PORT,
        nick: 'MetaBot',
        channels: [IRC_CHANNEL],
      };
      const metaOpts: IRCChannelOpts = {
        onMessage: () => {},
        onChatMetadata: (chatJid, timestamp, name, ch, isGroup) => {
          localMetadata.push({ chatJid, timestamp, name, channel: ch, isGroup });
        },
        registeredGroups: () => ({
          [`irc:${IRC_CHANNEL.toLowerCase()}@${IRC_SERVER}:${IRC_PORT}`]: {
            name: 'Test IRC Channel',
            folder: 'test-irc',
            trigger: '@Andy',
            added_at: new Date().toISOString(),
          },
        }),
      };

      const metaChannel = new IRCChannel(metaConfig, metaOpts);
      await metaChannel.connect();
      await waitFor(() => localMetadata.length > 0, 3000);
      await metaChannel.disconnect();

      const relevantMetadata = localMetadata.filter(
        (m) =>
          m.chatJid ===
          `irc:${IRC_CHANNEL.toLowerCase()}@${IRC_SERVER}:${IRC_PORT}`,
      );

      expect(relevantMetadata.length).toBeGreaterThan(0);
      expect(relevantMetadata[0].channel).toBe('irc');
      expect(relevantMetadata[0].isGroup).toBe(true);
    }, 10000);
  });

  describe('JID Ownership', () => {
    it('should correctly identify owned IRC JIDs', async () => {
      if (!channel) {
        console.warn('⚠️  Channel not initialized, skipping');
        return;
      }

      const ownedJid = `irc:${IRC_CHANNEL.toLowerCase()}@${IRC_SERVER}:${IRC_PORT}`;
      const otherJid = 'irc:#other@different.server.com';
      const nonIrcJid = 'tg:123456';

      expect(channel.ownsJid(ownedJid)).toBe(true);
      expect(channel.ownsJid(otherJid)).toBe(false);
      expect(channel.ownsJid(nonIrcJid)).toBe(false);
    }, 5000);
  });

  describe('Error Handling', () => {
    it('should handle send failure gracefully', async () => {
      if (!channel) {
        console.warn('⚠️  Channel not initialized, skipping');
        return;
      }

      // Try to send to an invalid JID
      const invalidJid = 'invalid-jid';

      await expect(
        channel.sendMessage(invalidJid, 'test'),
      ).resolves.toBeUndefined();
    }, 5000);

    it('should handle disconnect when not connected', async () => {
      const config = {
        server: IRC_SERVER,
        port: IRC_PORT,
        nick: 'TempBot',
        channels: [IRC_CHANNEL],
      };

      const tempChannel = new IRCChannel(config, createTestOpts());

      // Should not throw when disconnecting without connecting
      await expect(tempChannel.disconnect()).resolves.toBeUndefined();
    }, 5000);
  });

  describe('Full Workflow', () => {
    it('should complete full message roundtrip', async () => {
      // 1. Connect to IRC
      if (!channel || !channel.isConnected()) {
        const config = {
          server: IRC_SERVER,
          port: IRC_PORT,
          nick: IRC_NICK,
          channels: [IRC_CHANNEL],
        };
        channel = new IRCChannel(config, createTestOpts());
        await channel.connect();
      }

      // 2. Receive a message
      const userMessage = '@Andy hello there!';
      receivedMessages = [];

      ircServer?.simulateMessage('TestUser', IRC_CHANNEL, userMessage);

      await waitFor(() => receivedMessages.length > 0, 3000);

      expect(receivedMessages.length).toBeGreaterThan(0);
      expect(receivedMessages[0].message.content).toContain('@Andy');

      // 3. Send a response
      const chatJid = `irc:${IRC_CHANNEL.toLowerCase()}@${IRC_SERVER}:${IRC_PORT}`;
      const responseText = 'Hello! I received your message.';

      await channel.sendMessage(chatJid, responseText);

      // Verify the response was recorded by the server
      await waitFor(
        () =>
          (ircServer?.getChannelMessages(IRC_CHANNEL.toLowerCase()) ?? []).some(
            (m) => m.text === responseText,
          ),
        2000,
      );
      const channelMessages =
        ircServer?.getChannelMessages(IRC_CHANNEL.toLowerCase()) ?? [];
      expect(channelMessages.some((m) => m.text === responseText)).toBe(true);
    }, 15000);
  });

  describe('Multiple Channels', () => {
    let multiChannel: IRCChannel | null = null;
    let multiReceivedMessages: { chatJid: string; message: NewMessage }[] = [];
    // Use same port as main IRC server since MockIRCServer is a singleton
    const MULTI_PORT = IRC_PORT;
    const MULTI_SERVER = IRC_SERVER;
    const MULTI_NICK = 'MultiBot';
    const MULTI_CHANNELS = ['#test-multi-1', '#test-multi-2', '#test-multi-3'];

    function createMultiChannelOpts(): IRCChannelOpts {
      return {
        onMessage: (chatJid: string, message: NewMessage) => {
          multiReceivedMessages.push({ chatJid, message });
        },
        onChatMetadata: () => {
          // Not used in multi-channel tests
        },
        registeredGroups: () => ({
          [`irc:${MULTI_CHANNELS[0].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`]:
            {
              name: 'Test Channel 1',
              folder: 'test-irc-1',
              trigger: '@Andy',
              added_at: new Date().toISOString(),
            },
          [`irc:${MULTI_CHANNELS[1].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`]:
            {
              name: 'Test Channel 2',
              folder: 'test-irc-2',
              trigger: '@Andy',
              added_at: new Date().toISOString(),
            },
          [`irc:${MULTI_CHANNELS[2].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`]:
            {
              name: 'Test Channel 3',
              folder: 'test-irc-3',
              trigger: '@Andy',
              added_at: new Date().toISOString(),
            },
        }),
      };
    }

    beforeAll(async () => {
      // Ensure main channel is disconnected first to avoid nick conflicts
      if (channel && channel.isConnected()) {
        await channel.disconnect();
        channel = null;
      }
    }, 5000);

    afterAll(async () => {
      if (multiChannel) {
        await multiChannel.disconnect();
        multiChannel = null;
      }
    }, 5000);

    beforeEach(() => {
      multiReceivedMessages = [];
    });

    it('should join multiple IRC channels on connection', async () => {
      const config = {
        server: MULTI_SERVER,
        port: MULTI_PORT,
        nick: MULTI_NICK,
        channels: MULTI_CHANNELS,
      };

      multiChannel = new IRCChannel(config, createMultiChannelOpts());
      await multiChannel.connect();

      // Poll until all three channels are joined
      await waitFor(
        () => {
          const joined = (ircServer?.getChannels() ?? []).map((c) =>
            c.toLowerCase(),
          );
          return MULTI_CHANNELS.every((c) => joined.includes(c.toLowerCase()));
        },
        5000,
      );

      expect(multiChannel.isConnected()).toBe(true);

      const joinedChannels = ircServer?.getChannels() || [];
      const joinedLower = joinedChannels.map((c) => c.toLowerCase());
      for (const channel of MULTI_CHANNELS) {
        expect(joinedLower).toContain(channel.toLowerCase());
      }
    }, 10000);

    it('should route messages to correct channel', async () => {
      if (!multiChannel || !multiChannel.isConnected()) {
        console.warn('⚠️  Multi-channel not connected, skipping');
        return;
      }

      // Clear previous messages then send to each channel
      multiReceivedMessages = [];

      ircServer?.simulateMessage('User1', MULTI_CHANNELS[0], 'Message to channel 1');
      ircServer?.simulateMessage('User2', MULTI_CHANNELS[1], 'Message to channel 2');
      ircServer?.simulateMessage('User3', MULTI_CHANNELS[2], 'Message to channel 3');

      // Poll until all three messages have been delivered
      await waitFor(() => multiReceivedMessages.length >= 3, 3000);

      expect(multiReceivedMessages.length).toBe(3);

      // Verify each message was routed to the correct chatJid
      const expectedJid1 = `irc:${MULTI_CHANNELS[0].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`;
      const expectedJid2 = `irc:${MULTI_CHANNELS[1].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`;
      const expectedJid3 = `irc:${MULTI_CHANNELS[2].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`;

      const message1 = multiReceivedMessages.find(
        (m) => m.message.content === 'Message to channel 1',
      );
      const message2 = multiReceivedMessages.find(
        (m) => m.message.content === 'Message to channel 2',
      );
      const message3 = multiReceivedMessages.find(
        (m) => m.message.content === 'Message to channel 3',
      );

      expect(message1?.chatJid).toBe(expectedJid1);
      expect(message2?.chatJid).toBe(expectedJid2);
      expect(message3?.chatJid).toBe(expectedJid3);
    }, 10000);

    it('should handle messages in different channels independently', async () => {
      if (!multiChannel || !multiChannel.isConnected()) {
        console.warn('⚠️  Multi-channel not connected, skipping');
        return;
      }

      // Clear previous messages then send to channel 1 only
      multiReceivedMessages = [];

      ircServer?.simulateMessage('UserA', MULTI_CHANNELS[0], 'Only for channel 1');

      // Poll until the message arrives
      await waitFor(() => multiReceivedMessages.length >= 1, 3000);

      // Should only receive 1 message
      expect(multiReceivedMessages.length).toBe(1);

      const receivedJids = multiReceivedMessages.map((m) => m.chatJid);
      const expectedJid1 = `irc:${MULTI_CHANNELS[0].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`;
      const expectedJid2 = `irc:${MULTI_CHANNELS[1].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`;
      const expectedJid3 = `irc:${MULTI_CHANNELS[2].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`;

      // Message should only be for channel 1
      expect(receivedJids).toContain(expectedJid1);
      expect(receivedJids).not.toContain(expectedJid2);
      expect(receivedJids).not.toContain(expectedJid3);
    }, 5000);

    it('should send messages to correct channel', async () => {
      if (!multiChannel || !multiChannel.isConnected()) {
        console.warn('⚠️  Multi-channel not connected, skipping');
        return;
      }

      // Send messages to different channels
      const jid1 = `irc:${MULTI_CHANNELS[0].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`;
      const jid2 = `irc:${MULTI_CHANNELS[1].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`;
      const jid3 = `irc:${MULTI_CHANNELS[2].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`;

      // Should not throw errors for any channel
      await expect(
        multiChannel.sendMessage(jid1, 'Message to channel 1'),
      ).resolves.toBeUndefined();
      await expect(
        multiChannel.sendMessage(jid2, 'Message to channel 2'),
      ).resolves.toBeUndefined();
      await expect(
        multiChannel.sendMessage(jid3, 'Message to channel 3'),
      ).resolves.toBeUndefined();
    }, 5000);

    it('should handle JID ownership for multiple channels', async () => {
      if (!multiChannel) {
        console.warn('⚠️  Multi-channel not initialized, skipping');
        return;
      }

      // Should own all JIDs on the configured server/port
      const jid1 = `irc:${MULTI_CHANNELS[0].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`;
      const jid2 = `irc:${MULTI_CHANNELS[1].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`;
      const jid3 = `irc:${MULTI_CHANNELS[2].toLowerCase()}@${MULTI_SERVER}:${MULTI_PORT}`;
      // Other channel on same server/port - ownsJid returns true for any channel on this server
      const otherJid = `irc:#other@${MULTI_SERVER}:${MULTI_PORT}`;
      // Same channel name but wrong server - should not own
      const wrongServerJid = `irc:${MULTI_CHANNELS[0].toLowerCase()}@other.server:6667`;
      // Wrong port - should not own
      const wrongPortJid = `irc:${MULTI_CHANNELS[0].toLowerCase()}@${MULTI_SERVER}:6667`;
      // Non-IRC JID - should not own
      const nonIrcJid = 'tg:123456';

      expect(multiChannel.ownsJid(jid1)).toBe(true);
      expect(multiChannel.ownsJid(jid2)).toBe(true);
      expect(multiChannel.ownsJid(jid3)).toBe(true);
      expect(multiChannel.ownsJid(otherJid)).toBe(true); // Same server/port
      expect(multiChannel.ownsJid(wrongServerJid)).toBe(false);
      expect(multiChannel.ownsJid(wrongPortJid)).toBe(false);
      expect(multiChannel.ownsJid(nonIrcJid)).toBe(false);
    }, 5000);
  });

  describe('Resilience and Reconnection', () => {
    let resilientChannel: IRCChannel | null = null;
    let resilientMessages: { chatJid: string; message: NewMessage }[] = [];

    // Use main IRC server that is already running
    const RESILIENT_NICK = 'ResilientBot';

    function createResilientOpts(): IRCChannelOpts {
      return {
        onMessage: (chatJid: string, message: NewMessage) => {
          resilientMessages.push({ chatJid, message });
        },
        onChatMetadata: () => {
          // Not used in resilience tests
        },
        registeredGroups: () => ({
          [`irc:${IRC_CHANNEL.toLowerCase()}@${IRC_SERVER}:${IRC_PORT}`]: {
            name: 'Test Resilient Channel',
            folder: 'test-resilient',
            trigger: '@Andy',
            added_at: new Date().toISOString(),
          },
        }),
      };
    }

    afterEach(async () => {
      if (resilientChannel) {
        await resilientChannel.disconnect();
        resilientChannel = null;
      }
    }, 5000);

    it('should handle disconnect and reconnect gracefully', async () => {
      const config = {
        server: IRC_SERVER,
        port: IRC_PORT,
        nick: RESILIENT_NICK,
        channels: [IRC_CHANNEL],
      };

      resilientChannel = new IRCChannel(config, createResilientOpts());

      // Connect
      await resilientChannel.connect();
      await new Promise((r) => setTimeout(r, 500));
      expect(resilientChannel.isConnected()).toBe(true);
      console.log('[Resilience] Connected successfully');

      // Disconnect
      await resilientChannel.disconnect();
      await new Promise((r) => setTimeout(r, 500));
      expect(resilientChannel.isConnected()).toBe(false);
      console.log('[Resilience] Disconnected successfully');

      // Reconnect
      await resilientChannel.connect();
      await new Promise((r) => setTimeout(r, 500));
      expect(resilientChannel.isConnected()).toBe(true);
      console.log('[Resilience] Reconnected successfully');
    }, 10000);

    it('should handle message sending while disconnected', async () => {
      const config = {
        server: IRC_SERVER,
        port: IRC_PORT,
        nick: RESILIENT_NICK,
        channels: [IRC_CHANNEL],
      };

      resilientChannel = new IRCChannel(config, createResilientOpts());

      // Connect then disconnect
      await resilientChannel.connect();
      await new Promise((r) => setTimeout(r, 500));
      await resilientChannel.disconnect();
      await new Promise((r) => setTimeout(r, 500));

      expect(resilientChannel.isConnected()).toBe(false);

      // Attempt to send message while disconnected - should not crash
      const chatJid = `irc:${IRC_CHANNEL.toLowerCase()}@${IRC_SERVER}:${IRC_PORT}`;
      const messageText = 'Test message during disconnection';

      // Should not throw an error (channel gracefully handles disconnected state)
      await expect(
        resilientChannel.sendMessage(chatJid, messageText),
      ).resolves.toBeUndefined();

      console.log(
        '[Resilience] Message sending during disconnection handled gracefully',
      );
    }, 10000);

    it('should process messages after multiple connect/disconnect cycles', async () => {
      const config = {
        server: IRC_SERVER,
        port: IRC_PORT,
        nick: RESILIENT_NICK,
        channels: [IRC_CHANNEL],
      };

      resilientChannel = new IRCChannel(config, createResilientOpts());

      // Perform multiple cycles
      for (let i = 0; i < 3; i++) {
        await resilientChannel.connect();
        await new Promise((r) => setTimeout(r, 500));
        expect(resilientChannel.isConnected()).toBe(true);

        await resilientChannel.disconnect();
        await new Promise((r) => setTimeout(r, 300));
        expect(resilientChannel.isConnected()).toBe(false);
      }

      // Final connect and verify message processing
      await resilientChannel.connect();
      await waitFor(
        () =>
          (ircServer?.getChannels() ?? [])
            .map((c) => c.toLowerCase())
            .includes(IRC_CHANNEL.toLowerCase()),
        3000,
      );

      resilientMessages = [];
      ircServer?.simulateMessage('TestUser', IRC_CHANNEL, 'Message after cycles');

      await waitFor(() => resilientMessages.length > 0, 3000);

      expect(resilientMessages.length).toBeGreaterThan(0);
      expect(resilientMessages[0].message.content).toBe('Message after cycles');
      console.log(
        '[Resilience] Message processing after multiple cycles successful',
      );
    }, 15000);
  });
});
