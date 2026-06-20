/**
 * GET /jobs/<id> and DELETE /jobs/<id> — End-to-End Tests (Story 69)
 *
 * Exercises GET and DELETE on /jobs/<id> using a real HttpChannel bound to
 * port 14152. Uses an in-memory SQLite database pre-seeded with tool_jobs rows.
 * DELETE /jobs/<id> is exercised with a stubbed killJobFn (no Redis required).
 *
 * No Kubernetes or live Redis required — in-process only.
 *
 * Namespace: kubeclaw-e2e-jobs-id
 * Port: 14152
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeHttpChannel, type HttpChannelOpts } from './lib/http-test-channel.js';
import {
  _initTestDatabase,
  __resetDbForTest,
  recordToolJob,
  resolveToolJob,
  storeToolJob,
} from '../src/db.js';

const HTTP_PORT = 14152;
const TEST_USER = 'alice';
const TEST_PASS = 'alicepass';
const TEST_GROUP_FOLDER = 'alice-group';
const TEST_JID = `http:${TEST_USER}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// Stub kill function: resolves with cancelled by default; can be swapped per-test.
let stubKillResult: { ok: boolean; status?: string; currentStatus?: string; error?: string } = {
  ok: true,
  status: 'cancelled',
};

function makeOpts(): HttpChannelOpts {
  return {
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({
      [TEST_JID]: {
        name: 'Alice',
        folder: TEST_GROUP_FOLDER,
        trigger: '@Andy',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      },
    }),
    killJobFn: async (_jobId, _groupFolder) => ({ ...stubKillResult }),
  };
}

describe('GET /jobs/<id> + DELETE /jobs/<id> — HTTP endpoint (Story 69)', () => {
  let channel: ReturnType<typeof makeHttpChannel> | null = null;

  beforeAll(async () => {
    await _initTestDatabase();

    channel = makeHttpChannel(
      {
        port: HTTP_PORT,
        users: { [TEST_USER]: TEST_PASS },
        perUserMessagesPerMinute: 0,
        corsOrigin: '*',
      },
      makeOpts(),
    );
    await channel.connect();
  }, 10_000);

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  });

  beforeEach(() => {
    __resetDbForTest();
    stubKillResult = { ok: true, status: 'cancelled' };
  });

  // ── AC1: GET /jobs/<id> happy path ─────────────────────────────────────────

  it('AC1: GET /jobs/<id> returns 200 with job detail fields', async () => {
    recordToolJob('nc-alice-get01', TEST_GROUP_FOLDER, TEST_JID, null, 'search');
    resolveToolJob('nc-alice-get01', 'completed');

    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs/nc-alice-get01`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as Record<string, unknown>;
    expect(body.job_id).toBe('nc-alice-get01');
    expect(body.specialist_name).toBe('search');
    expect(body.status).toBe('completed');
    expect(body).toHaveProperty('created_at');
    expect(body).toHaveProperty('resolved_at');
  }, 5000);

  // ── AC2: unknown id → 404 (same as cross-group) ────────────────────────────

  it('AC2: GET /jobs/<unknown-id> → 404', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs/no-such-job-id`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(404);
  }, 5000);

  it('AC2: GET /jobs/<id-from-another-group> → 404 (identical wording, no enumeration)', async () => {
    // Insert a job for a different group
    storeToolJob('nc-other-job01', 'other-group');
    resolveToolJob('nc-other-job01', 'completed');

    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs/nc-other-job01`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    // Same wording as unknown id — no enumeration
    expect(body.error).toBe('Not found');
  }, 5000);

  // ── AC3: DELETE active job → 200 cancelled ────────────────────────────────

  it('AC3: DELETE /jobs/<id> for active job → 200 { status: "cancelled", job_id }', async () => {
    recordToolJob('nc-alice-kill01', TEST_GROUP_FOLDER, TEST_JID, null, 'search');
    // Leave as active — don't call resolveToolJob

    stubKillResult = { ok: true, status: 'cancelled' };

    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs/nc-alice-kill01`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; job_id: string };
    expect(body.status).toBe('cancelled');
    expect(body.job_id).toBe('nc-alice-kill01');
  }, 5000);

  // ── AC4: DELETE resolved job → 409 not_active ────────────────────────────

  it('AC4: DELETE /jobs/<id> for resolved job → 409 not_active', async () => {
    recordToolJob('nc-alice-done02', TEST_GROUP_FOLDER, TEST_JID, null, 'search');
    resolveToolJob('nc-alice-done02', 'completed');

    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs/nc-alice-done02`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; current_status: string };
    expect(body.error).toBe('not_active');
    expect(body.current_status).toBe('completed');
  }, 5000);

  it('AC4: DELETE /jobs/<unknown-id> → 404', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs/no-such-job`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(404);
  }, 5000);

  // ── AC5: method + auth guards ──────────────────────────────────────────────

  it('AC5: POST /jobs/<id> → 405 Allow: GET, HEAD, DELETE', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs/nc-alice-any`, {
      method: 'POST',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(405);
    const allow = res.headers.get('allow') ?? '';
    expect(allow).toMatch(/\bGET\b/);
    expect(allow).toMatch(/\bHEAD\b/);
    expect(allow).toMatch(/\bDELETE\b/);
  }, 5000);

  it('AC5: HEAD /jobs/<id> → same headers as GET, no body', async () => {
    recordToolJob('nc-alice-head01', TEST_GROUP_FOLDER, TEST_JID, null, 'search');
    resolveToolJob('nc-alice-head01', 'completed');

    const [getRes, headRes] = await Promise.all([
      fetch(`http://localhost:${HTTP_PORT}/jobs/nc-alice-head01`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      }),
      fetch(`http://localhost:${HTTP_PORT}/jobs/nc-alice-head01`, {
        method: 'HEAD',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      }),
    ]);

    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toContain('application/json');
    const headBody = await headRes.text();
    expect(headBody).toBe('');
    const getBody = await getRes.text();
    expect(getBody.length).toBeGreaterThan(0);
  }, 5000);

  it('AC5: unauthenticated GET /jobs/<id> → 401', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs/nc-alice-any`);
    expect(res.status).toBe(401);
  }, 5000);

  it('AC5: unauthenticated DELETE /jobs/<id> → 401', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs/nc-alice-any`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  }, 5000);
});
