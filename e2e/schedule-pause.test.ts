/**
 * Integration tests for /schedule pause/resume (Story 62).
 *
 * These tests exercise the full stack:
 *   - handleScheduleCommand (the slash-command handler)
 *   - pauseTask / resumeTask (DB writes)
 *   - scheduler tick (verifies paused tasks are skipped)
 *
 * Runs entirely in-process using a real in-memory SQLite DB.
 * No Kubernetes required.
 *
 * Namespace: kubeclaw-e2e-schedule-pause   Port: 14145
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
import {
  handleScheduleCommand,
  isScheduleCommand,
} from '../src/channel-runner.js';

const POLL_MS = 100;

function makeTask(groupFolder: string, status: 'active' | 'paused' = 'active') {
  const id = `e2e-pause-${randomUUID().slice(0, 8)}`;
  createTask({
    id,
    group_folder: groupFolder,
    chat_jid: `${groupFolder}@chat`,
    prompt: 'Say hello',
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    next_run: new Date(Date.now() - 1000).toISOString(), // overdue
    status,
    created_at: new Date().toISOString(),
  });
  return id;
}

describe('Schedule Pause/Resume Integration', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    _resetSchedulerLoopForTests();
    process.env.SCHEDULER_POLL_INTERVAL = String(POLL_MS);
  });

  afterEach(() => {
    _resetSchedulerLoopForTests();
    delete process.env.SCHEDULER_POLL_INTERVAL;
  });

  // ── handleScheduleCommand + DB ────────────────────────────────────────────

  it('pause command writes paused status to DB', async () => {
    const group = `pause-group-${randomUUID().slice(0, 6)}`;
    const id = makeTask(group);

    const reply = await handleScheduleCommand(group, `${group}@chat`, `/schedule pause ${id}`);

    expect(reply).toBe(`Task "${id}" paused.`);
    expect(getTaskById(id)?.status).toBe('paused');
  });

  it('resume command restores active status in DB', async () => {
    const group = `resume-group-${randomUUID().slice(0, 6)}`;
    const id = makeTask(group, 'paused');

    const reply = await handleScheduleCommand(group, `${group}@chat`, `/schedule resume ${id}`);

    expect(reply).toBe(`Task "${id}" resumed.`);
    expect(getTaskById(id)?.status).toBe('active');
  });

  it('unknown id returns "Task not found." for both pause and resume', async () => {
    const group = `notfound-group-${randomUUID().slice(0, 6)}`;

    const pauseReply = await handleScheduleCommand(group, `${group}@chat`, '/schedule pause no-such-id');
    const resumeReply = await handleScheduleCommand(group, `${group}@chat`, '/schedule resume no-such-id');
    expect(pauseReply).toBe('Task not found.');
    expect(resumeReply).toBe('Task not found.');
  });

  it('cross-group id returns same "not found" wording (no enumeration)', async () => {
    const owner = `owner-group-${randomUUID().slice(0, 6)}`;
    const attacker = `attacker-group-${randomUUID().slice(0, 6)}`;
    const id = makeTask(owner);

    const crossReply = await handleScheduleCommand(attacker, `${attacker}@chat`, `/schedule pause ${id}`);
    const unknownReply = await handleScheduleCommand(attacker, `${attacker}@chat`, '/schedule pause totally-unknown');

    expect(crossReply).toBe(unknownReply);
    // task must remain active
    expect(getTaskById(id)?.status).toBe('active');
  });

  // ── list annotation ───────────────────────────────────────────────────────

  it('list shows [paused] prefix for paused tasks, not for active tasks', async () => {
    const group = `list-group-${randomUUID().slice(0, 6)}`;
    const activeId = makeTask(group, 'active');
    const pausedId = makeTask(group, 'paused');

    const reply = await handleScheduleCommand(group, `${group}@chat`, '/schedule list');

    const lines = reply.split('\n');
    const activeLine = lines.find((l) => l.includes(activeId));
    const pausedLine = lines.find((l) => l.includes(pausedId));

    expect(activeLine).toBeDefined();
    expect(activeLine!.startsWith('[paused]')).toBe(false);
    expect(pausedLine).toBeDefined();
    expect(pausedLine!.startsWith('[paused]')).toBe(true);
  });

  // ── scheduler tick skips paused tasks ────────────────────────────────────

  it('scheduler tick does not run a paused task', async () => {
    const group = `tick-group-${randomUUID().slice(0, 6)}`;
    const id = makeTask(group, 'paused'); // already paused, overdue

    const runnedIds: string[] = [];
    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: {
        enqueueTask: (_jid: string, taskId: string, fn: () => Promise<void>) => {
          runnedIds.push(taskId);
          fn().catch(() => {});
        },
        notifyIdle: () => {},
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    // Wait for 5 poll cycles
    await new Promise((r) => setTimeout(r, POLL_MS * 5));

    expect(runnedIds).not.toContain(id);
  }, 10_000);

  it('scheduler tick runs a task after it is resumed', async () => {
    const group = `tick-resume-${randomUUID().slice(0, 6)}`;
    const id = makeTask(group, 'paused'); // paused and overdue

    const runnedIds: string[] = [];
    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: {
        enqueueTask: (_jid: string, taskId: string, fn: () => Promise<void>) => {
          runnedIds.push(taskId);
          fn().catch(() => {});
        },
        notifyIdle: () => {},
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    // Confirm task is skipped while paused
    await new Promise((r) => setTimeout(r, POLL_MS * 3));
    expect(runnedIds).not.toContain(id);

    // Resume via command
    await handleScheduleCommand(group, `${group}@chat`, `/schedule resume ${id}`);
    expect(getTaskById(id)?.status).toBe('active');

    // Wait for the scheduler to pick it up
    await new Promise((r) => setTimeout(r, POLL_MS * 4));
    expect(runnedIds).toContain(id);
  }, 15_000);

  // ── isScheduleCommand guard ───────────────────────────────────────────────

  it('isScheduleCommand matches /schedule prefix only', () => {
    expect(isScheduleCommand('/schedule list')).toBe(true);
    expect(isScheduleCommand('/schedule pause abc')).toBe(true);
    expect(isScheduleCommand('/secret list')).toBe(false);
    expect(isScheduleCommand('hello')).toBe(false);
  });
});
