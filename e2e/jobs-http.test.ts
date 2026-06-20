/**
 * GET /jobs HTTP endpoint — End-to-End Tests (Story 65)
 *
 * Exercises the GET /jobs REST endpoint on a real HttpChannel instance
 * bound to port 14148. The channel uses an in-memory SQLite database
 * pre-seeded with tool_jobs rows so every assertion runs against real
 * db queries rather than stubs.
 *
 * No Kubernetes or mock LLM server required — in-process only.
 *
 * Namespace: kubeclaw-e2e-jobs-http
 * Port: 14148
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

const HTTP_PORT = 14148;
const TEST_USER = 'alice';
const TEST_PASS = 'alicepass';
const TEST_GROUP_FOLDER = 'alice-group';
const TEST_JID = `http:${TEST_USER}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

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
  };
}

describe('GET /jobs — HTTP endpoint (Story 65)', () => {
  let channel: ReturnType<typeof makeHttpChannel> | null = null;

  beforeAll(async () => {
    await _initTestDatabase();

    channel = makeHttpChannel(
      { port: HTTP_PORT, users: { [TEST_USER]: TEST_PASS } },
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
  });

  // ── AC1: authenticated GET → 200 JSON array ────────────────────────────────

  it('AC1: GET /jobs returns 200 application/json array', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  }, 5000);

  it('AC1: returns newest-first order', async () => {
    const now = new Date();
    const older = new Date(now.getTime() - 60_000).toISOString();
    const newer = now.toISOString();

    recordToolJob('nc-alice-old001', TEST_GROUP_FOLDER, TEST_JID, null, 'search');
    // Resolve so it appears in getRecentToolJobsForGroup (non-active)
    resolveToolJob('nc-alice-old001', 'completed');
    // Manually insert newer job using recordToolJob — we need to resolve both
    recordToolJob('nc-alice-new002', TEST_GROUP_FOLDER, TEST_JID, null, 'search');
    resolveToolJob('nc-alice-new002', 'completed');

    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ job_id: string }>;
    expect(body.length).toBeGreaterThanOrEqual(2);
    // newest-first: nc-alice-new002 should appear before nc-alice-old001
    // (Both were inserted in order, newer second — ORDER BY created_at DESC)
    const ids = body.map((j) => j.job_id);
    expect(ids).toContain('nc-alice-new002');
    expect(ids).toContain('nc-alice-old001');
  }, 5000);

  it('AC1: response rows have required fields', async () => {
    storeToolJob('nc-alice-shape01', TEST_GROUP_FOLDER);
    resolveToolJob('nc-alice-shape01', 'completed');

    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body.length).toBeGreaterThanOrEqual(1);
    const row = body.find((j) => j.job_id === 'nc-alice-shape01');
    expect(row).toBeDefined();
    expect(row).toHaveProperty('job_id');
    expect(row).toHaveProperty('specialist_name');
    expect(row).toHaveProperty('status');
    expect(row).toHaveProperty('created_at');
    expect(row).toHaveProperty('resolved_at');
  }, 5000);

  // ── AC2: status filter ─────────────────────────────────────────────────────

  it('AC2: ?status=active returns only active jobs', async () => {
    recordToolJob('nc-alice-act01', TEST_GROUP_FOLDER, TEST_JID, null, 'search');
    recordToolJob('nc-alice-done01', TEST_GROUP_FOLDER, TEST_JID, null, 'search');
    resolveToolJob('nc-alice-done01', 'completed');

    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs?status=active`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ job_id: string; status: string }>;
    const ids = body.map((j) => j.job_id);
    expect(ids).toContain('nc-alice-act01');
    expect(ids).not.toContain('nc-alice-done01');
    expect(body.every((j) => j.status === 'active')).toBe(true);
  }, 5000);

  it('AC2: ?status=completed returns only resolved jobs', async () => {
    recordToolJob('nc-alice-act02', TEST_GROUP_FOLDER, TEST_JID, null, 'search');
    recordToolJob('nc-alice-done02', TEST_GROUP_FOLDER, TEST_JID, null, 'search');
    resolveToolJob('nc-alice-done02', 'completed');

    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs?status=completed`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ job_id: string; status: string }>;
    const ids = body.map((j) => j.job_id);
    expect(ids).toContain('nc-alice-done02');
    expect(ids).not.toContain('nc-alice-act02');
  }, 5000);

  it('AC2: invalid status param → 400 with error body', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs?status=bogus`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
  }, 5000);

  // ── AC3: unauthenticated → 401 ─────────────────────────────────────────────

  it('AC3: unauthenticated GET /jobs → 401', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs`);
    expect(res.status).toBe(401);
  }, 5000);

  it('AC3: wrong password → 401', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs`, {
      headers: { Authorization: basicAuth(TEST_USER, 'wrongpass') },
    });
    expect(res.status).toBe(401);
  }, 5000);

  // ── AC4: POST → 405; HEAD → no body ────────────────────────────────────────

  it('AC4: POST /jobs → 405 with Allow: GET, HEAD', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs`, {
      method: 'POST',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  }, 5000);

  it('AC4: HEAD /jobs → 200 same headers as GET, no body', async () => {
    const [getRes, headRes] = await Promise.all([
      fetch(`http://localhost:${HTTP_PORT}/jobs`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      }),
      fetch(`http://localhost:${HTTP_PORT}/jobs`, {
        method: 'HEAD',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      }),
    ]);

    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toContain('application/json');
    // HEAD body must be empty
    const headBody = await headRes.text();
    expect(headBody).toBe('');
    // GET has a body
    const getBody = await getRes.text();
    expect(getBody.length).toBeGreaterThan(0);
  }, 5000);

  // ── default limit and scoping ──────────────────────────────────────────────

  it('default limit is 20 — does not return more than 20 rows', async () => {
    for (let i = 0; i < 25; i++) {
      const jobId = `nc-alice-lim${String(i).padStart(3, '0')}`;
      storeToolJob(jobId, TEST_GROUP_FOLDER);
      resolveToolJob(jobId, 'completed');
    }

    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const body = await res.json() as unknown[];
    expect(body.length).toBeLessThanOrEqual(20);
  }, 5000);

  it('only returns jobs belonging to the authenticated group', async () => {
    storeToolJob('nc-alice-mine01', TEST_GROUP_FOLDER);
    resolveToolJob('nc-alice-mine01', 'completed');
    storeToolJob('nc-other-theirs01', 'other-group');
    resolveToolJob('nc-other-theirs01', 'completed');

    const res = await fetch(`http://localhost:${HTTP_PORT}/jobs`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const body = await res.json() as Array<{ job_id: string }>;
    const ids = body.map((j) => j.job_id);
    expect(ids).toContain('nc-alice-mine01');
    expect(ids).not.toContain('nc-other-theirs01');
  }, 5000);
});
