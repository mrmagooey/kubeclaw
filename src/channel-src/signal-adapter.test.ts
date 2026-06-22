import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import register from '../../helm/kubeclaw/files/channel-src/signal/channel-entry.js';

vi.mock('node:fs', async () => {
  const mkdirSync = vi.fn();
  const writeFileSync = vi.fn();
  const mod = { mkdirSync, writeFileSync };
  return { ...mod, default: mod };
});

function fakeSdk(env: Record<string, string>) {
  const factories: Record<string, any> = {};
  return {
    sdk: {
      registerChannel: (name: string, f: any) => {
        factories[name] = f;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      readEnvFile: () => env,
      assistantName: 'Andy',
    },
    factories,
  };
}

function fakeOpts(overrides?: { registeredGroups?: () => Record<string, any> }) {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:+61400000000': {
        name: 'Alice',
        folder: 'alice',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'signal:group.ABCD': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

const BOT = '+61412345678';

function buildChannel(env: Record<string, string>, opts?: any) {
  const { sdk, factories } = fakeSdk(env);
  register(sdk);
  const ch = factories['signal'](opts ?? fakeOpts());
  return { sdk, ch };
}

describe('signal-adapter: factory + config parsing', () => {
  it('registers a signal factory that builds a channel with a valid number', () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    expect(ch).not.toBeNull();
    expect(ch.name).toBe('signal');
  });

  it('returns null when SIGNAL_PHONE_NUMBER is missing', () => {
    const { ch } = buildChannel({});
    expect(ch).toBeNull();
  });

  it('returns null when phone number is not E.164', () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: '0412345678' });
    expect(ch).toBeNull();
  });

  it('defaults api url and poll interval', () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    expect(ch.config.apiUrl).toBe('http://localhost:8080');
    expect(ch.config.pollMs).toBe(2000);
  });

  it('honours SIGNAL_API_URL and trims trailing slash', () => {
    const { ch } = buildChannel({
      SIGNAL_PHONE_NUMBER: BOT,
      SIGNAL_API_URL: 'http://signal.test:9000/',
    });
    expect(ch.config.apiUrl).toBe('http://signal.test:9000');
  });

  it('declares markdownOutput:false (Signal renders no markdown)', () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    expect(ch.capabilities.markdownOutput).toBe(false);
  });

  it('honours SIGNAL_POLL_MS as the poll interval (m3)', () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT, SIGNAL_POLL_MS: '5000' });
    expect(ch.config.pollMs).toBe(5000);
  });
});

describe('signal-adapter: ownsJid', () => {
  it('owns signal: JIDs', () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    expect(ch.ownsJid('signal:+61400000000')).toBe(true);
    expect(ch.ownsJid('signal:group.ABCD')).toBe(true);
  });
  it('does not own other JIDs', () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    expect(ch.ownsJid('irc:#x@irc.test:6697')).toBe(false);
    expect(ch.ownsJid('tg:123')).toBe(false);
    expect(ch.ownsJid(undefined as any)).toBe(false);
  });
});

describe('signal-adapter: JID derivation', () => {
  it('uses the group id when present', () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    expect(
      ch.jidForEnvelope({
        sourceNumber: '+61400000000',
        dataMessage: { groupInfo: { groupId: 'ABCD' } },
      }),
    ).toBe('signal:group.ABCD');
  });
  it('uses the sender number for 1:1', () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    expect(ch.jidForEnvelope({ sourceNumber: '+61400000000', dataMessage: {} })).toBe(
      'signal:+61400000000',
    );
  });
});

