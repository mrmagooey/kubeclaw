# Story 106: Orchestrator pod runs, connects to Redis on startup, and creates Kubernetes jobs — retrospective plan

**Goal:** Verify that the orchestrator pod reaches `Running` status, connects to Redis on startup (with log evidence), is reachable via its Kubernetes service, and creates a real Kubernetes Job when an agent-job message is enqueued. All three acceptance criteria are exercised by the `'Real Orchestrator E2E'` describe block in `e2e/orchestrator.test.ts`.

**Architecture:** `src/index.ts` is the single entrypoint; it branches on `KUBECLAW_MODE` and, for the default orchestrator mode, imports Redis watchers from `src/k8s/ipc-redis.ts` (`startIpcWatcher`, `startToolPodSpawnWatcher`, `startToolJobSpawnWatcher`, `startTaskRequestWatcher`) and registers them after the database, channel plugins, and group-runner infrastructure are initialised. `src/k8s/ipc-redis.ts` establishes all Redis clients via `src/k8s/redis-client.ts` and subscribes to pub/sub channels; on startup it logs a connection confirmation consumed by the e2e suite. `src/k8s/job-runner.ts` exports a `jobRunner` singleton that wraps the `@kubernetes/client-node` `BatchV1Api`; when an agent-job message arrives on the spawn-tool-job Redis stream, `ipc-redis.ts` calls `jobRunner.run(...)` which POSTs a `V1Job` manifest to the cluster.

**Tech Stack:** TypeScript (orchestrator, Redis IPC, job runner), ioredis (`src/k8s/redis-client.ts`), `@kubernetes/client-node` (Kubernetes Job creation), Helm (deployment manifests), vitest (unit + integration), minikube k8s cluster + `npm run test:e2e` (e2e).

---

## File structure

```
src/
  index.ts                        # main entrypoint; branches on KUBECLAW_MODE; wires Redis IPC
  config.ts                       # KUBECLAW_MODE, REDIS_* env vars, image config
  k8s/
    ipc-redis.ts                  # Redis watchers: IPC, tool-pod, tool-job, task-request
    redis-client.ts               # ioredis client factory; getRedisClient(), getRedisSubscriber()
    job-runner.ts                 # JobRunner singleton — creates V1Job via BatchV1Api

helm/kubeclaw/templates/
  deployment.yaml                 # orchestrator Deployment (KUBECLAW_MODE=orchestrator)
  service.yaml                    # ClusterIP service for orchestrator

e2e/
  orchestrator.test.ts            # 'Real Orchestrator E2E' describe block (lines 566, 598, 625)
```

---

## Tasks per acceptance criterion

- [x] **AC1 — orchestrator pod reaches Running status**
  - Helm chart `deployment.yaml` renders a Deployment with the built image; readiness probe passes once the HTTP health endpoint responds.
  - e2e test (`line 566`): `kubectl get pods` confirms orchestrator pod in `Running` phase within timeout.

- [x] **AC2 — connects to Redis on startup (logged + reachable via service)**
  - `src/k8s/redis-client.ts` creates the ioredis client; `src/k8s/ipc-redis.ts` calls `getRedisClient()` and logs `Redis connected` on the `ready` event.
  - e2e test (`line 598`): scrapes orchestrator pod logs for the startup Redis-connected message; also asserts the `ClusterIP` service resolves from within the cluster.

- [x] **AC3 — enqueued agent-job → orchestrator creates K8s Job**
  - Test publishes a message on the spawn-tool-job Redis stream; `ipc-redis.ts` `startToolJobSpawnWatcher` consumes it and calls `jobRunner.run(...)`.
  - `job-runner.ts` constructs a `V1Job` manifest and posts it via `BatchV1Api`; `kubectl get jobs` confirms the job appears.
  - e2e test (`line 625`): asserts job name appears in cluster within timeout.

- [x] **AC4 — real orchestrator deployment, not mock**
  - The Deployment uses the actual kubeclaw image built from `src/`; no mock server substituted for the orchestrator process itself.

- [x] **AC5 — cluster + Redis + image build prerequisites honored**
  - Test suite `beforeAll` ensures minikube is running, the image is loaded, and the Helm release is current before any assertion runs.

---

## Retrospective

Implementation was complete before this plan was written. Tests were run against the live minikube cluster (`minikube` node, `v1.35.1`) on 2026-06-01. All three targeted ACs verified green: 3 passed, 5 skipped (unrelated tests), 0 failed.
