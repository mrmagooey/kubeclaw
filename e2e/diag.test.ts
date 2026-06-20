/**
 * End-to-end tests for the GET /diag operational snapshot endpoint (Story 79).
 *
 * Namespace: kubeclaw-e2e-diag
 * Port:      14162
 *
 * The test spins up a real HttpChannel on port 14162, calls /diag via HTTP
 * (both GET and HEAD), and verifies all 7 required fields in the JSON response.
 *
 * Because this is a real channel pod running against the in-process DB (not a
 * Kubernetes deployment) we call _initTestDatabase() before starting the
 * server so the snapshot reads from a known-empty database.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';

import { makeHttpChannel, type HttpChannelOpts } from './lib/http-test-channel.js';
import { _initTestDatabase } from '../src/db.js';

const E2E_PORT = 14162;
const E2E_USER = 'diag-user';
const E2E_PASS = 'diag-secret';
const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function makeOpts(): HttpChannelOpts {
  return {
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({
      [`http:${E2E_USER}`]: {
        name: E2E_USER,
        folder: `http-${E2E_USER}`,
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      },
    }),
  };
}

describe(`GET /diag (Story 79, namespace kubeclaw-e2e-diag, port ${E2E_PORT})`, () => {
  let channel: ReturnType<typeof makeHttpChannel>;

  beforeAll(async () => {
    // Initialise an in-process SQLite DB so the snapshot queries have a real DB.
    await _initTestDatabase();

    channel = makeHttpChannel(
      { port: E2E_PORT, users: { [E2E_USER]: E2E_PASS } },
      makeOpts(),
    );
    await channel.connect();
  }, 10_000);

  afterAll(async () => {
    await channel?.disconnect();
  });

  // ── AC1: all 7 fields present, all numbers ─────────────────────────────────

  it('returns 200 JSON with all 7 required fields as numbers or null', async () => {
    const res = await fetch(`${BASE_URL}/diag`, {
      headers: { Authorization: basicAuth(E2E_USER, E2E_PASS) },
    });

    expect(res.status, 'expected 200').toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');

    const body = await res.json() as Record<string, unknown>;

    // All 7 fields must be present
    const required = [
      'conversation_history_rows',
      'scheduled_tasks_active',
      'tool_jobs_recent_24h',
      'attachment_count',
      'attachment_bytes',
      'db_size_bytes',
      'uptime_seconds',
    ];
    for (const key of required) {
      expect(body, `missing field: ${key}`).toHaveProperty(key);
    }

    // Each field must be a number or null
    for (const key of required) {
      const val = body[key];
      expect(
        val === null || typeof val === 'number',
        `field ${key} should be number or null, got ${typeof val}`,
      ).toBe(true);
    }

    // uptime_seconds must be a non-negative integer (not null)
    expect(typeof body.uptime_seconds).toBe('number');
    expect(body.uptime_seconds as number).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.uptime_seconds)).toBe(true);
  }, 10_000);

  // ── AC2: group-scoped — conversation_history and scheduled_tasks are 0 on clean DB

  it('conversation_history_rows is 0 on a fresh empty database', async () => {
    const res = await fetch(`${BASE_URL}/diag`, {
      headers: { Authorization: basicAuth(E2E_USER, E2E_PASS) },
    });
    const body = await res.json() as Record<string, unknown>;
    expect(body.conversation_history_rows).toBe(0);
  }, 10_000);

  it('scheduled_tasks_active is 0 on a fresh empty database', async () => {
    const res = await fetch(`${BASE_URL}/diag`, {
      headers: { Authorization: basicAuth(E2E_USER, E2E_PASS) },
    });
    const body = await res.json() as Record<string, unknown>;
    expect(body.scheduled_tasks_active).toBe(0);
  }, 10_000);

  // ── AC3: unauthenticated → 401 ─────────────────────────────────────────────

  it('returns 401 when no Authorization header is sent', async () => {
    const res = await fetch(`${BASE_URL}/diag`);
    expect(res.status).toBe(401);
  }, 10_000);

  it('returns 401 when wrong password is supplied', async () => {
    const res = await fetch(`${BASE_URL}/diag`, {
      headers: { Authorization: basicAuth(E2E_USER, 'wrong-password') },
    });
    expect(res.status).toBe(401);
  }, 10_000);

  // ── AC4: POST → 405 Allow: GET, HEAD ───────────────────────────────────────

  it('POST /diag returns 405 with Allow: GET, HEAD header', async () => {
    const res = await fetch(`${BASE_URL}/diag`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(E2E_USER, E2E_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD');
  }, 10_000);

  // ── AC4: HEAD → same headers as GET, no body ──────────────────────────────

  it('HEAD /diag returns 200 with Content-Type: application/json and no body', async () => {
    const res = await fetch(`${BASE_URL}/diag`, {
      method: 'HEAD',
      headers: { Authorization: basicAuth(E2E_USER, E2E_PASS) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    // Content-Length must match the GET body size
    const clHeader = res.headers.get('Content-Length');
    expect(clHeader).toBeTruthy();
    expect(parseInt(clHeader!, 10)).toBeGreaterThan(0);
    // HEAD responses have no body
    const text = await res.text();
    expect(text).toBe('');
  }, 10_000);

  // ── AC4: HEAD Content-Length matches GET body size ─────────────────────────

  it('HEAD Content-Length matches actual GET body size', async () => {
    const auth = { Authorization: basicAuth(E2E_USER, E2E_PASS) };

    const [getRes, headRes] = await Promise.all([
      fetch(`${BASE_URL}/diag`, { headers: auth }),
      fetch(`${BASE_URL}/diag`, { method: 'HEAD', headers: auth }),
    ]);

    const getBody = await getRes.text();
    const headCl = parseInt(headRes.headers.get('Content-Length') ?? '0', 10);

    expect(headCl).toBe(Buffer.byteLength(getBody));
  }, 10_000);
});
