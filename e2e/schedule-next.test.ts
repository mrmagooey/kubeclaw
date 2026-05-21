/**
 * E2E test: /schedule next (Story 67)
 *
 * Namespace: kubeclaw-e2e-schedule-next   Port: 14150
 *
 * Verifies the full path from DB state through handleScheduleCommand to the
 * formatted reply — including paused-task prefix, human delta, single-task
 * view, completed once-task, unknown id, and no-tasks response.
 *
 * Uses a real sql.js in-memory database — no Kubernetes required.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  _initTestDatabase,
  createTask,
  pauseTask,
} from '../src/db.js';
import { handleScheduleCommand } from '../src/channel-runner.js';

const GROUP = `e2e-sched-next-${Date.now()}`;
const OTHER_GROUP = `e2e-sched-next-other-${Date.now()}`;

// Tasks: active (5 minutes ahead), paused (2 hours ahead), completed once
const ACTIVE_ID = `active-${Date.now()}`;
const PAUSED_ID = `paused-${Date.now()}`;
const COMPLETED_ID = `completed-${Date.now()}`;
const OTHER_ID = `other-${Date.now()}`;

const ACTIVE_NEXT_RUN = new Date(Date.now() + 5 * 60 * 1000).toISOString();
const PAUSED_NEXT_RUN = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

beforeAll(async () => {
  await _initTestDatabase();

  createTask({
    id: ACTIVE_ID,
    group_folder: GROUP,
    chat_jid: 'e2e@g.us',
    prompt: 'Active task',
    schedule_type: 'interval',
    schedule_value: '300000',
    context_mode: 'isolated',
    next_run: ACTIVE_NEXT_RUN,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  createTask({
    id: PAUSED_ID,
    group_folder: GROUP,
    chat_jid: 'e2e@g.us',
    prompt: 'Paused task',
    schedule_type: 'interval',
    schedule_value: '7200000',
    context_mode: 'isolated',
    next_run: PAUSED_NEXT_RUN,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  pauseTask(PAUSED_ID, GROUP);

  createTask({
    id: COMPLETED_ID,
    group_folder: GROUP,
    chat_jid: 'e2e@g.us',
    prompt: 'One-shot task',
    schedule_type: 'once',
    schedule_value: '2024-01-01T00:00:00.000Z',
    context_mode: 'isolated',
    next_run: null,
    status: 'completed',
    created_at: new Date().toISOString(),
  });

  createTask({
    id: OTHER_ID,
    group_folder: OTHER_GROUP,
    chat_jid: 'other@g.us',
    prompt: 'Other group task',
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    next_run: new Date(Date.now() + 60000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
  });
});

describe('/schedule next e2e', () => {
  it('AC1: multi-task view contains all group tasks with id and ISO timestamp', async () => {
    const reply = await handleScheduleCommand(GROUP, 'e2e@g.us', '/schedule next');

    expect(reply).toContain(ACTIVE_ID);
    expect(reply).toContain(PAUSED_ID);
    // next_run ISO timestamps appear
    expect(reply).toContain(ACTIVE_NEXT_RUN);
    expect(reply).toContain(PAUSED_NEXT_RUN);
  });

  it('AC1: paused tasks are prefixed [paused] and delta says "paused"', async () => {
    const reply = await handleScheduleCommand(GROUP, 'e2e@g.us', '/schedule next');

    // Only paused task gets [paused] prefix
    expect(reply).toContain('[paused]');
    // The paused task's delta is "paused", not a time
    const lines = reply.split('\n');
    const pausedLine = lines.find((l) => l.includes(PAUSED_ID));
    expect(pausedLine).toBeDefined();
    expect(pausedLine).toMatch(/\(paused\)/);
    expect(pausedLine).not.toMatch(/in \d+[smhd]/);
  });

  it('AC1: active tasks have a human delta (in Xs/Xm/Xh/Xd)', async () => {
    const reply = await handleScheduleCommand(GROUP, 'e2e@g.us', '/schedule next');

    const lines = reply.split('\n');
    const activeLine = lines.find((l) => l.includes(ACTIVE_ID));
    expect(activeLine).toBeDefined();
    // ~5 minutes ahead — delta should be "in Xm"
    expect(activeLine).toMatch(/in \d+[mshd]/);
    // No [paused] prefix for active task
    expect(activeLine).not.toContain('[paused]');
  });

  it('AC2: single-task view for active task', async () => {
    const reply = await handleScheduleCommand(GROUP, 'e2e@g.us', `/schedule next ${ACTIVE_ID}`);

    expect(reply).toContain(ACTIVE_ID);
    expect(reply).toContain(ACTIVE_NEXT_RUN);
    expect(reply).toMatch(/in \d+[mshd]/);
  });

  it('AC2: once task with status completed returns "no future run" message', async () => {
    const reply = await handleScheduleCommand(GROUP, 'e2e@g.us', `/schedule next ${COMPLETED_ID}`);

    expect(reply).toContain(COMPLETED_ID);
    expect(reply).toMatch(/no future run/i);
    expect(reply).toContain('completed');
  });

  it('AC3: unknown id returns "Task not found"', async () => {
    const reply = await handleScheduleCommand(GROUP, 'e2e@g.us', '/schedule next no-such-task');

    expect(reply).toBe('Task not found');
  });

  it('AC3: cross-group id returns "Task not found"', async () => {
    const reply = await handleScheduleCommand(GROUP, 'e2e@g.us', `/schedule next ${OTHER_ID}`);

    expect(reply).toBe('Task not found');
  });

  it('does not include OTHER_GROUP tasks in multi-task view', async () => {
    const reply = await handleScheduleCommand(GROUP, 'e2e@g.us', '/schedule next');

    expect(reply).not.toContain(OTHER_ID);
  });
});

describe('/schedule next — empty group', () => {
  const EMPTY_GROUP = `e2e-sched-next-empty-${Date.now()}`;

  it('AC4: returns "No scheduled tasks" when group has no tasks', async () => {
    const reply = await handleScheduleCommand(EMPTY_GROUP, 'e2e@g.us', '/schedule next');

    expect(reply).toBe('No scheduled tasks');
  });
});
