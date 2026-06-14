# Tool Bridge

## Overview

Each sidecar tool pod is a two-container Kubernetes Job: `kubeclaw-tool-bridge` (running `tool-server.js`) and `user-tool` (an arbitrary container supplied by the tool author). The bridge is the only container that touches Redis; `user-tool` never sees Redis credentials.

The bridge reads tool calls from the stream `kubeclaw:toolcalls:{agentJobId}:{toolName}` (the `{toolName}` segment is passed to the bridge container as `KUBECLAW_CATEGORY`) and writes results to `kubeclaw:toolresults:{agentJobId}:{toolName}`. Between those two stream operations, the bridge forwards the call to `user-tool` using one of three IPC patterns, selected by `ToolSpec.pattern`.

Regardless of pattern, the user container receives a single injected env var, `PORT`, set to the value of `ToolSpec.port` (default `8080`).

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

The port is set by `ToolSpec.port` (default `8080`).

#### Request mapping

Without `requestMapping` the default `/invoke` contract described above is unchanged — this is backward compatible and remains the correct choice when the user-tool container is written for KubeClaw.

When `ToolSpec.requestMapping` is set, the bridge builds the real HTTP request to the co-located container (`http://localhost:{port}`) from the mapping instead of POSTing `/invoke`. The request always targets the localhost sidecar container; the container is responsible for its own upstream credentials and egress.

**Schema** (`requestMapping` fields):

| Field | Type | Required | Notes |
|---|---|---|---|
| `method` | `GET\|POST\|PUT\|PATCH\|DELETE` | yes | |
| `path` | string | yes | Must begin with `/`; `{field}` tokens are URL-encoded |
| `query` | `Record<string, string>` | no | Values are literals or `{field}` (URL-encoded) |
| `headers` | `Record<string, string>` | no | Values are literals or `{field}`; CR/LF stripped to prevent header injection |
| `body` | JSON template | no | Omit for GET/DELETE; see substitution rules below |
| `responsePath` | string | no | Dot-separated path into a JSON response, e.g. `current.temp_c` |

**Substitution rules:**

- A `{field}` token is looked up in the tool-call input by name. Referencing a field that is not present in the input fails the call with an error message identifying the missing field.
- In `path` and `query`, the substituted value is URL-encoded by the built-in `URL` / `URLSearchParams` APIs. Non-string values are JSON-stringified before encoding.
- In `headers`, CR and LF characters are stripped from substituted values (header injection prevention); `Accept: application/json` is added automatically.
- In `body`, a string leaf that is exactly `"{field}"` (no surrounding text) has its field's raw JSON type preserved — a numeric field remains a number, a boolean remains a boolean, an object/array remains structured. A string leaf that embeds a token inside other text (e.g. `"hello {name}"`) is string-interpolated: the field value is coerced to string. Non-string body nodes (numbers, booleans, objects, arrays) are copied as-is.

**Response handling:**

- Without `responsePath`: the raw response body is returned as the tool result, truncated to the output cap (`KUBECLAW_MAX_TOOL_OUTPUT_BYTES`, default 50 kB).
- With `responsePath`: the bridge parses the body as JSON and walks the dot-separated keys. A string leaf is returned as-is; an object or array subtree is JSON-stringified. If the body is not valid JSON or any key in the path is absent, the call fails.
- Non-2xx responses become a tool error (`Tool HTTP {status}: {body}`) via the existing `fetchWithRetry` retry discipline (4xx fail-fast; 5xx retry up to 3 attempts).

**Example:**

```yaml
# A stock weather REST image, driven via request mapping (no /invoke needed):
tools:
  - name: weather
    description: Current weather for a city
    parameters:
      type: object
      properties:
        city: { type: string }
        units: { type: string }
      required: [city]
    image: ghcr.io/example/weather-api:1      # must also be in TOOL_IMAGE_ALLOWLIST
    pattern: http
    port: 8080
    requestMapping:
      method: GET
      path: /v1/weather/{city}
      query:
        units: "{units}"
      responsePath: current.summary
```

A call with `{ city: "London", units: "metric" }` sends `GET http://localhost:8080/v1/weather/London?units=metric` to the co-located container and returns the value at `current.summary` in the JSON response. The container image must be present in `TOOL_IMAGE_ALLOWLIST` in production deployments.

### File pattern

The bridge and user-tool share a `/shared` emptyDir volume. The bridge writes per-field input files for each declared parameter and polls for a response directory written atomically by `user-tool`.

#### Per-field request protocol

