# Agent-Runner Catalog Unification — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Builds on:** the shipped bash/web/browser catalog conversions (web-tools, browser-cdp-bridge)

## Problem

KubeClaw runs LLM tool calls through two different execution paths:

- **Channel pods** (`DirectLLMRunner`, `src/runtime/direct-llm-runner.ts`) are already
  catalog-driven. Their static tool list is *only* in-process/IPC tools
  (`execute_agent`, `schedule_task`, `list_tasks`, `cancel_task`, `pause_task`,
  `deploy_mcp_server`, `remove_mcp_server`, `list_mcp_servers`, `propose_skill`,
  `places_search`). Everything else — `bash`, `bash_persist`, `web_fetch`,
  `web_search`, `browser` — is loaded dynamically from the tool catalog
  (`toolCatalog.getForChannel(KUBECLAW_CHANNEL)` → `buildCatalogToolDefs`) and
  executed **by name** via the `kubeclaw:spawn-tool-pod` stream →
  `createSidecarToolPodJob` (stock image + bridge). `read`/`write`/`edit`/`glob`/`grep`
  do not exist in the channel at all — file ops are done through `bash`/`bash_persist`.

- **The legacy agent-runner** (`container/agent-runner/src/index.ts`, a
  `@mariozechner/pi-agent-core` autonomous loop run as a K8s Job) never got migrated.
  It still hardcodes routed AgentTools (`bash`, `read`, `write`, `edit`, `glob`,
  `grep`, `web_fetch`, `web_search`, `agent_browser`) and executes them **by
  category** through a pub/sub `tool_pod_request` + ACK handshake →
  `processTaskIpc` → `createToolPodJob(category)` → a `tool-server` pod running
  `executeToolLocal`.

The result is dual-existence: e.g. `bash` runs one way for the channel (catalog
sidecar) and another for agent jobs (`executeToolLocal` via the `execution`
category). The `'execution'` category is used **exclusively** by the agent-runner;
the channel routes nothing to it.

We keep the agent-runner (its autonomous multi-turn loop, K8s-Job isolation,
multi-provider support via `pi-ai`, and group-PVC workspace are all load-bearing
and have no `DirectLLMRunner` equivalent — see the `agent-runner-unification`
investigation). What we unify is the agent-runner's tool **execution**: make it
mirror the channel's catalog path so there is exactly one way to run a catalog tool.

## Goal

Normal agent jobs (`execute_agent` sub-agents, scheduled tasks, non-`direct`
channel messages) become catalog consumers, identical to the channel:

- load the tool catalog,
- expose catalog tools by name to the LLM (ACL-filtered),
- execute them through the same `spawn-tool-pod` stream the channel uses,
- drop the bespoke file-op tools (file ops go through `bash`/`bash_persist`).

Bootstrap (Mode 1) stays the **untouched privileged exception**: it keeps its
`local_*` file tools, the `/runtime` PVC mount, and `ask_admin`/`commit_channel_config`.

## Non-goals (explicit)

- Bootstrap Mode 1 behavior — unchanged.
- Converting `places_search` to a catalog tool — separate follow-on.
- Deleting `executeToolLocal` / `createToolPodJob` wholesale — they remain for
  the `places` category until the places follow-on lands.
- Any change to the channel's `DirectLLMRunner` (it is already the target shape).

## Confirmed current-state facts (the design rests on these)

