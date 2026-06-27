/**
 * WhatsApp adapter unit tests.
 *
 * Tests pure helpers and the WhatsAppChannel class in isolation.
 * No real HTTP server is started here — see the integration test for that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  ownsJid,
  verifySignature,
  handleVerify,
  parseWebhook,
  WhatsAppChannel,
  parseConfig,
} from '../../helm/kubeclaw/files/channel-src/whatsapp/channel-entry.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSdk(env: Record<string, string> = {}) {
  return {
    registerChannel: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readEnvFile: () => env,
    assistantName: 'Kubey',
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

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    accessToken: 'tok-abc',
    phoneNumberId: '12345678',
    verifyToken: 'my-verify-token',
    appSecret: 'super-secret',
    httpPort: 4080,
    ...overrides,
  };
}

function makeChannel(opts = makeOpts(), config = makeConfig()) {
  const sdk = makeSdk();
  return new WhatsAppChannel(config, opts, sdk);
}

function hmacSign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// ── ownsJid ───────────────────────────────────────────────────────────────────

describe('ownsJid', () => {
  it('returns true for whatsapp: prefix', () => {
    expect(ownsJid('whatsapp:+14155238886')).toBe(true);
    expect(ownsJid('whatsapp:group.abc123')).toBe(true);
  });

  it('returns false for other prefixes', () => {
    expect(ownsJid('telegram:123')).toBe(false);
    expect(ownsJid('signal:+1234')).toBe(false);
    expect(ownsJid('http:alice')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(ownsJid(undefined as any)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(ownsJid('')).toBe(false);
  });
});

// ── handleVerify ──────────────────────────────────────────────────────────────

describe('handleVerify', () => {
  const TOKEN = 'my-verify-token';

  it('returns challenge when mode=subscribe and token matches', () => {
    const query = {
      'hub.mode': 'subscribe',
      'hub.verify_token': TOKEN,
      'hub.challenge': 'abc123',
    };
    expect(handleVerify(query, TOKEN)).toBe('abc123');
  });

  it('returns null when mode is not subscribe', () => {
    const query = {
      'hub.mode': 'unsubscribe',
      'hub.verify_token': TOKEN,
      'hub.challenge': 'abc123',
    };
    expect(handleVerify(query, TOKEN)).toBeNull();
  });

  it('returns null when verify_token does not match', () => {
    const query = {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'abc123',
    };
    expect(handleVerify(query, TOKEN)).toBeNull();
  });

  it('returns null when challenge is missing but mode+token match', () => {
    const query = {
      'hub.mode': 'subscribe',
      'hub.verify_token': TOKEN,
    };
    expect(handleVerify(query, TOKEN)).toBeNull();
  });
});

// ── verifySignature ───────────────────────────────────────────────────────────

describe('verifySignature', () => {
  const SECRET = 'my-app-secret';
  const BODY = Buffer.from('{"object":"whatsapp_business_account"}');

  it('returns true for a correctly-signed body', () => {
    const sig = hmacSign(BODY.toString(), SECRET);
    expect(verifySignature(BODY, SECRET, sig)).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const sig = hmacSign('original body', SECRET);
    const tampered = Buffer.from('tampered body');
    expect(verifySignature(tampered, SECRET, sig)).toBe(false);
  });

  it('returns false for wrong secret', () => {
    const sig = hmacSign(BODY.toString(), 'wrong-secret');
    expect(verifySignature(BODY, SECRET, sig)).toBe(false);
  });

  it('returns false when headerSig is missing sha256= prefix', () => {
    const raw = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifySignature(BODY, SECRET, raw)).toBe(false);
  });

  it('returns false for an empty signature', () => {
    expect(verifySignature(BODY, SECRET, '')).toBe(false);
  });

  it('returns false for undefined signature', () => {
    expect(verifySignature(BODY, SECRET, undefined as any)).toBe(false);
  });
});

// ── parseWebhook ──────────────────────────────────────────────────────────────

describe('parseWebhook', () => {
  function makeMessagesPayload(messages: any[], contacts: any[] = []) {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry-id',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: '12345678',
                  display_phone_number: '+15550001234',
                },
                contacts,
                messages,
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
  }

  it('extracts text message from a standard payload', () => {
    const payload = makeMessagesPayload(
      [
        {
          from: '14155238886',
          id: 'msg-id-1',
          type: 'text',
          text: { body: 'Hello KubeClaw' },
          timestamp: '1700000000',
        },
      ],
      [{ wa_id: '14155238886', profile: { name: 'Alice' } }],
    );
    const result = parseWebhook(payload);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      jid: 'whatsapp:14155238886',
      sender: '14155238886',
      senderName: 'Alice',
      text: 'Hello KubeClaw',
      isGroup: false,
    });
  });

  it('returns [] for statuses-only payload', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry-id',
          changes: [
            {
              value: {
                statuses: [{ id: 'msg1', status: 'delivered' }],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    expect(parseWebhook(payload)).toEqual([]);
  });

  it('ignores own/echo messages (from_me = true)', () => {
    const payload = makeMessagesPayload([
      {
        from: '14155238886',
        id: 'msg-echo',
        type: 'text',
        text: { body: 'I sent this' },
        from_me: true,
        timestamp: '1700000000',
      },
    ]);
    expect(parseWebhook(payload)).toEqual([]);
  });

  it('appends [Attachment: unsupported in v1] for media-only messages', () => {
    const payload = makeMessagesPayload(
      [
        {
          from: '14155238886',
          id: 'msg-img',
          type: 'image',
          image: { id: 'img-id', mime_type: 'image/jpeg' },
          timestamp: '1700000000',
        },
      ],
      [{ wa_id: '14155238886', profile: { name: 'Bob' } }],
    );
    const result = parseWebhook(payload);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('[Attachment: unsupported in v1]');
  });

  it('returns [] for empty entry list', () => {
    expect(
      parseWebhook({ object: 'whatsapp_business_account', entry: [] }),
    ).toEqual([]);
  });

  it('returns [] for malformed payload (null)', () => {
    expect(parseWebhook(null)).toEqual([]);
  });

  it('uses sender id as senderName when contacts array is empty', () => {
    const payload = makeMessagesPayload([
      {
        from: '14155238886',
        id: 'msg-no-contact',
        type: 'text',
        text: { body: 'Hi' },
        timestamp: '1700000000',
      },
    ]);
    const result = parseWebhook(payload);
    expect(result[0].senderName).toBe('14155238886');
  });
});

// ── factory: null when creds missing ─────────────────────────────────────────

describe('parseConfig: returns null when credentials missing', () => {
  it('returns null when access token missing', () => {
    const sdk = makeSdk({
      WHATSAPP_PHONE_NUMBER_ID: '123',
      WHATSAPP_VERIFY_TOKEN: 'tok',
      WHATSAPP_APP_SECRET: 'sec',
    });
    expect(parseConfig(sdk)).toBeNull();
    expect(sdk.logger.warn).toHaveBeenCalled();
  });

  it('returns null when phone number id missing', () => {
    const sdk = makeSdk({
      WHATSAPP_ACCESS_TOKEN: 'tok',
      WHATSAPP_VERIFY_TOKEN: 'vtok',
      WHATSAPP_APP_SECRET: 'sec',
    });
    expect(parseConfig(sdk)).toBeNull();
  });

  it('returns null when verify token missing', () => {
    const sdk = makeSdk({
      WHATSAPP_ACCESS_TOKEN: 'tok',
      WHATSAPP_PHONE_NUMBER_ID: '123',
      WHATSAPP_APP_SECRET: 'sec',
    });
    expect(parseConfig(sdk)).toBeNull();
  });

  it('returns null when app secret missing', () => {
    const sdk = makeSdk({
      WHATSAPP_ACCESS_TOKEN: 'tok',
      WHATSAPP_PHONE_NUMBER_ID: '123',
      WHATSAPP_VERIFY_TOKEN: 'vtok',
    });
    expect(parseConfig(sdk)).toBeNull();
  });

  it('returns null when ALL credentials missing', () => {
    const sdk = makeSdk({});
    expect(parseConfig(sdk)).toBeNull();
  });
});

// ── registered groups drop ────────────────────────────────────────────────────

describe('inbound: drop messages from unregistered JIDs', () => {
  it('does not call onMessage for unregistered JID', async () => {
    // Build a minimal channel with no server (skip connect)
    const sdk = makeSdk();
    const opts = makeOpts({}); // no registered groups
    const ch = new WhatsAppChannel(makeConfig(), opts, sdk);

    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'e1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '12345678' },
                contacts: [
                  { wa_id: '14155238886', profile: { name: 'Stranger' } },
                ],
                messages: [
                  {
                    from: '14155238886',
                    id: 'msg-1',
                    type: 'text',
                    text: { body: 'Hello' },
                    timestamp: '1700000001',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    // Simulate the internal processing directly
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = hmacSign(rawBody.toString(), 'super-secret');

    // We call the internal method to avoid needing a real server
    let response403 = false;
    const fakeReq = {
      url: '/webhook',
      method: 'POST',
      headers: { 'x-hub-signature-256': sig },
      on: (event: string, handler: (chunk?: any) => void) => {
        if (event === 'data') handler(rawBody);
        if (event === 'end') handler();
      },
    } as any;
    const fakeRes = {
      headersSent: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    } as any;

    await ch._handleWebhookRequest(fakeReq, fakeRes);
    // Should respond 200 OK (signature valid, just no registered group)
    expect(fakeRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    // But onMessage should NOT have been called
    expect(opts.onMessage).not.toHaveBeenCalled();
  });
});

// ── mention rewrite ───────────────────────────────────────────────────────────

describe('inbound: mention rewrite for group messages', () => {
  it('prepends @AssistantName when message mentions but does not start with it', async () => {
    const sdk = makeSdk();
    sdk.assistantName = 'Kubey';
    const jid = 'whatsapp:group.abc';
    const opts = makeOpts({
      [jid]: { folder: 'wa-group', name: 'test group' },
    });
    const ch = new WhatsAppChannel(makeConfig(), opts, sdk);

    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'e1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '12345678' },
                contacts: [
                  { wa_id: '14155238886', profile: { name: 'Alice' } },
                ],
                messages: [
                  {
                    from: '14155238886',
                    id: 'msg-2',
                    type: 'text',
                    text: { body: 'hey @Kubey can you help?' },
                    group_id: 'abc',
                    timestamp: '1700000002',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = hmacSign(rawBody.toString(), 'super-secret');
    const fakeReq = {
      url: '/webhook',
      method: 'POST',
      headers: { 'x-hub-signature-256': sig },
      on: (event: string, handler: (chunk?: any) => void) => {
        if (event === 'data') handler(rawBody);
        if (event === 'end') handler();
      },
    } as any;
    const fakeRes = {
      headersSent: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    } as any;

    await ch._handleWebhookRequest(fakeReq, fakeRes);
    // Give async processing a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.onMessage).toHaveBeenCalled();
    const [, msg] = opts.onMessage.mock.calls[0];
    expect(msg.content).toMatch(/^@Kubey hey @Kubey can you help\?/);
  });
});

// ── sendMessage ───────────────────────────────────────────────────────────────

describe('sendMessage', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '',
    });
    // @ts-ignore
    global.fetch = fetchSpy;
  });

  it('POSTs to the correct Graph API URL with bearer header', async () => {
    const ch = makeChannel();
    await ch.sendMessage('whatsapp:+14155238886', 'Hello World');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v20.0/12345678/messages');
    expect(init.headers['Authorization']).toBe('Bearer tok-abc');
    const body = JSON.parse(init.body);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('+14155238886');
    expect(body.type).toBe('text');
    expect(body.text.body).toBe('Hello World');
  });

  it('chunks messages at 4096 characters', async () => {
    const ch = makeChannel();
    const longText = 'a'.repeat(5000);
    await ch.sendMessage('whatsapp:+14155238886', longText);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const body1 = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const body2 = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(body1.text.body.length).toBe(4096);
    expect(body2.text.body.length).toBe(5000 - 4096);
  });

  it('ignores JIDs it does not own', async () => {
    const ch = makeChannel();
    await ch.sendMessage('telegram:12345', 'should be ignored');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs error on HTTP failure without throwing', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    });
    const sdk = makeSdk();
    const ch = new WhatsAppChannel(makeConfig(), makeOpts(), sdk);
    await ch.sendMessage('whatsapp:+14155238886', 'Hi');
    expect(sdk.logger.error).toHaveBeenCalled();
  });

  it('logs error on network failure without throwing', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'));
    const sdk = makeSdk();
    const ch = new WhatsAppChannel(makeConfig(), makeOpts(), sdk);
    await ch.sendMessage('whatsapp:+14155238886', 'Hi');
    expect(sdk.logger.error).toHaveBeenCalled();
  });

  it('does NOT call fetch for group JID (Cloud API does not support group send)', async () => {
    const sdk = makeSdk();
    const ch = new WhatsAppChannel(makeConfig(), makeOpts(), sdk);
    await ch.sendMessage('whatsapp:group.abc123', 'Group message');

    // No HTTP call should be made — group send is unsupported in v1
    expect(fetchSpy).not.toHaveBeenCalled();
    // A warning must have been logged
    expect(sdk.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'whatsapp:group.abc123' }),
      expect.stringContaining('group JIDs is not supported'),
    );
  });
});

// ── _readBody size cap ────────────────────────────────────────────────────────

describe('_readBody: size cap', () => {
  it('resolves with body when within 64 KiB limit', async () => {
    const ch = makeChannel();
    const smallData = Buffer.alloc(100, 'x');
    const fakeReq = {
      on: (event: string, handler: (chunk?: any) => void) => {
        if (event === 'data') handler(smallData);
        if (event === 'end') handler();
      },
      destroy: vi.fn(),
    } as any;
    const body = await (ch as any)._readBody(fakeReq);
    expect(body.length).toBe(100);
  });

  it('rejects with "body too large" and destroys when body exceeds 64 KiB', async () => {
    const ch = makeChannel();
    // 65537 bytes — one byte over the 65536 limit
    const bigChunk = Buffer.alloc(65537, 'a');
    let destroyCalled = false;
    const fakeReq = {
      on: (event: string, handler: (chunk?: any) => void) => {
        if (event === 'data') handler(bigChunk);
        // 'end' is deliberately never fired after destroy in real Node
      },
      destroy: () => {
        destroyCalled = true;
      },
    } as any;
    await expect((ch as any)._readBody(fakeReq)).rejects.toThrow(
      'body too large',
    );
    expect(destroyCalled).toBe(true);
  });
});

// ── disconnect idempotency ────────────────────────────────────────────────────

describe('disconnect: idempotency', () => {
  it('calling disconnect() twice does not throw', async () => {
    const ch = makeChannel();
    // Fake a server so we can test disconnect without binding a port
    let closeCalled = 0;
    (ch as any).server = {
      close: (cb: () => void) => {
        closeCalled++;
        cb();
      },
    };
    (ch as any).connected = true;

    await expect(
      Promise.all([ch.disconnect(), ch.disconnect()]),
    ).resolves.not.toThrow();
    // Only one close call because the second disconnect sees server === null
    expect(closeCalled).toBe(1);
    expect(ch.isConnected()).toBe(false);
  });
});

// ── onChatMetadata called BEFORE onMessage ────────────────────────────────────

describe('inbound: onChatMetadata fired before onMessage', () => {
  it('onChatMetadata is called then onMessage for a valid registered message', async () => {
    const jid = 'whatsapp:+14155551234';
    const sdk = makeSdk();
    const callOrder: string[] = [];
    const opts = {
      onMessage: vi.fn(() => callOrder.push('onMessage')),
      onChatMetadata: vi.fn(() => callOrder.push('onChatMetadata')),
      registeredGroups: vi.fn(() => ({
        [jid]: { folder: 'wa-dm', name: 'dm' },
      })),
    };
    const ch = new WhatsAppChannel(makeConfig(), opts, sdk);

    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'e1',
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345678' },
                contacts: [
                  { wa_id: '+14155551234', profile: { name: 'Test User' } },
                ],
                messages: [
                  {
                    from: '+14155551234',
                    id: 'msg-meta',
                    type: 'text',
                    text: { body: 'test' },
                    timestamp: '1700000003',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = hmacSign(rawBody.toString(), 'super-secret');
    const fakeReq = {
      url: '/webhook',
      method: 'POST',
      headers: { 'x-hub-signature-256': sig },
      on: (event: string, handler: (chunk?: any) => void) => {
        if (event === 'data') handler(rawBody);
        if (event === 'end') handler();
      },
    } as any;
    const fakeRes = {
      headersSent: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    } as any;

    await ch._handleWebhookRequest(fakeReq, fakeRes);
    await new Promise((r) => setTimeout(r, 10));

    expect(callOrder).toEqual(['onChatMetadata', 'onMessage']);
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      jid,
      expect.any(String),
      'Test User',
      'whatsapp',
      false,
    );
  });
});
