/**
 * WhatsApp adapter integration test.
 *
 * Boots the REAL node:http server on an ephemeral port and exercises:
 *   1. GET /webhook → verification handshake (200 + challenge)
 *   2. POST /webhook with correctly-signed body → onMessage fires
 *   3. POST /webhook with bad signature → 403 and no onMessage
 *
 * No network access to Meta. HMAC signed by the real algorithm.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  WhatsAppChannel,
  parseConfig,
} from '../../helm/kubeclaw/files/channel-src/whatsapp/channel-entry.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const APP_SECRET = 'integration-secret';
const VERIFY_TOKEN = 'integration-verify-token';
const ACCESS_TOKEN = 'Bearer-not-real';
const PHONE_ID = '99887766';

function makeSdk() {
  return {
    registerChannel: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readEnvFile: () => ({
      WHATSAPP_ACCESS_TOKEN: ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
      WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
      WHATSAPP_APP_SECRET: APP_SECRET,
    }),
    assistantName: 'IntegBot',
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

function hmacSign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/** Start the channel on an ephemeral port; returns { ch, port }. */
async function startChannel(opts: ReturnType<typeof makeOpts>) {
  const sdk = makeSdk();
  const cfg = parseConfig(sdk);
  if (!cfg) throw new Error('parseConfig returned null');
  // Use port 0 for ephemeral port assignment
  cfg.httpPort = 0;
  const ch = new WhatsAppChannel(cfg, opts, sdk);
  await ch.connect();
  const port = (ch as any).server.address().port as number;
  return { ch, port };
}

// Track channels to close after each test
const openChannels: WhatsAppChannel[] = [];

afterEach(async () => {
  for (const ch of openChannels) {
    await ch.disconnect().catch(() => {});
  }
  openChannels.length = 0;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('whatsapp-adapter: integration (real HTTP server)', () => {
  it('GET /webhook with correct mode+token → 200 and returns challenge', async () => {
    const opts = makeOpts();
    const { ch, port } = await startChannel(opts);
    openChannels.push(ch);

    const url = new URL(`http://127.0.0.1:${port}/webhook`);
    url.searchParams.set('hub.mode', 'subscribe');
    url.searchParams.set('hub.verify_token', VERIFY_TOKEN);
    url.searchParams.set('hub.challenge', 'test-challenge-xyz');

    const res = await fetch(url.toString(), { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('test-challenge-xyz');
  });

  it('GET /webhook with wrong token → 403', async () => {
    const opts = makeOpts();
    const { ch, port } = await startChannel(opts);
    openChannels.push(ch);

    const url = new URL(`http://127.0.0.1:${port}/webhook`);
    url.searchParams.set('hub.mode', 'subscribe');
    url.searchParams.set('hub.verify_token', 'WRONG-TOKEN');
    url.searchParams.set('hub.challenge', 'should-not-matter');

    const res = await fetch(url.toString(), { method: 'GET' });
    expect(res.status).toBe(403);
  });

  it('POST /webhook with correct HMAC signature → 200 and onMessage fires', async () => {
    const jid = 'whatsapp:+15551234567';
    const opts = makeOpts({ [jid]: { folder: 'wa-dm', name: 'Test DM' } });
    const { ch, port } = await startChannel(opts);
    openChannels.push(ch);

    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'e-integ',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: PHONE_ID,
                  display_phone_number: '+1555000',
                },
                contacts: [
                  { wa_id: '+15551234567', profile: { name: 'Integrator' } },
                ],
                messages: [
                  {
                    from: '+15551234567',
                    id: 'msg-integ-1',
                    type: 'text',
                    text: { body: 'Integration test message' },
                    timestamp: '1700000010',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    });

    const sig = hmacSign(payload, APP_SECRET);
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': sig,
      },
      body: payload,
    });

    expect(res.status).toBe(200);

    // Wait briefly for async processing after 200 response
    await new Promise((r) => setTimeout(r, 50));

    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const [msgJid, msg] = opts.onMessage.mock.calls[0];
    expect(msgJid).toBe(jid);
    expect(msg.content).toBe('Integration test message');
    expect(msg.is_from_me).toBe(false);
    expect(msg.sender).toBe('+15551234567');
    expect(msg.sender_name).toBe('Integrator');
  });

  it('POST /webhook with BAD signature → 403 and no onMessage', async () => {
    const jid = 'whatsapp:+15551234567';
    const opts = makeOpts({ [jid]: { folder: 'wa-dm', name: 'Test DM' } });
    const { ch, port } = await startChannel(opts);
    openChannels.push(ch);

    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'e-bad-sig',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PHONE_ID },
                contacts: [],
                messages: [
                  {
                    from: '+15551234567',
                    id: 'msg-bad',
                    type: 'text',
                    text: { body: 'Should not process' },
                    timestamp: '1700000020',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    });

    // Use wrong secret to generate bad signature
    const badSig = hmacSign(payload, 'wrong-secret-totally');

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
  });

  it('GET /healthz → 200', async () => {
    const opts = makeOpts();
    const { ch, port } = await startChannel(opts);
    openChannels.push(ch);

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
  });

  it('unknown path → 404', async () => {
    const opts = makeOpts();
    const { ch, port } = await startChannel(opts);
    openChannels.push(ch);

    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it('disconnect closes the server cleanly', async () => {
    const opts = makeOpts();
    const { ch, port } = await startChannel(opts);
    // Note: NOT added to openChannels since we close manually
    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);

    // Confirm port is no longer listening
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it('POST /webhook with body > 64 KiB → 413 or connection closed; no onMessage', async () => {
    const opts = makeOpts();
    const { ch, port } = await startChannel(opts);
    openChannels.push(ch);

    // 65537 bytes — one byte over the 65536 cap.
    // HMAC will be wrong, but the size check fires first.
    const bigBody = Buffer.alloc(65537, 'a');

    // req.destroy() in the handler causes the socket to close before the
    // response is sent, so the client sees either 413 or a socket hang-up.
    // Both outcomes prove the body was rejected and no payload was processed.
    const { request } = await import('node:http');
    const result = await new Promise<number | 'hangup'>((resolve) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/webhook',
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': bigBody.length,
            'X-Hub-Signature-256': 'sha256=00',
          },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', () => resolve('hangup'));
      req.write(bigBody);
      req.end();
    });

    // Accept 413 (header written before body exhausted) or hangup (req.destroy races)
    expect(result === 413 || result === 'hangup').toBe(true);

    await new Promise((r) => setTimeout(r, 20));
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('calling disconnect() twice does not throw', async () => {
    const opts = makeOpts();
    const { ch } = await startChannel(opts);
    // Not added to openChannels — we manage cleanup here
    await expect(
      Promise.all([ch.disconnect(), ch.disconnect()]),
    ).resolves.not.toThrow();
    expect(ch.isConnected()).toBe(false);
  });
});
