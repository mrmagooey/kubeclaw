# Per-Tool HTTP Request-Mapping — Design

**Status:** Approved (brainstorming complete)
**Date:** 2026-06-13
**Author:** Peter + Claude

## Problem

The sidecar tool bridge's `http` pattern requires the wrapped container to
implement a fixed KubeClaw contract: `POST localhost:{port}/invoke` with body
`{tool, input}`, returning `{result|error}`. An *unmodified* third-party REST
container (e.g. `weather-api:latest` serving `GET /weather/{city}?units=metric`)
does not speak that contract, so today it can only be used by writing a custom
wrapper. This is the last gap to the "drop in an arbitrary tool container"
goal: teach the bridge how to map a tool call onto the container's real REST
surface.

## Scope

**In scope:** an optional `requestMapping` on `ToolSpec` (valid only for
`pattern: 'http'`) that the bridge uses to construct the real HTTP request to
the co-located `user-tool` container and to shape the response back into the
tool-result string.

**Out of scope (unchanged / separate):**
- The `file` and `acp` bridge patterns — untouched.
- Targeting external URLs directly (no container) — explicitly rejected; a
  mapped request always targets the localhost sidecar container.
- Credential injection for the container's own upstream calls — that is the
  container's concern and is already handled by the Envoy/broker egress path;
  the bridge→container hop is in-pod and needs no secret injection.
- Form-encoded / multipart request bodies — JSON bodies only.
- A general template/expression language — substitution is limited to
  `{field}` token replacement with position-correct encoding.

## Decisions (from brainstorming)

1. **Expressiveness:** per-field placement — each input field can be placed into
   the URL path, a query param, a header, or the JSON body. Declarative, no
   scripting.
2. **Response:** pass-through by default (raw body, truncated to the existing
   output cap), with an optional `responsePath` dot-path extraction.
3. **Target:** always the co-located `user-tool` sidecar container at
   `http://localhost:{port}` — reuses the entire sidecar model (image
   allowlist, per-job Redis ACL, network policy, container-owned egress).
4. **Schema shape:** a structured `requestMapping` block that references input
   fields by `{field}` name, keeping the LLM-facing `parameters` JSON Schema
   clean (chosen over OpenAPI-style per-field annotations or raw template
   strings).

## Topology

A sidecar tool pod is one pod, two containers sharing localhost:
- **`kubeclaw-tool-bridge`** — KubeClaw's canonical agent image running
  `tool-server.js` (the *bridge executor*, trusted KubeClaw code).
- **`user-tool`** — the unmodified third-party REST container on `PORT`.

The bridge reads the tool call from Redis, builds the mapped HTTP request, calls
the user-tool container over localhost, shapes the response, and writes the
result back to Redis. The user-tool container is never modified — it serves its
normal REST endpoints; the mapping teaches the bridge how to call them.

```
┌──────────────── sidecar tool pod ────────────────┐
│  kubeclaw-tool-bridge            user-tool         │
│  (tool-server.js, KubeClaw)      (their REST image)│
│   Redis ◀─toolcalls──┐                             │
│        │             │   HTTP localhost:PORT       │
│        ▼             └──── GET /weather/{city} ───▶ │
│   buildMappedRequest ◀──── JSON response ──────────┘
│        │                                            │
│   Redis ─toolresults▶                               │
└────────────────────────────────────────────────────┘
```

## Component 1 — `requestMapping` schema

New optional field on `ToolSpec` (`src/tools/types.ts`), valid only when
`pattern: 'http'`:

```typescript
interface RequestMapping {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;                    // e.g. "/weather/{city}"; {field} substituted, URL-encoded
  query?: Record<string, string>;  // value is a literal or "{field}"; URL-encoded
  headers?: Record<string, string>;// value is a literal or "{field}"; raw string
  body?: unknown;                  // JSON value; string leaves with "{field}" substituted; omit for GET/DELETE
  responsePath?: string;           // optional dot-path, e.g. "current.temp_c"
}

// on ToolSpec:
requestMapping?: RequestMapping;
```

### Substitution model

A token is exactly `{fieldName}`, where `fieldName` is a key of the call's
`input` object. Encoding is determined by position:

- **path** — each `{field}` value `encodeURIComponent`'d before insertion.
- **query** — values URL-encoded (key=value pairs).
- **headers** — raw string value; newline characters stripped to prevent
  header injection.
- **body** — applied to string leaves of the JSON `body` template: a leaf whose
  value is exactly `"{field}"` is replaced with the input field's value
  **preserving its JSON type** (a number stays a number, an object stays an
  object); a leaf that merely *contains* `{field}` within a larger string is
  string-interpolated (the field value stringified).

A token referencing a field absent from `input` causes the tool call to fail
with a clear error **before any HTTP request is issued**. Position-correct
encoding (never raw string concatenation) closes the request-injection surface
by construction.

### Validation (`validateTool`, registration time)

- `requestMapping` is only permitted when `pattern === 'http'` — reject on
  `file`/`acp`.
- `method` ∈ the enum.
- `path` is a non-empty string beginning with `/`.
- `query` / `headers` values, if present, are strings.
- `responsePath`, if present, is a non-empty string.
- Token references are **not** cross-checked against `parameters` (the JSON
  Schema may legitimately be permissive); an unresolved token surfaces at call
  time as a tool error, not a registration error.

## Component 2 — Bridge executor

In `container/agent-runner/src/tool-server.ts`, `executeToolBridgeHttp(tool,
input)` branches on whether a mapping is present. The mapping reaches the bridge
via a new env var on the `kubeclaw-tool-bridge` container:
`KUBECLAW_TOOL_REQUEST_MAPPING` = `JSON.stringify(requestMapping)`.

