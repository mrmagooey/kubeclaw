# Story 164: HTTP-sidecar Follow-up Message Flow — multi-turn tool sessions

## Goal

Verify that `HttpSidecarJobRunner` in `src/k8s/http-sidecar-runner.ts` correctly handles follow-up messages delivered to the http-adapter sidecar after the initial response is published, without requiring the pod to restart between turns.

## Architecture

The HTTP-sidecar pattern creates a Kubernetes Job with two containers sharing localhost network:

- **kubeclaw-http-adapter** — handles the KubeClaw protocol, reads the initial task from a Redis Stream (`kubeclaw:input:{jobId}`), forwards it to the user container over HTTP, publishes the response to a Redis Pub/Sub channel (`kubeclaw:messages:{groupFolder}`), then blocks-reads the same input stream for subsequent `type=followup` entries.
- **user-agent** — the user's arbitrary container image exposing an HTTP REST API on `localhost:{userPort}` (default 8080).

The adapter waits for the user container's health endpoint (`/agent/health` by default) to return 200 before dispatching the first call. Each follow-up arrives as a new `XADD` entry on the input stream; the adapter processes it and publishes a fresh response. Because the pod is never restarted, session state accumulated during call 1 remains available in memory for call 2.

`HttpSidecarJobRunner.runToolJob` streams output via `jobRunner.streamOutput` (Redis Pub/Sub) racing against `waitForJobCompletion` (K8s Job status polling at 5 s intervals). The adapter injects `REDIS_URL`, `REDIS_USERNAME`, and `REDIS_PASSWORD` so it can authenticate to the Redis ACL-enabled cluster.

The e2e test (`e2e/http-sidecar.test.ts`, `describe('Follow-up Message Flow', ...)` at line 622) exercises this with four scenarios:

1. **Single follow-up** — initial call + one follow-up, both `status: success` with echo text.
2. **Session-ID preservation** — explicit `sessionId` propagated unchanged through both turns.
3. **Multiple sequential follow-ups** — three messages (Message 1 → 2 → 3) all succeed.
4. **Clean shutdown on close** — a `type=close` stream entry causes the adapter to exit; no further output arrives within 10 s.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real kind cluster (`kubeclaw-e2e-istio`) with `kubeclaw-http-adapter:latest` loaded
- **Implementation:** `src/k8s/http-sidecar-runner.ts` — `HttpSidecarJobRunner.runToolJob` and `generateHttpSidecarJobManifest`
- **Follow-up channel:** Redis Stream `kubeclaw:input:{jobId}` — fields `type`, `prompt`, optional `sessionId`
- **Output channel:** Redis Pub/Sub `kubeclaw:messages:{groupFolder}` — envelope `{ type, jobId, groupFolder, timestamp, payload }`
- **Health polling:** adapter polls `KUBECLAW_HEALTH_ENDPOINT` at `SIDECAR_HTTP_HEALTH_POLL_INTERVAL` ms intervals until `SIDECAR_HTTP_HEALTH_POLL_TIMEOUT` is reached
- **LLM dependence:** none (mock echo adapter)

## File Structure

| Path | Role |
|------|------|
| `e2e/http-sidecar.test.ts` | E2E suite; `Follow-up Message Flow` describe block at line 622 |
| `src/k8s/http-sidecar-runner.ts` | `HttpSidecarJobRunner` — `runToolJob`, `generateHttpSidecarJobManifest`, `waitForJobCompletion` |
| `src/config.ts` | `SIDECAR_HTTP_*` constants wired into adapter env vars |
| `e2e/lib/redis-cluster.ts` | ACL provisioning helpers, `execRedisCommand` |
| `e2e/setup.ts` | `requireKubernetes`, `getSharedRedis`, `subscribeToOutputMulti` |

## Tasks (retrospective)

### AC 1 — After call 1 returns, call 2 succeeds against the same sidecar pod

The test creates one K8s Job per `jobId`. The adapter reads the initial Redis Stream entry, forwards it to the user container via HTTP POST, publishes the response to the pub/sub channel, then re-enters a blocking `XREAD` loop. `sendFollowupMessage` issues `XADD kubeclaw:input:{jobId} '*' type followup prompt '<text>'` via `execRedisCommand`; the adapter picks it up, calls the user container again, and publishes a second response. Both `waitForNext()` calls resolve with `status: success` and the correct echo text.

### AC 2 — Session state from call 1 is visible to call 2

The test supplies an explicit `sessionId` in both the initial job and the follow-up XADD. The adapter echoes it back as `newSessionId` in both responses. The e2e assertion (`expect(secondOutput!.newSessionId).toBe(sessionId)`) verifies the value is propagated unchanged. Because the same adapter process handles both turns, any in-memory session state (e.g. conversation history held by the user container over localhost) is also preserved.

### AC 3 — The sidecar doesn't restart between calls

The same K8s Job (single pod) handles both messages in sequence. There is no pod restart: the adapter's blocking `XREAD` loop keeps the process alive between turns. The test captures both responses from the same `subscribeToOutputMulti` subscription without any pod-lifecycle assertions needed at the test layer.

### AC 4 — Per-call timing stays consistent

`runToolJob` records `startTime = Date.now()` and logs `duration` after `Promise.all([streamingPromise, completionPromise])` resolves. Each follow-up is an independent Redis Stream entry processed by the same event loop; timing is bounded by `SIDECAR_HTTP_REQUEST_TIMEOUT` per HTTP call and `spec.timeout || CONTAINER_TIMEOUT` for the overall job.

### AC 5 — Tests use real cluster + http-adapter

`requireKubernetes()` in `beforeAll` gates the entire suite; all tests carry `it.skipIf(!ADAPTER_AVAILABLE)`. `ADAPTER_AVAILABLE` is true only when the `kubeclaw-http-adapter:latest` image is present in the cluster. The `Follow-up Message Flow` suite ran 4/4 against a live kind cluster.

## Verification

Run: `npm run test:e2e -- http-sidecar -t "Follow-up Message Flow"`

Expected: **4 / 4 tests pass**.

Runtime: ~90–180 s end-to-end (includes cluster connectivity check, image verification, Redis ACL setup, four K8s Job round-trips including multi-turn follow-up flows, and teardown).
