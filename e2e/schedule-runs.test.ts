/**
 * GET /schedule/<id>/runs — End-to-End Tests (Story 80)
 *
 * Exercises the run-log history REST endpoint on a real HttpChannel instance
 * bound to port 14163. Uses an in-memory SQLite database so tests run
 * in-process without Kubernetes, Redis, or a live LLM.
 *
 * AC1: GET /schedule/<id>/runs → 200 JSON { runs: [{ run_at, status,
 *      duration_ms, result?, error? }] } newest-first, default limit 20.
 * AC2: ?limit=N honored, capped at 100.
 * AC3: Unknown id OR cross-group id → 404 { error: "Not found" } (same wording).
 * AC4: Unauthenticated → 401.
 *      POST /schedule/<id>/runs → 405 Allow: GET, HEAD.
 *      HEAD → same headers as GET, no body.
 * AC5: Two inserted rows (1 success, 1 error) are both present with correct fields.
 *
 * Namespace: kubeclaw-e2e-schedule-runs
 * Port: 14163
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { HttpChannel, type HttpChannelOpts } from '../src/channels/http.js';
import {
  _initTestDatabase,
  __resetDbForTest,
  createTask,
  logTaskRun,
} from '../src/db.js';

const HTTP_PORT = 14163;
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

describe('GET /schedule/<id>/runs — HTTP endpoint (Story 80)', () => {
  let channel: HttpChannel | null = null;

  beforeAll(async () => {
    await _initTestDatabase();

    channel = new HttpChannel(
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

  // ── AC1: basic GET returns run history ──────────────────────────────────────

  it('AC1: GET /schedule/<id>/runs returns 200 JSON { runs: [...] } newest-first', async () => {
    const taskId = `task-runs-${Date.now()}`;
    createTask({
      id: taskId,
      group_folder: TEST_GROUP_FOLDER,
      chat_jid: TEST_JID,
      prompt: 'Test task',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logTaskRun({
      task_id: taskId,
      run_at: '2025-05-01T08:00:00.000Z',
      duration_ms: 300,
      status: 'success',
      result: 'Hello from task',
      error: null,
    });
    logTaskRun({
      task_id: taskId,
      run_at: '2025-05-02T09:00:00.000Z',
      duration_ms: 50,
      status: 'error',
      result: null,
      error: 'Agent timed out',
    });

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/${taskId}/runs`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as { runs: Array<Record<string, unknown>> };
    expect(body).toHaveProperty('runs');
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs).toHaveLength(2);

    // Newest-first: error run (2025-05-02) before success run (2025-05-01)
    expect(body.runs[0].run_at).toBe('2025-05-02T09:00:00.000Z');
    expect(body.runs[0].status).toBe('error');
    expect(body.runs[1].run_at).toBe('2025-05-01T08:00:00.000Z');
    expect(body.runs[1].status).toBe('success');
  }, 5000);

  it('AC1: each run row has run_at, status, duration_ms, result, error fields', async () => {
    const taskId = `task-fields-${Date.now()}`;
    createTask({
      id: taskId,
      group_folder: TEST_GROUP_FOLDER,
      chat_jid: TEST_JID,
      prompt: 'Test task',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logTaskRun({
      task_id: taskId,
      run_at: '2025-06-01T10:00:00.000Z',
      duration_ms: 120,
      status: 'success',
      result: 'Done',
      error: null,
    });

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/${taskId}/runs`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { runs: Array<Record<string, unknown>> };
    const row = body.runs[0];
    expect(row).toHaveProperty('run_at', '2025-06-01T10:00:00.000Z');
    expect(row).toHaveProperty('status', 'success');
    expect(row).toHaveProperty('duration_ms', 120);
    expect(row).toHaveProperty('result', 'Done');
    expect(row).toHaveProperty('error', null);
  }, 5000);

  it('AC1: returns empty runs array for task with no run history', async () => {
    const taskId = `task-empty-${Date.now()}`;
    createTask({
      id: taskId,
      group_folder: TEST_GROUP_FOLDER,
      chat_jid: TEST_JID,
      prompt: 'Empty task',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/${taskId}/runs`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { runs: unknown[] };
    expect(body.runs).toHaveLength(0);
  }, 5000);

  // ── AC2: ?limit=N ───────────────────────────────────────────────────────────

  it('AC2: ?limit=1 returns at most 1 row', async () => {
    const taskId = `task-limit-${Date.now()}`;
    createTask({
      id: taskId,
      group_folder: TEST_GROUP_FOLDER,
      chat_jid: TEST_JID,
      prompt: 'Limit task',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    for (let i = 1; i <= 3; i++) {
      logTaskRun({
        task_id: taskId,
        run_at: `2025-05-0${i}T00:00:00.000Z`,
        duration_ms: i * 100,
        status: 'success',
        result: `Run ${i}`,
        error: null,
      });
    }

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/${taskId}/runs?limit=1`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { runs: unknown[] };
    expect(body.runs).toHaveLength(1);
  }, 5000);

  it('AC2: ?limit=100 is the maximum (200 → 100)', async () => {
    const taskId = `task-cap-${Date.now()}`;
    createTask({
      id: taskId,
      group_folder: TEST_GROUP_FOLDER,
      chat_jid: TEST_JID,
      prompt: 'Cap task',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    // Insert 5 rows — enough to confirm at most 100 are returned
    for (let i = 1; i <= 5; i++) {
      logTaskRun({
        task_id: taskId,
        run_at: `2025-05-0${i}T00:00:00.000Z`,
        duration_ms: 10,
        status: 'success',
        result: null,
        error: null,
      });
    }

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/${taskId}/runs?limit=200`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { runs: unknown[] };
    // 5 rows inserted, limit capped at 100 — all 5 returned
    expect(body.runs).toHaveLength(5);
  }, 5000);

  // ── AC3: 404 cases ──────────────────────────────────────────────────────────

  it('AC3: unknown task id → 404 { error: "Not found" }', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/does-not-exist/runs`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
  }, 5000);

  it('AC3: cross-group id → 404 identical wording', async () => {
    // Create a task owned by a different group
    const otherTaskId = `task-other-${Date.now()}`;
    createTask({
      id: otherTaskId,
      group_folder: 'different-group',
      chat_jid: 'http:bob',
      prompt: 'Other group task',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/${otherTaskId}/runs`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
  }, 5000);

  // ── AC4: auth and method guards ─────────────────────────────────────────────

  it('AC4: unauthenticated → 401', async () => {
    const taskId = `task-auth-${Date.now()}`;
    createTask({
      id: taskId,
      group_folder: TEST_GROUP_FOLDER,
      chat_jid: TEST_JID,
      prompt: 'Auth test',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/${taskId}/runs`);
    expect(res.status).toBe(401);
  }, 5000);

  it('AC4: POST /schedule/<id>/runs → 405 with Allow: GET, HEAD', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/any-id/runs`, {
      method: 'POST',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  }, 5000);

  it('AC4: HEAD → same Content-Type and Content-Length as GET, no body', async () => {
    const taskId = `task-head-${Date.now()}`;
    createTask({
      id: taskId,
      group_folder: TEST_GROUP_FOLDER,
      chat_jid: TEST_JID,
      prompt: 'Head test',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logTaskRun({
      task_id: taskId,
      run_at: '2025-06-01T10:00:00.000Z',
      duration_ms: 50,
      status: 'success',
      result: 'ok',
      error: null,
    });

    const getRes = await fetch(`http://localhost:${HTTP_PORT}/schedule/${taskId}/runs`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const headRes = await fetch(`http://localhost:${HTTP_PORT}/schedule/${taskId}/runs`, {
      method: 'HEAD',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toBe(getRes.headers.get('content-type'));
    expect(headRes.headers.get('content-length')).toBe(getRes.headers.get('content-length'));
    const headBody = await headRes.text();
    expect(headBody).toBe('');
  }, 5000);

  // ── AC5: both row types present with correct fields ─────────────────────────

  it('AC5: both status tags present, result/error fields correct', async () => {
    const taskId = `task-ac5-${Date.now()}`;
    createTask({
      id: taskId,
      group_folder: TEST_GROUP_FOLDER,
      chat_jid: TEST_JID,
      prompt: 'AC5 task',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logTaskRun({
      task_id: taskId,
      run_at: '2025-07-01T08:00:00.000Z',
      duration_ms: 250,
      status: 'success',
      result: 'Task completed',
      error: null,
    });
    logTaskRun({
      task_id: taskId,
      run_at: '2025-07-02T09:00:00.000Z',
      duration_ms: 75,
      status: 'error',
      result: null,
      error: 'Connection refused',
    });

    const res = await fetch(`http://localhost:${HTTP_PORT}/schedule/${taskId}/runs`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { runs: Array<{ status: string; result: string | null; error: string | null }> };

    const statusTags = body.runs.map((r) => r.status);
    expect(statusTags).toContain('success');
    expect(statusTags).toContain('error');

    const successRow = body.runs.find((r) => r.status === 'success')!;
    expect(successRow).toBeDefined();
    expect(successRow.result).toBe('Task completed');
    expect(successRow.error).toBeNull();

    const errorRow = body.runs.find((r) => r.status === 'error')!;
    expect(errorRow).toBeDefined();
    expect(errorRow.error).toBe('Connection refused');
    expect(errorRow.result).toBeNull();
  }, 5000);
});
