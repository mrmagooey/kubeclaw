/**
 * Integration tests for GET /export (Story 52).
 *
 * Spin up a real HttpChannel on an ephemeral port, insert conversation rows
 * via the real DB, then hit GET /export and parse the NDJSON — verifying
 * headers, row content, ordering, and auth guard.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import net from 'node:net';

// ── Stubs for side-effectful deps that don't need to bind real resources ──────

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

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return actual;
});

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  GROUPS_DIR: '/tmp',
}));

// Import real DB helpers
import {
  _initTestDatabase,
  __resetDbForTest,
  appendConversationMessage,
} from '../db.js';

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

async function doFetch(
  url: string,
  opts: RequestInit,
): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(url, opts);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('HTTP channel — GET /export (Story 52) integration', () => {
  let channel: HttpChannel;
  let baseUrl: string;

  beforeAll(async () => {
    await _initTestDatabase();
    __resetDbForTest();

    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    // Insert 3 conversation rows for group folder "alice"
    appendConversationMessage('alice', 'user', 'Hello from user');
    appendConversationMessage('alice', 'assistant', 'Hello back!');
    appendConversationMessage('alice', 'user', 'One more message');

    const registeredGroups: Record<string, unknown> = {
      'http:alice': {
        name: 'alice',
        folder: 'alice',
        trigger: '',
        added_at: new Date().toISOString(),
      },
    };

    channel = new HttpChannel(
      {
        port,
        users: { alice: 'secret' },
        perUserMessagesPerMinute: 0,
        corsOrigin: '*',
      },
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => registeredGroups as Record<string, any>,
      },
    );
    await channel.connect();
  });

  afterAll(async () => {
    await channel.disconnect();
  });

  it('AC1: GET /export returns 200 with Content-Type: application/x-ndjson', async () => {
    const res = await doFetch(`${baseUrl}/export`, {
      headers: { Authorization: basicAuth('alice', 'secret') },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
  });

  it('AC1: Content-Disposition includes group name and YYYY-MM-DD date', async () => {
    const res = await doFetch(`${baseUrl}/export`, {
      headers: { Authorization: basicAuth('alice', 'secret') },
    });
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(
      /^attachment; filename="kubeclaw-export-alice-\d{4}-\d{2}-\d{2}\.ndjson"$/,
    );
  });

  it('AC2: body contains all 3 rows as NDJSON lines, oldest-first', async () => {
    const res = await doFetch(`${baseUrl}/export`, {
      headers: { Authorization: basicAuth('alice', 'secret') },
    });
    expect(res.status).toBe(200);

    const lines = res.text.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(3);

    const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

    // All rows have the required keys
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'content',
        'role',
        'sender',
        'timestamp',
      ]);
    }

    // Oldest-first ordering
    expect(rows[0].role).toBe('user');
    expect(rows[0].content).toBe('Hello from user');
    expect(rows[0].sender).toBe('alice');

    expect(rows[1].role).toBe('assistant');
    expect(rows[1].content).toBe('Hello back!');
    expect(rows[1].sender).toBe('assistant');

    expect(rows[2].role).toBe('user');
    expect(rows[2].content).toBe('One more message');
  });

  it('AC3: unauthenticated GET /export → 401', async () => {
    const res = await doFetch(`${baseUrl}/export`, {});
    expect(res.status).toBe(401);
  });

  it('AC4: HEAD /export returns 200 with same headers as GET, no body', async () => {
    const res = await doFetch(`${baseUrl}/export`, {
      method: 'HEAD',
      headers: { Authorization: basicAuth('alice', 'secret') },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="kubeclaw-export-/,
    );
    expect(res.text).toBe('');
  });

  it('AC5: POST /export → 405 with Allow: GET, HEAD', async () => {
    const res = await doFetch(`${baseUrl}/export`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth('alice', 'secret'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(405);
    const allow = res.headers.get('allow') ?? '';
    expect(allow).toMatch(/\bGET\b/);
    expect(allow).toMatch(/\bHEAD\b/);
  });
});
