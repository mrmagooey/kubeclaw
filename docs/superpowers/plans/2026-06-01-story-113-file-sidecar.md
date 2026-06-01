# Story 113: File-sidecar processes a Simple Echo task end-to-end

## Goal

Verify that the file-bridge sidecar pattern — where the `kubeclaw-file-adapter` container exchanges task payloads with the user container via shared JSON files on an emptyDir volume — works end-to-end against a real Kubernetes cluster, with the result published back through the toolresults Redis stream.

## Architecture

The file-bridge path is implemented in two layers. `executeToolBridgeFile()` in `container/agent-runner/src/tool-server.ts` writes `<id>.request.json` to `$KUBECLAW_SHARED_DIR` (default `/shared`) and polls for `<id>.response.json`; the user container processes the file and writes the response. On the cluster side, `FileSidecarJobRunner` in `src/k8s/file-sidecar-runner.ts` creates a two-container Kubernetes Job — `kubeclaw-file-adapter` and the user agent image — sharing an emptyDir volume, with the adapter receiving the serialised `JobInput` via stdin from the orchestrator, then relaying results back to Redis pub/sub on `kubeclaw:messages:{groupFolder}`.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube, namespace `kubeclaw-e2e`
- **Adapter image:** `kubeclaw-file-adapter` (must be loaded into minikube; checked via `minikube image list`)
- **User container:** `kubeclaw-test-file-echo:latest` (built from `e2e/test-containers/file-echo/`)
- **IPC mechanism:** emptyDir volume; request/response JSON files under `/shared/`
- **Redis IPC:** Redis Streams for input, pub/sub for output
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/file-sidecar.test.ts` | Full e2e suite; `describe('Simple Echo Task Processing', ...)` at line 465 |
| `container/agent-runner/src/tool-server.ts` | `executeToolBridgeFile()` — writes request file, polls response file |
| `src/k8s/file-sidecar-runner.ts` | `FileSidecarJobRunner` — generates two-container Job manifests with emptyDir |
| `src/k8s/types.ts` | `SidecarFileJobSpec`, `JobInput`, `JobOutput` type definitions |
| `e2e/test-containers/file-echo/` | Echo user-agent container (polls `/shared/*.request.json`, writes response) |
| `e2e/lib/redis-cluster.ts` | ACL helpers and `cleanupTestKeys()` |

## Tasks (retrospective)

### AC 1 — File-sidecar accepts POST and writes `/shared/<id>.request.json`

`executeToolBridgeFile()` (tool-server.ts line 227) constructs `reqPath = path.join(SHARED_DIR, \`${requestId}.request.json\`)` and writes `JSON.stringify({ requestId, tool, input })` atomically via `fs.writeFileSync`. The adapter container running under `KUBECLAW_TOOL_MODE=file-bridge` invokes this path when the orchestrator POSTs a tool call.

### AC 2 — User container polls, processes, writes `/shared/<id>.response.json`

The `kubeclaw-test-file-echo` container polls `/shared` for `*.request.json` files, reads the payload, echoes the prompt as `{ result: { text: "Echo: <prompt>" } }`, and writes `/shared/<id>.response.json`. `executeToolBridgeFile()` polls on a 500 ms interval up to `idleTimeout`, reads the response, unlinks it, and returns the result.

### AC 3 — Sidecar publishes response to toolresults Redis stream

`FileSidecarJobRunner.runToolJob()` calls `jobRunner.streamOutput()` which subscribes to `kubeclaw:messages:{groupFolder}`. The adapter publishes the final `JobOutput` (including `status`, `result`, and `newSessionId`) to this pub/sub channel after processing completes. The test subscribes via `subscribeToOutput(jobId)` before job creation to avoid missing the message.

### AC 4 — Simple Echo describe isolates per-test state via `beforeEach`

A `beforeEach` at line 123 calls `cleanupTestKeys('kubeclaw:*:file-echo-test-*')` before each test, clearing leftover Redis stream and pub/sub state. Each test also generates a unique `jobId` with `Date.now()` and a test-specific suffix (`-simple`, `-multiword`, etc.) to prevent cross-test interference.

### AC 5 — End-to-end against a real cluster

The suite is gated on `ADAPTER_AVAILABLE` (checks minikube image list for `kubeclaw-file-adapter`) and `K8S_AVAILABLE` (live cluster reachable). All tests use `it.skipIf(!ADAPTER_AVAILABLE)` so they are recorded as skipped rather than failed when the adapter is unavailable. `beforeAll` at line 79 calls `requireKubernetes()`, which throws if the cluster is unreachable.

### Verification

Run: `npm run test:e2e -- file-sidecar -t "Simple Echo Task Processing"`

Expected: **2 / 2 tests pass** (simple echo + multi-word echo).

Runtime: 5–15 minutes (includes Job scheduling, emptyDir mount, file-poll round-trip, and Redis pub/sub delivery).

## Retrospective

Implementation was complete before this plan was written. The file-bridge IPC pattern mirrors the HTTP sidecar pattern but replaces HTTP with filesystem rendezvous: the adapter writes a request file and polls for the response file, decoupling the user container from any network listener requirement. The `ADAPTER_AVAILABLE` gate ensures CI does not report false failures when the adapter image has not been loaded into minikube.
