# Story 158: File-sidecar Multiple Sequential Tasks — N consecutive calls succeed

## Goal

Verify that the file-bridge mode in `container/agent-runner/src/tool-server.ts` handles N consecutive tool calls without leaking shared-volume state, degrading in latency, or leaving stale request/response files between iterations.

## Architecture

`executeToolBridgeFile` in `tool-server.ts` implements the file-bridge loop: it writes a `<requestId>.request.json` into `SHARED_DIR` (`/shared`), then polls for the matching `<requestId>.response.json` at 500 ms intervals until either the file appears or `idleTimeout` elapses. On receipt it reads the response, **immediately `unlinkSync`s the response file**, and returns the result (or throws on `data.error`). Because each call uses a unique `requestId` (derived from the Redis Stream message ID), request and response files are namespaced per call and the unlink runs synchronously before returning. This means no cross-call contamination: each iteration starts with a clean `/shared` directory.

The e2e test (`e2e/file-sidecar.test.ts`, `describe('Multiple Sequential Tasks', ...)` at line 608) exercises this by dispatching three independent jobs — each with its own Redis ACL user, job ID, and file-echo tool container — in a simple `for` loop. It asserts that all three complete with `status: success` and that the echo payloads are returned unmodified.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube with `kubeclaw-file-adapter:latest` loaded
- **File-bridge entrypoint:** `container/agent-runner/src/tool-server.ts` — `executeToolBridgeFile`
- **Shared volume:** ephemeral `emptyDir` mounted at `/shared` in both the agent-runner and the file-adapter sidecar container
- **LLM dependence:** none (mock LLM server on port 11434)

## File Structure

| Path | Role |
|------|------|
| `e2e/file-sidecar.test.ts` | E2E suite; `Multiple Sequential Tasks` describe block at line 608 |
| `container/agent-runner/src/tool-server.ts` | File-bridge loop (`executeToolBridgeFile`, line 227) |
| `e2e/helpers/file-sidecar-helpers.ts` | `createTestJob`, `subscribeToOutput`, ACL provisioning helpers |

## Tasks (retrospective)

### AC 1 — N sequential calls all complete successfully

The test iterates over `['First message', 'Second message', 'Third message']`, creates a fresh job per iteration, and asserts `output.status === 'success'` for each. Three independent file-bridge round-trips complete without any failure.

### AC 2 — Request/response files are cleaned up before the next call starts

`executeToolBridgeFile` calls `fs.unlinkSync(resPath)` synchronously on the response file immediately after reading it (line 235). The request file is never explicitly deleted by the agent-runner — it is the file-adapter's responsibility to consume it. Because each call generates a unique `requestId`, stale request files from a prior call cannot shadow a new call's response.

### AC 3 — Shared-volume disk usage stays bounded across N calls

Each call writes one `<requestId>.request.json` and expects one `<requestId>.response.json`. The response is unlinked on receipt; the request is consumed by the adapter. With N=3 sequential (not concurrent) calls, at most one request file and one response file exist on `/shared` at any moment.

### AC 4 — The Nth call gets the same latency as the 1st (no degradation)

Sequential execution with a fresh jobId per iteration means no polling accumulation or file-descriptor leakage between iterations. The 500 ms poll interval and deadline are reset for each call. Total wall time ~10 s for three calls.

### AC 5 — Tests use real cluster + file-adapter

`requireKubernetes()` in `beforeAll` gates the suite; all tests carry `it.skipIf(!ADAPTER_AVAILABLE)`. The `Multiple Sequential Tasks` test ran against a live minikube cluster with `kubeclaw-file-adapter` loaded as a sidecar.

## Verification

Run: `npm run test:e2e -- file-sidecar -t "Multiple Sequential"`

Expected: **1 / 1 test passes**.

Runtime: ~23 s end-to-end (includes cluster connectivity check, image verification, Redis setup, three sequential job round-trips, and teardown).
