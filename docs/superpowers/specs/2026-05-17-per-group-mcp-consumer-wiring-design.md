# Per-Group MCP Consumer Wiring — Design

**Date:** 2026-05-17
**Status:** Approved (brainstorming)
**Phase:** Phase B, Spec 1 of 3 (consumer wiring → then filesystem → then docling, as separate specs)
**Foundation:** Phase A merged in `05eef2f`. Reference: `docs/superpowers/specs/2026-05-17-per-group-mcp-capabilities-phase-a-design.md`.

## Goal

Wire the channel runtime to consume per-group MCP capabilities introduced in Phase A. After this spec lands, a channel pod can advertise a `mcp__<capability>__<tool>` tool to the LLM, have the orchestrator scale up the group's per-(group × capability) pod on demand when the tool is called, and route the MCP HTTP call to the resolved endpoint.

This spec ships the consumer plumbing only. Filesystem and docling capability implementations are the next two specs.

## Non-goals

- Filesystem and docling MCP servers themselves (separate specs)
- HTTP session pooling — v1 uses per-call MCP sessions
- Transparent retries on transient failures — v1 returns errors to the LLM
- Per-channel ACLs on group-scoped capabilities beyond Phase A's existing `channels: []` filter
- Schema invalidation without an image-tag change (operator bumps tag to force re-scrape)
- Custom `tools/list` parameters or pagination
- Pre-warming / anticipatory scale-up

## Background

Phase A delivered the orchestrator-side foundation: per-(group × capability) Deployments, scale-up on Redis-stream discovery requests, scale-down sweeper, GC. No production code in `src/runtime/` or `src/channel-runner.ts` currently consumes this foundation — the discovery RPC stream has no producers, and `getMcpEntries(channelName)` returns cluster-scoped entries only.

This spec adds the consumer side: the channel runtime learns about group-scoped MCPs via the existing push-based `capabilities_update` IPC, advertises their tools to the LLM with cached schemas, and resolves endpoints lazily at tool-call time via the discovery RPC.

## Architecture

### Data flow

```
Orchestrator                                        Channel pod
─────────────                                       ─────────────

Reconciler creates per-group Deployment
  (replicas: 0, no schema cached yet)
  ↓
Background scraper sees missing schema:
  - scale to 1 → tools/list → scale to 0
  - cache schemas in SQLite per
    (capability_name, image)
  ↓
Push capabilities_update over Redis IPC
  with mcp-group templates:                          channel-runner receives
  { kind: 'mcp-group',                               capabilities_update
    name: 'filesystem',                              ↓
    state: 'ready',                                  configureGroupMcpTemplates(templates)
    toolSchemas: [...] }                       ────→ stored in McpManager
                                                     ↓
                                                     Tool list = cluster tools
                                                     + group templates renamed to
                                                     mcp__filesystem__read_file etc.
                                                     ↓
                                                     LLM calls
                                                     mcp__filesystem__read_file
                                                     ↓
                                                     McpManager.callTool(name, args,
                                                       { groupFolder: 'Family' })
                                                     ↓
                                                     Publish discovery request to
Receive discovery request:                           Redis stream
  { capability: filesystem,                    ←──── publish
    group: Family }
  ↓
scaleUpInstance() — Phase A code
  - patch Deployment replicas → 1
  - wait for ready
  - return { state: 'ready', endpoint }
  ↓                                                  Receive response, open MCP
Write response key                            ────→  HTTP session, forward tools/call
                                                     ↓
                                                     Return result to LLM
```

### Discriminated-union extension

`src/capabilities/types.ts`:

```ts
export type CapabilityDiscoveryEntry =
  | ClusterMcpEntry      // existing: kind: 'mcp'
  | RagEntry             // existing
  | HttpEntry            // existing
  | GroupMcpEntry;       // NEW

export interface GroupMcpEntry {
  name: string;
  kind: 'mcp-group';
  // No endpoint — resolved per-call via discovery RPC
  state: 'ready' | 'pending-schema' | 'failed';
  toolSchemas?: McpToolSchema[];   // present iff state='ready'
  allowedTools?: string[];          // optional filter (from spec)
  error?: string;                   // present iff state='failed'
}

export interface McpToolSchema {
  name: string;          // bare tool name from upstream MCP server
  description?: string;
  inputSchema: unknown;  // JSON Schema, opaque to us
}
```

