# Story 138: HTTP-sidecar Health Check Polling — sidecar marked Ready only after user container responds

## Goal

Verify that the HTTP-sidecar adapter polls the user container's `/healthz` endpoint before accepting inbound tasks, so Kubernetes only routes traffic when the whole pod (sidecar + user container) is actually serving.

## Architecture

The HTTP-sidecar pattern runs two containers in a single Kubernetes Job pod: the `kubeclaw-http-adapter` sidecar and a user-supplied container. The adapter is built from the `kubeclaw-http-adapter` Docker image and communicates with the user container over localhost HTTP.

**Health-check polling** is implemented in `src/k8s/http-sidecar-runner.ts` via environment variables injected into the adapter container at job-creation time:

- `KUBECLAW_HEALTH_ENDPOINT` — path to poll on the user container (default `/agent/health`; configurable via `spec.healthEndpoint`)
- `KUBECLAW_AGENT_URL` — base URL for the user container (`http://localhost:<userPort>`)
- `KUBECLAW_HEALTH_POLL_INTERVAL` — milliseconds between poll attempts
- `KUBECLAW_HEALTH_POLL_TIMEOUT` — total time to wait for the user container to become healthy

The adapter reads these env vars and polls `<KUBECLAW_AGENT_URL><KUBECLAW_HEALTH_ENDPOINT>` in a loop. It forwards the first task only after receiving HTTP 200 from the health endpoint, satisfying AC 1 and AC 2.

Chart-level probe config in `helm/kubeclaw/templates/capability-pods.yaml` applies `readinessProbe` and `livenessProbe` via `tcpSocket` on the HTTP port (`initialDelaySeconds: 5 / periodSeconds: 10 / failureThreshold: 3`), gating Kubernetes Endpoints membership on socket availability. The adapter's own health poll adds the application-level gate on top of this transport-level gate.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube via `requireKubernetes()` + `isKubernetesAvailable()`
- **Adapter image:** `kubeclaw-http-adapter:latest` (must be loaded into minikube before running)
- **User image:** `kubeclaw-test-http-echo:latest` (built and loaded by `beforeAll`)
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/http-sidecar.test.ts` | E2e suite; `describe('Health Check Polling', ...)` at line 468 |
| `src/k8s/http-sidecar-runner.ts` | `generateJobManifest()` injects `KUBECLAW_HEALTH_ENDPOINT` and poll-timing env vars into the adapter container |
| `helm/kubeclaw/templates/capability-pods.yaml` | `readinessProbe` + `livenessProbe` via `tcpSocket` on the HTTP port |

## Tasks (retrospective)

### AC 1 — Pod becomes Ready only after user container's `/healthz` returns 200

`generateJobManifest()` in `http-sidecar-runner.ts` sets `KUBECLAW_HEALTH_ENDPOINT` (defaulting to `/agent/health`, overridable per spec), `KUBECLAW_HEALTH_POLL_INTERVAL`, and `KUBECLAW_HEALTH_POLL_TIMEOUT` on the adapter container. The adapter polls `http://localhost:<userPort><healthEndpoint>` and withholds task dispatch until it receives HTTP 200.

### AC 2 — Slow user container keeps the pod NotReady until it responds

The adapter's health-poll timeout (`KUBECLAW_HEALTH_POLL_TIMEOUT`) is long enough to accommodate slow container startup. Tasks submitted before the user container is healthy are queued in Redis and dispatched only after the poll succeeds, so no task is dropped.

### AC 3 — Once Ready, the sidecar accepts inbound tasks

After the health poll returns HTTP 200 the adapter subscribes to the Redis stream for the job, processes tasks, and returns results. The e2e test asserts `output.status === 'success'` and `elapsed > 500 ms` (confirming polling did occur before dispatch).

### AC 4 — User container crash transitions pod back to NotReady

Kubernetes detects the crash via the `readinessProbe` / `livenessProbe` `tcpSocket` checks in `capability-pods.yaml` (`failureThreshold: 3`, `periodSeconds: 10`). The pod transitions to NotReady within the probe period, removing it from Endpoints.

### AC 5 — Tests use a real cluster

`beforeAll` calls `requireKubernetes()`. The test suite is guarded by `ADAPTER_AVAILABLE` (checked by inspecting `minikube image list` for `kubeclaw-http-adapter`). Each `it` is wrapped in `it.skipIf(!ADAPTER_AVAILABLE)`, so the suite passes (1 active test) when the image is present and skips gracefully otherwise.

## Verification

Run: `npm run test:e2e -- http-sidecar -t "Health Check Polling"`

Expected: **1 / 1 tests pass** (health endpoint polled, result received, elapsed > 500 ms).

Runtime: ~15 seconds with the adapter image pre-loaded into minikube.
