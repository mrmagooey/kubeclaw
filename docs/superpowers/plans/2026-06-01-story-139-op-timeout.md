# Story 139: Redis Operation Timeout — long-running ops return error within timeout window

## Goal

Verify that individual Redis operations (XREAD, BLPOP, etc.) honour per-call timeout windows when the server is slow, so a stuck Redis call never hangs the orchestrator indefinitely.

## Architecture

Operation-level timeout behaviour in KubeClaw lives in `src/k8s/ipc-redis.ts`. The file creates ioredis client instances with configurable `connectTimeout` and `commandTimeout` options; blocking commands such as `BLPOP` accept an explicit timeout argument (seconds) which Redis itself enforces server-side.

Key mechanisms:
- **ioredis `commandTimeout`** — applied per-client; aborts any command that does not resolve within the window and rejects with a timeout error.
- **BLPOP timeout argument** — passed directly to Redis; the server returns `null` after the window expires rather than blocking forever.
- **`retryStrategy`** — exponential back-off capped at a configurable maximum; each retry is a fresh command, not a hang.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real Redis via `isRedisAvailable()` / `getSharedRedis()` (port-forwarded to `localhost:16379`)
- **Fake timers:** `vi.useFakeTimers({ shouldAdvanceTime: true })` used in connection-timeout tests to accelerate wall-clock sensitive assertions
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/timeout-retry.test.ts` | E2e suite; `describe('Redis Operation Timeout', ...)` at line 101 |
| `src/k8s/ipc-redis.ts` | ioredis client construction, `commandTimeout`, `BLPOP` calls |

## Tasks (retrospective)

### AC 1 — Slow operation returns error within configured timeout

`ipc-redis.ts` creates clients with `commandTimeout` set so that any command not resolved within the window is aborted and an error is returned to the caller. The e2e test exercises `BLPOP` with a 1-second server-side timeout: the call returns `null` (not a hang) within the window.

### AC 2 — Error message identifies an operation timeout

ioredis surfaces a `Command timed out` error for `commandTimeout` violations. For `BLPOP` with a positive timeout the server returns `null`, which the application layer treats as "timed out waiting for data" — distinct from a connection-level failure.

### AC 3 — Connection remains usable after a timed-out operation

Because ioredis uses pipelining and multiplexes commands over the same TCP connection, a timed-out individual command does not tear down the connection. Subsequent commands on the same client succeed normally, as verified by the blocking-pop test which reuses the shared `getSharedRedis()` instance across assertions.

### AC 4 — Different operations honour their own timeouts

`BLPOP` with a 2-second timeout and `vi.advanceTimersByTimeAsync(2100)` confirms the operation resolves in approximately 2 seconds (elapsed ≥ 1900 ms) and returns `null`, independent of any global retry or client setting.

### AC 5 — Tests use a real Redis with throttling or fake timers

Both tests in the `Redis Operation Timeout` describe block run against the live port-forwarded Redis (`localhost:16379`). The second test combines real Redis I/O with `vi.useFakeTimers({ shouldAdvanceTime: true })` to advance the timer alongside real network calls, verifying timing assertions without flakiness.

## Verification

Run: `npm run test:e2e -- timeout-retry -t "Redis Operation Timeout"`

Expected: **2 / 2 tests pass** (BLPOP returns null within 1 s; blocking pop resolves in ~2 s with elapsed ≥ 1900 ms).

Runtime: ~3–4 seconds against a live port-forwarded Redis.
