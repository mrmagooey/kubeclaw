/**
 * iMessage Channel End-to-End Tests
 *
 * Full lifecycle test against a fake BlueBubbles REST server:
 *   1. connect() → probes /api/v1/ping → channel is connected
 *   2. pollOnce() → queries message/query → onMessage fires with correct data
 *   3. sendMessage() → records POST to /api/v1/message/text
 *   4. disconnect() → stops the poll loop cleanly
 *
 * NOTE: A live round-trip requires a Mac running BlueBubbles and is NOT CI-able.
 * This test proves the full in-process adapter loop without external deps.
 * See e2e/minikube-live-channel-imessage-bootstrap.test.ts for the Kubernetes
 * bootstrap path (requires an 8 GiB cluster).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
// @ts-ignore — no TS types; the adapter is pure JS ESM
import {
  IMessageChannel,
  parseConfig,
} from '../helm/kubeclaw/files/channel-src/imessage/channel-entry.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const BRIDGE_PW = 'e2e-bridge-password';
const SENDER_JID = 'imessage:+19005550001';
const GROUP_JID = 'imessage:group.iMessage;+;e2e-group-guid';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSdk(bridgeUrl: string) {
  return {
    registerChannel: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readEnvFile: () => ({
      IMESSAGE_BRIDGE_URL: bridgeUrl,
      IMESSAGE_BRIDGE_PASSWORD: BRIDGE_PW,
    }),
    assistantName: 'E2EBot',
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

const openResources: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const r of openResources) {
    await r.close().catch(() => {});
  }
  openResources.length = 0;
});

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('imessage-channel: e2e (fake BlueBubbles server)', () => {
  it('full lifecycle: connect → poll delivers → onMessage → sendMessage → Graph receives → disconnect', async () => {
    // 1. Start fake BlueBubbles server
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);

    // 2. Build adapter
    const opts = makeOpts({
      [SENDER_JID]: { folder: 'e2e-dm', name: 'E2E User' },
    });
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);
    openResources.push({ close: () => ch.disconnect() });

    // 3. Connect — should probe /api/v1/ping
    await ch.connect();
    expect(ch.isConnected()).toBe(true);

    const pings = fake.requests.filter((r) => r.url.includes('/api/v1/ping'));
    expect(pings.length).toBe(1);

    // 4. Queue an inbound message and poll
    const ts1 = Date.now() + 1;
    fake.queueMessages([
      {
        chats: [{ guid: 'iMessage;-;+19005550001' }],
        handle: { address: '+19005550001', displayName: 'E2E User' },
        text: 'E2E test inbound message',
        dateCreated: ts1,
        isFromMe: false,
      },
    ]);
    await ch.pollOnce();

    // 5. Verify onMessage was called correctly
    expect(opts.onMessage).toHaveBeenCalledOnce();
    const [jid, msg] = opts.onMessage.mock.calls[0];
    expect(jid).toBe(SENDER_JID);
    expect(msg.content).toBe('E2E test inbound message');
    expect(msg.is_from_me).toBe(false);
    expect(msg.sender).toBe('+19005550001');
    expect(msg.sender_name).toBe('E2E User');
    expect(msg.chat_jid).toBe(SENDER_JID);

    // 6. Bot replies via sendMessage
    await ch.sendMessage(SENDER_JID, 'E2E reply from bot');

    // 7. Assert fake server received the outbound POST
    const sends = fake.requests.filter((r) =>
      r.url.includes('/api/v1/message/text'),
    );
    expect(sends.length).toBe(1);
    expect(sends[0].method).toBe('POST');
    expect(sends[0].body.chatGuid).toBe('iMessage;-;+19005550001');
    expect(sends[0].body.message).toBe('E2E reply from bot');
    expect(sends[0].url).toContain('password=');

    // 8. Disconnect
    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
  });

  it('group chat: poll delivers → mention rewrite → correct group JID', async () => {
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);

    const opts = makeOpts({
      [GROUP_JID]: { folder: 'e2e-group', name: 'E2E Group' },
    });
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);
    openResources.push({ close: () => ch.disconnect() });

    await ch.connect();

    const ts1 = Date.now() + 1;
    fake.queueMessages([
      {
        chats: [{ guid: 'iMessage;+;e2e-group-guid' }],
        handle: { address: '+19005550001', displayName: 'Group Member' },
        text: 'hey @E2EBot what time is it',
        dateCreated: ts1,
        isFromMe: false,
      },
    ]);
    await ch.pollOnce();

    expect(opts.onMessage).toHaveBeenCalledOnce();
    const [jid, msg] = opts.onMessage.mock.calls[0];
    expect(jid).toBe(GROUP_JID);
    // Mention rewrite: bare @E2EBot mid-sentence gets prepended
    expect(msg.content).toBe('@E2EBot hey @E2EBot what time is it');
  });

  it('isFromMe messages are dropped (echo guard)', async () => {
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);

    const opts = makeOpts({
      [SENDER_JID]: { folder: 'e2e-dm', name: 'E2E User' },
    });
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);
    openResources.push({ close: () => ch.disconnect() });

    await ch.connect();

    fake.queueMessages([
      {
        chats: [{ guid: 'iMessage;-;+19005550001' }],
        handle: { address: '+19005550001' },
        text: 'this was sent by me',
        dateCreated: Date.now() + 1,
        isFromMe: true,
      },
    ]);
    await ch.pollOnce();

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('unregistered JID messages are dropped', async () => {
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);

    // Empty registered groups
    const opts = makeOpts({});
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);
    openResources.push({ close: () => ch.disconnect() });

    await ch.connect();

    fake.queueMessages([
      {
        chats: [{ guid: 'iMessage;-;+19005550001' }],
        handle: { address: '+19005550001' },
        text: 'not registered',
        dateCreated: Date.now() + 1,
        isFromMe: false,
      },
    ]);
    await ch.pollOnce();

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('attachment-only message is delivered with [Attachment: unsupported in v1] marker', async () => {
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);

    const opts = makeOpts({
      [SENDER_JID]: { folder: 'e2e-dm', name: 'E2E User' },
    });
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);
    openResources.push({ close: () => ch.disconnect() });

    await ch.connect();

    fake.queueMessages([
      {
        chats: [{ guid: 'iMessage;-;+19005550001' }],
        handle: { address: '+19005550001', displayName: 'E2E User' },
        text: '',
        attachments: [{ transferName: 'photo.jpg', mimeType: 'image/jpeg' }],
        dateCreated: Date.now() + 1,
        isFromMe: false,
      },
    ]);
    await ch.pollOnce();

    expect(opts.onMessage).toHaveBeenCalledOnce();
    const [, m] = opts.onMessage.mock.calls[0];
    expect(m.content).toBe('[Attachment: unsupported in v1]');
  });

  it('cursor prevents duplicate delivery across polls', async () => {
    const fake = await startFakeBBServer();
    openResources.push(fake);

    const bridgeUrl = `http://127.0.0.1:${fake.port}`;
    const sdk = makeSdk(bridgeUrl);

    const opts = makeOpts({
      [SENDER_JID]: { folder: 'e2e-dm', name: 'E2E User' },
    });
    const cfg = parseConfig(sdk);
    if (!cfg) throw new Error('parseConfig returned null');
    const ch = new IMessageChannel(cfg, opts, sdk);
    openResources.push({ close: () => ch.disconnect() });

    await ch.connect();

    const ts1 = Date.now() + 1;
    fake.queueMessages([
      {
        chats: [{ guid: 'iMessage;-;+19005550001' }],
        handle: { address: '+19005550001', displayName: 'E2E User' },
        text: 'first',
        dateCreated: ts1,
        isFromMe: false,
      },
    ]);
    await ch.pollOnce();
    expect(opts.onMessage).toHaveBeenCalledTimes(1);

    // Second poll — nothing queued → no new messages
    await ch.pollOnce();
    expect(opts.onMessage).toHaveBeenCalledTimes(1);

    // Verify the second query carries the advanced cursor
    const queries = fake.requests.filter((r) =>
      r.url.includes('/api/v1/message/query'),
    );
    expect(queries.length).toBe(2);
    expect(queries[1].body.after).toBe(ts1);
  });
});