For each incoming tool call the bridge builds a request directory under `/shared/req/{requestId}/input/`. One file is written per **declared** parameter field (fields not present in the call are skipped; undeclared fields are dropped). File content is the field value — plain text for string values, JSON-serialized for all other types. The directory is published atomically by renaming a hidden staging directory into place (`/shared/.req.{id}.tmp` → `/shared/req/{id}`).

`user-tool` must write a response atomically (mktemp + mv) to `/shared/resp/{requestId}/`. The response directory must contain three files:

| File | Content |
|---|---|
| `exit_code` | Exit status as a decimal string (e.g. `0`) |
| `response` | Stdout (may be absent; treated as empty) |
| `stderr` | Stderr (may be absent; treated as empty) |

The bridge polls for the response directory on a 500 ms schedule. When it appears:
- Exit code `0` → returns the contents of `response`, truncated to `KUBECLAW_MAX_TOOL_OUTPUT_BYTES` (default 50 kB).
- Any other exit code → returns an error: `exit {code}: {stderr}` (stderr truncated to the same cap).

The bridge deletes the response directory after reading. Timeout (idle timeout reached before response appears) → `File bridge timeout`.

**Declared fields and traversal guard.** The bridge knows which fields to write via `KUBECLAW_TOOL_FIELDS` (comma-separated list of property names, derived from `ToolSpec.parameters.properties`). For file-pattern tools, `validateTool` enforces that every parameter property name matches `[A-Za-z_][A-Za-z0-9_]*`, preventing filename traversal via field names.

#### The KubeClaw wrapper (`tool-wrapper.sh`)

When `ToolSpec.run` is set (file pattern only), there is no need to write custom bridge code. The orchestrator sets the user-tool container's command to `/bin/sh /kubeclaw/tool-wrapper.sh` and injects two env vars into the **user-tool** container:

| Variable | Container | Content |
|---|---|---|
| `KUBECLAW_TOOL_RUN` | user-tool | The `run` string from the ToolSpec — executed verbatim as `sh -c "$KUBECLAW_TOOL_RUN"` |
| `WORKDIR` | user-tool | Working directory (see Mounts below) |

`KUBECLAW_TOOL_FIELDS` (comma-separated declared parameter names) is injected into the **`kubeclaw-tool-bridge`** container — the bridge reads it at startup to know which declared input fields to write into `/shared/req/{id}/input/`. It is not present on the user-tool container.

The wrapper runs in a `while true` loop, scanning `/shared/req/*/`:

1. For each request directory found, exports `INPUT_DIR` pointing at its `input/` subdirectory.
2. Runs `(cd "$WORKDIR" && sh -c "$KUBECLAW_TOOL_RUN")`, capturing stdout to `response` and stderr to `stderr`.
3. Records the exit code in `exit_code`.
4. Publishes the response directory atomically (mktemp + mv) to `/shared/resp/{id}/`.
5. Deletes the request directory.

Output is captured byte-for-exact (no subshell `$()` newline stripping). The wrapper uses only `sh` — no `jq` or other external dependencies.

`KUBECLAW_POLL_INTERVAL` (default `1` second) controls the wrapper's scan interval. This is independent of the bridge's 500 ms response poll.

Within `$KUBECLAW_TOOL_RUN`, individual fields are accessed as:

```sh
$(cat "$INPUT_DIR/<fieldname>")
```

#### Mounts

File-pattern tools can optionally receive a writable working directory via `ToolSpec.mount`:

| `mount` value | `WORKDIR` | Volume type | Notes |
|---|---|---|---|
| `none` (default) | `/tmp` | — | No persistent storage |
| `scratch` | `/work` | emptyDir | Ephemeral; lives only for the duration of the job |
| `group` | `/work` | Group PVC (`kubeclaw-groups`), subPath = groupFolder | Persistent; scoped to the calling group |

The `group` mount is gated by **`TOOL_GROUP_MOUNT_ALLOWLIST`** (default-deny). This is separate from `TOOL_IMAGE_ALLOWLIST`. When the allowlist is empty, no image may use `mount: group`. The Helm default ships `alpine:*`, enabling the stock `bash_persist` tool. The group PVC is **never** mounted on the bridge container — only on user-tool.

`mountReadOnly: true` (boolean, only valid with `mount: group`) mounts the group PVC read-only. Default is read-write.

All mount types apply only to the `file` pattern.

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