| Fact | Location |
| --- | --- |
| `bash` (mount `scratch`, ephemeral) and `bash_persist` (mount `group`, persistent) are `file`-bridge catalog tools; `web_fetch`/`web_search`/`browser` likewise | `helm/kubeclaw/values.yaml:500-566` |
| `DirectLLMRunner` loads the catalog dynamically and builds tool defs from `getForChannel(KUBECLAW_CHANNEL)` | `direct-llm-runner.ts:1195-1197`, `buildCatalogToolDefs` `:398-409` |
| Channel's only builtin-category tool is `places_search` → `'places'`; `'execution'` is unused by the channel | `direct-llm-runner.ts:387-394` (`TOOL_CATEGORY`) |
| `BUILTIN_CATEGORIES = {'execution','places'}`; spawn watcher branches builtin → `createToolPodJob`, else catalog-by-name → `createSidecarToolPodJob` (re-resolves spec + re-checks `spec.channels` ACL) | `ipc-redis.ts:279`, `startToolPodSpawnWatcher` `:998-1125` |
| Channel spawn: `XADD kubeclaw:spawn-tool-pod` with `{agentJobId, groupFolder, category, timeout, channel}`; writes call to `kubeclaw:toolcalls:{agentJobId}:{category}` **before** spawn; reads results from `kubeclaw:toolresults:{agentJobId}:{category}` starting `lastId='0-0'`, correlating by `requestId` | `direct-llm-runner.ts:440-472, 506-539` |
| Agent-runner spawn (legacy): pub/sub `tool_pod_request{category}` to `kubeclaw:tasks:{groupFolder}` + `waitForToolPodAck`; then identical toolcalls/toolresults streams but reads from `lastId='$'` | `index.ts:350-414` |
| `tool_pod_request` is published **only** by the agent-runner | `index.ts:365-371` (sole producer) |
| `ToolCatalogLoader` is standalone — `new ToolCatalogLoader(path).load()` works without `.start()`/watch; `getForChannel(name)` returns non-restricted + channel-matched tools | `src/tools/catalog-loader.ts` |
| Agent job + execution tool pod already co-mount `kubeclaw-groups` subPath=groupFolder at `/workspace/group` | `job-runner.ts` `generateJobManifest` / `createToolPodJob` |

## Design

### 1. Catalog loading in the agent-runner

The agent job manifest (`generateJobManifest`, `src/k8s/job-runner.ts`) gains a
`kubeclaw-tools` ConfigMap volume mounted at `/etc/kubeclaw/tools` — the same
mount the channel pod gets (`channel-pods.yaml`). At startup the runner constructs
`new ToolCatalogLoader('/etc/kubeclaw/tools/tools.json')` and calls `.load()` once
(no `.start()`/`fs.watch` — agent jobs are short-lived).

**Bootstrap (Mode 1) does not get this mount or loader.** Its tool surface is
unchanged (hardcoded `local_*` + `ask_admin`/`commit_channel_config`).

### 2. Tool assembly (`buildToolDefinitions`, agent-runner `index.ts ~618`)

- **Drop** the hardcoded routed AgentTools: `bash`, `read`, `write`, `edit`,
  `glob`, `grep`, `web_fetch`, `web_search`, `agent_browser`.
- **Add** catalog tools: for each `ToolSpec` from
  `loader.getForChannel(process.env.KUBECLAW_CHANNEL ?? '')`, build an AgentTool
  whose `name`/`description`/`parameters` come from the spec and whose `execute`
  calls the unified by-name dispatch (§3).
  - `getForChannel('')` returns only non-channel-restricted tools — **ACL option A**
    for scheduler jobs (no channel context).
  - `execute_agent` sub-agents already carry `KUBECLAW_CHANNEL`, so they also
    receive channel-scoped tools — **ACL option B-lite, at no extra cost.**
