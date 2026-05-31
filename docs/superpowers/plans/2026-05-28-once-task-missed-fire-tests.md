# Once-task missed-fire regression tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the existing correct missed-fire semantics for `once` tasks with deterministic regression tests — and fix the real bug where a `once` task whose group is not registered never reaches `status='completed'` because the "group not found" early-return path calls `updateTask` instead of `updateTaskAfterRun`.

**Architecture:** `getDueTasks` queries `scheduled_tasks WHERE status='active' AND next_run <= now`. `updateTaskAfterRun(id, nextRun, lastResult)` sets `status='completed'` via `CASE WHEN ? IS NULL THEN 'completed'` when `nextRun` is `null` — which `computeNextRun` always returns for `once` tasks. However, the "group not found" branch in `runTask` calls `updateTask(id, { last_result: ... })` and returns early, bypassing `updateTaskAfterRun` entirely — so `status` stays `'active'` and the task re-fires on every poll cycle. Tests confirm this bug exists and the fix makes it pass.

**Tech Stack:** TypeScript, vitest (fake timers), better-sqlite3 (via sql.js in tests)

---

## File Map

| File | Change |
|------|--------|
| `src/task-scheduler.test.ts` | Add three unit tests (Tasks 1–2) + one integration test (Task 2) |
| `src/task-scheduler.ts` | Fix `runTask`: call `updateTaskAfterRun` in "group not found" path for `once` tasks (Task 3) |
| `e2e/task-scheduler.test.ts` | Strengthen existing "marks a once-type task as processed" test (Task 4) |

---

## Bug analysis: "group not found" path never completes `once` tasks

`runTask` (lines 104–122 of `src/task-scheduler.ts`) handles a missing group by calling:

```typescript
updateTask(task.id, { last_result: `Error: ${errorMsg}` });
return;
```

`updateTask` never touches `status`. `updateTaskAfterRun` (which would set `status='completed'` for a `once` task) is never reached. Result: the task stays `active`, re-appears in `getDueTasks` every poll, and fires indefinitely.

The fix: in the "group not found" branch, after the `updateTask` call, also call `updateTaskAfterRun` with `nextRun = computeNextRun(task)` so `once` tasks are completed and recurring tasks get their next scheduled run advanced.

---

## Task 1: Three unit tests pinning DB-level semantics

**Files:**
- Modify: `src/task-scheduler.test.ts`

These tests exercise `getDueTasks` and `updateTaskAfterRun` directly via the DB. No scheduler loop or fake timers needed. They confirm the SQL predicates are correct before touching the loop.

Add the following `describe` block **inside** the existing `describe('task scheduler', ...)` block, after the last existing test case (after line 374, before the closing `}`).

- [ ] **Step 1: Write the three unit tests**

Add this block inside `describe('task scheduler', ...)` in `src/task-scheduler.test.ts`. Also add `getDueTasks` and `updateTaskAfterRun` to the import from `./db.js` at the top of the file (line 9 currently reads `import { _initTestDatabase, createTask, getTaskById } from './db.js';`).

```typescript
// Updated import line (replace existing db.js import):
import {
  _initTestDatabase,
  createTask,
  getDueTasks,
  getTaskById,
  updateTaskAfterRun,
} from './db.js';
```

```typescript
  describe('once-task missed-fire DB semantics', () => {
    it('overdue once-task appears in getDueTasks', async () => {
      createTask({
        id: 'once-overdue',
        group_folder: 'test',
        chat_jid: 'test@g.us',
        prompt: 'hello',
        schedule_type: 'once',
        schedule_value: '',
        context_mode: 'isolated',
        next_run: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48 h ago
        status: 'active',
        created_at: new Date().toISOString(),
      });

      const due = getDueTasks();
      expect(due.map((t) => t.id)).toContain('once-overdue');
    });

    it('updateTaskAfterRun with null nextRun sets status to completed', async () => {
      createTask({
        id: 'once-complete',
        group_folder: 'test',
        chat_jid: 'test@g.us',
        prompt: 'hello',
        schedule_type: 'once',
        schedule_value: '',
        context_mode: 'isolated',
        next_run: new Date(Date.now() - 1000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });

      updateTaskAfterRun('once-complete', null, 'Completed');

      const task = getTaskById('once-complete');
      expect(task?.status).toBe('completed');
    });

    it('completed once-task does not reappear in getDueTasks', async () => {
      createTask({
        id: 'once-no-refire',
        group_folder: 'test',
        chat_jid: 'test@g.us',
        prompt: 'hello',
        schedule_type: 'once',
        schedule_value: '',
        context_mode: 'isolated',
        next_run: new Date(Date.now() - 1000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });

      updateTaskAfterRun('once-no-refire', null, 'Completed');

      const due = getDueTasks();
      expect(due.map((t) => t.id)).not.toContain('once-no-refire');
    });
  });
```

