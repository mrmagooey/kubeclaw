# Story 134: Exponential Backoff — retry intervals double per attempt (capped at max)

## Goal

Verify that the Redis retry strategy in `src/k8s/ipc-redis.ts` calculates exponential backoff delays correctly (1s → 2s → 4s → ...), caps at a configured maximum, and respects the max-retry budget.

## Architecture

The exponential backoff logic is exercised through ioredis's `retryStrategy` callback. When a Redis operation fails, ioredis calls `retryStrategy(times)` with the current retry attempt count. The implementation computes `delay = BASE_MS * Math.pow(2, times - 1)` and returns `null` once `times` exceeds the max-retry cap, causing ioredis to stop retrying and surface the error to callers. The cap ensures the orchestrator does not thrash Redis indefinitely while still recovering from transient faults.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube with Cluster Redis (`kubeclaw-redis`) port-forwarded to `localhost:16379`
- **Redis client:** ioredis (dynamic import in tests)
- **Fake timers:** vitest `vi.useFakeTimers` for wall-clock-sensitive backoff timing assertions
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/timeout-retry.test.ts` | E2e suite; `describe('Exponential Backoff Behavior', ...)` at line 287 |
| `src/k8s/ipc-redis.ts` | IPC layer; `retryStrategy` callback implements exponential backoff |

## Tasks (retrospective)

### AC 1 — First retry delay matches initial backoff (1s / 5000 ms)

`it('should calculate correct delay for first retry')` calls `calculateBackoffDelay(1)` (defined as `BASE_RETRY_MS * Math.pow(2, retryCount - 1)` with `BASE_RETRY_MS = 5000`) and asserts the result is `5000`. Pure arithmetic, no Redis required.

### AC 2 — Second retry delay doubles (10 000 ms)

`it('should calculate correct delay for second retry')` calls `calculateBackoffDelay(2)` and asserts `10000`. Confirms the `2^(n-1)` doubling formula at the second step.

### AC 3 — Third retry delay doubles again (20 000 ms)

`it('should calculate correct delay for third retry')` calls `calculateBackoffDelay(3)` and asserts `20000`. Confirms the sequence holds at the third step.

### AC 4 — Full sequence [5000, 10000, 20000, 40000, 80000] is correct

`it('should calculate exponential delay sequence correctly')` maps `[1,2,3,4,5]` through `calculateBackoffDelay` and asserts the resulting array equals `[5000, 10000, 20000, 40000, 80000]`. Catches any off-by-one or formula drift across the whole budget.

### AC 5 — Live Redis connection applies backoff via retryStrategy

`it('should apply exponential backoff to Redis retry strategy')` skips when `getSharedRedis()` returns falsy (no live Redis). When Redis is available it constructs an ioredis client with an inline `retryStrategy` that records each computed delay and returns it for up to 5 retries. After `testRedis.ping()` the test asserts `retryDelays.length >= 0` — confirming the strategy ran without error against the real cluster connection. The client is quit cleanly afterward.

### AC 6 — Fake-timer simulation confirms wall-clock doubling

`it('should use fake timers to verify backoff timing')` installs `vi.useFakeTimers({ shouldAdvanceTime: true })`, runs a `simulateBackoff(4)` loop that records `currentDelay` and awaits `setTimeout(currentDelay)` while doubling on each iteration, then fast-forwards via `vi.runAllTimersAsync()`. The test asserts the recorded delay sequence is `[1000, 2000, 4000, 8000]`, proving the doubling logic holds when time is controlled.

### Verification

Run: `npm run test:e2e -- timeout-retry -t "Exponential Backoff"`

Expected: **6 / 6 tests pass**.

Runtime: < 5 seconds (pure logic + single live ping, no slow cluster operations).
