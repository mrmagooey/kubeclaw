/**
 * POST/DELETE/PATCH /schedule — End-to-End Tests (Story 71)
 *
 * Exercises the write-side REST endpoints on a real HttpChannel instance
 * bound to port 14154. Uses an in-memory SQLite database so tests run
 * in-process without Kubernetes, Redis, or a live LLM.
 *
 * AC1: POST /schedule { schedule_type, schedule_expression, prompt }
 *      → 201 JSON { id, status:"active", schedule_type, schedule_expression,
 *                   prompt, next_run, created_at }
 *      Invalid body → 400
 * AC2: DELETE /schedule/<id> for own group → 204 (no body)
 *      Row removed from scheduled_tasks
 * AC3: DELETE /schedule/<unknown-id> and DELETE /schedule/<id-from-another-group>
 *      → 404 (identical wording)
 * AC4: PATCH /schedule/<id> { paused: true } → 200 status "paused"
 *      PATCH /schedule/<id> { paused: false } → 200 status "active"
 *      Unknown/cross-group → 404
 * AC5: POST /schedule/<id> → 405 Allow: DELETE, PATCH
 *      Unauthenticated → 401
 *      HEAD /schedule/<id> → 200/404 same headers as GET, no body
 *
 * Namespace: kubeclaw-e2e-schedule-write
 * Port: 14154
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeHttpChannel, type HttpChannelOpts } from './lib/http-test-channel.js';
import {
  _initTestDatabase,
  __resetDbForTest,
  createTask,
  getTaskById,
} from '../src/db.js';

const HTTP_PORT = 14154;
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

describe('POST/DELETE/PATCH /schedule — HTTP endpoint (Story 71)', () => {
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
  });

  // ── AC1: POST /schedule happy path ─────────────────────────────────────────

  it('AC1: POST /schedule with cron body → 201 JSON with required fields', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        schedule_type: 'cron',
        schedule_expression: '0 9 * * *',
        prompt: 'Send daily report',
      }),
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('id');
    expect(typeof body.id).toBe('string');
    expect(body.status).toBe('active');
    expect(body.schedule_type).toBe('cron');
    expect(body.schedule_expression).toBe('0 9 * * *');
    expect(body.prompt).toBe('Send daily report');
    expect(body).toHaveProperty('next_run');
    expect(body).toHaveProperty('created_at');
  }, 5000);

  it('AC1: POST /schedule with interval body → 201 JSON', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        schedule_type: 'interval',
        schedule_expression: '60000',
        prompt: 'Interval ping',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.schedule_type).toBe('interval');
    expect(body.status).toBe('active');
  }, 5000);

  it('AC1: POST /schedule with once body → 201 JSON', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        schedule_type: 'once',
        schedule_expression: '2099-12-31T23:59:59.000Z',
        prompt: 'Once only',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.schedule_type).toBe('once');
  }, 5000);

  it('AC1: created task persisted in DB under authenticated group', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        schedule_type: 'cron',
        schedule_expression: '0 8 * * 1',
        prompt: 'Weekly task',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { id: string };
    const task = getTaskById(body.id);
    expect(task).toBeDefined();
    expect(task!.group_folder).toBe(TEST_GROUP_FOLDER);
    expect(task!.schedule_type).toBe('cron');
    expect(task!.prompt).toBe('Weekly task');
  }, 5000);

  it('AC1: POST /schedule with missing fields → 400', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ schedule_type: 'cron' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body).toHaveProperty('error');
  }, 5000);

  it('AC1: POST /schedule with invalid schedule_type → 400', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        schedule_type: 'daily',
        schedule_expression: '0 9 * * *',
        prompt: 'Hi',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/schedule_type/i);
  }, 5000);

  it('AC1: POST /schedule with invalid cron expression → 400', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        schedule_type: 'cron',
        schedule_expression: 'not-a-cron',
        prompt: 'Hi',
      }),
    });

    expect(res.status).toBe(400);
  }, 5000);

  it('AC1: POST /schedule with invalid interval (zero) → 400', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        schedule_type: 'interval',
        schedule_expression: '0',
        prompt: 'Hi',
      }),
    });

    expect(res.status).toBe(400);
  }, 5000);

  // ── AC2: DELETE /schedule/<id> for own group → 204 ─────────────────────────

  it('AC2: DELETE /schedule/<id> for own group → 204 no body', async () => {
    createTask(makeTask('task-del-001'));

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/task-del-001`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');
  }, 5000);

  it('AC2: deleted task is removed from DB', async () => {
    createTask(makeTask('task-del-002'));
    expect(getTaskById('task-del-002')).toBeDefined();

    await fetch(`http://localhost:${HTTP_PORT}/schedule/task-del-002`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(getTaskById('task-del-002')).toBeUndefined();
  }, 5000);

  // ── AC3: DELETE unknown/cross-group → 404 (identical wording) ──────────────

  it('AC3: DELETE /schedule/<unknown-id> → 404', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/no-such-id`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(404);
  }, 5000);

  it('AC3: DELETE /schedule/<cross-group-id> → 404 (identical wording)', async () => {
    createTask(makeTask('task-other-001', { group_folder: 'other-group' }));

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/task-other-001`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    // Identical wording — cannot distinguish unknown from cross-group
    expect(body.error).toBe('Not found');
  }, 5000);

  // ── AC4: PATCH /schedule/<id> paused/resumed ────────────────────────────────

  it('AC4: PATCH { paused: true } → 200 status "paused"', async () => {
    createTask(makeTask('task-pause-001', { status: 'active' }));

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/task-pause-001`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paused: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; id: string };
    expect(body.status).toBe('paused');
    expect(body.id).toBe('task-pause-001');
    // DB should also be updated
    expect(getTaskById('task-pause-001')!.status).toBe('paused');
  }, 5000);

  it('AC4: PATCH { paused: false } → 200 status "active"', async () => {
    createTask(makeTask('task-resume-001', { status: 'active' }));
    // Pause it first
    await fetch(`http://localhost:${HTTP_PORT}/schedule/task-resume-001`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paused: true }),
    });

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/task-resume-001`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paused: false }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('active');
    expect(getTaskById('task-resume-001')!.status).toBe('active');
  }, 5000);

  it('AC4: PATCH /schedule/<unknown-id> → 404', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/no-such-task`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paused: true }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
  }, 5000);

  it('AC4: PATCH /schedule/<cross-group-id> → 404 (identical wording)', async () => {
    createTask(makeTask('task-cross-001', { group_folder: 'other-group' }));

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/task-cross-001`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paused: true }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
  }, 5000);

  it('AC4: PATCH response contains required task fields', async () => {
    createTask(makeTask('task-fields-001'));

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/task-fields-001`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paused: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('schedule_type');
    expect(body).toHaveProperty('schedule_expression');
    expect(body).toHaveProperty('prompt');
    expect(body).toHaveProperty('next_run');
    expect(body).toHaveProperty('created_at');
  }, 5000);

  // ── AC5: method guards, auth ────────────────────────────────────────────────

  it('AC5: POST /schedule/<id> → 405 Allow: DELETE, PATCH', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/some-task`, {
      method: 'POST',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(405);
    const allow = res.headers.get('allow') ?? '';
    expect(allow).toMatch(/\bDELETE\b/);
    expect(allow).toMatch(/\bPATCH\b/);
  }, 5000);

  it('AC5: unauthenticated DELETE /schedule/<id> → 401', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/some-task`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  }, 5000);

  it('AC5: unauthenticated PATCH /schedule/<id> → 401', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/some-task`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    expect(res.status).toBe(401);
  }, 5000);

  it('AC5: unauthenticated POST /schedule → 401', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule_type: 'cron', schedule_expression: '0 9 * * *', prompt: 'Hi' }),
    });
    expect(res.status).toBe(401);
  }, 5000);

  it('AC5: HEAD /schedule/<id> → 200 when task exists for own group, no body', async () => {
    createTask(makeTask('task-head-001'));

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/task-head-001`, {
      method: 'HEAD',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('');
  }, 5000);

  it('AC5: HEAD /schedule/<id> → 404 when task does not exist, no body', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/no-such-task`, {
      method: 'HEAD',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toBe('');
  }, 5000);
});
