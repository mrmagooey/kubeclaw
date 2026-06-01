# Plan: Story 92 — Once-task with overdue `next_run` fires exactly once on next scheduler poll

## Goal

Guarantee that a once-task whose fire time passed while the orchestrator was down is delivered on the very next scheduler poll after restart, and never re-delivered.

## Architecture

`getDueTasks()` in `src/db.ts` selects rows where `next_run <= now AND status = 'active'`; there is no upper time bound on `next_run`, so a task overdue by 48 hours (or any duration) appears on the first poll after the scheduler regains control. After firing, `updateTaskAfterRun(id, null, 'Completed')` writes `status = 'completed', next_run = NULL` to the row; subsequent calls to `getDueTasks()` filter on `status = 'active'`, so completed rows are permanently excluded and the task cannot fire again. The schema choice — one-sided time predicate plus a status gate — is what provides the missed-fire-survives-restart guarantee without any special recovery logic in the scheduler loop.

## Tech Stack

- Test framework: Vitest (default config, `npm test`)
- Database: in-memory SQLite via `_initTestDatabase()` — no Kubernetes, no LLM, no Redis required
- Language: TypeScript / Node 22

## File Structure

| File | Role |
|---|---|
| `src/task-scheduler.test.ts` | `describe('once-task missed-fire DB semantics', …)` block at line 431; 3 tests covering AC1–AC4 |
| `src/task-scheduler.ts` | Scheduler entry-point; `_initTestDatabase()` helper for in-memory DB wiring |
| `src/db.ts` | `createTask`, `getDueTasks`, `updateTaskAfterRun`, `getTaskById` — the four functions under test |

## Tasks (retrospective)

### AC1 — Overdue once-task appears in getDueTasks()

`getDueTasks()` queries `next_run <= ?` with the current timestamp as the bound, with no maximum-age guard. A task created with `next_run = now - 48 h` satisfies the predicate and is returned on the next poll, regardless of how stale it is.

### AC2 — updateTaskAfterRun sets status to 'completed' with next_run = null

Calling `updateTaskAfterRun(id, null, 'Completed')` writes `status = 'completed'` and `next_run = NULL` to the row. `getTaskById` confirms both columns after the call.

### AC3 — Completed once-task does not reappear in getDueTasks()

After `updateTaskAfterRun` marks the row completed, a second call to `getDueTasks()` returns an empty array — the status filter excludes the row and prevents any re-fire.

### AC4 — Testable purely at the SQLite layer

All three tests operate through `createTask` + `getDueTasks` + `updateTaskAfterRun` + `getTaskById` against an `_initTestDatabase()` in-memory instance. No scheduler loop, no Redis, and no LLM call is required, keeping the suite fast and deterministic.

### AC5 — Missed-fire-survives-restart guarantee

ACs 1–3 compose to give the user-visible property: if the orchestrator was down when `next_run` passed, the task fires on the first subsequent poll (AC1) and fires only once (AC3), with its final state correctly recorded (AC2).

### Verification

```
npm test -- src/task-scheduler.test.ts -t "missed-fire"
```

Expected: **3 passed / 3 total** (overdue-appears, updateTaskAfterRun-completed, no-refire tests in the `once-task missed-fire DB semantics` describe block).
