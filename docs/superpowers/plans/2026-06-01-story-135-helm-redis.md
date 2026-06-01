# Story 135: Helm chart Redis sub-chart — Redis Deployment + Service + ACL render and run

## Goal

Verify that the chart's Redis sub-chart renders a StatefulSet + Service with ACL-enforced auth, reaches `readyReplicas=1`, and serves live read/write traffic via port-forward from the test host.

## Architecture

Redis is deployed as a `StatefulSet` (not a `Deployment`) named `kubeclaw-redis` with a single replica and a PVC for persistence. An `initContainer` named `init-acl` runs as root, reads five passwords from the `kubeclaw-redis` Secret, writes a `/data/redis-acl.conf` ACL file, then chowns `/data` to UID 999 (the Redis process user). The main `redis:7-alpine` container starts with `--aclfile /data/redis-acl.conf`, enforcing per-role access control. A headless `Service` named `kubeclaw-redis` exposes port 6379 for in-cluster consumers (orchestrator, channel, agent, tool-server, adapter).

The test suite's `beforeAll` establishes a `kubectl port-forward` from a local port (`PORT_FORWARD_LOCAL_PORT`, default 16379) to the StatefulSet pod, then verifies ACL connectivity using the `orchestrator` user before marking `redisConnected = true`. All four `describe('Redis', ...)` tests then run against the live cluster.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e -- helm-chart -t "Redis"`)
- **Kubernetes resource:** `StatefulSet/kubeclaw-redis` + `Service/kubeclaw-redis`
- **Port-forward:** `kubectl port-forward` to localhost for ioredis client access
- **Redis client:** `ioredis` — authenticated as the `orchestrator` ACL user
- **LLM dependence:** none
- **Cluster dependence:** yes — live cluster with helm install required

## File Structure

| Path | Role |
|------|------|
| `e2e/helm-chart.test.ts` | `describe('Redis', ...)` block at line 550 — 4 `it()` tests |
| `helm/kubeclaw/templates/redis.yaml` | StatefulSet + Service definition with `init-acl` initContainer |
| `helm/kubeclaw/values.yaml` | `redis.maxmemory`, `redis.resources`, `redis.storage` defaults |

## Tasks (retrospective)

### AC 1 — StatefulSet has 1 ready replica

`kubectl get statefulset kubeclaw-redis -o jsonpath={.status.readyReplicas}` is polled via `waitUntil` (up to `REDIS_READY_TIMEOUT`). The test asserts the value equals `"1"`. The StatefulSet uses `serviceName: kubeclaw-redis` for stable network identity and a `PersistentVolumeClaim` template for the `/data` mount.

### AC 2 — Service exposes port 6379

`kubectl get service/kubeclaw-redis` is fetched as JSON and the test asserts `spec.ports.some(p => p.port === 6379)`.

### AC 3 — Responds to PING via port-forward

An ioredis client connects to `redis://orchestrator:<password>@localhost:<PORT_FORWARD_LOCAL_PORT>` with a 5 s connect timeout. The test asserts `redis.ping()` resolves to `"PONG"`. Skipped if `redisConnected` is false (port-forward unavailable).

### AC 4 — Supports read/write via port-forward

Using the same ioredis connection, the test sets key `helm-e2e:smoke` to `"ok"` with a 30 s TTL, reads it back, and asserts the value is `"ok"`, then deletes the key. Skipped if `redisConnected` is false.

### Verification

Run: `npm run test:e2e -- helm-chart -t "Redis"`

Expected: **4 / 4 tests pass** — live cluster with helm install required, completes in under 60 seconds once the StatefulSet is ready.
