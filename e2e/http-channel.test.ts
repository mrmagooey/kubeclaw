/**
 * HTTP Channel End-to-End Tests
 *
 * Tests the HTTP channel implementation: Basic Auth, inbound messages via
 * POST /message, outbound delivery via SSE /stream, and full roundtrip.
 * Follows the same pattern as irc-channel.test.ts.
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
import { HttpChannel, type HttpChannelOpts } from '../src/channels/http.js';
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

const HTTP_PORT = 14080;
const TEST_USER = 'alice';
const TEST_PASS = 'testsecret';
const TEST_JID = `http:${TEST_USER}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

describe('HTTP Channel End-to-End', () => {
  let channel: HttpChannel | null = null;
  let receivedMessages: { chatJid: string; message: NewMessage }[] = [];
  let receivedMetadata: {
    chatJid: string;
    timestamp: string;
    name?: string;
    channel?: string;
    isGroup?: boolean;
  }[] = [];

  function createTestOpts(): HttpChannelOpts {
    return {
      onMessage: (chatJid: string, message: NewMessage) => {
        receivedMessages.push({ chatJid, message });
      },
      onChatMetadata: (
        chatJid: string,
        timestamp: string,
        name?: string,
        ch?: string,
        isGroup?: boolean,
      ) => {
        receivedMetadata.push({
          chatJid,
          timestamp,
          name,
          channel: ch,
          isGroup,
        });
      },
      registeredGroups: () => ({
        [TEST_JID]: {
          name: 'Alice HTTP',
          folder: 'http-alice',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      }),
    };
  }

  function createChannel(): HttpChannel {
    const config = {
      port: HTTP_PORT,
      users: { [TEST_USER]: TEST_PASS, bob: 'bobpass' },
    };
    return new HttpChannel(config, createTestOpts());
  }

  beforeEach(() => {
    receivedMessages = [];
    receivedMetadata = [];
  });

  afterEach(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  });

  // ── Connection Lifecycle ──────────────────────────────────────────────────

  describe('Connection Lifecycle', () => {
    it('should start HTTP server and report connected', async () => {
      channel = createChannel();
      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    }, 5000);

    it('should serve the chat UI on GET /', async () => {
      channel = createChannel();
      await channel.connect();

      const res = await fetch(`http://localhost:${HTTP_PORT}/`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<html');
    }, 5000);

    it('should disconnect cleanly', async () => {
      channel = createChannel();
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      channel = null;
    }, 5000);
  });

  // ── Authentication ────────────────────────────────────────────────────────

  describe('Authentication', () => {
    beforeAll(async () => {
      channel = createChannel();
      await channel.connect();
    });

    afterAll(async () => {
      if (channel) {
        await channel.disconnect();
        channel = null;
      }
    });

    it('should reject requests without credentials', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/`);
      expect(res.status).toBe(401);
    }, 5000);

    it('should reject requests with wrong password', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/`, {
        headers: { Authorization: basicAuth(TEST_USER, 'wrongpass') },
      });
      expect(res.status).toBe(401);
    }, 5000);

    it('should reject requests with unknown user', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/`, {
        headers: { Authorization: basicAuth('nobody', 'pass') },
      });
      expect(res.status).toBe(401);
    }, 5000);

    it('should accept requests with valid credentials', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });
      expect(res.status).toBe(200);
    }, 5000);
  });

  // ── Inbound Messages ──────────────────────────────────────────────────────

  describe('Inbound Messages (POST /message)', () => {
    beforeAll(async () => {
      channel = createChannel();
      await channel.connect();
    });

    afterAll(async () => {
      if (channel) {
        await channel.disconnect();
        channel = null;
      }
    });

    it('should receive a JSON message and call onMessage', async () => {
      receivedMessages = [];

      const res = await fetch(`http://localhost:${HTTP_PORT}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(TEST_USER, TEST_PASS),
        },
        body: JSON.stringify({ text: 'Hello from test!' }),
      });

      expect(res.status).toBe(200);

      await waitFor(() => receivedMessages.length > 0, 3000);

      expect(receivedMessages[0].chatJid).toBe(TEST_JID);
      expect(receivedMessages[0].message.content).toBe('Hello from test!');
      expect(receivedMessages[0].message.sender).toBe(TEST_USER);
      expect(receivedMessages[0].message.is_from_me).toBe(false);
    }, 5000);

    it('should use the authenticated username as sender', async () => {
      receivedMessages = [];

      await fetch(`http://localhost:${HTTP_PORT}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth('bob', 'bobpass'),
        },
        body: JSON.stringify({ text: 'Message from Bob' }),
      });

      await waitFor(() => receivedMessages.length > 0, 3000);

      expect(receivedMessages[0].chatJid).toBe('http:bob');
      expect(receivedMessages[0].message.sender).toBe('bob');
    }, 5000);

    it('should reject POST /message without auth', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Should be rejected' }),
      });

      expect(res.status).toBe(401);
    }, 5000);
  });

  // ── Outbound Messages (SSE) ───────────────────────────────────────────────

  describe('Outbound Messages (SSE /stream)', () => {
    beforeAll(async () => {
      channel = createChannel();
      await channel.connect();
    });

    afterAll(async () => {
      if (channel) {
        await channel.disconnect();
        channel = null;
      }
    });

    it('should deliver messages to SSE clients via sendMessage', async () => {
      // Connect an SSE stream
      const controller = new AbortController();
      const sseData: string[] = [];

      const ssePromise = fetch(`http://localhost:${HTTP_PORT}/stream`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
        signal: controller.signal,
      }).then(async (res) => {
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            // Parse SSE data lines
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data: ')) {
                sseData.push(line.slice(6));
              }
            }
          }
        } catch {
          // AbortError expected on cleanup
        }
      });

      // Give the SSE connection time to establish
      await new Promise((r) => setTimeout(r, 200));

      // Send a message through the channel
      await channel!.sendMessage(TEST_JID, 'Hello via SSE!');

      // Wait for SSE delivery
      await waitFor(() => sseData.some((d) => d.includes('Hello via SSE!')), 3000);

      expect(sseData.some((d) => d.includes('Hello via SSE!'))).toBe(true);

      // Cleanup SSE connection
      controller.abort();
      await ssePromise.catch(() => {});
    }, 10000);

    it('should only deliver messages to the matching user', async () => {
      // Connect SSE for bob
      const controller = new AbortController();
      const bobData: string[] = [];

      const ssePromise = fetch(`http://localhost:${HTTP_PORT}/stream`, {
        headers: { Authorization: basicAuth('bob', 'bobpass') },
        signal: controller.signal,
      }).then(async (res) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data: ')) {
                bobData.push(line.slice(6));
              }
            }
          }
        } catch {
          // AbortError expected
        }
      });

      await new Promise((r) => setTimeout(r, 200));

      // Send message to alice only
      await channel!.sendMessage(TEST_JID, 'For alice only');

      // Short wait — bob should NOT receive it
      await new Promise((r) => setTimeout(r, 500));

      expect(bobData.some((d) => d.includes('For alice only'))).toBe(false);

      controller.abort();
      await ssePromise.catch(() => {});
    }, 10000);
  });

  // ── JID Ownership ─────────────────────────────────────────────────────────

  describe('JID Ownership', () => {
    it('should own http: JIDs', () => {
      channel = createChannel();
      expect(channel.ownsJid('http:alice')).toBe(true);
      expect(channel.ownsJid('http:bob')).toBe(true);
      expect(channel.ownsJid('http:unknown')).toBe(true);
    });

    it('should not own non-http JIDs', () => {
      channel = createChannel();
      expect(channel.ownsJid('tg:123456')).toBe(false);
      expect(channel.ownsJid('irc:#channel@server')).toBe(false);
      expect(channel.ownsJid('dc:999')).toBe(false);
    });
  });

  // ── Full Roundtrip ────────────────────────────────────────────────────────

  describe('Full Message Roundtrip', () => {
    it('should handle POST → onMessage → sendMessage → SSE delivery', async () => {
      channel = createChannel();
      await channel.connect();

      // 1. Connect SSE stream
      const controller = new AbortController();
      const sseData: string[] = [];

      const ssePromise = fetch(`http://localhost:${HTTP_PORT}/stream`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
        signal: controller.signal,
      }).then(async (res) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data: ')) {
                sseData.push(line.slice(6));
              }
            }
          }
        } catch {
          // AbortError expected
        }
      });

      await new Promise((r) => setTimeout(r, 200));

      // 2. Send inbound message via POST
      receivedMessages = [];
      const res = await fetch(`http://localhost:${HTTP_PORT}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(TEST_USER, TEST_PASS),
        },
        body: JSON.stringify({ text: '@Andy what time is it?' }),
      });
      expect(res.status).toBe(200);

      // 3. Verify onMessage callback fired
      await waitFor(() => receivedMessages.length > 0, 3000);
      expect(receivedMessages[0].chatJid).toBe(TEST_JID);
      expect(receivedMessages[0].message.content).toBe(
        '@Andy what time is it?',
      );

      // 4. Simulate agent response via sendMessage
      await channel.sendMessage(TEST_JID, 'It is 3:00 PM.');

      // 5. Verify SSE delivery
      await waitFor(
        () => sseData.some((d) => d.includes('It is 3:00 PM.')),
        3000,
      );
      expect(sseData.some((d) => d.includes('It is 3:00 PM.'))).toBe(true);

      controller.abort();
      await ssePromise.catch(() => {});
    }, 15000);
  });

  // ── Multiple Users ────────────────────────────────────────────────────────

  describe('Multiple Users', () => {
    it('should isolate messages between users', async () => {
      channel = createChannel();
      await channel.connect();

      // Connect SSE for alice and bob
      const aliceController = new AbortController();
      const bobController = new AbortController();
      const aliceData: string[] = [];
      const bobData: string[] = [];

      const aliceSse = fetch(`http://localhost:${HTTP_PORT}/stream`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
        signal: aliceController.signal,
      }).then(async (res) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of decoder
              .decode(value, { stream: true })
              .split('\n')) {
              if (line.startsWith('data: ')) aliceData.push(line.slice(6));
            }
          }
        } catch {}
      });

      const bobSse = fetch(`http://localhost:${HTTP_PORT}/stream`, {
        headers: { Authorization: basicAuth('bob', 'bobpass') },
        signal: bobController.signal,
      }).then(async (res) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of decoder
              .decode(value, { stream: true })
              .split('\n')) {
              if (line.startsWith('data: ')) bobData.push(line.slice(6));
            }
          }
        } catch {}
      });

      await new Promise((r) => setTimeout(r, 200));

      // Send to alice
      await channel.sendMessage('http:alice', 'For alice');
      // Send to bob
      await channel.sendMessage('http:bob', 'For bob');

      await waitFor(
        () =>
          aliceData.some((d) => d.includes('For alice')) &&
          bobData.some((d) => d.includes('For bob')),
        3000,
      );

      // Alice gets her message, not Bob's
      expect(aliceData.some((d) => d.includes('For alice'))).toBe(true);
      expect(aliceData.some((d) => d.includes('For bob'))).toBe(false);

      // Bob gets his message, not Alice's
      expect(bobData.some((d) => d.includes('For bob'))).toBe(true);
      expect(bobData.some((d) => d.includes('For alice'))).toBe(false);

      aliceController.abort();
      bobController.abort();
      await Promise.all([aliceSse.catch(() => {}), bobSse.catch(() => {})]);
    }, 15000);
  });

  // ── Error Handling ────────────────────────────────────────────────────────

  describe('Error Handling', () => {
    beforeAll(async () => {
      channel = createChannel();
      await channel.connect();
    });

    afterAll(async () => {
      if (channel) {
        await channel.disconnect();
        channel = null;
      }
    });

    it('should return 405 for unsupported methods', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/message`, {
        method: 'PUT',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });
      // Channel should reject or return an error for non-POST on /message
      expect([400, 404, 405]).toContain(res.status);
    }, 5000);

    it('should handle empty message body gracefully', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(TEST_USER, TEST_PASS),
        },
        body: JSON.stringify({}),
      });

      // Should not crash — may return 400 or silently ignore
      expect([200, 400]).toContain(res.status);
    }, 5000);

    it('should handle sendMessage to disconnected channel gracefully', async () => {
      const tempChannel = createChannel();
      // Don't connect — sendMessage should not throw
      await expect(
        tempChannel.sendMessage(TEST_JID, 'test'),
      ).resolves.toBeUndefined();
    }, 5000);
  });
});
