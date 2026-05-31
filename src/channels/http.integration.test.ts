/**
 * Integration tests for the HTTP channel's GIF and WebP attachment round-trip
 * (Story 42).
 *
 * These tests spin up a real HttpChannel bound to an ephemeral port, POST
 * multipart bodies with GIF and WebP payloads, then retrieve the stored files
 * via GET /attachments/raw/<filename> — exercising the full upload → detect →
 * write → serve pipeline without mocking node:fs or node:http.
 *
 * Also verifies AC5: a RIFF container that is NOT WebP (e.g. a WAV file with
 * "WAVE" at bytes 8-11) is rejected with HTTP 415.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── Stub side-effectful deps that don't bind real resources ──────────────────

import { vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('../db.js', () => ({
  appendConversationMessage: vi.fn(),
}));

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// ── Config mock — points GROUPS_DIR at a real temp directory ─────────────────

let groupsDir = '';

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  get GROUPS_DIR() {
    return groupsDir;
  },
}));

import { HttpChannel } from './http.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

function basicAuth(user: string, pass: string): string {
  return `Basic ${b64(`${user}:${pass}`)}`;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string')
        return reject(new Error('no addr'));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function buildMultipart(
  boundary: string,
  parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    data: Buffer;
  }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let header = `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) header += `; filename="${part.filename}"`;
    header += '\r\n';
    if (part.contentType) header += `Content-Type: ${part.contentType}\r\n`;
    header += '\r\n';
    chunks.push(Buffer.from(header));
    chunks.push(part.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function doFetch(
  url: string,
  opts: RequestInit,
): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const res = await fetch(url, opts);
  const arrayBuf = await res.arrayBuffer();
  return {
    status: res.status,
    headers: res.headers,
    body: Buffer.from(arrayBuf),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('HTTP channel — GIF and WebP attachment round-trip (integration)', () => {
  let channel: HttpChannel;
  let baseUrl: string;
  let registeredGroups: Record<string, unknown>;

  beforeAll(async () => {
    // Temp directory that acts as GROUPS_DIR for this test run.
    groupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-http-it-'));

    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    registeredGroups = {};

    channel = new HttpChannel(
      { port, users: { alice: 'secret' } },
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn((_jid: string) => {
          // Auto-register alice so the image upload path doesn't silently drop.
          registeredGroups['http:alice'] = {
            name: 'alice',
            folder: 'alice',
            trigger: '',
            added_at: new Date().toISOString(),
          };
        }),
        registeredGroups: () => registeredGroups as Record<string, any>,
      },
    );
    await channel.connect();
  });

  afterAll(async () => {
    await channel.disconnect();
    // Clean up temp dir
    try {
      fs.rmSync(groupsDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  // ── AC1 — GIF round-trip ─────────────────────────────────────────────────

  it('AC1: POST a GIF returns 200; GET /attachments/raw/<file> returns image/gif with identical bytes', async () => {
    // Minimal valid GIF89a header (first 6 bytes define format; the magic check
    // only requires the first 3: 47 49 46).
    const gifBytes = Buffer.from([
      0x47,
      0x49,
      0x46,
      0x38,
      0x39,
      0x61, // GIF89a
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00, // minimal header continuation
    ]);

    const boundary = 'gif-boundary-it';
    const body = buildMultipart(boundary, [
      {
        name: 'image',
        filename: 'test.gif',
        contentType: 'image/gif',
        data: gifBytes,
      },
    ]);

    // POST
    const postRes = await doFetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth('alice', 'secret'),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    expect(
      postRes.status,
      `POST /message should return 200, got ${postRes.status}`,
    ).toBe(200);

    // Find the written file
    const attachDir = path.join(groupsDir, 'http:alice', 'attachments', 'raw');
    const files = fs.readdirSync(attachDir).filter((f) => f.endsWith('.gif'));
    expect(
      files.length,
      'Expected at least one .gif file written',
    ).toBeGreaterThan(0);

    const filename = files[0];

    // GET
    const getRes = await doFetch(`${baseUrl}/attachments/raw/${filename}`, {
      method: 'GET',
      headers: { Authorization: basicAuth('alice', 'secret') },
    });

    expect(
      getRes.status,
      `GET /attachments/raw/${filename} should return 200`,
    ).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('image/gif');
    expect(getRes.body).toEqual(gifBytes);
  });

  // ── AC2 — WebP round-trip ────────────────────────────────────────────────

  it('AC2: POST a WebP returns 200; GET /attachments/raw/<file> returns image/webp with identical bytes', async () => {
    // Minimal RIFF????WEBP payload (12 bytes mandatory + minimal VP8 data).
    const webpBytes = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x04,
      0x00,
      0x00,
      0x00, // file size (8 bytes follow)
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
    ]);

    const boundary = 'webp-boundary-it';
    const body = buildMultipart(boundary, [
      {
        name: 'image',
        filename: 'test.webp',
        contentType: 'image/webp',
        data: webpBytes,
      },
    ]);

    // POST
    const postRes = await doFetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth('alice', 'secret'),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    expect(
      postRes.status,
      `POST /message should return 200, got ${postRes.status}`,
    ).toBe(200);

    // Find the written file
    const attachDir = path.join(groupsDir, 'http:alice', 'attachments', 'raw');
    const files = fs.readdirSync(attachDir).filter((f) => f.endsWith('.webp'));
    expect(
      files.length,
      'Expected at least one .webp file written',
    ).toBeGreaterThan(0);

    const filename = files[0];

    // GET
    const getRes = await doFetch(`${baseUrl}/attachments/raw/${filename}`, {
      method: 'GET',
      headers: { Authorization: basicAuth('alice', 'secret') },
    });

    expect(
      getRes.status,
      `GET /attachments/raw/${filename} should return 200`,
    ).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('image/webp');
    expect(getRes.body).toEqual(webpBytes);
  });

  // ── AC5 — RIFF-but-not-WebP is rejected ──────────────────────────────────

  it('AC5: POST a RIFF container that is not WebP (WAV: bytes 8-11 = WAVE) returns 415', async () => {
    // WAV file: RIFF at [0-3], size at [4-7], "WAVE" at [8-11].
    const wavBytes = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x24,
      0x00,
      0x00,
      0x00, // file size
      0x57,
      0x41,
      0x56,
      0x45, // WAVE  ← not WEBP
      0x66,
      0x6d,
      0x74,
      0x20, // "fmt " chunk
    ]);

    const boundary = 'wav-boundary-it';
    const body = buildMultipart(boundary, [
      {
        name: 'image',
        filename: 'audio.wav',
        data: wavBytes,
      },
    ]);

    const postRes = await doFetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth('alice', 'secret'),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    expect(
      postRes.status,
      'RIFF-but-not-WebP should be rejected with 415',
    ).toBe(415);
  });

  // ── GET /attachments/raw — auth check ─────────────────────────────────────

  it('GET /attachments/raw/<filename> returns 401 without authentication', async () => {
    const res = await doFetch(`${baseUrl}/attachments/raw/test.gif`, {
      method: 'GET',
      // No Authorization header
    });
    expect(res.status).toBe(401);
  });

  it('GET /attachments/raw/<filename> returns 404 for non-existent file', async () => {
    const res = await doFetch(`${baseUrl}/attachments/raw/nonexistent.gif`, {
      method: 'GET',
      headers: { Authorization: basicAuth('alice', 'secret') },
    });
    expect(res.status).toBe(404);
  });
});
