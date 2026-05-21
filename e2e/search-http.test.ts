// e2e/search-http.test.ts
/**
 * E2E tests for GET /search?q= HTTP endpoint (Story 72).
 *
 * Spins up a real HttpChannel bound to port 14155 with an in-memory sql.js
 * database. Inserts rows via appendConversationMessage, then probes the
 * /search endpoint over HTTP to verify JSON output, auth, validation, 405,
 * and HEAD behaviour.
 *
 * Namespace: kubeclaw-e2e-search-http. Port: 14155.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { HttpChannel, type HttpChannelOpts } from '../src/channels/http.js';
import { _initTestDatabase, appendConversationMessage } from '../src/db.js';

const HTTP_PORT = 14155;
const TEST_USER = 'alice';
const TEST_PASS = 'e2esecret';
const GROUP_JID = `http:${TEST_USER}`;
const GROUP_FOLDER = `kubeclaw-e2e-search-http-${Date.now()}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

describe('GET /search HTTP endpoint (Story 72)', () => {
  let channel: HttpChannel;

  beforeAll(async () => {
    await _initTestDatabase();

    // Insert two conversation rows newest-first (by insertion order — db orders by created_at DESC)
    appendConversationMessage(GROUP_FOLDER, 'user', 'The sidecar proxy terminates TLS');
    appendConversationMessage(GROUP_FOLDER, 'assistant', 'Yes the sidecar handles mTLS between pods');
    // A third row with unrelated content that should NOT appear in search results
    appendConversationMessage(GROUP_FOLDER, 'user', 'What time is it?');

    const opts: HttpChannelOpts = {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({
        [GROUP_JID]: {
          name: TEST_USER,
          folder: GROUP_FOLDER,
          trigger: '@Andy',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      }),
    };

    channel = new HttpChannel(
      { port: HTTP_PORT, users: { [TEST_USER]: TEST_PASS } },
      opts,
    );
    await channel.connect();
  });

  afterAll(async () => {
    await channel.disconnect();
  });

  // ── AC3: Unauthenticated → 401 ────────────────────────────────────────────

  it('returns 401 when no credentials are supplied', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/search?q=sidecar`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when wrong password is supplied', async () => {
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/search?q=sidecar`,
      { headers: { Authorization: basicAuth(TEST_USER, 'wrongpass') } },
    );
    expect(res.status).toBe(401);
  });

  // ── AC2: Missing / empty q → 400 ─────────────────────────────────────────

  it('returns 400 with {error} when q is missing', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/search`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/q required/i);
  });

  it('returns 400 with {error} when q is empty string', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/search?q=`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/q required/i);
  });

  it('returns 400 when q exceeds 500 characters', async () => {
    const longQ = 'a'.repeat(501);
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/search?q=${encodeURIComponent(longQ)}`,
      { headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) } },
    );
    expect(res.status).toBe(400);
  });

  // ── AC1: 200 JSON array newest-first ─────────────────────────────────────

  it('returns 200 JSON array for matching query', async () => {
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/search?q=sidecar`,
      { headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const rows = await res.json() as Array<{ id: string; role: string; content: string; timestamp: string }>;
    expect(Array.isArray(rows)).toBe(true);
    // Both sidecar rows must be present
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // All rows must have required fields
    for (const row of rows) {
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('role');
      expect(row).toHaveProperty('content');
      expect(row).toHaveProperty('timestamp');
    }
    // newest-first: assistant reply was inserted second and must come first
    const roles = rows.map((r) => r.role);
    expect(roles[0]).toBe('assistant');
    expect(roles[1]).toBe('user');
  });

  it('does not return rows that do not match the query', async () => {
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/search?q=sidecar`,
      { headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) } },
    );
    const rows = await res.json() as Array<{ content: string }>;
    // "What time is it?" should not appear
    expect(rows.every((r) => !r.content.includes('What time is it?'))).toBe(true);
  });

  // ── AC2: ?limit=N honored, capped at 100 ─────────────────────────────────

  it('respects ?limit=1 and returns at most 1 row', async () => {
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/search?q=sidecar&limit=1`,
      { headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) } },
    );
    expect(res.status).toBe(200);
    const rows = await res.json() as unknown[];
    expect(rows.length).toBe(1);
  });

  it('applies default limit of 20 when limit is not specified', async () => {
    // Insert enough rows to exceed 20 is impractical in e2e; just confirm 200 and ≤ 20
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/search?q=sidecar`,
      { headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) } },
    );
    expect(res.status).toBe(200);
    const rows = await res.json() as unknown[];
    expect(rows.length).toBeLessThanOrEqual(20);
  });

  // ── AC4: POST → 405 Allow: GET, HEAD  /  HEAD same headers no body ────────

  it('returns 405 with Allow: GET, HEAD for POST /search', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/search`, {
      method: 'POST',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('HEAD /search?q=sidecar returns same status+headers as GET but no body', async () => {
    const [getRes, headRes] = await Promise.all([
      fetch(`http://localhost:${HTTP_PORT}/search?q=sidecar`, {
        method: 'GET',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      }),
      fetch(`http://localhost:${HTTP_PORT}/search?q=sidecar`, {
        method: 'HEAD',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      }),
    ]);

    expect(headRes.status).toBe(200);
    expect(headRes.status).toBe(getRes.status);
    expect(headRes.headers.get('content-type')).toContain('application/json');
    // HEAD must have no body
    const headBody = await headRes.text();
    expect(headBody).toBe('');
    // GET must have a body
    const getBody = await getRes.text();
    expect(getBody.length).toBeGreaterThan(0);
  });
});
