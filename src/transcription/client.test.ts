import { describe, it, expect, vi, beforeEach } from 'vitest';

const readFile = vi.hoisted(() => vi.fn());
vi.mock('fs/promises', () => ({ readFile }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TranscriptionClient } from './client.js';

beforeEach(() => {
  readFile.mockReset();
  vi.unstubAllGlobals();
});

const provider = {
  transcribePath: '/v1/audio/transcriptions',
  responseField: 'text',
  timeoutMs: 60000,
};

describe('TranscriptionClient', () => {
  it('POSTs multipart to endpoint+transcribePath and returns the responseField', async () => {
    readFile.mockResolvedValueOnce(Buffer.from('FAKEAUDIO'));
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'hello world' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new TranscriptionClient({ endpoint: 'http://cap:9000', provider });
    const out = await client.transcribeFile('/groups/g/attachments/raw/a.ogg');

    expect(out).toBe('hello world');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://cap:9000/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).has('file')).toBe(true);
  });

  it('sends the model multipart field when provider.model is set', async () => {
    readFile.mockResolvedValueOnce(Buffer.from('A'));
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 't' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new TranscriptionClient({
      endpoint: 'http://cap:9000/',
      provider: { ...provider, model: 'base.en' },
    });
    await client.transcribeFile('/x/a.ogg');

    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get('model')).toBe('base.en');
    // trailing slash on endpoint is normalized (no double slash)
    expect(fetchMock.mock.calls[0][0]).toBe('http://cap:9000/v1/audio/transcriptions');
  });

  it('reads a custom responseField', async () => {
    readFile.mockResolvedValueOnce(Buffer.from('A'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transcription: 'custom field value' }),
    }));
    const client = new TranscriptionClient({
      endpoint: 'http://cap:9000',
      provider: { ...provider, responseField: 'transcription' },
    });
    expect(await client.transcribeFile('/x/a.ogg')).toBe('custom field value');
  });

  it('throws on a non-2xx response', async () => {
    readFile.mockResolvedValueOnce(Buffer.from('A'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'boom',
    }));
    const client = new TranscriptionClient({ endpoint: 'http://cap:9000', provider });
    await expect(client.transcribeFile('/x/a.ogg')).rejects.toThrow(/500/);
  });

  it('throws when the response field is missing', async () => {
    readFile.mockResolvedValueOnce(Buffer.from('A'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ other: 'x' }),
    }));
    const client = new TranscriptionClient({ endpoint: 'http://cap:9000', provider });
    await expect(client.transcribeFile('/x/a.ogg')).rejects.toThrow(/text/);
  });

  it('propagates a read failure', async () => {
    readFile.mockRejectedValueOnce(new Error('ENOENT'));
    vi.stubGlobal('fetch', vi.fn());
    const client = new TranscriptionClient({ endpoint: 'http://cap:9000', provider });
    await expect(client.transcribeFile('/missing.ogg')).rejects.toThrow(/ENOENT/);
  });
});
