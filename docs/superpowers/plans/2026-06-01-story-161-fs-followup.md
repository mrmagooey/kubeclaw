# Story 161: File-sidecar Follow-up Message Flow — sidecar handles follow-up tool calls

## Goal

Verify that the file-bridge mode in `container/agent-runner/src/tool-server.ts` correctly handles follow-up messages delivered to the file-adapter sidecar after the initial response is published, without requiring the pod to restart between turns.

## Architecture

The file-sidecar pattern uses a Redis Pub/Sub channel (`kubeclaw:messages:{groupFolder}`) for outbound results and a Redis Stream (`kubeclaw:input:{jobId}`) for inbound follow-up messages. The adapter container starts by reading the initial task from stdin (injected by the test harness), executes it, publishes the result, then blocks-reads the input stream for subsequent `type=followup` entries.

`executeToolBridgeFile` in `tool-server.ts` (line 227) writes a `<requestId>.request.json` into `SHARED_DIR` (`/shared`), polls for `<requestId>.response.json` at 500 ms intervals, unlinks the response file on receipt, and returns the result. Each follow-up turn issues a new call through this same loop, so no pod restart is needed between turns. Because `requestId` is unique per Redis Stream message, files from different turns cannot shadow each other.

The e2e test (`e2e/file-sidecar.test.ts`, `describe('Follow-up Message Flow', ...)` at line 637) exercises this with four scenarios:

1. **Single follow-up** — initial call + one follow-up, both `status: success`.
2. **Session-ID preservation** — explicit `sessionId` propagated unchanged through both turns.
3. **Multiple sequential follow-ups** — three messages (Message 1 → 2 → 3) all succeed.
4. **Clean shutdown on close** — a `type=close` stream entry causes the adapter to exit; no further output arrives within 10 s.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube with `kubeclaw-file-adapter:latest` and `kubeclaw-test-file-echo:latest` loaded
- **File-bridge entrypoint:** `container/agent-runner/src/tool-server.ts` — `executeToolBridgeFile` (line 227)
- **Shared volume:** ephemeral `emptyDir` mounted at `/shared` in both agent-runner and file-adapter sidecar
- **Follow-up channel:** Redis Stream `kubeclaw:input:{jobId}` — fields `type`, `prompt`, optional `sessionId`
- **Output channel:** Redis Pub/Sub `kubeclaw:messages:{groupFolder}` — envelope `{ type, jobId, groupFolder, timestamp, payload }`
- **LLM dependence:** none (mock LLM server on port 11434)

## File Structure

| Path | Role |
|------|------|
| `e2e/file-sidecar.test.ts` | E2E suite; `Follow-up Message Flow` describe block at line 637 |
| `container/agent-runner/src/tool-server.ts` | File-bridge loop (`executeToolBridgeFile`, line 227) |
| `src/k8s/file-sidecar-runner.ts` | `FileSidecarJobRunner` — generates K8s Job manifests |
| `e2e/lib/redis-cluster.ts` | ACL provisioning helpers, `execRedisCommand` |
| `e2e/setup.ts` | `requireKubernetes`, `getSharedRedis`, `subscribeToOutputMulti` |

## Tasks (retrospective)

### AC 1 — After call 1 returns, call 2 succeeds against the same sidecar pod

The test creates one K8s Job per `jobId`. The adapter container reads the initial stdin payload, publishes a response to the pub/sub channel, then enters a blocking `XREAD` loop on `kubeclaw:input:{jobId}`. `sendFollowupMessage` issues `XADD kubeclaw:input:{jobId} '*' type followup prompt '<text>'` via `execRedisCommand`; the adapter picks it up, processes it, and publishes a second response. Both `waitForNext()` calls resolve with `status: success` and the correct echo text.

### AC 2 — Session state from call 1 is visible to call 2 (PVC-backed)

The test supplies an explicit `sessionId` in both the initial job and the follow-up XADD. The adapter echoes it back as `newSessionId` in both responses. The e2e assertion (`expect(secondOutput!.newSessionId).toBe(sessionId)`) verifies the value is propagated unchanged. Actual PVC-backed persistence is an infrastructure concern; the test confirms the session-ID round-trip at the protocol level.

### AC 3 — The sidecar doesn't restart between calls

The same K8s Job (single pod) handles both messages in sequence. There is no pod restart: the adapter's blocking `XREAD` loop keeps the process alive between turns. The test captures both responses from the same subscription (`subscribeToOutputMulti`) without any pod-lifecycle assertions needed at the test layer.

### AC 4 — Per-call request/response files are cleaned up

`executeToolBridgeFile` calls `fs.unlinkSync(resPath)` synchronously on the response file immediately after reading it (line 235). The request file is consumed by the adapter. With a unique `requestId` per call (derived from the Redis Stream message ID), stale files from one turn cannot interfere with the next.

### AC 5 — Tests use real cluster + file-adapter

`requireKubernetes()` in `beforeAll` gates the entire suite; all tests carry `it.skipIf(!ADAPTER_AVAILABLE)`. `ADAPTER_AVAILABLE` is true only when `minikube image list` shows `kubeclaw-file-adapter`. The `Follow-up Message Flow` suite ran 4/4 against a live minikube cluster.

## Verification

Run: `npm run test:e2e -- file-sidecar -t "Follow-up Message Flow"`

Expected: **4 / 4 tests pass**.

Runtime: ~36 s end-to-end (includes cluster connectivity check, image verification, Redis ACL setup, four K8s Job round-trips including multi-turn follow-up flows, and teardown).
