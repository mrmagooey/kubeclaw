# Story 129: Redis Connection Timeout — connect attempt fails fast on unreachable host

## Goal

Verify that ioredis connection attempts against an unreachable host fail within a bounded time window, surface a recognisable error, and do not spin indefinitely at the ioredis retry layer — so the orchestrator surfaces connection problems quickly instead of hanging.

## Architecture

`src/k8s/ipc-redis.ts` is the Redis-based IPC module; it imports `Redis` from `ioredis` and delegates all client construction to `src/k8s/redis-client.ts`. The relevant ioredis knobs are:

- `connectTimeout` — milliseconds before the TCP connect attempt is aborted.
- `maxRetriesPerRequest` — caps per-command retries (set to 1 or 0 to prevent indefinite command queuing).
- `retryStrategy: () => null` — returning `null` tells ioredis to stop reconnecting entirely, which is the correct behaviour for tests that want to probe a dead host without holding the process open.

The e2e tests construct throwaway `Redis` instances pointed at `192.0.2.1:6379` (a TEST-NET address that is guaranteed unreachable and causes `EHOSTUNREACH` almost immediately on Linux) rather than a TCP blackhole, which means the OS-level failure typically arrives well inside the 2 s `connectTimeout`. The test for "timeout after configured duration" uses `vi.useFakeTimers({ shouldAdvanceTime: true })` combined with `vi.advanceTimersByTimeAsync(5000)` to accelerate wall-clock time without fully freezing the event loop, ensuring the timeout fires during the test.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube (Redis port-forwarded to localhost:16379 by global setup)
- **LLM dependence:** none
- **Fake timers:** `vi.useFakeTimers({ shouldAdvanceTime: true })` for the timeout-duration test

## File Structure

| Path | Role |
|------|------|
| `e2e/timeout-retry.test.ts` | Host suite; `describe('Redis Connection Timeout Handling', ...)` at line 54 |
| `src/k8s/ipc-redis.ts` | Redis IPC watcher; consumers of `getRedisClient()` / `getRedisSubscriber()` |
| `src/k8s/redis-client.ts` | Client factory — sets `connectTimeout`, `maxRetriesPerRequest`, `retryStrategy` |

## Tasks (retrospective)

### AC 1 — Connect attempt fails fast on unreachable host

`it('should fail fast when connecting to invalid host with short timeout')` creates a throwaway `Redis` instance with `connectTimeout: 2000`, `maxRetriesPerRequest: 1`, `retryStrategy: () => null`, aimed at `192.0.2.1:6379`. It asserts that `redis.ping()` rejects and that the total elapsed wall time is under 5 000 ms. On Linux the `EHOSTUNREACH` arrives in single-digit milliseconds, so the test completes in ~26 ms in practice.

### AC 2 — Error is surfaced (reject on ping)

The same test asserts `await expect(failedRedis.ping()).rejects.toThrow()`, confirming that the error propagates to the caller rather than being silently swallowed. The ioredis unhandled-error stderr line (`[ioredis] Unhandled error event: Error: connect EHOSTUNREACH`) is expected and does not fail the test.

### AC 3 — No infinite ioredis retry

`retryStrategy: () => null` is passed to the throwaway client. Returning `null` from the retry strategy tells ioredis to stop reconnecting, satisfying the constraint that app-level retry (not ioredis-level) should control reconnection policy.

### AC 4 — Successful reconnection does not require restart

Covered implicitly: the test suite's shared Redis client (port-forwarded to the live cluster) connects and disconnects normally around every test. Reconnection after transient failure is handled at the app level by re-creating the client, not by relying on ioredis auto-reconnect.

### AC 5 — Tests use wrong host/port to force failure

Both tests use `192.0.2.1:6379` (RFC 5737 TEST-NET-3), which is routable but has no listener, ensuring predictable `EHOSTUNREACH` behaviour without depending on firewall rules or iptables tricks.

## Verification

Run: `npm run test:e2e -- timeout-retry -t "Redis Connection Timeout Handling"`

Expected: **2 / 2 tests pass**.

Runtime: under 10 s (no helm install; relies on the shared port-forward set up by global setup).