- **Env unset (no mapping):** unchanged behavior — `POST localhost:{port}/invoke`
  with `{tool, input}` → `{result|error}`. Full backward compatibility.
- **Env set (mapping present):**
  1. Parse the mapping (guard `JSON.parse`; malformed → clean tool error, never
     crash the loop).
  2. `buildMappedRequest(mapping, input, port)` — a pure helper returning
     `{ url, method, headers, body? }`. Substitutes `{field}` tokens with
     position-correct encoding; an unresolved token throws before any fetch.
     URL = `http://localhost:{port}` + path + encoded query. Default header
     `Accept: application/json`; add `Content-Type: application/json` when a
     body is sent.
  3. Reuse existing hardening: the readiness gate (`ensureToolReady` /
     `healthPath`) fires before the first call; the request goes through
     `fetchWithRetry` (per-attempt timeout, 4xx fail-fast as
     `Tool HTTP {status}`, 5xx/network/timeout retried).
  4. Response: if `responsePath` is set, parse JSON and extract via
     `extractResponsePath(bodyText, responsePath)` (dot-path); else return the
     raw body. Truncate to the existing `MAX_TOOL_OUTPUT_BYTES`.

`buildMappedRequest` and `extractResponsePath` are pure, unit-testable helpers
separate from `fetch`. The `file` and `acp` paths are untouched.

## Component 3 — Plumbing

The orchestrator already resolves the full `ToolSpec` by name at spawn (catalog
work), so it has `requestMapping` available.

- **`src/k8s/job-runner.ts` `createSidecarToolPodJob`:** when
  `spec.toolSpec.requestMapping` is set, add
  `{ name: 'KUBECLAW_TOOL_REQUEST_MAPPING', value: JSON.stringify(spec.toolSpec.requestMapping) }`
  to the **bridge container's** env (next to `KUBECLAW_TOOL_MODE`). Absent →
  env unset.
- **No Redis-stream changes.** The channel still sends only the tool name; the
  orchestrator resolves the spec (including the mapping) from its own catalog.
  A compromised channel cannot inject a mapping — the orchestrator is the sole
  authority on a named tool's mapping.
- **`SidecarToolPodJobSpec`** already carries the full `toolSpec`; no spec-type
  change needed.

## Error handling

| Condition | Behavior |
|---|---|
| `{field}` token missing from `input` | Bridge throws before any HTTP call → `Tool error: request mapping references missing field "{x}"` on the toolresults stream. |
| Non-2xx from the container | Handled by `fetchWithRetry`: 4xx → `Tool HTTP {status}: {body}` (fail-fast); 5xx/network/timeout retried then surfaced. |
| `responsePath` not found / body not JSON | Tool error naming the path, with a short body prefix for debugging. |
| Container never ready | Existing readiness-gate timeout path. |
| Malformed `KUBECLAW_TOOL_REQUEST_MAPPING` JSON | Cannot happen for catalog tools (validated + serialized by the orchestrator), but the bridge guards `JSON.parse` and fails the call cleanly. |

## Testing (three levels)

**Unit:**
- `buildMappedRequest`: path/query/header/body substitution; position-correct
  encoding (URL-encode in path/query; header newline stripping; JSON type
  preservation for `"{field}"` body leaves vs string-interpolation for embedded
  tokens); unresolved-token error; GET with no body; query assembly/encoding.
- `extractResponsePath`: top-level hit, nested hit, miss (error), non-JSON body
  (error).
- `validateTool`: valid mapping accepted; `requestMapping` rejected on
  `file`/`acp`; bad `method`; `path` without leading `/`; non-string
  query/header values.

**Integration** (real compiled bridge subprocess + a tiny local HTTP server
standing in for `user-tool`, mirroring `e2e/sidecar-tool-pod.test.ts`):
- GET mapping with path + query reaches the right URL and returns the body.
- POST mapping with a JSON body (type preservation verified at the server).
- `responsePath` extraction returns the selected field.
- A 404 from the server surfaces as a tool error.
Proves the real `tool-server.js` honors `KUBECLAW_TOOL_REQUEST_MAPPING` over
localhost.

**End-to-end (minikube-live):** register (via the catalog) an `http` tool
backed by a stock REST image with a `requestMapping`, invoke it, confirm the
mapped call returns. If a suitable tiny image is awkward in CI, assert the
narrower invariant at the manifest level — the bridge container receives the
`KUBECLAW_TOOL_REQUEST_MAPPING` env — since behavior is fully covered at the
integration level.

## Key files

| File | Change |
|---|---|
| `src/tools/types.ts` | Add `RequestMapping` interface + `requestMapping?` on `ToolSpec`; validate it in `validateTool` |
| `container/agent-runner/src/tool-server.ts` | `buildMappedRequest` + `extractResponsePath` helpers; mapping branch in `executeToolBridgeHttp` reading `KUBECLAW_TOOL_REQUEST_MAPPING` |
| `src/k8s/job-runner.ts` | Stamp `KUBECLAW_TOOL_REQUEST_MAPPING` into the bridge container env when `requestMapping` is set |
| Tests | unit (types + helpers), integration (`e2e/`), e2e (minikube-live) |

## Backward compatibility

`requestMapping` is optional. Any existing `http` tool without it keeps the
`POST /invoke` contract verbatim. `file`/`acp` tools are unaffected. No Redis
protocol or `SidecarToolPodJobSpec` type changes.