- [ ] **Step 2: Run tests, verify all three pass**

```bash
npm test -- src/task-scheduler.test.ts -t "once-task missed-fire DB semantics"
```

Expected: PASS for all three (pinning current correct DB behavior).

- [ ] **Step 3: Sanity-check by temporarily breaking one assertion**

In the second test, temporarily change `expect(task?.status).toBe('completed')` to `expect(task?.status).toBe('active')`. Re-run; verify it fails. Restore.

- [ ] **Step 4: Commit**

```bash
git add src/task-scheduler.test.ts
git commit -m "test(scheduler): unit tests pin getDueTasks and updateTaskAfterRun once-task semantics"
```

---

## Task 2: Integration test — scheduler loop fires overdue once-task exactly once (exposes the bug)

**Files:**
- Modify: `src/task-scheduler.test.ts`

This test wires `startSchedulerLoop` with a real DB and a mocked runner, advances fake timers through two poll cycles, and asserts `enqueueTask` is called exactly once and `status='completed'` afterward. With the current production code the test will **FAIL** (the bug) because the "group not found" path never sets `status='completed'`, so the task fires on every cycle.

Add the following test inside `describe('task scheduler', ...)` after the DB-semantics describe block added in Task 1. The import of `getRunnerForGroup` from `./runtime/index.js` is already mocked at the top of the file via `vi.mock('./runtime/index.js', ...)`.

- [ ] **Step 1: Write the failing integration test**

```typescript
  it('once-task fires exactly once even when group is not registered', async () => {
    createTask({
      id: 'once-exactly-once',
      group_folder: 'missing-group',
      chat_jid: 'test@g.us',
      prompt: 'hello',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 24 h ago
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    process.env.SCHEDULER_POLL_INTERVAL = '50';

    startSchedulerLoop({
      registeredGroups: () => ({}), // group deliberately missing
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    // First poll cycle: task fires
    await vi.advanceTimersByTimeAsync(60);

    // Second poll cycle: task must NOT fire again
    await vi.advanceTimersByTimeAsync(60);

    // Exactly one enqueue across both cycles
    expect(enqueueTask).toHaveBeenCalledTimes(1);

    // Status must be 'completed', not 'active'
    const task = getTaskById('once-exactly-once');
    expect(task?.status).toBe('completed');

    // getDueTasks must return nothing for this task
    const due = getDueTasks();
    expect(due.map((t) => t.id)).not.toContain('once-exactly-once');
  });
```

- [ ] **Step 2: Run test, expect FAIL (confirms the bug)**

```bash
npm test -- src/task-scheduler.test.ts -t "once-task fires exactly once"
```

Expected: FAIL — `enqueueTask` is called more than once and `task?.status` is `'active'` rather than `'completed'`. This is the regression we are about to fix.

---

## Task 3: Fix `runTask` — call `updateTaskAfterRun` in "group not found" path

**Files:**
- Modify: `src/task-scheduler.ts`

The "group not found" early-return branch (lines 104–122) currently calls `updateTask(task.id, { last_result: ... })` and returns. It must also call `updateTaskAfterRun` so `once` tasks are marked `completed` and recurring tasks advance their `next_run`.

- [ ] **Step 1: Read the current "group not found" block**

Lines 104–122 of `src/task-scheduler.ts`:

```typescript
  if (!group) {
    const errorMsg = `Group not found: ${task.group_folder}`;
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: errorMsg,
    });
    // Update last_result so callers can detect that the task was processed,
    // but preserve the current status (don't mark as completed).
    updateTask(task.id, { last_result: `Error: ${errorMsg}` });
    return;
  }
```

- [ ] **Step 2: Apply the fix**

Replace the `if (!group)` block with the version below. The only change is: remove the `updateTask` call and replace it with `updateTaskAfterRun`, which both records the error result **and** correctly sets `status='completed'` for `once` tasks (because `computeNextRun` returns `null` for them):