These are read from the bridge container's environment; the Job manifest does not currently stamp them, so changing them requires baking new ENV defaults into the agent image — per-ToolSpec or Helm-level overrides are not yet supported (except `healthPath`, which is per-ToolSpec).

## Redis authentication

The bridge authenticates to Redis using per-job ACL credentials injected via `REDIS_URL` (the URL contains the username and password). The credentials are minted by the orchestrator before the pod is created; see [docs/SIDECAR_ACL.md](./SIDECAR_ACL.md) for ACL minting details.

If the bridge loses its Redis connection, it reconnects with exponential backoff: `min(2^retries × 100 ms, 10 s)`, giving up after 10 retries.

## Credential-injected tools

Some catalog tools need a third-party API key at egress. Rather than placing the real key in the pod environment, KubeClaw uses the credential-injection system: the tool declares which broker-catalog ids it needs, the orchestrator stamps placeholder env vars onto the `user-tool` container, and the in-pod Envoy sidecar (or Istio egress gateway) substitutes the real value at the moment the request leaves the cluster. The `user-tool` container never holds the real secret.

### `ToolSpec.credentials`

`credentials` is an optional array of broker-catalog id strings:

```yaml
credentials: [brave-search]
```

Each id must correspond to an entry in `credentialInjection.catalog` in `values.yaml`. Validation rejects non-strings and empty strings. Declaring any id triggers credential-sidecar attachment in sidecar mode and stamps per-tool placeholder env vars onto `user-tool`. A tool only receives the placeholders for the ids it declares — it cannot reference another id's env var and therefore cannot form a request that exfiltrates another host's secret.

### What gets attached (sidecar mode, `mode: sidecar`)

When `toolSpec.credentials` is non-empty and `CREDENTIAL_INJECTION_MODE != off`, `createSidecarToolPodJob` builds:

| What | How |
|---|---|
| `credential-sidecar` container | Envoy proxy; runs at `CREDENTIAL_SIDECAR_PORT`; substitutes the real credential at egress via `ext_authz` |
| `envoy-config` volume | ConfigMap `kubeclaw-envoy-sidecar`; mounted at `/etc/envoy` on the sidecar |
| `broker-token` volume | Projected service-account token (audience `kubeclaw-credential-broker`, 10 min TTL); mounted at `/var/run/secrets/tokens` on the sidecar |
| `egress-ca` volume | Secret `kubeclaw-egress-ca-tls` (key `ca.crt` → path `kubeclaw-egress-ca.crt`); mounted at `/etc/ssl/certs` on the sidecar |
| Proxy env on `user-tool` | `HTTPS_PROXY`, `HTTP_PROXY` → `http://127.0.0.1:{port}`; `NO_PROXY` → `localhost,127.0.0.1,kubeclaw-redis,credential-broker`; `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` → `/etc/ssl/certs/kubeclaw-egress-ca.crt` |
| Placeholder env on `user-tool` | One env var per `credentialFields` entry for each declared id (e.g. `BRAVE_API_KEY`); value is the group's registered placeholder, the operator-fallback sentinel, or `injected-by-broker` |
| `serviceAccountName: kubeclaw-tool-job` | Set whenever injection is active (`mode != off`) |
| `automountServiceAccountToken: false` | Set alongside the SA |
| `kubeclaw.io/owner-group` annotation | Set on the pod template so the broker can resolve the group for identity propagation |

The `kubeclaw-tool-bridge` container receives none of the credential env vars or the proxy env — only the `user-tool` container does.

**Audit-only mode** (`CREDENTIAL_INJECTION_AUDIT_ONLY=true`): the sidecar container and volumes are still attached (so the broker can observe egress), and `serviceAccountName` is still set, but the placeholder env vars and the `kubeclaw.io/owner-group` annotation are skipped.

**`mode: off`**: no injection occurs — no sidecar, no SA, no env changes.

### How the secret is protected

The real API key never appears in the pod spec. The `user-tool` container holds only a `KC_PH_…` placeholder (or the operator-fallback sentinel `KC_PH_FALLBACK_{id}`). When `user-tool` makes an outbound HTTPS request, traffic is intercepted by the `credential-sidecar` Envoy, which calls the broker's `ext_authz` endpoint. The broker maps the placeholder back to the real secret, stamps the appropriate request header (e.g. `X-Subscription-Token`), and forwards the request to the upstream host.

### Worked example: `web_fetch` and `web_search`

Both tools ship in the Helm baseline catalog on `curlimages/curl:latest` with `pattern: file` and `mount: none`.

**`web_fetch`** (no credentials — direct egress):

