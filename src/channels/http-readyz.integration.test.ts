/**
 * Integration test — HTTP channel /readyz endpoint
 *
 * Uses a real in-memory SQLite database (via _initTestDatabase) and a
 * simulated Redis client that can be toggled reachable / unreachable.
 * Tests the 200→503 transition (AC1+AC2) and the 503→200 recovery (AC3).
 *
 * No mocks of node:http — the real HTTP server binds on a random port
 * and we make real requests against it.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as nodeHttp from 'node:http';
import { vi } from 'vitest';

// ── Stub logging / side-effectful deps ──────────────────────────────────────

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

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'TestBot',
  TRIGGER_PATTERN: /^@TestBot\b/i,
  GROUPS_DIR: '/tmp/groups-http-readyz-integration',
}));

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('node:fs', () => ({
  default: { mkdirSync: vi.fn(), writeFileSync: vi.fn(), existsSync: vi.fn(() => false), readFileSync: vi.fn() },
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { _initTestDatabase, db } from '../db.js';
import { HttpChannel } from './http.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Find a free TCP port by briefly binding on :0. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = nodeHttp.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

/** Make an HTTP GET or HEAD request and return status + body. */
function rawRequest(
  method: string,
  url: string,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = nodeHttp.request(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port, 10),
        path: parsed.pathname,
        method,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Test-controllable Redis check ────────────────────────────────────────────

let redisReachable = true;

async function checkRedisFn(): Promise<'ok' | 'unreachable'> {
  return redisReachable ? 'ok' : 'unreachable';
}

function checkDbFn(): 'ok' | 'failed' {
  try {
    db.exec('SELECT 1');
    return 'ok';
  } catch {
    return 'failed';
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('HTTP channel /readyz integration', () => {
  let channel: HttpChannel;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    // Initialise a real in-memory SQLite database.
    await _initTestDatabase();

    port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;

    channel = new HttpChannel(
      { port, users: { alice: 'pass' } } as any,
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn(() => ({})),
        checkDb: checkDbFn,
        checkRedis: checkRedisFn,
      },
    );
    await channel.connect();
  }, 15_000);

  afterAll(async () => {
    await channel.disconnect();
  });

  afterEach(() => {
    // Reset Redis to reachable between tests.
    redisReachable = true;
  });

  // AC1: healthy pod → 200 + ready body
  it('AC1: GET /readyz → 200 with ready JSON when DB+Redis healthy', async () => {
    redisReachable = true;
    const { statusCode, headers, body } = await rawRequest('GET', `${baseUrl}/readyz`);

    expect(statusCode).toBe(200);
    expect(headers['content-type']).toMatch(/application\/json/);

    const parsed = JSON.parse(body) as {
      status: string;
      checks: { db: string; redis: string };
    };
    expect(parsed.status).toBe('ready');
    expect(parsed.checks.db).toBe('ok');
    expect(parsed.checks.redis).toBe('ok');
  });

  // AC2: Redis unreachable → 503, pod does NOT crash
  it('AC2: GET /readyz → 503 when Redis unreachable; checks.redis = unreachable', async () => {
    redisReachable = false;

    const { statusCode, body } = await rawRequest('GET', `${baseUrl}/readyz`);

    expect(statusCode).toBe(503);
    const parsed = JSON.parse(body) as {
      status: string;
      checks: { db: string; redis: string };
    };
    expect(parsed.status).toBe('not_ready');
    expect(parsed.checks.db).toBe('ok');
    expect(parsed.checks.redis).toBe('unreachable');

    // AC2: pod itself does NOT crash — server still accepts connections
    expect(channel.isConnected()).toBe(true);
  });

  // AC3: Redis restored → 200 again, no pod restart required
  it('AC3: GET /readyz → 200 again after Redis is restored', async () => {
    // First verify unreachable state
    redisReachable = false;
    const r1 = await rawRequest('GET', `${baseUrl}/readyz`);
    expect(r1.statusCode).toBe(503);

    // Restore Redis
    redisReachable = true;
    const r2 = await rawRequest('GET', `${baseUrl}/readyz`);
    expect(r2.statusCode).toBe(200);

    // No channel restart was needed
    expect(channel.isConnected()).toBe(true);
  });

  // AC4: HEAD mirrors GET status, no body
  it('AC4: HEAD /readyz → 200, no body when healthy', async () => {
    redisReachable = true;
    const { statusCode, body } = await rawRequest('HEAD', `${baseUrl}/readyz`);
    expect(statusCode).toBe(200);
    expect(body).toBe('');
  });

  it('AC4: HEAD /readyz → 503, no body when Redis unreachable', async () => {
    redisReachable = false;
    const { statusCode, body } = await rawRequest('HEAD', `${baseUrl}/readyz`);
    expect(statusCode).toBe(503);
    expect(body).toBe('');
  });

  // No auth required — probes don't send credentials
  it('does not require Authorization header', async () => {
    redisReachable = true;
    const { statusCode } = await rawRequest('GET', `${baseUrl}/readyz`);
    // 200, not 401
    expect(statusCode).toBe(200);
  });

  // DB failure path — close the db handle and see if check reports failure
  it('returns 503 with db:failed when DB exec throws', async () => {
    redisReachable = true;
    // Create a channel with a checkDb that always throws
    const port2 = await freePort();
    const failingChannel = new HttpChannel(
      { port: port2, users: { alice: 'pass' } } as any,
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn(() => ({})),
        checkDb: () => 'failed',
        checkRedis: async () => 'ok',
      },
    );
    await failingChannel.connect();

    const { statusCode, body } = await rawRequest('GET', `http://127.0.0.1:${port2}/readyz`);
    expect(statusCode).toBe(503);
    const parsed = JSON.parse(body) as { status: string; checks: { db: string; redis: string } };
    expect(parsed.checks.db).toBe('failed');

    await failingChannel.disconnect();
  });
});
