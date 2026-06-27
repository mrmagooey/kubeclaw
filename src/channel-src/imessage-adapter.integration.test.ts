/**
 * iMessage adapter integration test.
 *
 * Boots a real in-process fake BlueBubbles REST server on an ephemeral port
 * and exercises:
 *   1. connect() → probes GET /api/v1/ping → channel connected
 *   2. pollOnce() → queries POST /api/v1/message/query → onMessage fires
 *   3. sendMessage() → records POST /api/v1/message/text
 *   4. Cursor advances: a second poll with same data yields no duplicates
 *
 * No real BlueBubbles server or Apple hardware required.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  IMessageChannel,
  parseConfig,
} from '../../helm/kubeclaw/files/channel-src/imessage/channel-entry.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const BRIDGE_PW = 'integration-secret';

function makeSdk(bridgeUrl: string) {
  return {
    registerChannel: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readEnvFile: () => ({
      IMESSAGE_BRIDGE_URL: bridgeUrl,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    }),
    assistantName: 'IntegBot',
  };
}

function makeOpts(registeredMap: Record<string, any> = {}) {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => registeredMap),
  };
}

interface FakeBBServer {
  port: number;
  requests: Array<{ url: string; method: string; body: any }>;
  queueMessages: (msgs: any[]) => void;
  close: () => Promise<void>;
}

/**
 * Start a fake BlueBubbles REST server.
 * Responds to:
 *   GET /api/v1/ping            → 200 OK
 *   POST /api/v1/message/query  → 200 + queued messages (returns & clears queue)
 *   POST /api/v1/message/text   → 200 + records request
 */
function startFakeBBServer(): Promise<FakeBBServer> {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  let messageQueue: any[] = [];

  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: any = raw;
        try {
          body = JSON.parse(raw);
        } catch {}

        const url = req.url ?? '/';
        requests.push({ url, method: req.method ?? 'GET', body });

        if (req.method === 'GET' && url.startsWith('/api/v1/ping')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 200, message: 'pong' }));
          return;
        }

        if (req.method === 'POST' && url.includes('/api/v1/message/query')) {
          const msgs = messageQueue.splice(0);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ status: 200, message: 'Success', data: msgs }),
          );
          return;
        }

        if (req.method === 'POST' && url.includes('/api/v1/message/text')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 200, message: 'Message sent' }));
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });
    });

    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        port,
        requests,
        queueMessages: (msgs: any[]) => {
          messageQueue.push(...msgs);
        },
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

