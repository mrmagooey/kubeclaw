# Story 114: Sidecar security boundaries

## Goal

Verify that each sidecar job's Redis ACL is scoped strictly to its own input/output keys and a minimal whitelist of commands, so that a compromised sidecar cannot read another job's data or execute admin commands that could affect the cluster-wide Redis configuration.

## Architecture

`src/k8s/acl-manager.ts` contains a per-job ACL builder that creates a Redis user for each sidecar pod, granting read access only to the job's own input stream keys (`job:<id>:input*`) and write access only to the job's own output channel (`job:<id>:output*`), while explicitly blocking admin verbs (`CONFIG`, `FLUSHDB`, `FLUSHALL`, `ACL`, `DEBUG`, `SHUTDOWN`, `SLAVEOF`, `REPLICAOF`, `CLUSTER`, `SCRIPT`, `LATENCY`, `MODULE`). The e2e test in `e2e/sidecar-security.test.ts` provisions test users via `ACL SETUSER` directly against the in-cluster Redis through a port-forward, then connects as those users and asserts NOPERM responses for forbidden operations and success for permitted ones.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube with port-forward to `kubeclaw-redis` on `localhost:16379`
- **Redis client:** ioredis with `enableReadyCheck: false` (sidecar users lack `INFO` permission)
- **ACL provisioning:** `ACL SETUSER` via orchestrator credentials in `beforeAll`; teardown via `ACL DELUSER`
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/sidecar-security.test.ts` | 10-test e2e suite across four describe blocks |
| `src/k8s/acl-manager.ts` | Per-job ACL builder — scoped key patterns, blocked admin verbs |

## Tasks (retrospective)

### AC 1 — Sidecar A credentials rejected for Sidecar B keys

`beforeAll` creates two ACL users (`sidecar-security-test-job-a`, `sidecar-security-test-job-b`) each scoped to their own `job:<id>:*` key pattern. The `Key Isolation Between Sidecars` describe block connects as sidecar A and attempts `GET`/`SET` on sidecar B's keys, asserting the error message contains `NOPERM`. A second test attempts wildcard-style key access from a third user and asserts the same.

### AC 2 — Admin commands blocked for sidecar users

The `Admin Command Restrictions` describe block provisions sidecar users and issues `FLUSHDB`, `CONFIG GET maxmemory`, `ACL LIST`, and `DEBUG SLEEP 0` / `SHUTDOWN NOSAVE`. Each invocation must throw an error containing `NOPERM`.

### AC 3 — Sidecar can read its own input and publish to its own output

Verified implicitly: the whitelist test in `Command Whitelist` provisions a user with `GET`, `SET`, `XREAD`, and `PUBLISH` on its own key prefix and confirms these commands succeed without error.

### AC 4 — Invalid/revoked credentials rejected

The `Authentication` describe block creates three negative scenarios: wrong password (`WRONGPASS` or `NOAUTH`), a username that was never created (`ERR`), and a user that is disabled mid-test (`NOPERM` or `NOAUTH`). Each connection attempt or first command must throw.

### AC 5 — Real Redis ACL on in-cluster Redis

All tests connect through the global-setup port-forward (`localhost:16379`) to the live `kubeclaw-redis` pod in minikube, provisioning and tearing down ACL users with orchestrator credentials. No mock Redis is used.

### Verification

Run: `npm run test:e2e -- sidecar-security`

Expected: **10 / 10 tests pass** (2 key-isolation + 4 admin-restriction + 3 authentication + 1 command-whitelist).

Runtime: under 10 seconds (no helm install; port-forward already established by global-setup).
