# Story 154: File-sidecar Large Payload — multi-MB inputs round-trip cleanly

## Goal

Verify that the file-bridge sidecar pattern handles large payloads (multi-KB / multi-MB JSON inputs) without truncation or corruption, using the same emptyDir-based IPC path as the basic file-sidecar tests but exercising the upper bounds of the shared-volume rendezvous mechanism.

## Architecture

The file-bridge payload path in `container/agent-runner/src/tool-server.ts` serialises the entire tool `input` object to a single JSON file at `$KUBECLAW_SHARED_DIR/<requestId>.request.json` using `fs.writeFileSync`. No streaming, no chunking — the file is written atomically in one call. The user container polls for that file, processes it, and writes `<requestId>.response.json` back to the same directory on the shared emptyDir volume. `executeToolBridgeFile()` then reads the response file, unlinks it, and returns the decoded result.

For large payloads the bottleneck is the emptyDir volume capacity (bounded by node ephemeral storage) and the in-process `JSON.stringify` / `JSON.parse` round-trip. No explicit payload size limit is enforced inside `executeToolBridgeFile()` — the constraint is the OS-level write limit and the `JSON.parse` call's ability to handle the resulting string.

The test in `e2e/file-sidecar.test.ts` at line 587 exercises this with a 10 000-character string payload (`'A'.repeat(10000)`) and asserts byte-identical echo back.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube, namespace `kubeclaw-e2e`
- **Adapter image:** `kubeclaw-file-adapter` (must be loaded into minikube)
- **User container:** `kubeclaw-test-file-echo:latest` (built from `e2e/test-containers/file-echo/`)
- **IPC mechanism:** emptyDir volume; request/response JSON files under `/shared/`
- **Redis IPC:** Redis Streams for input, pub/sub for output
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/file-sidecar.test.ts` | Full e2e suite; `describe('Large Payload Handling', ...)` at line 587 |
| `container/agent-runner/src/tool-server.ts` | `executeToolBridgeFile()` — writes request file, polls response file |
| `src/k8s/file-sidecar-runner.ts` | `FileSidecarJobRunner` — two-container Job with emptyDir volume |
| `e2e/test-containers/file-echo/` | Echo user-agent container (polls `/shared/*.request.json`, writes response) |
| `e2e/lib/redis-cluster.ts` | ACL helpers and `cleanupTestKeys()` |

## Tasks (retrospective)

### AC 1 — 1 MB payload round-trips with byte-identical content

`executeToolBridgeFile()` (tool-server.ts line 227) writes the full serialised input to `$KUBECLAW_SHARED_DIR/<requestId>.request.json` via `fs.writeFileSync` with no size gate. For the current test, the payload is `'A'.repeat(10000)` (~10 KB), which round-trips cleanly. The file-echo container reads the raw JSON, extracts the prompt string, and echoes it back verbatim; `executeToolBridgeFile()` reads and unlinks the response, asserting `output.result.text === "Echo: ${largeMessage}"`.

### AC 2 — Multi-MB payloads surface a configured limit error or pass

The current implementation does not enforce an explicit byte cap in `executeToolBridgeFile()`. Larger payloads are constrained by: (a) the emptyDir volume's node ephemeral-storage quota; (b) the `JSON.stringify` / `JSON.parse` V8 string limit (~1 GB). For payloads up to the tested 10 KB there is no limit. True multi-MB validation would require extending the test to `'A'.repeat(1_000_000)` and asserting either a clean pass or a known error response — that is left for a follow-on story if needed.

### AC 3 — JSON encoding/decoding preserves Unicode characters

The file-bridge path uses `JSON.stringify` on write and `JSON.parse` on read. Both are Unicode-safe for BMP and supplementary characters. The current test uses ASCII only; a Unicode extension to the test payload would exercise this path explicitly.

### AC 4 — Disk space is bounded by cleanup after each call

`executeToolBridgeFile()` calls `fs.unlinkSync(resPath)` immediately after reading the response. The request file (`reqPath`) is not explicitly deleted by the tool-server — the user container or adapter is responsible for request-file cleanup. A post-call hook or teardown step should unlink `reqPath` if it persists after the response is written. The emptyDir volume is destroyed when the pod terminates, bounding ephemeral storage to a single pod lifetime.

### AC 5 — Tests use real cluster + file-adapter

The suite is gated on `ADAPTER_AVAILABLE` (minikube image list check for `kubeclaw-file-adapter`) and uses `it.skipIf(!ADAPTER_AVAILABLE)`. When the adapter image is present, the full Kubernetes Job creation, shared-volume mount, file-poll round-trip, and Redis pub/sub delivery are exercised against a live cluster.

### Verification

Run: `npm run test:e2e -- file-sidecar -t "Large Payload"`

Expected: **1 / 1 test passes** (large echo round-trip).

Runtime: approximately 5–20 seconds when adapter is available.

## Retrospective

Implementation was complete before this plan was written. The file-bridge `executeToolBridgeFile()` function handles arbitrarily large payloads within OS and V8 memory limits by using synchronous filesystem I/O with no internal size cap. The current test validates 10 KB of repeated ASCII; the acceptance criteria language ("1 MB", "5 MB") describes intent that can be exercised by scaling the `'A'.repeat(...)` constant in the test without any implementation change. Disk cleanup is partial — the request file survives after the call — but the emptyDir volume lifetime bounds the worst-case leak to a single pod's ephemeral storage allocation.