// Track open resources for cleanup
const openResources: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const r of openResources) {
    await r.close().catch(() => {});
  }
  openResources.length = 0;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('imessage-adapter: integration (fake BlueBubbles server)', () => {
  it('connect() probes /api/v1/ping and becomes connected', async () => {
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);
    const opts = makeOpts();
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);
    openResources.push({ close: () => ch.disconnect() });

    await ch.connect();
    expect(ch.isConnected()).toBe(true);

    // Verify the ping was hit
    const pings = fake.requests.filter((r) => r.url.includes('/api/v1/ping'));
    expect(pings.length).toBe(1);
  });

  it('pollOnce() fetches new messages and fires onMessage', async () => {
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);

    const JID = 'imessage:+61400000000';
    const opts = makeOpts({ [JID]: { folder: 'alice', name: 'Alice' } });
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);
    openResources.push({ close: () => ch.disconnect() });

    const ts1 = Date.now() + 1;
    fake.queueMessages([
      {
        chats: [{ guid: 'iMessage;-;+61400000000' }],
        handle: { address: '+61400000000', displayName: 'Alice' },
        text: 'integration test message',
        dateCreated: ts1,
        isFromMe: false,
      },
    ]);

    await ch.pollOnce();

    expect(opts.onMessage).toHaveBeenCalledOnce();
    const [jid, msg] = opts.onMessage.mock.calls[0];
    expect(jid).toBe(JID);
    expect(msg.content).toBe('integration test message');
    expect(msg.is_from_me).toBe(false);
    expect(msg.sender).toBe('+61400000000');
    expect(msg.sender_name).toBe('Alice');

    // Cursor advanced
    expect(ch.lastSeen).toBeGreaterThanOrEqual(ts1);
  });

  it('cursor advances: second poll with no new messages delivers nothing new', async () => {
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);

    const JID = 'imessage:+61400000000';
    const opts = makeOpts({ [JID]: { folder: 'alice', name: 'Alice' } });
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);
    openResources.push({ close: () => ch.disconnect() });

    const ts1 = Date.now() + 1;
    // First poll: one message
    fake.queueMessages([
      {
        chats: [{ guid: 'iMessage;-;+61400000000' }],
        handle: { address: '+61400000000', displayName: 'Alice' },
        text: 'first message',
        dateCreated: ts1,
        isFromMe: false,
      },
    ]);
    await ch.pollOnce();
    expect(opts.onMessage).toHaveBeenCalledTimes(1);

    // Second poll: queue is empty (server returns nothing)
    await ch.pollOnce();
    // Still only 1 call total — no duplicate delivery
    expect(opts.onMessage).toHaveBeenCalledTimes(1);

    // Verify the query body carries the advanced cursor
    const queryRequests = fake.requests.filter((r) =>
      r.url.includes('/api/v1/message/query'),
    );
    expect(queryRequests.length).toBe(2);
    // The second query's `after` should equal ts1 (the cursor we set from first poll)
    const secondBody = queryRequests[1].body;
    expect(secondBody.after).toBe(ts1);
  });

  it('client-side cursor guard: second poll returning same message does not re-deliver', async () => {
    // This test exercises the Fix 1 guard: the server returns the SAME message
    // on the second poll (simulating a server that treats `after` as inclusive
    // or ignores it). The client-side guard (ts <= cursorAtStart) must suppress
    // re-delivery.
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);

    const JID = 'imessage:+61400000000';
    const opts = makeOpts({ [JID]: { folder: 'alice', name: 'Alice' } });
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);
    openResources.push({ close: () => ch.disconnect() });

    const ts1 = Date.now() + 1;
    const sameMsg = {
      chats: [{ guid: 'iMessage;-;+61400000000' }],
      handle: { address: '+61400000000', displayName: 'Alice' },
      text: 'duplicate me',
      dateCreated: ts1,
      isFromMe: false,
    };

    // First poll: server returns the message → delivered once, cursor advances to ts1
    fake.queueMessages([sameMsg]);
    await ch.pollOnce();
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    expect(ch.lastSeen).toBe(ts1);

    // Second poll: server returns the SAME message again (ts1 === cursor).
    // Client-side guard skips it — onMessage must NOT be called again.
    fake.queueMessages([sameMsg]);
    await ch.pollOnce();
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
  });

  it('sendMessage() POSTs to /api/v1/message/text with correct chatGuid + message', async () => {
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);
    const opts = makeOpts();
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);
    openResources.push({ close: () => ch.disconnect() });

    await ch.sendMessage('imessage:+61400000000', 'hello from the bot');

    const sends = fake.requests.filter((r) =>
      r.url.includes('/api/v1/message/text'),
    );
    expect(sends.length).toBe(1);
    expect(sends[0].method).toBe('POST');
    expect(sends[0].body.chatGuid).toBe('iMessage;-;+61400000000');
    expect(sends[0].body.message).toBe('hello from the bot');
    expect(sends[0].body.tempGuid).toBeDefined();
    // Password in URL
    expect(sends[0].url).toContain('password=');
  });

  it('sendMessage() works for group JIDs', async () => {
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);
    const opts = makeOpts();
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);
    openResources.push({ close: () => ch.disconnect() });

    await ch.sendMessage(
      'imessage:group.iMessage;+;chat-guid-123',
      'group reply',
    );

    const sends = fake.requests.filter((r) =>
      r.url.includes('/api/v1/message/text'),
    );
    expect(sends.length).toBe(1);
    expect(sends[0].body.chatGuid).toBe('iMessage;+;chat-guid-123');
  });

  it('disconnect() stops the poll loop cleanly', async () => {
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);
    const opts = makeOpts();
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);

    await ch.connect();
    expect(ch.isConnected()).toBe(true);
    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
    expect(ch.stopped).toBe(true);
    expect(ch.pollTimer).toBeNull();
  });
});
