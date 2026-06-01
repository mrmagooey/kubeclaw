# Story 102: Sidecar ACL Lifecycle — Retrospective Plan

## Goal

Implement and verify per-job Redis ACL user creation and revocation for sidecar
tool-job pods, ensuring each pod gets a unique, scoped credential that is revoked
after the job completes or is killed.

## Architecture

The `RedisACLManager` class in `src/k8s/acl-manager.ts` (not `redis-acl.ts` as
originally specced) handles creation and revocation of per-job ACL users by
calling `ACL SETUSER` with key-pattern restrictions scoped to the job's input
stream and group output channel. Credentials are stored encrypted in SQLite via
`src/db.ts` helpers (`storeJobACL`, `revokeJobACL`). After a job completes or is
killed, the orchestrator calls `revokeJobACL` which issues `ACL DELUSER` to Redis
and marks the record as revoked in the database.

## Tech Stack

- **Runtime:** Node.js / TypeScript
- **Redis client:** ioredis (ACL commands via `redis.acl(...)`)
- **Test framework:** Vitest e2e suite against a real Minikube cluster + Redis
- **Credential storage:** better-sqlite3 (SQLite), AES-256-GCM encryption

## File Structure

| File | Role |
|------|------|
| `e2e/sidecar-acl.test.ts` | E2E tests — `ACL Lifecycle` describe block (line 157) |
| `src/k8s/acl-manager.ts` | `RedisACLManager` — create / revoke / cleanup expired ACLs |
| `src/db.ts` | SQLite helpers: `storeJobACL`, `getJobACL`, `revokeJobACL`, `cleanupExpiredACLs` |

## Tasks (one per AC)

1. **AC1 — Redis supports ACL commands:** `RedisACLManager.verifyRedisVersion()`
   confirms Redis 7+ via `INFO server`; tests call `ACL LIST` directly on
   `getSharedRedis()`.

2. **AC2 — Create per-job ACL user on job start:** `createJobACL(jobId, groupFolder)`
   calls `ACL SETUSER` with `on`, password, key pattern `%R~kubeclaw:input:<jobId>`,
   channel pattern `&kubeclaw:messages:<groupFolder>`, and minimal command set
   (`+xread`, `+xrange`, `+publish`, `+ping`).

3. **AC3 — Revoke ACL user after job completes/killed:** `revokeJobACL(jobId)`
   calls `ACL DELUSER` on the username and sets status to `revoked` in SQLite.

4. **AC4 — Permissions scoped to job stream keys:** ACL rules restrict key access
   to `%R~kubeclaw:input:<jobId>` (read-only) and channel access to
   `&kubeclaw:messages:<groupFolder>` (publish only); admin and dangerous command
   categories blocked.

5. **AC5 — Full lifecycle against real cluster Redis:** `e2e/sidecar-acl.test.ts`
   `ACL Lifecycle` block runs `ACL SETUSER`, verifies key access with a scoped
   connection, calls `ACL DELUSER`, and asserts the user no longer appears in
   `ACL LIST` — all against the live Minikube Redis.

6. **Verification:** `npm run test:e2e -- sidecar-acl -t "ACL Lifecycle"` —
   all tests in the describe block pass against the live cluster.
