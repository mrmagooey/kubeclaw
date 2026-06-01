# Story 86: `set_reminder` tool dispatches and emits human-readable confirmation in the same turn

## Header

**Goal:** Register a `set_reminder` LocalTool on `DirectLLMRunner` so that when the LLM calls it the tool returns `"Reminder set"` plus the echoed reminder text in the same conversation turn, and the assistant's final reply surfaces a human-readable datetime.

**Architecture:** The LLM invokes `set_reminder` with `{ reminder_text, when_iso }` during the first chat-completions call; `DirectLLMRunner` intercepts the tool call in-process (no K8s pod), validates the ISO-8601 timestamp strictly, writes the row via `scheduleTaskDirect`, and feeds a `"Reminder set: <text>"` tool result back to the LLM in a second call; the LLM then produces a natural-language confirmation reply containing both the reminder text and a human-readable datetime representation. Malformed `when_iso` values (e.g. relative strings like `"in 3 days"`) are rejected before any scheduler write, and the error string is fed back to the LLM instead of crashing the runner.

**Tech Stack:** Vitest 4 e2e suite (`vitest.e2e.config.ts`), in-process `OpenAI` client stub injected at construction time, real SQLite via `_initTestDatabase()`. No Kubernetes cluster required.

---

## File Structure

```
e2e/
  set-reminder.test.ts          # E2E acceptance tests for Story 86 (5 ACs across 2 test cases)

src/runtime/
  direct-llm-runner.ts          # DirectLLMRunner constructor — registers set_reminder via
                                #   makeSetReminderTool(scheduleTaskDirect) at line ~1066
```

---

## Tasks

### Task 1 — Implementation (already merged)

`set_reminder` is registered as a `LocalTool` inside the `DirectLLMRunner` constructor (`src/runtime/direct-llm-runner.ts`, line ~1067). The tool is built by `makeSetReminderTool(scheduleTaskDirect)`, which:

- Validates `when_iso` against strict ISO-8601 pattern; rejects relative strings with `"when_iso must be an absolute ISO 8601 ..."` error.
- On success, writes a scheduler row and returns a string containing `"Reminder set"` and the original `reminder_text`.
- `getLocalToolNames()` exposes registered tool names for test assertions.

The test file `e2e/set-reminder.test.ts` drives `DirectLLMRunner` with an injected `fakeClient` stub that returns a `tool_calls` response on the first call and a `stop` response on the second, asserting all five acceptance criteria across two `it` blocks.

### Task 2 — Verification

Run the e2e test suite (no cluster needed):

```bash
npm run test:e2e -- set-reminder
```

Expected result: **2 passed / 2 total** — one test for the happy path (tool result contains `"Reminder set"` + reminder text; final reply echoes text and human-readable datetime), one test for the malformed-`when_iso` error path (runner does not crash; tool result matches `/when_iso must be an absolute ISO 8601/i`).
