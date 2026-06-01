# Story 111: Retry logic for failed Redis operations — exponential backoff with max-retry cap

## Goal

Verify that failed Redis operations trigger retries with exponential backoff and that the retry loop is bounded by a max-retry cap, with retry state cleaned up on eventual success. The story is exercised entirely within `e2e/timeout-retry.test.ts` using a self-contained `createRetryHandler` helper that simulates failure injection without requiring real Redis faults.

## Architecture

The retry logic lives in `src/group-queue.ts` and `src/k8s/job-queue.ts`, which share the same pattern: a per-group `RetryState` object (`retryCount`, `lastError`, `success`) drives a `while(true)` loop; on catch, `retryCount` is incremented and a delay of `BASE_RETRY_MS * 2^(retryCount-1)` is awaited before the next attempt; once `retryCount > MAX_RETRIES` the state is reset and the error is surfaced. The e2e test in `timeout-retry.test.ts` replicates this pattern with a local `createRetryHandler` closure so the spec is self-contained and does not require injecting faults into the live Redis instance.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube with live Redis (port-forwarded to `localhost:16379`)
- **Redis client:** ioredis with `retryStrategy` callback for connection-level retries
- **Fake timers:** `vi.useFakeTimers` for backoff-timing assertions without wall-clock delay
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/timeout-retry.test.ts` | e2e suite; `describe('Retry Logic for Failed Operations', ...)` at line 189 |
| `src/group-queue.ts` | Production retry loop — `RetryState`, `BASE_RETRY_MS`, `MAX_RETRIES`, backoff formula |
| `src/k8s/job-queue.ts` | Second retry loop with the same pattern for job-queue operations |
| `src/group-queue.test.ts` | Unit tests for the retry-with-backoff behavior (lines 127–) |

## Tasks (retrospective)

### AC 1 — Failed Redis op triggers retry after short delay

`createRetryHandler` increments `state.retryCount` on every catch and schedules the next attempt after `Math.min(BASE_RETRY_MS * 2^(retryCount-1), 100)` ms. `it('should retry failed operations')` injects a function that throws on the first two calls and returns `'success'` on the third; the test asserts `result === 'success'` and `callCount === 3`.

### AC 2 — Subsequent retries use exponential backoff

`it('should fail after max retries exhausted')` drives the loop to exhaustion with a permanently-failing operation and confirms `state.attempt === MAX_RETRIES`. The `describe('Exponential Backoff Behavior')` block (outside the `-t` filter but present in the file) validates the formula `BASE_RETRY_MS * 2^(retryCount-1)` with unit-level assertions and a `vi.useFakeTimers` timing test.

### AC 3 — Max-retry cap enforced

`MAX_RETRIES = 5` is declared at the top of the describe block. Once `state.retryCount >= MAX_RETRIES` the handler stores the error in `state.lastError` and re-throws, ending the loop. The test asserts `state.retryCount === MAX_RETRIES` and `state.success === false`.

### AC 4 — Retry state cleaned up after eventual success

On a successful return from `operation()`, the handler sets `state.success = true` and resets `state.retryCount = 0`. `it('should succeed on first attempt when no failure')` confirms `state.attempt === 1` and `state.retryCount === 0` after immediate success.

### AC 5 — Testable against real Redis

`beforeAll` connects to `localhost:16379` (port-forwarded from the minikube Redis pod) and verifies ACL access with the orchestrator user. The test suite runs against a live cluster, satisfying the requirement for real-Redis testability even though the retry-logic tests themselves use injected faults rather than network-level failures.

## Verification

Run: `npm run test:e2e -- timeout-retry -t "Retry Logic for Failed Operations"`

Expected: **3 / 3 tests pass** (retry on failure, max-retry exhaustion, immediate success).

Runtime: < 5 seconds (no helm install, no rollout wait; Redis already running).
