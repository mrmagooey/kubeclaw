/**
 * WhatsApp channel e2e test.
 *
 * Full loop against a fake Graph API server:
 *   1. Start the WhatsApp adapter (real node:http webhook server)
 *   2. Start a fake Graph API server to capture outbound POSTs
 *   3. POST a signed inbound webhook → onMessage fires
 *   4. Call sendMessage → assert fake Graph server received outbound POST
 *      with correct body and Authorization header
 *
 * Note: a live Meta round-trip requires a Business account and is NOT CI-able.
 * This test proves the full in-process adapter loop without external deps.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WhatsAppChannel } from '../helm/kubeclaw/files/channel-src/whatsapp/channel-entry.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const APP_SECRET = 'e2e-app-secret';
const VERIFY_TOKEN = 'e2e-verify-token';
const ACCESS_TOKEN = 'EAAe2e-fake-token';
const PHONE_NUMBER_ID = '11223344';
const SENDER_JID = 'whatsapp:+19005550001';

// ── Helpers ───────────────────────────────────────────────────────────────────

function hmacSign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function makeSdk(graphApiBase: string) {
  return {
    registerChannel: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readEnvFile: () => ({}),
    assistantName: 'E2EBot',
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

/** Build a fake Graph API server that records requests. */
function startFakeGraphServer(): Promise<{
  port: number;
  requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: any;
  }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: any;
  }> = [];

  return new Promise((resolve) => {
    const srv = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: any = raw;
        try {
          body = JSON.parse(raw);
        } catch {}
        requests.push({
          url: req.url ?? '/',
          method: req.method ?? 'GET',
          headers: req.headers as Record<string, string>,
          body,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages: [{ id: 'fake-msg-id' }] }));
      });
    });

    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        port,
        requests,
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

describe('whatsapp-channel: e2e (fake Graph API)', () => {
  it('full loop: inbound webhook → onMessage → sendMessage → Graph API call', async () => {
    // 1. Start fake Graph API server
    const fakeGraph = await startFakeGraphServer();
    openResources.push(fakeGraph);

    // 2. Build adapter config pointing at fake Graph API
    const opts = makeOpts({
      [SENDER_JID]: { folder: 'wa-e2e', name: 'E2E Chat' },
    });
    const sdk = makeSdk(`http://127.0.0.1:${fakeGraph.port}`);

    const config = {
      accessToken: ACCESS_TOKEN,
      phoneNumberId: PHONE_NUMBER_ID,
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      httpPort: 0, // ephemeral
      _graphApiBase: `http://127.0.0.1:${fakeGraph.port}`, // will patch below
    };

    const ch = new WhatsAppChannel(config, opts, sdk);
    // Patch the Graph API base URL to point at our fake server
    (ch as any)._graphApiBase = `http://127.0.0.1:${fakeGraph.port}`;

    await ch.connect();
    const port = (ch as any).server.address().port as number;
    openResources.push({ close: () => ch.disconnect() });

    // 3. POST a signed inbound webhook message
    const inboundPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry-e2e',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: PHONE_NUMBER_ID,
                  display_phone_number: '+1555',
                },
                contacts: [
                  { wa_id: '+19005550001', profile: { name: 'E2E User' } },
                ],
                messages: [
                  {
                    from: '+19005550001',
                    id: 'msg-e2e-1',
                    type: 'text',
                    text: { body: 'E2E test message inbound' },
                    timestamp: '1700000100',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    });

    const sig = hmacSign(inboundPayload, APP_SECRET);
    const webhookRes = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': sig,
      },
      body: inboundPayload,
    });

    expect(webhookRes.status).toBe(200);

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 50));

    // 4. Verify onMessage was called
    expect(opts.onMessage).toHaveBeenCalledOnce();
    const [jid, msg] = opts.onMessage.mock.calls[0];
    expect(jid).toBe(SENDER_JID);
    expect(msg.content).toBe('E2E test message inbound');
    expect(msg.is_from_me).toBe(false);

    // 5. Simulate the bot replying via sendMessage
    // We need to intercept fetch to point at our fake graph server
    const origFetch = global.fetch;
    // @ts-ignore
    global.fetch = async (url: string, init: RequestInit) => {
      const newUrl = url.replace(
        'https://graph.facebook.com/v20.0',
        `http://127.0.0.1:${fakeGraph.port}`,
      );
      return origFetch(newUrl, init);
    };

    try {
      await ch.sendMessage(SENDER_JID, 'E2E reply from bot');
    } finally {
      // @ts-ignore
      global.fetch = origFetch;
    }

    // 6. Assert Graph API received the outbound POST
    expect(fakeGraph.requests).toHaveLength(1);
    const outReq = fakeGraph.requests[0];
    expect(outReq.method).toBe('POST');
    expect(outReq.url).toContain(`/${PHONE_NUMBER_ID}/messages`);
    expect(outReq.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(outReq.body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '+19005550001',
      type: 'text',
      text: { body: 'E2E reply from bot' },
    });
  });

  it('inbound with bad HMAC → 403; no onMessage; no outbound to Graph', async () => {
    const fakeGraph = await startFakeGraphServer();
    openResources.push(fakeGraph);

    const opts = makeOpts({
      [SENDER_JID]: { folder: 'wa-e2e', name: 'E2E Chat' },
    });
    const sdk = makeSdk(`http://127.0.0.1:${fakeGraph.port}`);
    const config = {
      accessToken: ACCESS_TOKEN,
      phoneNumberId: PHONE_NUMBER_ID,
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      httpPort: 0,
    };

    const ch = new WhatsAppChannel(config, opts, sdk);
    await ch.connect();
    const port = (ch as any).server.address().port as number;
    openResources.push({ close: () => ch.disconnect() });

    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [],
    });
    const badSig =
      'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': badSig,
      },
      body: payload,
    });

    expect(res.status).toBe(403);

    await new Promise((r) => setTimeout(r, 20));

    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(fakeGraph.requests).toHaveLength(0);
  });
});
