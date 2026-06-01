# Plan: Story 122 — Mock onboarding (retrospective)

## Goal / Architecture

Story 122 verifies that the mock-channel + mock-LLM harness is wired up correctly
end-to-end before any onboarding-specific logic is added to `src/channel-runner.ts`.
The five tests exercise the lowest-level building blocks (environment boot, channel
lifecycle, SQLite chat/message/task CRUD) so that higher-level onboarding stories
can assume a reliable foundation.

## Tech Stack

- **Mock channel** — `e2e/lib/mock-channel.ts`; a fully in-process `Channel` impl
  that records sent messages and can simulate incoming ones.
- **Mock LLM** — `e2e/lib/mock-llm-server.ts`; an HTTP server that stands in for
  Ollama on port 11434, eliminating real-model latency.
- **In-memory SQLite** — initialised via `_initTestDatabase()` in `src/db.ts`; each
  test gets a fresh `TestDatabase` from `e2e/lib/test-db.ts`.

## File Structure

```
e2e/
  mock-onboarding.test.ts   # 5 it() tests (the deliverable)
  lib/
    mock-channel.ts         # Channel stub + simulateIncomingMessage helpers
    mock-llm-server.ts      # Ollama-compatible HTTP server
    test-db.ts              # Thin SQLite wrapper used by tests
  setup.ts                  # beforeAll: start mock LLM, init DB, connect Redis
src/
  channel-runner.ts         # Production code (not modified by this story)
  db.ts                     # _initTestDatabase export consumed by setup.ts
```

## Tasks per AC

| AC | Test | Verification |
|----|------|--------------|
| 5 (mock channel + LLM, no cluster) | `should initialize test environment` | `getMockLlmPort() === 11434`, `testDb` truthy |
| 5 | `should register mock channel` | `connect()` / `disconnect()` toggle `isConnected()` |
| 4 (state persisted per-user) | `should create test group in database` | `addChat` → `getChats()` returns 1 row with correct fields |
| 1/2 (message routing foundation) | `should add messages to test group` | `addMessage` → `getMessages()` returns content + sender_name |
| 3 (normal routing after onboarding) | `should support scheduled tasks` | `addTask` → `getAllTasks()` returns prompt + schedule_type |

## Retrospective

All 5 tests pass (5/5) against the existing implementation with no code changes
required. The story establishes the mock infrastructure baseline that subsequent
onboarding stories (123+) will extend.