```yaml
- name: web_fetch
  description: Fetch the raw content of a URL over HTTP(S).
  parameters:
    type: object
    properties:
      url: { type: string }
    required: [url]
  image: curlimages/curl:latest
  pattern: file
  mount: none
  run: 'curl -sSL -A "Mozilla/5.0 KubeClaw/1.0" -- "$(cat "$INPUT_DIR/url")"'
```

No `credentials` declared, so no sidecar is attached and the request goes directly to the remote host. The `--` option terminator before the URL prevents a crafted URL from being interpreted as a curl flag (argument-injection guard).

**`web_search`** (credentials required — egress via Envoy):

```yaml
- name: web_search
  description: Search the web via the Brave Search API. Returns the raw Brave JSON response (up to 10 results).
  parameters:
    type: object
    properties:
      query: { type: string }
    required: [query]
  image: curlimages/curl:latest
  pattern: file
  mount: none
  credentials: [brave-search]
  run: 'curl -sS -G -H "X-Subscription-Token: $BRAVE_API_KEY" --data-urlencode "q=$(cat "$INPUT_DIR/query")" --data-urlencode "count=10" "https://api.search.brave.com/res/v1/web/search"'
```

Declares `credentials: [brave-search]`, which maps to the `brave-search` catalog entry (`BRAVE_API_KEY` placeholder env, `allowOperatorFallback: true`). In sidecar mode the `credential-sidecar` Envoy intercepts the outbound HTTPS request and the broker substitutes the real Brave API key. The tool script reads `$BRAVE_API_KEY` (the placeholder) at request time; the real value is inserted at egress. The result is the raw Brave JSON response.

### Note: `browser` and the legacy agent-runner

`browser` is not a catalog tool — it remains a built-in (its own follow-on spec). The legacy agent-runner (non-direct-llm path) keeps `web_fetch` and `web_search` as in-process built-ins alongside their catalog counterparts, matching the same dual-existence pattern as `bash`. The channel's direct-llm path resolves `web_fetch` and `web_search` from the catalog.

## CDP pattern (browser tools)

### `pattern: 'cdp'`

The `cdp` pattern attaches the operator's stock Chromium-CDP image as a K8s
native sidecar and wires a Playwright-over-CDP connection from the bridge to
it.  `port` (the CDP port) is **required** — `validateTool` rejects the
catalog entry if it is absent.  No `run`, `mount`, `requestMapping`, or
`credentials` fields are used; `command` may be omitted if the image's
default entrypoint already exposes CDP on the declared port.

### Topology

A `cdp` tool pod contains:

| Container | Role |
|---|---|
| `kubeclaw-tool-bridge` | Bridge (kubeclaw-agent, `KUBECLAW_TOOL_MODE=cdp-bridge`) |
| `chromium` init container (`restartPolicy: Always`) | Operator's Chromium image; exposed on `toolSpec.port` |

There is **no `user-tool` container** for the `cdp` pattern.

A 256 Mi `/dev/shm` emptyDir is mounted on the `chromium` container — Chromium
requires shared memory for its renderer processes.

**Readiness**: the `chromium` init container has an `httpGet` readiness probe
on `/json/version` at `toolSpec.port` (`initialDelaySeconds: 2`,
`periodSeconds: 2`, `failureThreshold: 15`).  `connectOverCDP` internally
fetches `/json/version`, so the Playwright connect call itself also acts as a
readiness gate.

**Connection lifecycle**: the bridge holds one persistent `playwright-core`
`connectOverCDP` connection (cached `Browser` + `Page`).  On the first call
(or after a stale connection is detected) the bridge reconnects with up to 30 s
of retry/backoff.  State — open tabs, cookies, page position — persists across
tool calls within the pod's lifetime and is reset only when the pod exits (idle
timeout or job completion).

**Env vars stamped on the bridge container**:

| Variable | Value |
|---|---|
| `KUBECLAW_TOOL_MODE` | `cdp-bridge` |
| `KUBECLAW_CDP_URL` | `http://localhost:{port}` |

### The `action` contract

Every call must include an `action` field.  The supported actions are:

| Action | Required fields | Effect |
|---|---|---|
| `navigate` | `url` | Loads the URL (`domcontentloaded`, 30 s timeout); returns URL + title |
| `snapshot` | — | Injects `data-kc-ref="eN"` on visible interactive elements; returns URL, title, element list, and up to 4 000 chars of visible body text |
| `click` | `ref` | Clicks the element with `[data-kc-ref="{ref}"]` (10 s timeout) |
| `type` | `ref`, `text` | Fills the element; if `submit: true` also presses Enter |
| `press` | `key` | Fires `keyboard.press(key)` on the page |
| `back` | — | Navigates back (`domcontentloaded`, 30 s timeout) |
| `wait` | `for` | If `for` is all digits, waits that many milliseconds (capped at 30 000); otherwise waits for the CSS selector to appear (30 s timeout) |

**Snapshot and refs**: `snapshot` stamps `data-kc-ref` attributes on every
visible interactive element (links, buttons, inputs, selects, textareas, ARIA
roles, `tabindex`, `onclick`).  Each ref is of the form `eN` (e.g. `e1`,
`e2`).  `click` and `type` target `[data-kc-ref="…"]`.  If the element is
stale or not found the bridge returns:

```
error: element {ref} not found or not actionable — call snapshot first (…)
```

An unrecognised action returns:

```
error: unknown action "{action}". Valid actions: navigate, snapshot, click, type, press, back, wait
```

All errors are returned as strings (not exceptions), so the LLM can read the
message and recover without the tool call failing at the protocol layer.

### Worked example: the `browser` baseline

The Helm baseline catalog ships `browser` on `chromedp/headless-shell:latest`.
The image's default entrypoint already exposes CDP on port 9222, so no
`command` override is needed.

```yaml
- name: browser
  description: Drive a real web browser (Chromium). Call snapshot to see the
    page (it returns the interactive elements with refs and the visible text),
    then click/type using a ref. Actions persist within a session.
  parameters:
    type: object
    properties:
      action: { type: string, enum: [navigate, snapshot, click, type, press, back, wait] }
      url:    { type: string }
      ref:    { type: string }
      text:   { type: string }
      submit: { type: boolean }
      key:    { type: string }
      for:    { type: string }
    required: [action]
  image: chromedp/headless-shell:latest
  pattern: cdp
  port: 9222
  memoryRequest: 256Mi
  memoryLimit: 1Gi
  cpuRequest: 100m
  cpuLimit: "1"
```

No `credentials`, `mount`, `run`, or `command` are set.  The per-tool resource
fields (`memoryRequest`, `memoryLimit`, `cpuRequest`, `cpuLimit`) are applied
to the `chromium` init container; the bridge container uses fixed defaults
(64 Mi request / 128 Mi limit, 50 m / 200 m CPU).

**Dual existence note**: `browser` also remains a built-in tool in the legacy
agent-runner (the non-direct-LLM path).  The catalog entry and the built-in
coexist; the channel's direct-LLM path resolves `browser` from the catalog.
The first-party `kubeclaw-browser-sidecar` image used by the legacy
agent-runner's browser sidecar is separate and unchanged.

`places_search` was decoupled from the `browser` category onto its own `places`
category at the same time; both `places_search` and `places` are reserved names
in `validateTool` and cannot be used for catalog tools.

## Worked example: `bash` and `bash_persist`

The Helm baseline catalog ships two tools that illustrate the `run` + mount model using stock `alpine:latest` — no custom image required.

```yaml
tools:
  - name: bash
    description: Run a shell command in an ephemeral sandbox (no persistent changes; returns the command output).
    parameters:
      type: object
      properties:
        command: { type: string }
      required: [command]
    image: alpine:latest
    pattern: file
    mount: scratch
    run: 'sh -c "$(cat "$INPUT_DIR/command")"'

  - name: bash_persist
    description: Run a shell command against the group's persistent files. Changes are saved to the group filesystem.
    parameters:
      type: object
      properties:
        command: { type: string }
      required: [command]
    image: alpine:latest
    pattern: file
    mount: group
    run: 'sh -c "$(cat "$INPUT_DIR/command")"'
```

**`bash`** uses `mount: scratch`: the user-tool container gets an emptyDir at `/work`. The working directory is reset to empty on every job; nothing persists between calls.

**`bash_persist`** uses `mount: group`: the calling group's PVC subPath is mounted read-write at `/work`. Shell commands can read and write files that persist across calls. This requires `alpine:*` (or the specific image) in `TOOL_GROUP_MOUNT_ALLOWLIST`; the Helm default ships `"alpine:*"` so this works out of the box.

In both tools, the `run` string reads the `command` field from `$INPUT_DIR/command` and passes it to `sh -c`. The wrapper runs this command with `cd "$WORKDIR" && sh -c "$(cat "$INPUT_DIR/command")"`, captures stdout/stderr, and publishes the result.