```typescript
  if (!group) {
    const errorMsg = `Group not found: ${task.group_folder}`;
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: errorMsg,
    });
    // Use updateTaskAfterRun so once-tasks are marked completed and recurring
    // tasks have their next_run advanced — preventing unbounded retry churn.
    const nextRun = computeNextRun(task);
    updateTaskAfterRun(task.id, nextRun, `Error: ${errorMsg}`);
    return;
  }
```

- [ ] **Step 3: Run the integration test, expect PASS**

```bash
npm test -- src/task-scheduler.test.ts -t "once-task fires exactly once"
```

Expected: PASS — `enqueueTask` called exactly once, `task.status === 'completed'`.

- [ ] **Step 4: Run all unit tests to confirm no regressions**

```bash
npm test -- src/task-scheduler.test.ts
```

Expected: all tests pass.

Note: the existing test `'skips tasks when group not found in runTask'` (line 262 of `src/task-scheduler.test.ts`) asserts `task?.status === 'active'`. After the fix, a `once` task with a missing group will be `'completed'`, so **update that test's assertion** to `'completed'`:

```typescript
    const task = getTaskById('task-no-group');
    expect(task?.status).toBe('completed');
```

- [ ] **Step 5: Commit**

```bash
git add src/task-scheduler.ts src/task-scheduler.test.ts
git commit -m "fix(scheduler): once-tasks with missing group now reach status=completed

Previously, the 'group not found' early-return path called updateTask()
which never touched status, so once-tasks re-fired on every poll cycle.
Switch to updateTaskAfterRun() so computeNextRun(null) triggers the
CASE WHEN ? IS NULL THEN 'completed' SQL branch."
```

---

## Task 4: Strengthen existing e2e test

**Files:**
- Modify: `e2e/task-scheduler.test.ts`

The existing "marks a once-type task as processed after running" test (line 123) only checks `last_result` is truthy and contains "Group not found". After the fix, the test can also assert `status === 'completed'` and that the task no longer appears in `getDueTasks`. Import `getDueTasks` alongside the existing imports.

- [ ] **Step 1: Update the import line**

Line 15–19 of `e2e/task-scheduler.test.ts` currently reads:

```typescript
import {
  createTask,
  getTaskById,
  _initTestDatabase,
} from '../src/db.js';
```

Replace with:

```typescript
import {
  createTask,
  getDueTasks,
  getTaskById,
  _initTestDatabase,
} from '../src/db.js';
```

- [ ] **Step 2: Strengthen the test body**

The existing test body (lines 123–144) reads:

```typescript
  it('marks a once-type task as processed after running', async () => {
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

    // With no registered groups, the task hits the "group not found" error path.
    // The scheduler sets last_result to record the error but preserves the active status.
    expect(task.last_result).toBeTruthy();
    expect(task.last_result).toMatch(/Group not found/i);
    console.log(`✅ Once-type task processed, last_result: "${task.last_result}"`);
  }, 10_000);
```

Replace with the strengthened version:

```typescript
  it('marks a once-type task as processed after running', async () => {
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

    // Task must have recorded the "group not found" error
    expect(task.last_result).toBeTruthy();
    expect(task.last_result).toMatch(/Group not found/i);

    // Once-task must be completed — not re-firable
    expect(task.status).toBe('completed');

    // getDueTasks must not include this task any more
    const due = getDueTasks();
    expect(due.map((t) => t.id)).not.toContain(taskId);

    console.log(`✅ Once-type task completed and absent from getDueTasks. last_result: "${task.last_result}"`);
  }, 10_000);
```

Also update the `waitForTaskUpdate` helper (line 47–63) — it currently resolves when `last_result !== null OR status !== 'active'`. After the fix, `status` transitions to `'completed'`, which will satisfy `status !== 'active'` so no change is needed to the helper.

- [ ] **Step 3: Run the e2e test**

```bash
npm test -- e2e/task-scheduler.test.ts -t "marks a once-type task as processed"
```

Expected: PASS.

- [ ] **Step 4: Run the full e2e suite**

```bash
npm test -- e2e/task-scheduler.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add e2e/task-scheduler.test.ts
git commit -m "test(e2e/scheduler): assert once-task reaches status=completed and exits getDueTasks"
```

---

## Final verification

- [ ] Run the entire test suite to confirm no cross-file regressions:

```bash
npm test
```

Expected: all tests pass.
