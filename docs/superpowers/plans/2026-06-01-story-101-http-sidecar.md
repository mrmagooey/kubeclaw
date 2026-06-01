# Story 101: HTTP-channel sidecar processes a simple echo task end-to-end

## Goal

Verify that the HTTP sidecar adapter accepts a task POST, routes it through the orchestrator's echo handler, and returns the echoed result via Redis pub/sub — exercising the full happy path against a real Kubernetes cluster.

## Architecture

The HTTP channel sidecar pattern runs a two-container Kubernetes Job (`kubeclaw-http-adapter` + user agent container) sharing the same Pod network. The `HttpSidecarJobRunner` in `src/k8s/http-sidecar-runner.ts` generates the Job manifest, injects the task via stdin to the adapter, which reads from Redis Streams (`kubeclaw:input:{jobId}`), forwards the HTTP request to the user container's REST endpoint, and publishes the result back to Redis pub/sub on `kubeclaw:messages:{groupFolder}`. The e2e harness subscribes to pub/sub before submitting the Job, then asserts the returned payload contains the echoed text.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube, namespace `kubeclaw-e2e` (via `getNamespace()`)
- **Adapter image:** `kubeclaw-http-adapter` must be loaded into minikube
- **User container:** `kubeclaw-test-http-echo:latest` (built from `e2e/test-containers/http-echo/`)
- **Redis IPC:** Redis Streams for input, pub/sub for output
- **LLM dependence:** none (echo handler returns input verbatim)

## File Structure

| Path | Role |
|------|------|
| `e2e/http-sidecar.test.ts` | Full e2e suite; `describe('Simple Echo Task Processing', ...)` at line 429 |
| `src/k8s/http-sidecar-runner.ts` | `HttpSidecarJobRunner` — generates Job manifests, health-polls user container |
| `src/channels/http.ts` | HTTP channel implementation |
| `src/k8s/types.ts` | `SidecarHttpJobSpec`, `JobInput`, `JobOutput` type definitions |
| `e2e/test-containers/http-echo/` | Echo user-agent container (returns `Echo: <input>`) |
| `e2e/lib/redis-cluster.ts` | ACL user helpers (`createClusterACLUser`, `deleteClusterACLUser`) |

## Tasks (retrospective)

### AC 1 — HTTP sidecar accepts POST and routes through orchestrator

`createTestJob()` applies a kubectl manifest (written via temp file to handle quoting) for a two-container Job. The adapter container's entrypoint is overridden to pipe the serialised `JobInput` JSON into `node /app/dist/index.js` via stdin, mirroring what the real orchestrator does. The adapter reads the initial task, forwards it as an HTTP POST to the echo container on `localhost:8080`, and publishes the result back to Redis pub/sub.

### AC 2 — Echo handler returns input verbatim

The `kubeclaw-test-http-echo` container responds to POST requests with `{ text: "Echo: <prompt>" }`. The test asserts `output.result.text === 'Echo: Hello World'` and `output.status === 'success'`.

### AC 3 — Real cluster, not stubs

The suite is gated on `ADAPTER_AVAILABLE` (checks `minikube image list` for `kubeclaw-http-adapter`) and `K8S_AVAILABLE` (live cluster reachable). All Jobs are applied with `kubectl apply` and cleaned up with `kubectl delete job` in `afterAll`. Redis connections use `getSharedRedis()` / `getRedisUrlForTests()` pointing at the real cluster Redis.

### AC 4 — Simple Echo describe isolates via `beforeEach`

A top-level `beforeEach` at line 124 calls `cleanupTestKeys('kubeclaw:*:http-echo-test-*')` before each test, clearing leftover Redis stream and pub/sub state from prior runs and ensuring deterministic replay.

### AC 5 — SSE response timing bounded

Each `it()` in the Simple Echo describe sets a 120 000 ms vitest timeout. The `subscribeToOutput()` helper's `waitForResult()` also races against an internal 120 000 ms `setTimeout`, so a hung adapter cannot block the process indefinitely.

### Verification

Run: `npm run test:e2e -- http-sidecar -t "Simple Echo Task Processing"`

Expected: **2 / 2 tests pass** (simple echo + multi-word echo).

Runtime: 5–15 minutes (includes Job scheduling, health-poll wait, and echo round-trip).