- **Keep** unchanged the in-process / IPC tools: `send_message`, `schedule_task`,
  `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `update_task`, and the
  `isMain`-gated `register_group` / `deploy_channel` / `control_channel`.
- **Keep** the `isSuperuser`-gated `local_*` tools (`local_bash`/`local_read`/
  `local_write`/`local_edit`). They are double-gated (superuser flag OR bootstrap
  mode) and unreachable by normal jobs; they survive any rewiring.

File ops for normal agents are done through `bash` (ephemeral scratch) and
`bash_persist` (group filesystem) — no bespoke file tools, matching the channel.

### 3. By-name execution (`callToolViaRedis` rewrite, `index.ts:350-414`)

The bottom half of `callToolViaRedis` — writing the call to
`kubeclaw:toolcalls:{agentJobId}:{name}` and correlating a result on
`kubeclaw:toolresults:{agentJobId}:{name}` by `requestId` — is **already identical**
to the channel. Only the top half changes:

- Replace the `tool_pod_request` pub/sub publish + `waitForToolPodAck` with a
  single `XADD kubeclaw:spawn-tool-pod` carrying
  `{agentJobId, groupFolder, category: toolName, timeout, channel: KUBECLAW_CHANNEL ?? ''}`.
  Dedup the spawn per tool-name using the existing `podReadyMap` (keyed by name).
- Write the call **before** the spawn XADD and change the results read from
  `lastId='$'` to `lastId='0-0'` — the channel's race-free pattern (the pod reads
  calls from `0-0`, so a result produced before the reader starts is not missed).
  Correlation by `requestId` makes re-scanning prior entries harmless.
- Use `toolSpec.timeout` when present for both the spawn `timeout` field and the
  result-wait deadline (so `browser`'s 600 s works); default to the existing 60 s
  otherwise.

The orchestrator side needs **no change**: `startToolPodSpawnWatcher` already
resolves a catalog tool by name, re-checks `spec.channels` against the supplied
`channel`, and calls `createSidecarToolPodJob`. A scheduler job sends `channel=''`,
so the orchestrator's ACL check rejects channel-restricted tools — consistent with
§2's client-side filter (defense in depth, no divergence).

### 4. Dead-machinery removal (each gated on a no-remaining-caller check)

After §2–§3, these have no producer. Remove them, verifying reachability first:

- The `tool_pod_request` handler in `processTaskIpc` (`ipc-redis.ts ~751`) and the
  `waitForToolPodAck` path — the agent-runner was the sole publisher.
- `'execution'` from `BUILTIN_CATEGORIES` (`ipc-redis.ts:279`), the `'execution'`
  arm of `createToolPodJob`, and the execution-category cases in `executeToolLocal`
  (`bash`/`read`/`write`/`edit`/`glob`/`grep`/`todoWrite`/`notebookEdit`).
  After removal, a stray `category='execution'` would fall to the catalog branch
  and return a clean "Unknown tool" error; nothing sends it.

**Untouched:** all `places` machinery (the `'places'` category, the `places` arm of
`createToolPodJob`, and `executeToolLocal`), pending the places follow-on.

### 5. Minor cleanup en route

Fix the stale comment in `agent-runner/src/index.ts` that says `KUBECLAW_SUPERUSER`
is "for privileged groups" — it is bootstrap-only. (Only because we are editing
this file already.)

## Data flow (after unification — identical for channel and agent)

```
LLM tool call (catalog tool, by name)
  └─ runner: XADD kubeclaw:toolcalls:{job}:{name}  {requestId, tool, input}
  └─ runner: XADD kubeclaw:spawn-tool-pod          {agentJobId, groupFolder,
                                                     category=name, timeout, channel}
        └─ orchestrator startToolPodSpawnWatcher: resolveTool(name) + ACL(spec.channels, channel)
              └─ createSidecarToolPodJob(stock image + bridge)
                    └─ sidecar reads toolcalls from 0-0, executes, 
                       XADD kubeclaw:toolresults:{job}:{name} {requestId, result|error}
  └─ runner: block-read toolresults from 0-0, match requestId → return to LLM
```

## Testing (all three levels)

**Unit**
- `buildToolDefinitions` builds catalog AgentTools from a fake catalog and keeps the
  IPC tool set; dropped tools (`read`/`write`/`edit`/`glob`/`grep`/`web_*`/`agent_browser`)
  are absent.
- ACL filtering: `getForChannel('')` yields only non-restricted tools; a non-empty
  channel additionally yields tools whose `spec.channels` includes it.
- `callToolViaRedis` emits the correct `spawn-tool-pod` XADD fields and a
  `toolcalls` entry, and returns a result correlated by `requestId`; the result wait
  honors `toolSpec.timeout`.
- Bootstrap (Mode 1) tool assembly is unchanged (no catalog, `local_*` present).

**Integration** (in-process Redis)
- Agent-runner XADDs a spawn; a stub orchestrator consumer resolves + ACL-checks;
  a stub tool pod writes a result to the toolresults stream; the runner returns it.
- Restricted tool is absent for an empty-channel (scheduler) job and rejected by the
  orchestrator if forced.
- The removed `tool_pod_request` path has no consumer and no producer (regression
  guard against re-introduction).

**E2E** (minikube-live)
- An agent Job runs a real `bash` and `bash_persist` catalog tool end-to-end through
  the sidecar bridge against the group PVC, extending the existing combined-journey /
  sidecar e2e patterns.

## Risks

- **`bash`/`bash_persist` UX shift for agents.** Agents lose dedicated
  `read`/`write`/`edit`/`glob`/`grep` and use shell instead. This is the decided
  design ("file ops only necessary for bootstrap") and matches the channel, which
  already works this way.
- **Dead-code removal reachability.** §4 deletions are each gated on a grep-verified
  no-caller check before removal, so a missed producer surfaces as a failing build/test
  rather than silent breakage.
- **Per-tool timeout.** Honoring `toolSpec.timeout` is a small behavior add beyond the
  channel (which currently uses a fixed 60 s); it is required for `browser` to be usable
  from an agent and is otherwise a no-op.
