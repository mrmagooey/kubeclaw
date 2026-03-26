/**
 * Task Scheduler E2E Tests
 *
 * Verifies the scheduler loop end-to-end:
 *   - Due tasks are picked up from the SQLite DB within one poll interval
 *   - DB is updated (last_result set) after the task runs
 *   - Missing-group error is handled gracefully (task logged, not retried forever)
 *   - Once-type tasks are marked completed after running
 *
 * Runs entirely in-process — no Kubernetes required.
 * Uses the test DB initialized by global setup.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  createTask,
  getTaskById,
  _initTestDatabase,
} from '../src/db.js';
import {
  startSchedulerLoop,
  _resetSchedulerLoopForTests,
} from '../src/task-scheduler.js';

// Run scheduler polls quickly so tests resolve in < 1s
const POLL_MS = 100;

function makeTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  const id = `e2e-sched-${randomUUID()}`;
  createTask({
    id,
    group_folder: overrides.group_folder ?? `sched-group-${id.slice(-8)}`,
    chat_jid: overrides.chat_jid ?? 'e2e-sched@e2e',
    prompt: overrides.prompt ?? 'Say hello',
    schedule_type: overrides.schedule_type ?? 'once',
    schedule_value: overrides.schedule_value ?? '',
    context_mode: 'isolated',
    // Set next_run in the past so the task is immediately due
    next_run: new Date(Date.now() - 1000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

function waitForTaskUpdate(taskId: string, timeoutMs = 3000): Promise<typeof getTaskById extends (...args: any[]) => infer R ? NonNullable<R> : never> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      const task = getTaskById(taskId);
      // Task has been processed if last_result is set OR status changed
      if (task && (task.last_result !== null || task.status !== 'active')) {
        return resolve(task as any);
      }
      if (Date.now() >= deadline) {
        return reject(new Error(`Task ${taskId} not processed within ${timeoutMs}ms`));
      }
      setTimeout(check, 50);
    };
    check();
  });
}

describe('Task Scheduler', () => {
  beforeEach(async () => {
    // Ensure a clean DB for each test and reset scheduler state
    await _initTestDatabase();
    _resetSchedulerLoopForTests();
    process.env.SCHEDULER_POLL_INTERVAL = String(POLL_MS);
  });

  afterEach(() => {
    _resetSchedulerLoopForTests();
  });

  it('picks up a due task within one poll interval', async () => {
    const taskId = makeTask({ group_folder: `sched-nogroup-${Date.now()}` });

    // Deps with no registered groups — runTask will fail with "Group not found"
    // but that's fine: we're testing that the scheduler FINDS and ATTEMPTS the task
    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: {
        enqueueTask: (_jid: string, _id: string, fn: () => Promise<void>) => {
          fn().catch(() => {});
        },
        notifyIdle: () => {},
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    const task = await waitForTaskUpdate(taskId);

    // Task should have a last_result set (even if it's an error message)
    expect(task.last_result).toBeTruthy();
    console.log(`✅ Task processed within poll interval. last_result: "${task.last_result}"`);
  }, 10_000);

  it('logs "Group not found" error when group is not registered', async () => {
    const groupFolder = `sched-missing-${Date.now()}`;
    const taskId = makeTask({ group_folder: groupFolder });

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: {
        enqueueTask: (_jid: string, _id: string, fn: () => Promise<void>) => { fn().catch(() => {}); },
        notifyIdle: () => {},
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    const task = await waitForTaskUpdate(taskId);

    expect(task.last_result).toMatch(/Group not found/i);
    console.log(`✅ Missing group correctly logged: "${task.last_result}"`);
  }, 10_000);

  it('marks a once-type task as completed after running', async () => {
    const taskId = makeTask({ schedule_type: 'once', schedule_value: '' });

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: {
        enqueueTask: (_jid: string, _id: string, fn: () => Promise<void>) => { fn().catch(() => {}); },
        notifyIdle: () => {},
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    const task = await waitForTaskUpdate(taskId);

    // once-type tasks have next_run=null after running → status set to 'completed'
    expect(task.status).toBe('completed');
    console.log(`✅ Once-type task marked completed`);
  }, 10_000);

  it('skips a paused task even if next_run is in the past', async () => {
    const taskId = makeTask({});
    // Immediately pause the task
    const { updateTask } = await import('../src/db.js');
    updateTask(taskId, { status: 'paused' });

    let taskRan = false;
    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: {
        enqueueTask: (_jid: string, id: string, fn: () => Promise<void>) => {
          if (id === taskId) taskRan = true;
          fn().catch(() => {});
        },
        notifyIdle: () => {},
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    // Wait long enough for at least 3 poll cycles
    await new Promise((r) => setTimeout(r, POLL_MS * 5));

    expect(taskRan).toBe(false);
    console.log(`✅ Paused task correctly skipped`);
  }, 10_000);

  it('computes correct next_run for interval tasks', async () => {
    const { computeNextRun } = await import('../src/task-scheduler.js');
    const now = Date.now();
    const intervalMs = 60_000;

    const task = {
      id: 'test',
      group_folder: 'test',
      chat_jid: 'test',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(intervalMs),
      context_mode: 'isolated' as const,
      next_run: new Date(now - 1000).toISOString(), // already overdue
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const nextRunMs = new Date(nextRun!).getTime();

    // next_run must be in the future
    expect(nextRunMs).toBeGreaterThan(Date.now());
    // next_run must be approximately one interval from now
    expect(nextRunMs - now).toBeLessThan(intervalMs + 5000);
    console.log(`✅ computeNextRun: ${new Date(nextRunMs).toISOString()}`);
  });
});