Every existing `switch (kind)` site in the codebase needs the new variant. Phase A's `discovery.ts` already returns the existing variants with optional `state`/`error` for the group-scoped scale-up path; this spec consolidates the model around `mcp-group` as a first-class variant.

### Tool-name prefix scheme

All MCP tools, **cluster and group**, are renamed to `mcp__<capability>__<tool>` at the channel/LLM surface.

- Format chosen because Claude's own MCP-tool naming uses this convention, so the LLM has training-data prior for it.
- OpenAI tool-name validation safe (`^[a-zA-Z0-9_-]+$` — double underscores pass).
- Collision-free across capabilities.

**Breaking change:** Existing cluster-scoped MCP tools (e.g., `query_vectors` on a Qdrant capability) are renamed to `mcp__qdrant-rag__query_vectors`. Operator action required after upgrade — see Migration section.

### Channel context plumbing

`McpManager.callTool(name, args, ctx?: { groupFolder?: string })` — explicit ctx threading.

- `getTools()` is group-agnostic: advertises group-template tools for any group the channel handles (per-group ACL beyond the existing `channels: []` filter is out of scope).
- Binding to a specific group happens at call time via `ctx.groupFolder`.
- The direct-llm-runner already has `groupFolder` in scope at the `callTool` site (`src/runtime/direct-llm-runner.ts:1289`); no upstream refactor needed.

## Components

### New: `src/per-group-capabilities/schema-scraper.ts` (orchestrator)

Background async loop, runs alongside the Phase A reconciler/sweeper. Triggered by a simple timer:

- Orchestrator startup (first tick)
- Periodic every 60 seconds thereafter (matches the existing sweeper cadence)

No coupling to reconcile-completion events — the timer is enough. A capability whose per-group Deployments don't exist yet will simply skip and retry on the next tick (typically within 60s of the first group being registered).

Each tick:

1. Scan capability specs for `scope: group`. For each whose `(capability_name, image)` has no row in `capability_tool_schemas`:
2. Find any one existing per-group Deployment for this capability via SQLite `per_group_capability_instances`. If none → skip (no groups registered yet for this capability; will retry next tick).
3. `patchDeploymentReplicas → 1`, `waitForReady` (30s timeout).
4. Open MCP HTTP session to the pod's Service, send `tools/list`, capture response.
5. Write to `capability_tool_schemas` (capability_name, image, schemas_json, scraped_at).
6. Immediately scale Deployment back to 0 (`patchDeploymentReplicas → 0`).
7. Push `capabilities_update` for this capability to channels (`state: 'ready'` with schemas).

On failure (steps 3–4): log warn, leave the row missing, retry next tick. Cap retries at 3 per orchestrator-process lifetime per `(capability_name, image)` — after 3 attempts the scraper stops trying until the orchestrator restarts or the image tag changes. Retry counter is in-memory only (lost on restart, which is the intended reset semantics). No SQLite row is written for failures.

Schemas are immutable per image tag. Bumping the tag changes the cache key → triggers re-scrape on the next tick.

### New: SQLite table `capability_tool_schemas`

```sql
CREATE TABLE IF NOT EXISTS capability_tool_schemas (
  capability_name TEXT NOT NULL,
  image           TEXT NOT NULL,
  schemas_json    TEXT NOT NULL,    -- serialized McpToolSchema[]
  scraped_at      INTEGER NOT NULL, -- unix seconds
  PRIMARY KEY (capability_name, image)
);
```

Lives in `src/db.ts` `createSchema`. Idempotent `IF NOT EXISTS`. CRUD helpers in a new `src/per-group-capabilities/schema-cache.ts`:

- `cacheSchemas(capabilityName, image, schemas): void`
- `getCachedSchemas(capabilityName, image): McpToolSchema[] | null`
- `clearCachedSchemas(capabilityName, image): void`

### Modified: `capabilities_update` payload

The Redis IPC payload that already pushes cluster MCPs grows the `mcp-group` variant. Producer-side (orchestrator) builds the augmented payload by joining the capability spec with the cached schema:

```jsonc
{
  "channel": "telegram",
  "capabilities": [
    {
      "kind": "mcp",
      "name": "qdrant-rag",
      "endpoint": "http://kubeclaw-rag-qdrant.kubeclaw.svc:8000",
      "kindMetadata": { "path": "/mcp", "allowedTools": ["query_vectors"] }
    },
    {
      "kind": "mcp-group",
      "name": "filesystem",
      "state": "ready",
      "toolSchemas": [
        { "name": "read_file", "description": "...", "inputSchema": { ... } },
        { "name": "write_file", "description": "...", "inputSchema": { ... } }
      ],
      "allowedTools": ["read_file", "write_file"]
    },
    {
      "kind": "mcp-group",
      "name": "github",
      "state": "pending-schema"
    }
  ]
}
```

Channel-runner's `capabilities_update` handler grows one branch:

```ts
const clusterMcp = capabilities.filter(c => c.kind === 'mcp').map(toClusterServer);
const groupMcp   = capabilities.filter(c => c.kind === 'mcp-group');
await runner.configureMcp(clusterMcp);
await runner.configureGroupMcpTemplates(groupMcp);
```

### New: `src/capabilities/discovery-client.ts` (channel-side)

Channel-side counterpart to the orchestrator-side `discovery.ts` handler. Publishes Redis-stream discovery requests + polls for responses. Mirrors the existing tool-job IPC pattern at `src/runtime/direct-llm-runner.ts:398-510`.

```ts
export async function requestGroupCapability(
  capability: string,
  groupFolder: string,
  timeoutMs?: number,            // default 35_000
): Promise<{ endpoint: string } | { error: string }>;
```

Mechanics:

- `crypto.randomUUID()` for `requestId`.
- `XADD` to `kubeclaw:discovery:request` stream with `{ requestId, capability, group: groupFolder }`.
- Poll `GET kubeclaw:discovery:response:{requestId}` at 200ms intervals until non-null or timeout.
- Parse response, return endpoint or error.

Timeout slightly exceeds the orchestrator's `discoveryTimeoutMs` (30s default) to allow transport overhead.

### Modified: `src/runtime/mcp-manager.ts`

New method:

```ts
async configureGroupMcpTemplates(templates: GroupMcpEntry[]): Promise<void>
```

