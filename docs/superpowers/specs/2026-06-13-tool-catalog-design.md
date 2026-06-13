# Tool Catalog & Registration — Design

**Status:** Approved (brainstorming complete)
**Date:** 2026-06-13
**Author:** Peter + Claude

## Problem

KubeClaw tool-container definitions (`ToolSpec`) live today only in a per-group
`containerConfig.tools` JSON blob persisted in the `registered_groups` SQLite
column. There is no way to register a tool once and share it across groups or
channels, no operator workflow to add one (you hand-edit the JSON via
`register_group`), and no scoping mechanism. This is the gap that the
capabilities and specialists subsystems already solved for their domains.

This design adds a **cluster-wide tool catalog** with an operator registration
workflow, modeled directly on the proven specialists subsystem.

## Scope

**In scope (this spec):** cluster-wide registration of `ToolSpec`s — Helm
baseline, admin-shell CRUD, SQLite overrides, merged ConfigMap, per-channel
visibility, channel-side consumption, and orchestrator-side name resolution at
spawn time.

**Explicitly out of scope (separate follow-ons):**
- **Per-tool HTTP request-mapping** (letting unmodified REST containers work by
  mapping a tool call onto an arbitrary method/path/body). Touches the bridge /
  agent image; its own spec→plan→implement cycle.
- **Converting the static built-in tools** (`web_search`, `bash`, browser, file
  ops) into catalog entries. This spec leaves the static built-ins, MCP tools,
  and in-process local tools **untouched** — it replaces only the
  `containerConfig.tools` seam. The Helm `tools:` baseline ships **empty**.
- **Spawn-path hardening** beyond what already exists (SA-token opt-out,
  user-tool securityContext, imagePullSecrets, output caps, Envoy credential
  sidecar on tool pods).

## Chosen approach

**Mirror the specialists subsystem.** Reuse the exact pattern that already works
for specialists: Helm baseline ConfigMap → orchestrator merges with a SQLite
override table → writes a live ConfigMap → channel pods mount it and hot-reload
via `fs.watch`. Admin-shell gets register/edit/remove/list tools. The catalog
entry *is* the existing `ToolSpec` plus a `channels?: string[]` ACL field.

Rejected alternative: a live-query model (channel asks the orchestrator for its
tool list over Redis each turn) — puts the orchestrator on the hot path of every
message and abandons the proven fs.watch pattern for data that changes rarely.

## Architecture overview

```
REGISTRATION (rare):
  operator → admin-shell register_tool → SQLite tool_overrides
                                           │
        Helm tools: baseline ─────────────┤
        (/etc/kubeclaw/tools-baseline)     ▼
                              ToolReconciler.apply()  [orchestrator]
                              merge(baseline, overrides) → kubeclaw-tools ConfigMap
                                           │
                                  kubelet propagates
                                           ▼
                              channel pod: /etc/kubeclaw/tools/tools.json
                              ToolCatalogLoader fs.watch hot-reload

RUNTIME (per relevant turn):
  channel LLM tool list = catalog.getForChannel(KUBECLAW_CHANNEL)
  LLM calls a catalog tool
     → channel writes ONLY {name, args} to kubeclaw:spawn-tool-pod
        → orchestrator resolves ToolSpec by name from its own catalog
           → re-checks channel ACL
              → createSidecarToolPodJob (allowlist + per-job ACL apply)
                 → result on toolresults stream → back to the LLM
```

The orchestrator is the single authority for both *what tools exist* (phase 1)
and *what image a named tool maps to* (phase 2). The channel only ever holds
names, descriptions, and parameter schemas — never the image or spawn details.

## Components

### 1. Data model & types

`ToolSpec` moves to a dedicated module `src/tools/types.ts` (with its validator),
re-exported from `src/types.ts` for compatibility. It gains one field:

```typescript
/** Channels this tool is visible to. Empty/absent = all channels. */
channels?: string[];
```

Wire format (on-disk ConfigMap value and parse target), mirroring specialists'
`CatalogWire`:

```typescript
interface ToolCatalogWire {
  version: 1;
  generation: number;
  tools: ToolSpec[];
}
```

`validateTool` (modeled on `validateSpecialist`): allowed-keys whitelist;
`name` matches `^[A-Za-z][A-Za-z0-9_-]*$` (LLM-addressable, Redis stream-key
segment, K8s label); `description` non-empty; `parameters` an object; `image`
non-empty; `pattern` ∈ `{http, file, acp}`; `channels` (if present) a string
array. `parseToolCatalog` requires `version === 1` and **dedupes by name** —
names are globally unique (SQLite primary key). Same-name-in-different-channels
is disallowed, keeping name→spec resolution unambiguous.

The `containerConfig.tools` field is **deleted** from `ContainerConfig`
(`src/types.ts`). This is a breaking change: any existing per-group tools must be
re-registered in the catalog. (Consistent with the just-completed
catalog-is-the-only-source decision and the recent legacy-removal direction.)

### 2. Orchestrator side

**SQLite override table** (`src/db.ts`), mirroring `specialist_overrides`:

```sql
CREATE TABLE IF NOT EXISTS tool_overrides (
  name        TEXT PRIMARY KEY,
  spec_json   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

**Reconciler** (`src/tools/reconciler.ts`, modeled on `specialists/reconciler.ts`):
- `loadBaselineFromDisk('/etc/kubeclaw/tools-baseline/tools.json')` → `[]` on
  absence/error.
- `mergeCatalog(baseline, overrides)` — name-keyed Map, overrides win, sorted.
- `renderCatalog(tools, generation)` → `ToolCatalogWire` JSON.
- `ToolReconciler.apply()` — serialized behind a promise chain; reads baseline +
  `listToolOverrides()`, merges, increments generation, calls `configMapApply`
  to write `kubeclaw-tools` (GET resourceVersion → PUT, or CREATE on 404);
  generation rolls back on failure.
- Runs on orchestrator startup and after every admin CRUD mutation.

**Helm baseline.** New `tools:` stanza in `values.yaml` (ships **empty**) →
`templates/tools-baseline-configmap.yaml` rendering:
- `kubeclaw-tools-baseline` — mounted into the orchestrator at
  `/etc/kubeclaw/tools-baseline` (`optional: true`).
- `kubeclaw-tools` — an initial seed so channel mounts never dangle before the
  first reconcile; the orchestrator replaces it at startup via K8s PUT.

Both follow the specialists templates exactly.

**Spawn-time resolution** in `startToolPodSpawnWatcher` (`src/k8s/ipc-redis.ts`).
The orchestrator owns baseline + `tool_overrides`, so it resolves in-process (no
mount needed). New behavior when a spawn message names a catalog tool:

1. Resolve `ToolSpec` by name from the merged catalog. **Not found →** drop the
   spawn, log, **write an error to the toolresults stream** so the LLM turn ends
   cleanly rather than timing out.
2. **Re-check the channel ACL:** resolved spec's `channels` must be empty or
   include the stream's `channel`. Mismatch → reject + log.
3. Build the sidecar pod from the resolved spec via `createSidecarToolPodJob`
   (unchanged downstream — still subject to `TOOL_IMAGE_ALLOWLIST` and the
   per-job Redis ACL from prior hardening).

The stream fields `toolImage`/`toolPattern`/`toolPort`/`toolCommand`/`toolAcp*`/
`toolHealthPath` are **removed** — the orchestrator is now the single authority
on a named tool's image.

### 3. Channel side

**Loader** (`src/tools/catalog-loader.ts`, modeled on
`specialists/catalog-loader.ts`): `ToolCatalogLoader` mounts `kubeclaw-tools` at
`/etc/kubeclaw/tools/tools.json`; `start()` loads immediately then `fs.watch`es
the parent dir (50 ms debounce, catches kubelet's atomic `..data` symlink swap);
absent file → empty list, no error; parse failure → keep stale cache + warn.
Exposes `getAll()` and `getForChannel(channelName)` (tools whose `channels` is
empty or includes the name).

**Channel pod manifest.** `templates/channel-pods.yaml` mounts `kubeclaw-tools`
at `/etc/kubeclaw/tools` read-only (mirrors the specialists mount). Tool jobs do
**not** mount it — they receive a fully-resolved spec from the orchestrator.

**Rewiring `direct-llm-runner.ts`** (the two reads of `group.containerConfig?.tools`):
- **Seam 1 — LLM tool-list build (~line 1257):** read
  `toolCatalog.getForChannel(KUBECLAW_CHANNEL)` and map each to its
  `{name, description, parameters}` function definition. A module-singleton
  `ToolCatalogLoader` is started in `channel-runner.ts` `main()`, exactly like
  `specialistCatalog`.
- **Seam 2 — spawn-spec lookup (~line 513):** **removed on the channel side.**
  The channel no longer resolves image/pattern/port; `executeToolViaK8s` marks
  the call as a catalog tool and writes the tool **name** (+ args) to the spawn
  stream. The channel determines "this is a catalog tool, route to the sidecar
  path" by the name being present in its channel's catalog set (vs a static
  built-in like `bash`, which routes to the `execution`/`browser` category).

**Specialist interaction:** a specialist's `tools: [...]` allowlist
(`toolFilter`) keeps working unchanged — it filters the assembled list by name,
and catalog tools are part of that list. A specialist can only narrow, never
widen.

**Direct-mode parity:** when `DirectLLMRunner` runs in-process in the
orchestrator (not channel-pod mode), it already calls `createSidecarToolPodJob`
directly rather than via the stream; there it resolves from the same in-process
catalog the orchestrator owns. Both execution modes share one resolution
authority.

### 4. Admin-shell registration

Four tools in `src/admin-shell.ts`'s `TOOLS` array + handlers, mirroring the
specialist registry. CRUD in a new `src/skills/orchestrator/tool-registry.ts`
(`registerTool`/`editTool`/`removeTool`/`listToolOverrides`), each taking the
reconciler's `apply` as a callback so a mutation persists to SQLite **and**
rewrites the ConfigMap in one step.

| Tool | Required | Optional |
|---|---|---|
| `register_tool` | `name`, `description`, `parameters`, `image`, `pattern` | `port`, `command`, `healthPath`, `pullPolicy`, `channels`, `acpAgentName`, `acpMode`, resource fields |
| `edit_tool` | `name` | any of the above (partial patch merged onto stored spec) |
| `remove_tool` | `name` | — |
| `list_tools` | — | — |

`register_tool` runs `validateTool` and errors if the name exists or is
malformed; `list_tools` shows each tool with its `channels` scope and image.
Output is human-readable strings (admin shell is an LLM-driven REPL).

## Error handling & edge cases

- **Catalog absent / empty:** loader returns `[]`; LLM sees no catalog tools
  (built-ins/MCP still present). No error.
- **Malformed ConfigMap after an edit:** loader keeps last-good cache + warns; a
  bad write can't blank a running channel's tools.
- **Reconcile / ConfigMap write fails:** generation rolls back; SQLite already
  holds the override, so the next successful `apply()` heals it.
- **Unknown tool name at spawn:** orchestrator drops the spawn, logs, writes an
  error to the toolresults stream (clean LLM-turn failure).
- **Channel-ACL mismatch at spawn:** rejected + logged; surfaced as an error
  result.
- **Name collision on register:** rejected by PK + validator with a clear
  message.
- **Name collides with a static built-in** (e.g. registering a tool named
  `bash`): `validateTool` rejects names in the reserved static-tool set
  (`TOOL_SERVER_NAME` keys in `direct-llm-runner.ts` — `web_fetch`,
  `web_search`, `browser`, `bash`, `places_search`) so a catalog tool can never
  shadow or be shadowed by a built-in. The channel's spawn routing checks the
  built-in category map first; the reserved-name guard keeps that unambiguous.
- **Image not in `TOOL_IMAGE_ALLOWLIST`:** unchanged — `createSidecarToolPodJob`
  throws; surfaced as a spawn error. Registration does **not** check the
  allowlist (the allowlist is the deploy-time gate); enforcement stays at spawn.
- **Removing a tool mid-flight:** in-progress pod finishes; new invocations fail
  name resolution. Acceptable (same as removing a capability).

## Testing (three levels)

**Unit:**
- `validateTool` / `parseToolCatalog` (valid / invalid / dedupe / channels).
- `mergeCatalog` (baseline+override precedence, sort).
- Reconciler render + generation rollback.
- `getForChannel` ACL filtering.
- Orchestrator spawn-watcher name resolution + ACL re-check (resolve;
  not-found→error-result; wrong-channel→reject).
- Admin registry CRUD against an in-memory DB.
- `direct-llm-runner` seam-1 build sourcing from the catalog.

**Integration:**
- `ToolCatalogLoader` against a real temp file with `fs.watch` (initial load,
  hot-reload on rewrite, stale-cache-on-bad-parse) — mirrors the existing
  specialists catalog-loader test.
- Redis round-trip: channel writes only a name; orchestrator resolves + spawns
  (reuse the `sidecar-tool-pod` harness).

**End-to-end (minikube-live):**
- Register a tool scoped to a channel via the admin-shell path; confirm
  `kubeclaw-tools` ConfigMap updates and a tool call spawns the right image.
- Confirm a tool scoped to a *different* channel is invisible and rejected if
  named.

## Key files

| File | Change |
|---|---|
| `src/tools/types.ts` | New — `ToolSpec` (+`channels`), `ToolCatalogWire`, `validateTool`, `parseToolCatalog` |
| `src/tools/reconciler.ts` | New — baseline load, merge, render, `ToolReconciler` |
| `src/tools/catalog-loader.ts` | New — `ToolCatalogLoader` (fs.watch, `getAll`/`getForChannel`) |
| `src/skills/orchestrator/tool-registry.ts` | New — SQLite CRUD for `tool_overrides` |
| `src/types.ts` | Remove `containerConfig.tools`; re-export `ToolSpec` from new module |
| `src/db.ts` | New `tool_overrides` table + accessors |
| `src/admin-shell.ts` | Add `register_tool`/`edit_tool`/`remove_tool`/`list_tools` + handlers |
| `src/index.ts` | Start `ToolReconciler` at orchestrator startup |
| `src/channel-runner.ts` | Start `ToolCatalogLoader` singleton in `main()` |
| `src/runtime/direct-llm-runner.ts` | Seam 1 sources from catalog; seam 2 channel-side lookup removed |
| `src/k8s/ipc-redis.ts` | Spawn watcher resolves ToolSpec by name + ACL re-check; drop tool* stream fields |
| `helm/kubeclaw/values.yaml` | New empty `tools:` stanza |
| `helm/kubeclaw/templates/tools-baseline-configmap.yaml` | New — baseline + seed ConfigMaps |
| `helm/kubeclaw/templates/channel-pods.yaml` | Mount `kubeclaw-tools` |
| `helm/kubeclaw/templates/orchestrator.yaml` | Mount `kubeclaw-tools-baseline` |
