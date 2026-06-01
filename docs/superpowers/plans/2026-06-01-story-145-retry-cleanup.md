# Story 145: Retry state cleanup — successful call clears the retry counter

## Goal

Verify that the retry counter for a Redis-backed operation resets to zero immediately after a successful call, that temporary retry metadata is removed, that successful operation results are preserved, and that concurrent operations have independent counters that are cleaned up without interference.

## Architecture

Retry state is stored in Redis as hash fields (`retryCount`, `lastAttempt`) keyed under `<namespace>:retry-state:<group>` and as plain string values keyed under `<namespace>:temp-retry:<group>` and `<namespace>:retry-tracker:<group>`. On success, the implementation in `src/k8s/ipc-redis.ts` executes a cleanup callback that zeroes or removes these keys. The e2e tests use a live Redis connection (gated by `isRedisAvailable()`) obtained from the shared test harness, inject failure state directly via `hset`/`set`, call the success callback, and then assert via `hgetall`/`get` that the state has been cleared. No Helm install or cluster rollout is required — only a reachable Redis instance.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Redis:** live in-cluster Redis, accessed via shared harness helper
- **Gate:** `isRedisAvailable()` — tests are skipped (`if (!redis) return`) when Redis is unreachable
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/timeout-retry.test.ts` | 4-test e2e suite at line 463 (`describe('Retry State Cleanup After Success', ...)`) |
| `src/k8s/ipc-redis.ts` | Production implementation — retry state storage and cleanup on success |

## Tasks (retrospective)

### AC 1 — Reset retry count after successful operation

`it('should reset retry count after successful operation')` pre-seeds `<ns>:retry-state:<group>` with `retryCount=3` and a `lastAttempt` timestamp, calls the `onSuccess` callback (which sets `retryCount` to `'0'` and deletes `lastAttempt`), then asserts `hgetall` returns `retryCount === '0'` and `lastAttempt === undefined`. Cleanup removes the hash key.

### AC 2 — Clean up temporary retry data after success

`it('should clean up temporary retry data after success')` seeds `<ns>:temp-retry:<group>` with a JSON blob containing an `attempts` array and `failedAt` timestamp, calls `cleanupAfterSuccess` which calls `redis.del`, then asserts `redis.get` returns `null`.

### AC 3 — Preserve successful operation results

`it('should preserve successful operation results')` seeds both a result key (`<ns>:result:<group>`) and a retry-tracker key (`<ns>:retry-tracker:<group>`), calls `onSuccess` which deletes only the retry-tracker, then asserts the result key still holds its value while the retry-tracker is `null`.

### AC 4 — Handle concurrent success and cleanup

`it('should handle concurrent success and cleanup')` seeds 10 keys, then fans out `processWithCleanup` concurrently via `Promise.all`, alternating `shouldSucceed` by even/odd index. Asserts that exactly 5 results are truthy, confirming independent per-key cleanup without cross-contamination.

### Verification

Run: `npm run test:e2e -- timeout-retry -t "Retry State Cleanup"`

Expected: **4 / 4 tests pass**.

Runtime: seconds (no cluster install, Redis-only).
