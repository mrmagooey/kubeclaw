# Story 116: Tool-execution category — full call/response round-trip via tool pod

## Goal

Verify the full Redis-stream round-trip for a `category=execution` tool pod: orchestrator reads `kubeclaw:spawn-tool-pod`, creates a K8s Job whose container runs `tool-server.ts`, which reads tool calls from `kubeclaw:toolcalls:{agentJobId}:execution` (using `lastId='0-0'` to pick up pre-published calls) and writes results to `kubeclaw:toolresults:{agentJobId}:execution`.

## Architecture

The orchestrator's `watchSpawnToolPodStream()` in `src/k8s/ipc-redis.ts` (line ~818) listens on the `kubeclaw:spawn-tool-pod` Redis stream and creates a K8s Job for each spawn request. The Job container runs `container/agent-runner/src/tool-server.ts` as its entrypoint (started via `KUBECLAW_TOOL_JOB_ID` and `KUBECLAW_CATEGORY` env vars), which performs a blocking `XREAD` with `lastId='0-0'` on the tool-calls stream so calls published before pod startup are not lost; after executing `bash` or `read` tool handlers, it writes a result entry (keyed by `requestId`) to the tool-results stream.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e -- tool-execution`)
- **Cluster:** real minikube, shared namespace (`kubeclaw-e2e`)
- **Redis:** shared in-cluster Redis; test publishes to streams directly via `ioredis`
- **Image:** `kubeclaw-agent:latest` loaded by global-setup (tool-server entrypoint baked in)
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/tool-execution.test.ts` | 2-test e2e suite (bash + read round-trips) |
| `src/k8s/ipc-redis.ts` | `watchSpawnToolPodStream()` — reads `kubeclaw:spawn-tool-pod`, creates K8s Jobs |
| `container/agent-runner/src/tool-server.ts` | Tool pod entrypoint — XREAD loop, `toolBash` / `toolRead` handlers, writes to toolresults |
| `src/k8s/redis-client.ts` | `getSpawnToolPodStream()` — returns `kubeclaw:spawn-tool-pod` stream key |

## Tasks (retrospective)

### AC 1 — Orchestrator spawns execution-category tool pod

`watchSpawnToolPodStream()` performs `XREAD BLOCK` on `kubeclaw:spawn-tool-pod`. When the test publishes a message with `category=execution`, the orchestrator creates a K8s Job (via the existing `createToolPodJob()` helper) whose Pod runs the tool-server binary. `beforeAll` waits up to 90 s for the orchestrator deployment to reach Ready before any test runs.

### AC 2 — Agent publishes tool call to the toolcalls stream

The test uses `redis.xadd(toolCallsStream, '*', 'requestId', ..., 'tool', 'bash'/'read', 'input', ...)` before sending the spawn message, ensuring the call is queued before the pod starts. `lastId='0-0'` in the tool-server guarantees no message is skipped even when the pod starts after the call was published.

### AC 3 — Tool pod reads from lastId='0-0'

`tool-server.ts` issues `XREAD COUNT 1 BLOCK <idleTimeout> STREAMS <toolCallsStream> 0-0` on first read. By deleting the `spawn-tool-pod` stream and waiting one BLOCK cycle (6 s) before publishing, the test avoids the `lastId='$'` race where the server might start listening from the current tail.

### AC 4 — Response appears on toolresults stream

After `toolBash` or `toolRead` executes, `tool-server.ts` calls `redis.xadd(TOOLRESULTS_STREAM, '*', 'requestId', ..., 'result', ...)`. The test polls via `pollToolResult()` — scanning `XRANGE` every 2 s until it finds an entry matching the `requestId`, with a 90 s deadline.

### AC 5 — Result matches expected output

- **bash test:** asserts `result.toContain('hello-from-e2e')` (from `echo hello-from-e2e`); also accepts a tool error — in both cases `entries.length > 0` confirms the round-trip.
- **read test:** asserts `result.length > 0` (contents of `/etc/hostname`); also accepts a tool error — `entries.length > 0` confirms the round-trip.

### Verification

Run: `npm run test:e2e -- tool-execution`

Expected: **2 / 2 tests pass** (bash round-trip + read round-trip).

Runtime: 4–8 minutes per test (includes pod scheduling, image pull if needed, and execution).