describe('signal-adapter: handleEnvelope → onMessage', () => {
  it('routes a 1:1 text message to onMessage with the right JID', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    ch.handleEnvelope({
      source: '+61400000000',
      sourceNumber: '+61400000000',
      sourceName: 'Alice',
      timestamp: 1700000000000,
      dataMessage: { message: 'hello bot' },
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'signal:+61400000000',
      expect.objectContaining({
        content: 'hello bot',
        sender: '+61400000000',
        sender_name: 'Alice',
        is_from_me: false,
      }),
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'signal:+61400000000',
      expect.any(String),
      'Alice',
      'signal',
      false,
    );
  });

  it('rewrites a bare assistant mention into a trigger prefix in groups', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    ch.handleEnvelope({
      sourceNumber: '+61400000000',
      sourceName: 'Bob',
      timestamp: 1700000000000,
      dataMessage: { message: 'hey @Andy what time is it', groupInfo: { groupId: 'ABCD' } },
    });
    expect(opts.onMessage).toHaveBeenCalledWith(
      'signal:group.ABCD',
      expect.objectContaining({ content: '@Andy hey @Andy what time is it' }),
    );
  });

  it('ignores messages from unregistered chats', () => {
    const opts = fakeOpts({ registeredGroups: () => ({}) });
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    ch.handleEnvelope({
      sourceNumber: '+61400000000',
      dataMessage: { message: 'hello' },
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('ignores receipts/typing/empty (no dataMessage.message)', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    ch.handleEnvelope({ sourceNumber: '+61400000000', receiptMessage: {} });
    ch.handleEnvelope({ sourceNumber: '+61400000000', dataMessage: {} });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('ignores echoes from the bot itself', () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    ch.handleEnvelope({
      source: BOT,
      sourceNumber: BOT,
      dataMessage: { message: 'my own reply' },
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });
});

describe('signal-adapter: receiveOnce drains the queue', () => {
  let fetchMock: any;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses an array of {envelope} items and routes each', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          envelope: {
            sourceNumber: '+61400000000',
            sourceName: 'Alice',
            timestamp: 1700000000000,
            dataMessage: { message: 'one' },
          },
        },
      ],
    });
    await ch.receiveOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/v1/receive/' + encodeURIComponent(BOT),
    );
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    expect(opts.onMessage).toHaveBeenCalledWith(
      'signal:+61400000000',
      expect.objectContaining({ content: 'one' }),
    );
  });

  it('does nothing on a non-200 receive response', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await ch.receiveOnce();
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('routes a group envelope to onMessage with signal:group.<id> JID and isGroup=true (I2)', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          envelope: {
            sourceNumber: '+61400000000',
            sourceName: 'Bob',
            timestamp: 1700000001000,
            dataMessage: {
              message: 'group hello',
              groupInfo: { groupId: 'ABCD' },
            },
          },
        },
      ],
    });
    await ch.receiveOnce();
    expect(opts.onMessage).toHaveBeenCalledWith(
      'signal:group.ABCD',
      expect.objectContaining({
        content: 'group hello',
        sender: '+61400000000',
        is_from_me: false,
      }),
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'signal:group.ABCD',
      expect.any(String),
      'Bob',
      'signal',
      true,
    );
  });

  it('rejects when fetch throws (ECONNREFUSED) and does not crash (m4)', async () => {
    const opts = fakeOpts();
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    // receiveOnce propagates the rejection; scheduleReceive's catch handles re-scheduling.
    await expect(ch.receiveOnce()).rejects.toThrow('ECONNREFUSED');
    expect(opts.onMessage).not.toHaveBeenCalled();
  });
});

describe('signal-adapter: sendMessage → POST /v2/send', () => {
  let fetchMock: any;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the canonical send payload for a 1:1 recipient', async () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    await ch.sendMessage('signal:+61400000000', 'hi there');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/v2/send');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      message: 'hi there',
      number: BOT,
      recipients: ['+61400000000'],
    });
  });

  it('sends a group recipient as group.<id>', async () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    await ch.sendMessage('signal:group.ABCD', 'team update');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).recipients).toEqual(['group.ABCD']);
  });

  it('chunks messages longer than the limit into multiple sends', async () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    await ch.sendMessage('signal:+61400000000', 'x'.repeat(9000));
    // 9000 / 4000 = 3 chunks (4000 + 4000 + 1000)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message.length).toBe(4000);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).message.length).toBe(1000);
  });

  it('ignores a non-signal JID', async () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    await ch.sendMessage('irc:#x@irc.test:6697', 'nope');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('signal-adapter: lifecycle', () => {
  it('connect sets connected and disconnect clears it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    expect(ch.isConnected()).toBe(false);
    await ch.connect();
    expect(ch.isConnected()).toBe(true);
    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
    vi.unstubAllGlobals();
  });
});

// ── NEW: media capabilities ───────────────────────────────────────────────────

describe('signal-adapter: media capabilities', () => {
  it('declares all four media capability flags', () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    expect(ch.capabilities.inboundImages).toBe(true);
    expect(ch.capabilities.inboundPdfs).toBe(true);
    expect(ch.capabilities.inboundVoice).toBe(true);
    expect(ch.capabilities.outboundMedia).toBe(true);
    expect(ch.capabilities.markdownOutput).toBe(false);
  });
});

// ── NEW: inbound attachments ──────────────────────────────────────────────────

