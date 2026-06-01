# Story 110: Alpine sidecar tool pod executes a shell command via file-bridge

## Goal / Architecture

When an agent publishes a tool call to `kubeclaw:toolcalls:{agentJobId}:alpine-shell`, the
orchestrator's spawn-tool-pod watcher (in `src/k8s/tool-pod-spawn.ts`) creates a Kubernetes Job
with two containers: `alpine:latest` (the user container) and `kubeclaw-file-adapter` (the
file-bridge sidecar) sharing an `emptyDir` at `/shared`. The file-bridge (running in
`container/agent-runner/src/tool-server.ts` in `file-bridge` mode) reads the tool call from the
Redis stream, writes `/shared/<id>.request.json`, then polls for `/shared/<id>.response.json`
which alpine writes after executing the shell command, and finally publishes the result to
`kubeclaw:toolresults:{agentJobId}:alpine-shell`.

## Tech Stack

- TypeScript / Node.js
- ioredis (Redis Streams — `xadd` / `xread` / `xrange`)
- Kubernetes Jobs with multi-container pods and `emptyDir` shared volume
- Alpine Linux (shell polling loop via `sh -c`)
- Vitest (e2e)

## File Structure

| File | Role |
|------|------|
| `src/k8s/tool-pod-spawn.ts` | Spawn-tool-pod watcher; builds Job manifest with `toolImage`, `toolPattern`, `toolCommand`; mounts shared emptyDir |
| `container/agent-runner/src/tool-server.ts` | File-bridge mode: reads toolcalls stream, writes `request.json`, polls `response.json`, publishes to toolresults stream |
| `e2e/alpine-tool-execution.test.ts` | E2E test (1 it()) — publishes to spawn stream + toolcalls stream, polls toolresults stream |

## Tasks per Acceptance Criteria

### AC1 — agent publishes tool call to `kubeclaw:toolcalls:{agentJobId}:alpine-shell`
- E2E test does `redis.xadd(toolCallsStream, '*', 'requestId', requestId, 'tool', 'bash', 'input', JSON.stringify({command: 'echo hello | grep h'}))`.
- The stream key is `kubeclaw:toolcalls:${agentJobId}:alpine-shell`.

### AC2 — orchestrator spawns sidecar Job: alpine + kubeclaw-file-adapter
- E2E publishes to `kubeclaw:spawn-tool-pod` with `toolImage=alpine:latest`, `toolPattern=file`, `toolCommand=JSON.stringify(ALPINE_POLL_SCRIPT)`.
- `tool-pod-spawn.ts` reads this stream entry and creates a multi-container Job with the `kubeclaw-file-adapter` sidecar and `emptyDir` shared volume.

### AC3 — file-bridge writes request; alpine polls, runs, writes response
- The `kubeclaw-file-adapter` container runs `tool-server.ts` in `file-bridge` mode.
- It writes `/shared/<requestId>.request.json` with `{command: "echo hello | grep h"}`.
- Alpine's `ALPINE_POLL_SCRIPT` loops over `*.request.json`, extracts `command` via `sed`, runs it, writes `{"result":"..."}` to the corresponding `.response.json`.

### AC4 — file-bridge publishes result to toolresults stream
- After detecting the `.response.json`, the file-bridge reads it and does `redis.xadd(TOOLRESULTS_STREAM, '*', 'requestId', requestId, 'result', result)`.
- The stream key is `kubeclaw:toolresults:${agentJobId}:alpine-shell`.

### AC5 — real cluster round-trip completes
- E2E `pollToolResult()` polls the toolresults stream via `xrange` every 2 s with a 120 s deadline.
- Test confirmed round-trip completes with `result` containing `"hello"` in ~5 s on minikube.

## Retrospective

Implementation was complete before this plan was written. The e2e test passed 1/1 against the
live minikube cluster (~5 s end-to-end, result="hello"). No implementation changes were needed.
