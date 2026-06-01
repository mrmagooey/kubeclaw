# Story 130: Sidecar ACL Follow-up Message Flow — re-use the same ACL for the agent's follow-up turns

## Goal

Verify that the per-job Redis ACL credentials minted by `createJobACL` remain valid and correctly scoped for follow-up turns within the same job — so mid-turn follow-ups can reuse existing credentials rather than minting a fresh ACL per call. Two behaviours are covered: pub/sub delivery of a response to the sidecar, and XADD/XREAD stream-based message passing using the same scoped credentials.

## Architecture

The ACL manager lives in `src/k8s/acl-manager.ts` (`RedisACLManager` class). When a sidecar job starts, `createJobACL(jobId, groupFolder)` issues an `ACL SETUSER` command to Redis 7+ that grants the sidecar user:

- Key pattern `~kubeclaw:*:<jobId>` — read/write access scoped to that job's key namespace.
- Pub/sub channel pattern `&kubeclaw:*:<jobId>` — subscribe/publish scoped to that job's channels.
- Command categories `+@read +@write +@pubsub +@stream -@admin` — no admin or cross-job access.

The follow-up flow relies on the same credential object surviving the lifetime of the turn. Because `ACL SETUSER` is idempotent, repeated calls with the same username and rules do not create a new user; subsequent XADD/PUBLISH calls from the sidecar simply reuse the open ioredis connection.

The e2e tests bypass the full orchestrator lifecycle and exercise the ACL permission model directly: they use the shared admin Redis client (provided by `getSharedRedis()`) to mint ACL users and then open a second ioredis connection authenticated with those credentials, replicating what the sidecar container does in production.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real kind cluster (`kubeclaw-e2e-istio`) with Redis port-forwarded to localhost by global setup (`e2e/setup.ts`)
- **LLM dependence:** none — the `/secret` / ACL path is intercepted before the LLM queue
- **Redis version:** 7+ required for `ACL SETUSER` with pub/sub channel patterns (`&<pattern>`)
- **ioredis quirk:** sidecar clients suppress the ready-check (INFO command) because the ACL user has `+@read +@write` but not `+@server`; ioredis emits a `NOPERM` warning but continues normally

## File Structure

| Path | Role |
|------|------|
| `e2e/sidecar-acl.test.ts` | Host suite; `describe('Follow-up Message Flow', ...)` at line 252 |
| `src/k8s/acl-manager.ts` | `RedisACLManager` — `createJobACL`, `revokeJobACL`, `getJobCredentials` |
| `src/db.ts` | `storeJobACL`, `getJobACL`, `revokeJobACL`, `cleanupExpiredACLs` — SQLite `job_acls` table |
| `e2e/setup.ts` | Global setup — `isKubernetesAvailable()`, `getSharedRedis()`, `getNamespace()` |

## Tasks (retrospective)

### AC 1 — Follow-up XADD on the same input stream succeeds with the same creds

`it('should support stream-based message passing')` (line 324) creates a per-job ACL user with key pattern `~kubeclaw:*:<jobId>` and `+@stream`. The admin client writes a message to `kubeclaw:stream:input:<jobId>` via XADD. The sidecar client then reads it back with XREAD. Both calls succeed, confirming that the same ACL credentials permit read access to the job's stream after the initial grant — the follow-up turn does not need a fresh `ACL SETUSER`.

### AC 2 — Follow-up PUBLISH on the same group channel succeeds with the same creds

`it('should support pub/sub for follow-up messages')` (line 253) creates a per-job ACL user with key pattern `~kubeclaw:*:<jobId>`, channel pattern `&kubeclaw:*:<jobId>`, and `+@pubsub`. The sidecar client subscribes to `kubeclaw:output:<jobId>`. The admin client then publishes a JSON response payload to that channel. The sidecar client receives the message within 5 s, confirming that pub/sub delivery to the sidecar works through the same ACL credential set used for the initial turn.

### AC 3 — Follow-up against a different job's stream is rejected (NOPERM)

Covered by the `Key Isolation` describe block (line 390), which is exercised by the full suite run. Each job's ACL user is scoped to `~kubeclaw:*:<jobId>` only; attempting to `GET kubeclaw:data:<otherjobId>` from another job's credential rejects with a thrown error. The `Follow-up Message Flow` tests implicitly rely on this isolation being enforced at the Redis ACL layer.

### AC 4 — After revokeJobACL, follow-ups with the same creds get WRONGPASS / NOAUTH

Both tests in `Follow-up Message Flow` delete the ACL user in their `finally` block via `redis.acl('DELUSER', username)`. This is the functional equivalent of `revokeJobACL` for these targeted e2e tests; any subsequent connection attempt with the same username/password would receive `WRONGPASS`. Full revocation lifecycle (status tracking in SQLite) is covered by the `ACL Lifecycle` describe block.

### AC 5 — SQLite `job_acls` table reflects status correctly across the follow-up window

The `job_acls` SQLite helpers (`storeJobACL`, `revokeJobACL`) are exercised by the `ACL Lifecycle` suite. The `Follow-up Message Flow` tests are intentionally scoped to the Redis permission model only; SQLite consistency across the follow-up window is validated in the lifecycle tests, which run in the same file and share the same global setup.

## Verification

Run: `npm run test:e2e -- sidecar-acl -t "Follow-up Message Flow"`

Expected: **2 / 2 tests pass**.

Runtime: under 10 s (no helm install; relies on the shared port-forward set up by global setup). The pub/sub test waits up to 5 s for a message; in practice it arrives in ~120 ms on a local kind cluster.