Stores `state: 'ready'` templates in an internal map keyed by capability name. Drops `state: 'pending-schema'` and `state: 'failed'` entries (they don't get advertised — the LLM never sees a broken tool).

Modified methods:

- `getTools()`: returns the union of cluster MCP tools + group-template tools, all renamed `mcp__<capability>__<tool>`. Existing cluster tools also get the prefix (breaking change — see Migration).
- `hasTool(name)`: matches against the prefixed names.
- `callTool(name, args, ctx?)`:
  1. Parse `mcp__<capability>__<tool>`. If parse fails → existing built-in tool path (unchanged).
  2. Look up capability in the internal registry.
  3. **Cluster-scoped:** call existing endpoint as today.
  4. **Group-scoped:**
     - Require `ctx.groupFolder` (throw otherwise — programmer error).
     - `requestGroupCapability(capability, ctx.groupFolder)`.
     - If error → return MCP-protocol error: `{ isError: true, content: [{ type: 'text', text: 'capability unavailable: <error>' }] }`.
     - If endpoint → open one-shot MCP HTTP session, send `tools/call { name: <bare tool>, arguments: args }`, return result.

### Modified: `src/runtime/direct-llm-runner.ts`

`callTool` invocation site (line 1289):

```ts
result = await this.mcpManager.callTool(call.function.name, args, {
  groupFolder: group.folder,
});
```

The runner already has `group: RegisteredGroup` in scope at this point. Pass `groupFolder`.

### Modified: `src/capabilities/client.ts`

Unified async API per the architecture decision. `getMcpEntries(channelName)` is deleted; new function:

```ts
export async function getMcpEntriesAsync(
  channelName: string,
  groupFolder: string | undefined,
): Promise<CapabilityDiscoveryEntry[]>;
```

The cluster path is sync internally; the function is async so the caller pattern is uniform (and future scopes can extend without re-breaking callers). For Phase B v1, no caller actually awaits a meaningful async — but it's the right shape.

### Modified: `src/capabilities/discovery.ts` (orchestrator)

When the orchestrator builds a `capabilities_update` payload for push to channels, joining specs with the schema cache:

- For `scope: cluster` MCP specs → existing `kind: 'mcp'` entry, unchanged.
- For `scope: group` specs:
  - Look up schemas via `getCachedSchemas(capability_name, image)`.
  - If present → `kind: 'mcp-group', state: 'ready', toolSchemas: [...]`.
  - If absent → `kind: 'mcp-group', state: 'pending-schema'`.

The existing per-request Redis-stream handler (Phase A) is unchanged — it already handles the per-call scale-up + endpoint resolution. This spec only changes the push-based `capabilities_update` payload assembly.

## Tool-call error UX

| Failure | LLM-visible result |
|---|---|
| Cold-start timeout (30s exceeded by orchestrator-side wait) | `{ isError: true, content: 'capability unavailable: pod did not become ready in 30s' }` |
| Discovery RPC timeout (35s exceeded by channel-side poll) | `{ isError: true, content: 'discovery timeout' }` |
| MCP HTTP call error (connection refused, malformed response, etc.) | `{ isError: true, content: 'MCP call failed: <error>' }` |
| `ctx.groupFolder` missing on a group-scoped call | Thrown (programmer error — `hasTool()` should have routed differently) |
| Tool not in cached schema | Thrown — `hasTool()` would have returned false; the call shouldn't have been attempted |

No transparent retries. The LLM observes errors and decides whether to retry, work around, or surface to the user.

## HTTP session lifecycle

v1: **one MCP session per call.**

- Open Streamable HTTP transport.
- Send `initialize`.
- Send `tools/call { name, arguments }`.
- Close.

Profiling can drive v2 session pooling per `(groupFolder, capability)`. Personal-AI scale doesn't justify the complexity upfront.

## Migration

### Breaking change: cluster MCP tool name prefix

Every cluster-scoped MCP tool gets renamed from `<tool>` to `mcp__<capability>__<tool>`.

**Operator action after upgrade:**

```bash
# Find any prompts referencing flat MCP tool names:
grep -rn "query_vectors\|read_file\|<other-mcp-tool>" groups/*/CLAUDE.md groups/*/skills/*.md

# Update each reference to the new prefixed form, e.g.:
#   query_vectors  →  mcp__qdrant-rag__query_vectors
#   read_file      →  mcp__filesystem__read_file
```

Affected file types:

- `groups/{group}/CLAUDE.md` — per-group memory; may name MCP tools in instructions.
- `groups/{group}/skills/*.md` — learned skills; may name tools.
- Any scheduled-task `prompt` field stored in SQLite — operators with custom-scripted tasks should audit.

In-flight conversations during the upgrade may produce one failed tool call if the LLM tries a stale name; the next turn picks up the new names from the system-prompt-injected tool list.

CHANGELOG entry under "Breaking changes" with the grep patterns.

### Additive change: `mcp-group` discovery entry variant

Any code path that switches on `CapabilityDiscoveryEntry.kind` needs the new case. The TypeScript compiler will catch any missing cases. Audit `git grep "case 'mcp'"` to find them all.

## Tests

All three levels per project policy.

### Unit

- `src/per-group-capabilities/schema-scraper.test.ts` — scrape against `FakePerGroupK8sClient` + stubbed MCP HTTP server (use `msw` or a minimal http server). Verify: scale-up/down sequence, cache write, retry-on-failure cap at 3, no row written on failure, schema present after success.
- `src/per-group-capabilities/schema-cache.test.ts` — CRUD on `capability_tool_schemas` against `_initTestDatabase`.
- `src/capabilities/discovery-client.test.ts` — mock Redis client; verify request publish (correct stream key + fields), poll-for-response, timeout returns `{ error: '...' }`.
- `src/runtime/mcp-manager.test.ts` (extended) — tool-name prefixing for cluster + group; `callTool` parses prefix and routes correctly; cluster-scoped call goes through existing path; group-scoped call without `ctx.groupFolder` throws; group-scoped call with failed discovery returns MCP-protocol error result (not throw); `configureGroupMcpTemplates` drops non-`ready` entries.
- `src/capabilities/client.test.ts` — `getMcpEntriesAsync` returns both kinds with correct shape; `pending-schema` entries omitted from `getTools()` source.
- `src/db.test.ts` (extended) — `capability_tool_schemas` table exists after `createSchema`.

### Integration (real K8s + Redis; `vitest.e2e.config.ts`)

New file `e2e/per-group-mcp-consumer-integration.test.ts`:

- **Schema scraper end-to-end:** spin up `kubeclaw-echo-mcp` test image; run scraper against a real cluster + a per-group Deployment created via Phase A reconciler. Assert cache row written with the `echo` tool schema. Assert Deployment scales back to 0.
- **Discovery client round-trip:** channel-side `requestGroupCapability('echo', 'itest-1')` against a running orchestrator-side discovery handler. Assert response contains a `mcp-echo-<hash>.kubeclaw.svc:3000` endpoint. Open a real MCP HTTP session to that endpoint, call `echo("hello")`, assert response.

### E2E (full Helm install)

New file `e2e/per-group-mcp-consumer-e2e.test.ts`:

- Install kubeclaw via Helm with `capabilities.echo: { scope: group }` declared in values.
- Register a group via admin shell.
- Wait for schema scrape to complete (poll `capability_tool_schemas` until row present, or wait for the next `capabilities_update`).
- Send a message that prompts the LLM to call `mcp__echo__echo` with `msg=hello`. Assert reply contains `hello`.
- After the call, assert the per-group Deployment was scaled to 1 during the call. Wait past `scaleDownAfterIdleSeconds`. Assert Deployment scales back to 0.

## Telemetry

New structured log events (pino):

- `schema_scrape_started` (capability, image)
- `schema_scrape_completed` (capability, image, tool_count, duration_ms)
- `schema_scrape_failed` (capability, image, attempt, error, will_retry)
- `discovery_client_request` (capability, group)
- `discovery_client_response` (capability, group, state, duration_ms)
- `mcp_group_tool_call` (capability, tool, group, duration_ms, status)

No new SQLite metrics tables.

## Open questions surfaced but punted

- **Scraper running before any group registered:** if the operator installs a group-scoped capability but no groups exist, no per-group Deployment exists to scrape. Scraper skips until at least one group exists. The first user-facing turn for the first group registers will see the capability in `pending-schema` state. Acceptable for v1.
- **Schema staleness within the same image tag:** schemas are cached forever (until image tag changes). If a server starts returning different schemas for the same image tag (rare; non-deterministic startup), we have no detection mechanism. Acceptable for v1.
- **Tool-name collisions across cluster and group capabilities:** the prefix scheme makes intra-capability collisions impossible, but if two different capability names hash to the same prefixed string... they can't, because the capability name is in the prefix. Solved by construction.

## Phasing within this spec

Tasks naturally order:

1. SQLite `capability_tool_schemas` table + CRUD helpers
2. Discriminated-union extension (`GroupMcpEntry`, `McpToolSchema`)
3. Schema scraper module
4. `capabilities_update` payload assembly (orchestrator-side join with schema cache)
5. Discovery-client module (channel-side Redis RPC client)
6. McpManager extensions (`configureGroupMcpTemplates`, prefixed `getTools`, ctx-aware `callTool`)
7. `getMcpEntries` → `getMcpEntriesAsync` refactor (callers + tests)
8. `direct-llm-runner.ts` callTool site (pass groupFolder ctx)
9. Channel-runner `capabilities_update` handler branch
10. Integration tests
11. E2E test
12. Migration docs in CHANGELOG + grep patterns
13. Final sweep + verification

## Architecture references

- Phase A foundation: `docs/superpowers/specs/2026-05-17-per-group-mcp-capabilities-phase-a-design.md`
- Phase A implementation: `src/per-group-capabilities/`
- Existing MCP manager: `src/runtime/mcp-manager.ts`
- Existing capability discovery: `src/capabilities/discovery.ts` (orchestrator), `src/capabilities/client.ts` (sync facade)
- Existing tool-job IPC pattern (reference for discovery-client): `src/runtime/direct-llm-runner.ts:398-510`

---

**Approval state:** Conversationally approved 2026-05-17 in brainstorming session.
