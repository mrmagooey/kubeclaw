# Tool Bridge

## Overview

Each sidecar tool pod is a two-container Kubernetes Job: `kubeclaw-tool-bridge` (running `tool-server.js`) and `user-tool` (an arbitrary container supplied by the tool author). The bridge is the only container that touches Redis; `user-tool` never sees Redis credentials.

The bridge reads tool calls from the stream `kubeclaw:toolcalls:{agentJobId}:{toolName}` and writes results to `kubeclaw:toolresults:{agentJobId}:{toolName}`. Between those two stream operations, the bridge forwards the call to `user-tool` using one of three IPC patterns, selected by `ToolSpec.pattern`.

## The Three Patterns

### HTTP pattern

The bridge POSTs to `http://localhost:{port}/invoke` with a JSON body:

```json
{ "tool": "<toolName>", "input": { ... } }
```

`user-tool` must respond with one of:

```json
{ "result": ... }
{ "error": "human-readable message" }
```

The port is set by `ToolSpec.port` (default `8080`). The bridge also injects the `PORT` environment variable into the `user-tool` container set to the same value, so the container does not need to hard-code it.

### File pattern

The bridge writes a request file to the `/shared` emptyDir volume (mounted by both containers):

```
/shared/{requestId}.request.json
```

Request file format:

```json
{ "requestId": "...", "tool": "<toolName>", "input": { ... } }
```

`user-tool` must write a response atomically (mktemp + mv) to:

```
/shared/{requestId}.response.json
```

Response file format:

```json
{ "result": ... }
```

or

```json
{ "error": "human-readable message" }
```

The bridge polls for the response file on a 500 ms schedule and deletes it after reading. `/shared` is an emptyDir mounted by both containers.

### ACP pattern

The bridge POSTs to `http://localhost:{port}/runs` with a JSON body. The exact body depends on the sub-mode:

- **sync** (`ToolSpec.acpMode: sync`, default): includes `"mode": "synchronous"` — single POST; the pod idle timeout serves as the per-request timeout. Use this for long-running agents where a fixed timeout would be too short.

  ```json
  { "agent_name": "<acpAgentName>", "input": { ... }, "mode": "synchronous" }
  ```

- **async** (`ToolSpec.acpMode: async`): the `mode` field is **omitted** (ACP's default is async) — the initial POST returns a `run_id`; the bridge then polls `GET /runs/{run_id}` with exponential backoff (500 ms base, factor 1.5, cap 5 s) until completion or the pod idle timeout is reached.

  ```json
  { "agent_name": "<acpAgentName>", "input": { ... } }
  ```

Two sub-modes are available, set via `ToolSpec.acpMode` (default: `sync`).

`ToolSpec.acpAgentName` sets the `agent_name` field (default: the tool name).

## Readiness gate

Before forwarding the first tool call, the bridge polls the user-tool container to confirm it is listening. This applies to the **http** and **acp** patterns only; the **file** pattern skips it.

The bridge sends a GET to:

```
http://localhost:{port}{healthPath}
```

Any HTTP response — including `404` — counts as ready. The contract is that the port is listening, not that the health endpoint returns a specific status code. Connection errors (ECONNREFUSED, ETIMEDOUT) mean not-ready; polling continues until the deadline.

| Parameter | Default | Override |
|---|---|---|
| `healthPath` | `/` | `ToolSpec.healthPath` (must begin with `/`) or env `KUBECLAW_TOOL_HEALTH_PATH` |
| Ready timeout | `30000` ms | `KUBECLAW_TOOL_READY_TIMEOUT` |
| Poll interval | `1000` ms | `KUBECLAW_TOOL_READY_INTERVAL_MS` |

## Retry and timeouts

HTTP `/invoke` calls (http pattern) and ACP `/runs` POSTs and polls (acp pattern) go through `fetchWithRetry`.

**Per-attempt timeout**: `KUBECLAW_TOOL_REQUEST_TIMEOUT` (default `30000` ms). Exception: ACP sync mode uses the pod idle timeout as the per-request timeout to accommodate long-running agents.

**Retry policy**:

| Response | Behavior |
|---|---|
| 4xx | `ToolClientError` — fail fast, no retry. Error message: `Tool HTTP {status}: {body}` |
| 5xx, network error, or timeout | Exponential backoff retry |

Backoff formula: `delay = KUBECLAW_TOOL_RETRY_BASE_MS × 2^(attempt-1)`

- Retry 1: base × 1
- Retry 2: base × 2

Maximum 3 attempts total. `KUBECLAW_TOOL_RETRY_BASE_MS` default: `1000` ms.

## Redis authentication

The bridge authenticates to Redis using per-job ACL credentials injected via `REDIS_URL` (the URL contains the username and password). The credentials are minted by the orchestrator before the pod is created; see [docs/SIDECAR_ACL.md](./SIDECAR_ACL.md) for ACL minting details.

If the bridge loses its Redis connection, it reconnects with exponential backoff: `min(2^retries × 100 ms, 10 s)`, giving up after 10 retries.

## Zero-Dockerfile onboarding with the file-bridge wrapper

The file pattern requires no custom bridge code. Any image that can read JSON from stdin and write JSON to stdout can be wrapped using the `kubeclaw-tool-wrapper` ConfigMap, which is mounted read-only into the `user-tool` container at `/kubeclaw`.

### How the wrapper works

The wrapper shell script (`tool-wrapper.sh`) runs in the `user-tool` container and handles the file-bridge protocol:

1. Watches `/shared` for `{requestId}.request.json` files
2. Extracts `.input` from the request JSON using `jq -c '.input'` and pipes it to the wrapped command's stdin
3. Captures stdout and writes `{"result": ...}` or `{"error": ...}` atomically (mktemp + mv) to `{requestId}.response.json`. When using `tool-wrapper.sh`, the `result` value is always a JSON **string** containing the wrapped command's raw stdout (the wrapper JSON-stringifies it via `jq -Rs`); a custom user container writing response files directly may use any JSON value for `result`.
4. Handles malformed requests (jq parse failure) by writing an error response and continuing
5. Deletes the request file after processing

Wrapper environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `KUBECLAW_SHARED_DIR` | `/shared` | Directory to watch for request files |
| `KUBECLAW_POLL_INTERVAL` | `1` | Wrapper scan interval in seconds (independent of the bridge's 500 ms response poll) |

### Example ToolSpec

```yaml
# ToolSpec example: stock image, file bridge, zero custom code
tools:
  - name: word_count
    description: Count words in the input text
    parameters: { type: object, properties: { text: { type: string } } }
    image: alpine:latest        # must also be in TOOL_IMAGE_ALLOWLIST in production
    pattern: file
    command: ["/bin/sh", "/kubeclaw/tool-wrapper.sh", "wc", "-w"]
```

**Note**: `alpine:latest` does not include `jq`, which `tool-wrapper.sh` requires to parse `.input` from the request JSON. Use an image that includes `jq`, such as a `ghcr.io/jqlang/jq:latest` derivative, or add `jq` via a minimal Dockerfile:

```dockerfile
FROM alpine:latest
RUN apk add --no-cache jq
```

The `image` field must also be present in `TOOL_IMAGE_ALLOWLIST` in production deployments.
