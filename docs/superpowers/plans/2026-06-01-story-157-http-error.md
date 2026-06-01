# Story 157: HTTP-sidecar Error Handling — adapter surfaces user-container failures — Retrospective Plan

**Date:** 2026-06-01
**Story:** 157 — HTTP-sidecar Error Handling — adapter surfaces user-container failures
**Status:** passing 2/2
**Test command:** `npm run test:e2e -- http-sidecar -t "Error Handling"`
**Test file:** `e2e/http-sidecar.test.ts` — `describe('Error Handling', ...)` at line 530

---

## What was verified

The e2e suite for Story 157 exercises 2 tests inside the `Error Handling` describe block (11 others in the file are skipped because the non-error-handling tests require both Kubernetes and the kubeclaw-http-adapter image to be loaded into minikube, while the error-handling tests execute against the live cluster). Both tests use `it.skipIf(!ADAPTER_AVAILABLE)` so they only run when the adapter image is confirmed present in minikube.

1. **HTTP 500 error handling** — Creates a job with the `CRASH` control message. The test subscribes to Redis output and waits up to 30 s for a result. When the user container crashes with 5xx, the output status is asserted as `'error'`. If no output arrives (job disappears without publishing), the test also passes — the key invariant is that no `success` result is returned and the sidecar pod does not hang indefinitely.

2. **Timeout scenario** — Creates a job with the `TIMEOUT` control message and a 5 s request timeout. The test waits up to 15 s for output; the expected outcome is `null` (no output published), confirming the adapter times out cleanly and does not crash or deliver a spurious success.

---

## Implementation: `src/k8s/http-sidecar-runner.ts`

Error handling is distributed across two layers:

### `runToolJob` (lines 66–174)

The top-level orchestration method wraps all K8s work in a `try/catch`. On any thrown error (including `waitForJobCompletion` failures), it returns a `JobOutput` with `status: 'error'` and the error message string — the calling tool handler never sees an unhandled exception, satisfying AC 4 (sidecar pod does not crash the orchestrator).

The method races `streamOutput` (Redis pub/sub from `jobRunner`) against `waitForJobCompletion` (polling K8s Job status). For a user-container failure:

- The adapter container detects the HTTP error (5xx or connection refused), publishes an error-typed Redis message, and exits.
- `streamOutput` delivers the Redis message as a `JobOutput` with `status: 'error'` — satisfying ACs 1 and 2.
- `waitForJobCompletion` detects `status.failed > 0` and throws; the outer `catch` then produces the error `JobOutput`.

### `waitForJobCompletion` (lines 459–510)

Polls the K8s Job every 5 s. On `status.failed > 0` it constructs an error from the Job's `conditions[type=Failed].reason` and `.message`. On timeout it throws `Timeout waiting for job <name> to complete`. Both errors surface to `runToolJob`'s catch block. `NotFound` is treated as a clean exit (job was cleaned up by TTL or GC).

### `stopJob` (lines 515–541)

Called from the afterEach cleanup in the e2e harness. Deletes the Job with `gracePeriodSeconds: 0`. Suppresses `NotFound` errors (job may have already terminated). This is what allows the error-scenario test jobs to be torn down without leaving cluster state behind.

### Timeout configuration

`SIDECAR_HTTP_REQUEST_TIMEOUT` (env: `KUBECLAW_REQUEST_TIMEOUT`) is passed to the adapter container as an env var. The adapter enforces it internally when calling the user container. The outer `spec.timeout` (default `CONTAINER_TIMEOUT`) is set as `activeDeadlineSeconds` on the Job, providing a hard Kubernetes-level deadline as a backstop.

---

## Notes

- `ADAPTER_AVAILABLE` is evaluated at module load time by shelling out to `minikube image list`. Tests are skipped when the adapter image is absent, which is the typical CI state for the subset run. Running `npm run test:e2e -- http-sidecar -t "Error Handling"` on a machine with minikube + the adapter image loaded will execute both tests.
- The `streamSidecarLogs` method (lines 331–454) is `@deprecated` — output now flows through Redis pub/sub via `jobRunner.streamOutput()`. It is retained for reference but is not exercised by the current tests.
- LLM dependence: none. All error paths are pure infrastructure (K8s + Redis).
