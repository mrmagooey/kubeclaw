/**
 * E2E test: /schedule history
 *
 * Namespace: kubeclaw-e2e-schedule-history   Port: 14143
 *
 * Verifies the full path from task_run_logs insertion (via logTaskRun) through
 * the DB read function (getTaskRunLogs) and the command handler
 * (handleScheduleCommand) to the formatted reply.
 *
 * Uses a real sql.js in-memory database — no Kubernetes required.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  _initTestDatabase,
  createTask,
  logTaskRun,
} from '../src/db.js';
import { handleScheduleCommand } from '../src/channel-runner.js';

beforeAll(async () => {
  await _initTestDatabase();
});

const GROUP = `e2e-sched-hist-${Date.now()}`;
const TASK_ID = `e2e-task-${Date.now()}`;
const OTHER_GROUP = `e2e-sched-other-${Date.now()}`;
const OTHER_TASK_ID = `e2e-task-other-${Date.now()}`;

describe('/schedule history e2e', () => {
  beforeAll(() => {
    // Create a task owned by GROUP
    createTask({
      id: TASK_ID,
      group_folder: GROUP,
      chat_jid: 'e2e@g.us',
      prompt: 'Say hello from e2e',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    // Create a task owned by OTHER_GROUP (for group-isolation test)
    createTask({
      id: OTHER_TASK_ID,
      group_folder: OTHER_GROUP,
      chat_jid: 'other@g.us',
      prompt: 'Other group task',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    // Record one successful run
    logTaskRun({
      task_id: TASK_ID,
      run_at: '2025-05-01T08:00:00.000Z',
      duration_ms: 300,
      status: 'success',
      result: 'Hello from scheduled task',
      error: null,
    });

    // Record one failed run (newer)
    logTaskRun({
      task_id: TASK_ID,
      run_at: '2025-05-02T09:00:00.000Z',
      duration_ms: 50,
      status: 'error',
      result: null,
      error: 'Agent timed out',
    });
  });

  it('AC1: /schedule history <id> returns at least one row with run_at, status, duration_ms, result/error', async () => {
    const reply = await handleScheduleCommand(
      GROUP,
      'e2e@g.us',
      `/schedule history ${TASK_ID}`,
    );

    expect(reply).toContain(TASK_ID);
    // Both runs appear
    expect(reply).toContain('2025-05-01T08:00:00.000Z');
    expect(reply).toContain('[ok]');
    expect(reply).toContain('300ms');
    expect(reply).toContain('Hello from scheduled task');
    expect(reply).toContain('2025-05-02T09:00:00.000Z');
    expect(reply).toContain('[error]');
    expect(reply).toContain('Agent timed out');
  });

  it('AC1: rows appear newest-first', async () => {
    const reply = await handleScheduleCommand(
      GROUP,
      'e2e@g.us',
      `/schedule history ${TASK_ID}`,
    );

    const pos_may2 = reply.indexOf('2025-05-02');
    const pos_may1 = reply.indexOf('2025-05-01');
    expect(pos_may2).toBeLessThan(pos_may1);
  });

  it('AC2: /schedule history <unknown-id> → "not found"', async () => {
    const reply = await handleScheduleCommand(
      GROUP,
      'e2e@g.us',
      '/schedule history no-such-task-xyz',
    );
    expect(reply).toMatch(/not found/i);
  });

  it('AC3: /schedule history <id-from-another-group> → "not found"', async () => {
    // OTHER_TASK_ID belongs to OTHER_GROUP; querying as GROUP should return not-found
    const reply = await handleScheduleCommand(
      GROUP,
      'e2e@g.us',
      `/schedule history ${OTHER_TASK_ID}`,
    );
    expect(reply).toMatch(/not found/i);
  });

  it('AC4: /schedule history <id> 1 returns at most 1 row', async () => {
    const reply = await handleScheduleCommand(
      GROUP,
      'e2e@g.us',
      `/schedule history ${TASK_ID} 1`,
    );

    // Only one row block; the reply should mention "1 row"
    expect(reply).toMatch(/1 row/);
    // Newer row (may2) should appear; older (may1) should not since limit=1
    expect(reply).toContain('2025-05-02');
    expect(reply).not.toContain('2025-05-01');
  });
});
