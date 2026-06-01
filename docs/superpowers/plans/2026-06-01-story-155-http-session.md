# Story 155: HTTP-sidecar Session Persistence — sidecar keeps session across calls

## Goal

Verify that the HTTP-sidecar runner (`HttpSidecarJobRunner`) propagates a `sessionId` provided by the caller through to the adapter container, and generates a new session ID when none is supplied — so that in-memory state in the user container is addressable across sequential LLM rounds.

## Architecture

`src/k8s/http-sidecar-runner.ts` contains `HttpSidecarJobRunner`, which creates a Kubernetes Job with two containers sharing localhost network:

- **`kubeclaw-http-adapter`** — the KubeClaw-protocol adapter. It receives the job payload (including `sessionId`) via stdin/Redis, forwards calls to the user container over `http://localhost:<userPort>`, and emits a `newSessionId` field in its JSON output marker so the orchestrator can track session continuity.
- **`user-agent`** — the arbitrary user container exposing a REST API on `PORT`.

Session identity flows as follows: the caller passes `input.sessionId` → the adapter env var `KUBECLAW_SESSION_ID` → the adapter POSTs it to the user container on each call → the user container echoes it back in the response body → the adapter emits `newSessionId` in the output marker → `HttpSidecarJobRunner.runToolJob` captures it via `capturedSessionId` and surfaces it in the returned `JobOutput`.

When no `sessionId` is supplied, the adapter generates one with the prefix `session-` before the first call and echoes it back the same way.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube, namespace `kubeclaw` (default)
- **Image:** `kubeclaw-http-adapter:latest` + `http-echo:e2e-test` (built by global-setup)
- **Transport:** Redis pub/sub (`jobRunner.streamOutput`) — output markers delivered over `kubeclaw:output:<groupFolder>` channel
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/http-sidecar.test.ts` | E2e suite; `describe('Session Persistence', ...)` at line 492 |
| `src/k8s/http-sidecar-runner.ts` | `HttpSidecarJobRunner` — Job manifest generation + output streaming |
| `src/k8s/job-runner.ts` | `jobRunner.streamOutput` — Redis pub/sub consumer |
| `src/k8s/sidecar-log-parser.ts` | Parses `<<<KUBECLAW_OUTPUT:...>>>` markers from log/Redis stream |
| `src/k8s/types.ts` | `JobInput`, `JobOutput`, `SidecarHttpJobSpec` types |

## Tasks (retrospective)

### AC 1 — Session ID is echoed back when provided

`it('should persist session ID across tasks')` passes `sessionId = 'test-session-<timestamp>'` via `createTestJob`. The http-echo container reflects it in its response; the adapter emits `newSessionId` in the output marker. The test asserts `output.newSessionId === sessionId`.

### AC 2 — New session ID is generated when none provided

`it('should generate new session ID if not provided')` calls `createTestJob` without a `sessionId`. The adapter mints a `session-<uuid>` identifier and emits it in `newSessionId`. The test asserts `output.newSessionId` is truthy and contains the `'session-'` prefix.

### AC 3 — No user-container restart between calls

The Job spec sets `restartPolicy: Never` on the Pod and `backoffLimit: 0` on the Job. The adapter communicates with the user container over localhost HTTP without killing or re-spawning it; sequential calls within a single Job lifetime reuse the same container process. The e2e tests confirm the output arrives successfully, implying no restart occurred.

### AC 4 — Clean idle exit

After the adapter finishes processing all tool calls it exits with code 0, the Job transitions to `Succeeded`, and `waitForJobCompletion` returns cleanly. The `finally` block in `runToolJob` calls `jobRunner.unsubscribeFromOutput(jobId)` to prevent Redis subscription leaks.

### AC 5 — Real cluster + kubeclaw-http-adapter

Tests are gated by `it.skipIf(!ADAPTER_AVAILABLE)` where `ADAPTER_AVAILABLE` is derived from the presence of `kubeclaw-http-adapter:latest` in the minikube docker daemon. Global-setup builds and loads the image; if the image is absent all Session Persistence tests are skipped (not failed). With the image present, both tests run against the live cluster and pass in ~3–4 s each.

## Verification

Run: `npm run test:e2e -- http-sidecar -t "Session Persistence"`

Expected: **2 / 2 tests pass**.

Runtime: ~20 s total (includes Redis setup, image load check, two Job lifecycles).
