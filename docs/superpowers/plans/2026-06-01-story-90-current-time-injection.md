# Plan: Story 90 — Current wall-clock time injected into every LLM prompt and stripped from persisted history

## Goal

Inject a fresh `current_time="<ISO-UTC>"` token into the user-role message on every `runAgent` turn so the LLM can reason about relative time, while stripping that token before persisting the turn to `conversation_history` so stale timestamps never mislead future turns.

## Architecture

`formatMessages()` in `src/runtime/direct-llm-runner.ts` prepends a `<context current_time="…" timezone="…" />` XML header to the user-role content before the messages array is dispatched to the LLM. The history-write code path calls a sibling `stripContextHeader()` helper immediately before writing any user turn to the `conversation_history` table, ensuring the ephemeral header is never persisted. Both behaviours are verified independently: the e2e suite captures the raw LLM payload via an in-process mock server, while the integration suite asserts the database rows are header-free.

## Tech Stack

- Runtime: TypeScript / Node 22
- Test framework: Vitest (e2e mode via `npm run test:e2e`)
- LLM stub: in-process mock HTTP server that captures the request payload — no real LLM or Kubernetes required
- Persistence: Redis-backed `conversation_history`

## File Structure

| File | Role |
|---|---|
| `src/runtime/direct-llm-runner.ts` | `formatMessages()` injects `current_time=`; `stripContextHeader()` removes it before DB write |
| `src/runtime/direct-llm-runner.test.ts` | Integration tests: AC1 (payload contains token), AC3 (history rows omit token), AC4 (strip helper) |
| `e2e/direct-llm-runner.test.ts` | E2e test at line 151: AC1 + AC2 + AC4 + AC5 via captured mock-LLM payload |

## Tasks (retrospective)

### AC1 — Injection into user-role message (not system prompt)

`formatMessages()` appends `<context current_time="…" />` to the first user-role entry in the messages array. The system-prompt entry is left untouched, satisfying provider-level caching requirements.

### AC2 — Timestamp freshness (within 5 s of call)

`new Date().toISOString()` is evaluated at `formatMessages()` call time — no caching. The e2e test records a window `[before, after]` bracketing the call and asserts the parsed timestamp falls within it.

### AC3 — Persistence layer strips the token

Before `appendConversationMessage` writes any user turn, `stripContextHeader()` removes the entire `<context … />` XML element. Integration test asserts zero occurrences of `current_time=` across all persisted rows.

### AC4 — ISO-8601 UTC format

The injected value is `new Date().toISOString()` — always UTC, always valid ISO-8601. The e2e test matches `/current_time="([^"]+)"/` and calls `new Date(match[1])` to assert it parses without `NaN`.

### AC5 — Token in user message, not system prompt

`formatMessages()` targets the `user`-role slot; system-prompt content is assembled separately and never modified. Verified by asserting the captured LLM payload's user-role message contains the token.

### Verification

```
npm run test:e2e -- direct-llm-runner -t "current_time"
```

Expected: **1 passed / 1 total** (the `includes current_time in the prompt sent to the LLM, within 5s of test start` case in `e2e/direct-llm-runner.test.ts`).
