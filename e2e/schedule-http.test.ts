/**
 * GET /schedule HTTP endpoint — End-to-End Tests (Story 68)
 *
 * Exercises the GET /schedule REST endpoint on a real HttpChannel instance
 * bound to port 14151. The channel uses an in-memory SQLite database
 * pre-seeded with scheduled_tasks rows so every assertion runs against real
 * db queries rather than stubs.
 *
 * No Kubernetes or mock LLM server required — in-process only.
 *
 * Namespace: kubeclaw-e2e-schedule-http
 * Port: 14151
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { HttpChannel, type HttpChannelOpts } from '../src/channels/http.js';
import {
  _initTestDatabase,
  __resetDbForTest,
  createTask,
  pauseTask,
} from '../src/db.js';

const HTTP_PORT = 14151;
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

function makeTask(id: string, overrides?: Partial<{
  status: 'active' | 'paused' | 'completed';
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  prompt: string;
  group_folder: string;
}>) {
  return {
    id,
    group_folder: overrides?.group_folder ?? TEST_GROUP_FOLDER,
    chat_jid: TEST_JID,
    prompt: overrides?.prompt ?? 'Test prompt',
    schedule_type: (overrides?.schedule_type ?? 'cron') as 'cron' | 'interval' | 'once',
    schedule_value: overrides?.schedule_value ?? '0 9 * * *',
    context_mode: 'isolated' as const,
    next_run: new Date(Date.now() + 60_000).toISOString(),
    status: (overrides?.status ?? 'active') as 'active' | 'paused' | 'completed',
    created_at: new Date().toISOString(),
  };
}

describe('GET /schedule — HTTP endpoint (Story 68)', () => {
  let channel: HttpChannel | null = null;

  beforeAll(async () => {
    await _initTestDatabase();

    channel = new HttpChannel(
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

  it('AC1: GET /schedule returns 200 application/json array', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  }, 5000);

  it('AC1: returns newest-created first (ORDER BY created_at DESC)', async () => {
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();

    createTask({ ...makeTask('task-old-001'), created_at: older });
    createTask({ ...makeTask('task-new-002'), created_at: newer });

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string }>;
    expect(body.length).toBeGreaterThanOrEqual(2);
    const ids = body.map((t) => t.id);
    const oldIdx = ids.indexOf('task-old-001');
    const newIdx = ids.indexOf('task-new-002');
    expect(newIdx).toBeLessThan(oldIdx);
  }, 5000);

  it('AC1: response rows have required fields', async () => {
    createTask(makeTask('task-shape-001'));

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body.length).toBeGreaterThanOrEqual(1);
    const row = body.find((t) => t.id === 'task-shape-001');
    expect(row).toBeDefined();
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('schedule_type');
    expect(row).toHaveProperty('schedule_expression');
    expect(row).toHaveProperty('prompt');
    expect(row).toHaveProperty('status');
    expect(row).toHaveProperty('next_run');
    expect(row).toHaveProperty('created_at');
  }, 5000);

  it('AC1: schedule_expression maps from schedule_value column', async () => {
    createTask({ ...makeTask('task-expr-001'), schedule_value: '0 8 * * 1' });

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const body = await res.json() as Array<Record<string, unknown>>;
    const row = body.find((t) => t.id === 'task-expr-001');
    expect(row?.schedule_expression).toBe('0 8 * * 1');
  }, 5000);

  // ── AC2: status filter ─────────────────────────────────────────────────────

  it('AC2: ?status=active returns only active tasks', async () => {
    createTask(makeTask('task-active-01', { status: 'active' }));
    createTask(makeTask('task-paused-01', { status: 'paused' }));
    // Pause the second one
    pauseTask('task-paused-01', TEST_GROUP_FOLDER);

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule?status=active`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string; status: string }>;
    const ids = body.map((t) => t.id);
    expect(ids).toContain('task-active-01');
    expect(ids).not.toContain('task-paused-01');
    expect(body.every((t) => t.status === 'active')).toBe(true);
  }, 5000);

  it('AC2: ?status=paused returns only paused tasks', async () => {
    createTask(makeTask('task-active-02', { status: 'active' }));
    createTask(makeTask('task-paused-02', { status: 'active' }));
    pauseTask('task-paused-02', TEST_GROUP_FOLDER);

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule?status=paused`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string; status: string }>;
    const ids = body.map((t) => t.id);
    expect(ids).toContain('task-paused-02');
    expect(ids).not.toContain('task-active-02');
    expect(body.every((t) => t.status === 'paused')).toBe(true);
  }, 5000);

  it('AC2: invalid status param → 400 with error body', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule?status=bogus`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
  }, 5000);

  // ── AC3: unauthenticated → 401 ─────────────────────────────────────────────

  it('AC3: unauthenticated GET /schedule → 401', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`);
    expect(res.status).toBe(401);
  }, 5000);

  it('AC3: wrong password → 401', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      headers: { Authorization: basicAuth(TEST_USER, 'wrongpass') },
    });
    expect(res.status).toBe(401);
  }, 5000);

  // ── AC4: POST → 405; HEAD → no body ────────────────────────────────────────

  it('AC4: POST /schedule → 405 with Allow: GET, HEAD', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      method: 'POST',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  }, 5000);

  it('AC4: HEAD /schedule → 200 same headers as GET, no body', async () => {
    createTask(makeTask('task-head-001'));

    const [getRes, headRes] = await Promise.all([
      fetch(`http://localhost:${HTTP_PORT}/schedule`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      }),
      fetch(`http://localhost:${HTTP_PORT}/schedule`, {
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

  // ── group scoping ──────────────────────────────────────────────────────────

  it('only returns tasks belonging to the authenticated group', async () => {
    createTask(makeTask('task-mine-01', { group_folder: TEST_GROUP_FOLDER }));
    createTask(makeTask('task-theirs-01', { group_folder: 'other-group' }));

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const body = await res.json() as Array<{ id: string }>;
    const ids = body.map((t) => t.id);
    expect(ids).toContain('task-mine-01');
    expect(ids).not.toContain('task-theirs-01');
  }, 5000);
});
