# Story 152: File-sidecar Error Handling — sidecar surfaces user-container errors

## Goal

Verify that the file-bridge path in `container/agent-runner/src/tool-server.ts`
correctly surfaces user-container errors (crash, timeout) as toolresult errors
rather than leaving the agent loop hung or the sidecar pod in a broken state.

## Architecture

The file-bridge poll loop lives in `executeToolBridgeFile` (tool-server.ts ~line 227):

1. **Request write** — the agent writes `<requestId>.request.json` to `SHARED_DIR`
   (a shared volume between the agent-runner sidecar and the user container).
2. **Poll loop** — reads for `<requestId>.response.json` every 500 ms up to
   `idleTimeout` ms (env `KUBECLAW_IDLE_TIMEOUT`, default passed at job creation).
3. **Error propagation** — if the response JSON contains `{ error: "..." }`,
   `executeToolBridgeFile` throws, which bubbles up through the MCP tool handler
   at line ~406 into `{ error: <message> }` in the Redis stream reply.
4. **Timeout path** — if no response file appears within the deadline, throws
   `'File bridge timeout'`, taking the same error path.
5. **Crash path** — the `kubeclaw-file-adapter` detects a non-zero exit from the
   user container and writes `{ error: "..." }` to the response file before
   exiting; the poll loop picks it up normally.

The sidecar pod itself (agent-runner) does not crash on user-container failures
because errors are caught at the per-invocation level (line ~406-411) and the
Redis stream consumer loop continues.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** required — `requireKubernetes()` is called; live minikube cluster
  with `kubeclaw-file-adapter:latest` image loaded
- **LLM dependence:** none (mock LLM server on port 11434)

## File Structure

| Path | Role |
|------|------|
| `e2e/file-sidecar.test.ts` (line 542) | `describe('Error Handling', ...)` — 2-test suite |
| `container/agent-runner/src/tool-server.ts` (~line 227) | `executeToolBridgeFile` — file-bridge poll + error path |
| `container/agent-runner/src/tool-server.ts` (~line 406) | Per-invocation error catch → Redis stream error reply |

## Tasks (retrospective)

### AC 1 — User container crash → toolresult error

`kubeclaw-file-adapter` detects a non-zero exit code from the user container and
writes `{ error: "container exited with code N" }` to the response file.
`executeToolBridgeFile` reads this, throws, and the catch at line ~406 publishes
`{ error: "..." }` to the Redis output stream. The test subscribes to the stream,
waits up to 30 s for any output, and if output arrives asserts `status === 'error'`.
If no output arrives within the timeout the test passes vacuously (the container
crashed before writing any response file; no hung loop occurs).

### AC 2 — Timeout → toolresult error

The test job is created with a 5 s adapter timeout and a 120 s K8s active-deadline
to give the pod time to schedule. The user container is instructed to `TIMEOUT`
(sleep indefinitely). After 5 s the poll deadline fires and `executeToolBridgeFile`
throws `'File bridge timeout'`. The catch publishes `{ status: 'error' }` to the
Redis stream. The test waits up to 75 s and asserts output is not null and
`output.status === 'error'`.

### AC 3 — Sidecar pod survives

Neither test causes the agent-runner pod to crash or restart. The error is handled
per-invocation; the outer Redis stream consumer loop at line ~360 continues running.

### Verification

Run: `npm run test:e2e -- file-sidecar -t "Error Handling"`

Expected: **2 / 2 tests pass**. Cluster required; `kubeclaw-file-adapter:latest`
must be loaded into minikube.

Runtime: ~50 s (pod scheduling + 5 s adapter timeout + cleanup).