describe('signal-adapter: inbound attachments', () => {
  let fetchMock: any;
  let nodeFs: typeof import('node:fs');

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    nodeFs = await import('node:fs');
    vi.mocked(nodeFs.mkdirSync).mockReset();
    vi.mocked(nodeFs.writeFileSync).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads an image attachment and passes an ImageAttachment marker to onMessage', async () => {
    const opts = fakeOpts();
    const { sdk, ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    // Stub sdk.groupsDir (set by the runtime; simulate it)
    (ch as any).sdk = { ...sdk, groupsDir: '/groups' };

    const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            envelope: {
              sourceNumber: '+61400000000',
              sourceName: 'Alice',
              timestamp: 1700000000000,
              dataMessage: {
                message: '',
                attachments: [{ id: 'att1', contentType: 'image/jpeg', filename: 'pic.jpg' }],
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => imgBytes.buffer,
      });

    await ch.receiveOnce();

    expect(vi.mocked(nodeFs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining('attachments/raw'),
      expect.objectContaining({ recursive: true }),
    );
    expect(vi.mocked(nodeFs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('pic.jpg'),
      expect.any(Buffer),
    );
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const [_jid, msg] = opts.onMessage.mock.calls[0];
    expect(msg.content).toMatch(/\[ImageAttachment: attachments\/raw\/pic\.jpg\]/);
  });

  it('downloads a PDF attachment and passes a PdfAttachment marker', async () => {
    const opts = fakeOpts();
    const { sdk, ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    (ch as any).sdk = { ...sdk, groupsDir: '/groups' };

    const pdfBytes = Buffer.from('%PDF-1.4');
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            envelope: {
              sourceNumber: '+61400000000',
              sourceName: 'Alice',
              timestamp: 1700000002000,
              dataMessage: {
                message: '',
                attachments: [{ id: 'att2', contentType: 'application/pdf', filename: 'doc.pdf' }],
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => pdfBytes.buffer,
      });

    await ch.receiveOnce();

    const [_jid, msg] = opts.onMessage.mock.calls[0];
    expect(msg.content).toMatch(/\[PdfAttachment: attachments\/raw\/doc\.pdf\]/);
  });

  it('downloads a voice attachment and passes a VoiceAttachment marker', async () => {
    const opts = fakeOpts();
    const { sdk, ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    (ch as any).sdk = { ...sdk, groupsDir: '/groups' };

    const audioBytes = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // OGG magic
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            envelope: {
              sourceNumber: '+61400000000',
              sourceName: 'Alice',
              timestamp: 1700000003000,
              dataMessage: {
                message: '',
                attachments: [{ id: 'att3', contentType: 'audio/ogg', filename: 'voice.ogg' }],
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => audioBytes.buffer,
      });

    await ch.receiveOnce();

    const [_jid, msg] = opts.onMessage.mock.calls[0];
    expect(msg.content).toMatch(/\[VoiceAttachment: attachments\/raw\/voice\.ogg\]/);
  });

  it('combines text caption with image marker (text after marker)', async () => {
    const opts = fakeOpts();
    const { sdk, ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT }, opts);
    (ch as any).sdk = { ...sdk, groupsDir: '/groups' };

    const imgBytes = Buffer.from([0xff, 0xd8, 0xff]); // JPEG magic
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            envelope: {
              sourceNumber: '+61400000000',
              sourceName: 'Alice',
              timestamp: 1700000004000,
              dataMessage: {
                message: 'see this image',
                attachments: [{ id: 'att4', contentType: 'image/jpeg', filename: 'photo.jpg', caption: '' }],
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => imgBytes.buffer,
      });

    await ch.receiveOnce();

    const [_jid, msg] = opts.onMessage.mock.calls[0];
    expect(msg.content).toMatch(/\[ImageAttachment: attachments\/raw\/photo\.jpg\]/);
    expect(msg.content).toContain('see this image');
  });
});

// ── NEW: sendMedia ────────────────────────────────────────────────────────────

describe('signal-adapter: sendMedia', () => {
  let fetchMock: any;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts base64_attachments + message to /v2/send for a 1:1 JID', async () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    const imgBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await (ch as any).sendMedia('signal:+61400000000', imgBuf, 'image/png', 'hello caption');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/v2/send');
    const body = JSON.parse(init.body);
    expect(body.recipients).toEqual(['+61400000000']);
    expect(body.number).toBe(BOT);
    expect(body.message).toBe('hello caption');
    expect(body.base64_attachments).toEqual([imgBuf.toString('base64')]);
  });

  it('uses empty string as message when caption is omitted', async () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    const buf = Buffer.from('data');
    await (ch as any).sendMedia('signal:+61400000000', buf, 'image/png');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.message).toBe('');
    expect(body.base64_attachments).toEqual([buf.toString('base64')]);
  });

  it('does not call fetch for a non-signal JID', async () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    await (ch as any).sendMedia('oauth-webchat:user@example.com', Buffer.from('x'), 'image/png');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends to a group JID with the group recipient', async () => {
    const { ch } = buildChannel({ SIGNAL_PHONE_NUMBER: BOT });
    const buf = Buffer.from([1, 2, 3]);
    await (ch as any).sendMedia('signal:group.ABCD', buf, 'image/jpeg', 'caption');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.recipients).toEqual(['group.ABCD']);
  });
});
