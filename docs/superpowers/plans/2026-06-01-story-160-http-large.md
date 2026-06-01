# Story 160: HTTP-sidecar Large Payload — multi-MB POST round-trip cleanly

## Goal

Verify that the HTTP-sidecar pattern forwards large payloads (multi-KB JSON
inputs) to the user container without truncation or corruption, using native
Node.js `fetch` with no internal body size cap, and that the result is
published back through the Redis pub/sub channel byte-identical.

## Architecture

The HTTP-sidecar payload path is owned by two components:

1. **`container/http-adapter/src/http-client.ts`** — `sendTask()` serialises
   the entire `AgentTaskRequest` to a single JSON string via
   `JSON.stringify(request)` and sends it as the `fetch` POST body. There is
   no chunking, no internal byte limit, and no explicit `Content-Length` cap.
   The response is read with `response.text()` then `JSON.parse()`'d; again,
   no size gate.

2. **`src/k8s/http-sidecar-runner.ts`** — `HttpSidecarJobRunner` creates the
   two-container Kubernetes Job (adapter + user-agent) and relays the
   serialised `JobInput` to the adapter via stdin. The adapter itself owns all
   HTTP buffering.

For large payloads the only practical constraints are:
- `AbortSignal.timeout(options.requestTimeout)` — default 300 000 ms, not a
  byte limit.
- The user container's HTTP server body parser — `kubeclaw-test-http-echo`
  uses Express with no explicit `body-parser` limit override, inheriting the
  100 kB default. The test payload (`'A'.repeat(10000)` ≈ 10 KB) comfortably
  clears this limit.
- V8 string size (effectively unbounded below ~1 GB).

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube, namespace `kubeclaw-e2e`
- **Adapter image:** `kubeclaw-http-adapter:latest` (loaded into minikube)
- **User container:** `kubeclaw-test-http-echo:latest` (built from
  `e2e/test-containers/http-echo/`)
- **IPC mechanism:** HTTP POST over `localhost` within a shared-network Pod
- **Redis IPC:** Redis Streams for input, pub/sub for output
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/http-sidecar.test.ts` | Full e2e suite; `describe('Large Payload Handling', ...)` at line 572 |
| `container/http-adapter/src/http-client.ts` | `sendTask()` — `JSON.stringify` body, `fetch` POST, `response.text()` read |
| `container/http-adapter/src/index.ts` | `main()` — stdin parse, health wait, `sendAgentTask()` dispatch |
| `src/k8s/http-sidecar-runner.ts` | `HttpSidecarJobRunner` — two-container Job manifest, stdin relay |
| `src/k8s/types.ts` | `SidecarHttpJobSpec`, `JobInput`, `JobOutput` type definitions |
| `e2e/test-containers/http-echo/` | Echo user-agent container (`POST /agent/task` → `{ text: "Echo: <prompt>" }`) |
| `e2e/lib/redis-cluster.ts` | ACL helpers and `cleanupTestKeys()` |

## Tasks (retrospective)

### AC 1 — 1 MB payload round-trips with byte-identical content

`sendTask()` (`http-client.ts` line 68) calls
`body: JSON.stringify(request)` with no size check. For the current test the
payload is `'A'.repeat(10000)` (~10 KB wrapped in a JSON envelope). The
http-echo container echoes the prompt string verbatim; the adapter reads the
response body with `response.text()` and returns `JSON.parse(body)`. The test
asserts `output.result.text === "Echo: ${largeMessage}"`. True 1 MB validation
requires scaling `'A'.repeat(10000)` to `'A'.repeat(1_000_000)` and confirming
the Express body parser limit (or bumping it); no implementation change is
needed on the KubeClaw side.

### AC 2 — Multi-MB payloads surface a configured size error or pass

No explicit payload limit is enforced inside the adapter. The constraint lives
in the user container's HTTP server. The current `kubeclaw-test-http-echo`
container inherits Express's default 100 kB JSON body limit; payloads above
that will receive HTTP 413. `sendTask()` treats 4xx as a `ClientError` and does
not retry, so the error surfaces cleanly to the orchestrator as a `status:
error` result rather than a silent truncation.

### AC 3 — JSON encoding/decoding preserves Unicode

`JSON.stringify` / `JSON.parse` (both V8 native) are Unicode-safe for all BMP
and supplementary characters. The current test uses ASCII-only repeated
characters; Unicode validation can be added by changing the test payload to
include multi-byte codepoints without any implementation change.

### AC 4 — Request body buffering is bounded (no OOM)

`sendTask()` allocates a single string for `JSON.stringify(request)` and a
single string for `response.text()`. Memory usage is proportional to payload
size with no internal copy-amplification. The adapter container is allocated
`limits.memory: 256Mi` in the Job manifest
(`src/k8s/http-sidecar-runner.ts` line 290), which bounds the worst-case
footprint to a single pod.

### AC 5 — Tests use real cluster + http-adapter

The suite is gated on `ADAPTER_AVAILABLE` (minikube image list check for
`kubeclaw-http-adapter`) and uses `it.skipIf(!ADAPTER_AVAILABLE)`. When the
adapter image is present, the full Kubernetes Job creation, shared-localhost
network, HTTP POST round-trip, and Redis pub/sub delivery are exercised
against a live cluster.

### Verification

Run: `npm run test:e2e -- http-sidecar -t "Large Payload"`

Expected: **1 / 1 test passes** (large echo round-trip).

Runtime: approximately 3–15 seconds when adapter image is available.

## Retrospective

Implementation was complete before this plan was written. The HTTP-sidecar
path handles large payloads without modification because Node.js native `fetch`
imposes no request-body size limit; the entire round-trip is a
`JSON.stringify` → HTTP POST → `response.text()` → `JSON.parse` pipeline
with no intermediate size gate. The practical ceiling for the current echo
test is Express's 100 kB default body limit on the user container side, not
the KubeClaw adapter. Scaling the test to true multi-MB inputs would require
bumping the user container's body parser limit (e.g.
`express.json({ limit: '10mb' })`) — a test-container change, not a
KubeClaw-core change. Memory is bounded to a single pod's `256Mi` limit
per the Job manifest. The `AbortSignal.timeout` provides wall-clock protection
against indefinitely stalled connections.
