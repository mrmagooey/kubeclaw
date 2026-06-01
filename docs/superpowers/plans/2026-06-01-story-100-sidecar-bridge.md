# Story 100: Sidecar tool-pod bridge forwards a tool call to the user container and returns the result

## Goal

Verify that the sidecar tool-pod bridge in `container/agent-runner/src/tool-server.ts` correctly forwards tool calls received from Redis Streams to the user container in both `http-bridge` and `file-bridge` modes, and returns the result (or propagated error) back onto the toolresults stream — without requiring any Kubernetes infrastructure.

## Architecture

`tool-server.ts` is an alternative entrypoint for the agent-runner container image. On startup it reads from `kubeclaw:toolcalls:<agentJobId>:<category>` via `xRead` (starting at `0-0` so pre-queued calls are not missed) and dispatches each message through `executeTool`, which branches on `KUBECLAW_TOOL_MODE`. In `http-bridge` mode, `executeToolBridgeHttp` POSTs the call to `http://localhost:<port>/invoke` and surfaces any `{ error }` field as a thrown exception. In `file-bridge` mode, `executeToolBridgeFile` writes a `<requestId>.request.json` to a shared directory and polls every 500 ms for a matching `<requestId>.response.json`, enabling communication with a user container that only has shared-filesystem access. After execution (success or error), the result is written to `kubeclaw:toolresults:<agentJobId>:<category>` via `xAdd`.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Redis:** real Redis instance (port-forwarded from minikube at `localhost:16379`)
- **Bridge process:** local subprocess running `node dist/tool-server.js` — no Kubernetes required
- **User container simulation:** in-process Node.js HTTP server (http-bridge) / `setInterval` file watcher (file-bridge)
- **Build bootstrap:** `beforeAll` in the test file runs `npm install` + `npm run build` in `container/agent-runner` if needed
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/sidecar-tool-pod.test.ts` | 3-describe / 4-test e2e suite (build artifact, http-bridge, file-bridge) |
| `container/agent-runner/src/tool-server.ts` | Bridge dispatcher — `executeToolBridgeHttp`, `executeToolBridgeFile`, main Redis read loop |

## Tasks (retrospective)

1. **AC 1 — build artifact exists:** `beforeAll` runs `ensureToolServerBuilt()` which npm-installs (if needed) and always runs `tsc`; the first `describe` asserts `fs.existsSync(TOOL_SERVER_BIN)`.
2. **AC 2 — http-bridge call/response:** spawns `tool-server.js` with `KUBECLAW_TOOL_MODE=http-bridge` pointing at a local echo HTTP server; asserts the toolresults stream entry contains the echoed payload.
3. **AC 3 — http-bridge error propagation:** spawns a second bridge instance pointed at an error-returning server; asserts the toolresults stream entry's `error` field matches the server-returned message.
4. **AC 4 — file-bridge call/response:** spawns `tool-server.js` with `KUBECLAW_TOOL_MODE=file-bridge` and `KUBECLAW_SHARED_DIR` set to a temp dir; a `setInterval` watcher simulates the user container; asserts result on the toolresults stream.
5. **AC 5 — no Kubernetes:** all tests run entirely locally; bridge is a child process, Redis is port-forwarded.
6. **Verification:** `npm run test:e2e -- sidecar-tool-pod` → 4/4 passing.
