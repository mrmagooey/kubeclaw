# Story 146 Retrospective: Redis ACL Infrastructure

**Date:** 2026-06-01
**Story:** 146 — Sidecar ACL Infrastructure — Redis supports ACL commands
**Test suite:** `e2e/sidecar-acl.test.ts` → `describe('Redis ACL Infrastructure', ...)` (line 74)
**Test command:** `npm run test:e2e -- sidecar-acl -t "Redis ACL Infrastructure"`
**Result:** 3/3 passing

---

## What was built

The Redis ACL infrastructure lives entirely in the Helm chart at
`helm/kubeclaw/templates/redis.yaml`. There is no application code — the
feature is pure Kubernetes/Redis configuration.

### Key design: `aclfile` via init-container

Redis is started with `--aclfile /data/redis-acl.conf`. The ACL file is
written by an `initContainer` (`init-acl`) that runs `busybox sh` to
interpolate five secrets from Kubernetes `secretKeyRef` entries into the
ACL conf before the Redis process starts.

### Users defined in the ACL file

| User | Permissions summary |
|---|---|
| `default` | `off` — disabled, no anonymous access |
| `orchestrator` | `+@all` — full admin; used by the orchestrator and tests |
| `channel` | pub/sub + streams on `kubeclaw:*` channels only |
| `agent` | read/write on `kubeclaw:input:*`, tool-result, and toolcall keys |
| `tool-server` | read/write on `kubeclaw:toolcalls:*` and `kubeclaw:toolresults:*` |
| `adapter` | read-only on `kubeclaw:input:*`, pub/sub on messages |

### Why this satisfies the acceptance criteria

1. **`ACL LIST`** — works because the orchestrator user has `+@all`, which
   includes `+acl`. Tests connect as `orchestrator` and can call `ACL LIST`.
2. **`ACL SETUSER`** — orchestrator has admin permissions; tests create
   ephemeral users and verify them.
3. **`ACL DELUSER`** — same admin path; cleanup after each test case.
4. **`ACL WHOAMI`** — implicitly covered; `getSharedRedis()` returns a client
   authenticated as `orchestrator`, so `ACL WHOAMI` returns `orchestrator`.
5. **NOPERM for non-admins** — the key-pattern test creates a restricted user
   (`-@admin`) and verifies that writes outside the allowed key pattern are
   rejected with an error.

### Test structure (3 tests)

- `should have Redis 7+ available in cluster` — parses `INFO server` for
  `redis_version` and asserts `major >= 7`.
- `should support ACL commands` — creates a test user via `ACL SETUSER`,
  asserts it appears in `ACL LIST`, then removes it with `ACL DELUSER`.
- `should enforce key patterns for ACL users` — creates a restricted user,
  connects a second ioredis client as that user, verifies allowed-key writes
  succeed and disallowed-key writes throw `NOPERM`.

### Lessons / notes

- The `init-acl` container runs as `root` (UID 0) so it can write to the
  PVC data directory, then `chown -R 999:999 /data` hands ownership to the
  Redis UID before the main container starts.
- `enableReadyCheck` on the restricted-user ioredis client would fail because
  `INFO` is denied for non-admin users. The test lets the default ready-check
  fail gracefully (logged to stderr) and proceeds with functional assertions.
- No LLM dependency — the feature is purely infrastructure.
