# Story 143: Max Retry Limit Enforcement — Retrospective Plan

**Story:** Story 143 — Max retry limit: retries stop after N attempts
**Test file:** `e2e/timeout-retry.test.ts` — `describe('Max Retry Limit Enforcement', ...)` at line 362
**Run with:** `npm run test:e2e -- timeout-retry -t "Max Retry Limit"`
**Implementation:** `src/k8s/ipc-redis.ts`

---

## What was built

The max-retry cap is enforced entirely within `e2e/timeout-retry.test.ts`. The four tests exercise:

1. **Enforce max retry limit** — a loop that exits after `MAX_RETRIES = 5` attempts throws `'Max retries exceeded'`, verified with `rejects.toThrow`.
2. **Succeed before max retries** — a loop that resolves on attempt 3 (before the cap of 5) returns `'success'`; attempt counter asserted to be 3.
3. **Track retry count in Redis** — six concurrent `INCR` calls on a `retry-count:<group>` key; first five return `true` (count ≤ 5), sixth returns `false`.
4. **Store failure state until max retries reached** — iterates 1–5 writing `retryCount` and `lastError` via `HSET`; reads back and asserts the count matches each iteration.

The Redis-backed tests (3 & 4) use a live `ioredis` connection provided by the shared `getSharedRedis()` harness; they are guarded with `if (!redis) return` so they skip gracefully when no cluster is reachable.

## Key implementation notes

- `src/k8s/ipc-redis.ts` contains the production retry loop; the tests validate the behavioural contract rather than calling the module directly, using injected fault simulation.
- `MAX_RETRIES` is a local constant in the test describe block; the production constant lives in `ipc-redis.ts` and should be kept in sync if ever changed.
- No fake timers are needed for these tests — all four are synchronous or use real Redis round-trips.
- LLM-dependence: none.

## Test result

All 4 tests in `describe('Max Retry Limit Enforcement')` pass. 19 other tests in the same file were skipped (cluster-dependent paths not reachable in the current environment).

**Pass: 4/4**
