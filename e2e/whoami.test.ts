/**
 * End-to-End tests for GET /whoami
 *
 * Story 75 — GET /whoami returns authenticated identity.
 *
 * Namespace: kubeclaw-e2e-whoami  Port: 14158
 *
 * These tests start a real HttpChannel on port 14158 and make live HTTP
 * requests to verify the /whoami endpoint behaviour end-to-end.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { HttpChannel, type HttpChannelOpts } from '../src/channels/http.js';

const WHOAMI_PORT = 14158;
const TEST_USER = 'alice';
const TEST_PASS = 'alicepass';
const TEST_FOLDER = 'groups/http-alice';

function createOpts(): HttpChannelOpts {
  return {
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({
      [`http:${TEST_USER}`]: {
        name: TEST_USER,
        folder: TEST_FOLDER,
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    }),
  };
}

function createChannel(): HttpChannel {
  return new HttpChannel(
    { port: WHOAMI_PORT, users: { [TEST_USER]: TEST_PASS } },
    createOpts(),
  );
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

describe('GET /whoami (e2e)', () => {
  let channel: HttpChannel | null = null;

  beforeAll(async () => {
    channel = createChannel();
    await channel.connect();
  });

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  });

  // ── AC1: authenticated GET → 200, JSON, 3 fields ─────────────────────────

  it('AC1: authenticated GET returns 200 with Content-Type application/json', async () => {
    const res = await fetch(`http://localhost:${WHOAMI_PORT}/whoami`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  }, 5000);

  it('AC1: response body has username, group, and group_folder', async () => {
    const res = await fetch(`http://localhost:${WHOAMI_PORT}/whoami`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const body = await res.json() as Record<string, unknown>;

    expect(body.username).toBe(TEST_USER);
    expect(body.group).toBe(`http:${TEST_USER}`);
    expect(body.group_folder).toBe(TEST_FOLDER);
  }, 5000);

  it('AC1+AC4: response has EXACTLY 3 fields — no extras', async () => {
    const res = await fetch(`http://localhost:${WHOAMI_PORT}/whoami`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const body = await res.json() as Record<string, unknown>;
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(['group', 'group_folder', 'username']);
  }, 5000);

  // ── AC2: unauthenticated → 401 ────────────────────────────────────────────

  it('AC2: unauthenticated GET returns 401', async () => {
    const res = await fetch(`http://localhost:${WHOAMI_PORT}/whoami`);
    expect(res.status).toBe(401);
  }, 5000);

  it('AC2: wrong password returns 401', async () => {
    const res = await fetch(`http://localhost:${WHOAMI_PORT}/whoami`, {
      headers: { Authorization: basicAuth(TEST_USER, 'wrongpass') },
    });
    expect(res.status).toBe(401);
  }, 5000);

  // ── AC3: POST → 405, HEAD → 200 no body ──────────────────────────────────

  it('AC3: POST /whoami returns 405 with Allow: GET, HEAD', async () => {
    const res = await fetch(`http://localhost:${WHOAMI_PORT}/whoami`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  }, 5000);

  it('AC3: HEAD /whoami returns 200 with same headers as GET but no body', async () => {
    const [getRes, headRes] = await Promise.all([
      fetch(`http://localhost:${WHOAMI_PORT}/whoami`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      }),
      fetch(`http://localhost:${WHOAMI_PORT}/whoami`, {
        method: 'HEAD',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      }),
    ]);

    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toContain('application/json');

    // HEAD must not return a body
    const headBody = await headRes.text();
    expect(headBody).toBe('');

    // Content-Length should match between GET and HEAD
    expect(headRes.headers.get('content-length')).toBe(
      getRes.headers.get('content-length'),
    );
  }, 5000);

  // ── AC5: no sensitive material ────────────────────────────────────────────

  it('AC5: response contains no sensitive material (no token/password/session)', async () => {
    const res = await fetch(`http://localhost:${WHOAMI_PORT}/whoami`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const raw = (await res.text()).toLowerCase();
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('session');
  }, 5000);
});
