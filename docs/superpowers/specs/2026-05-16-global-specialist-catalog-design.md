# Global Specialist Catalog — Design

**Date:** 2026-05-16
**Status:** Design — pending implementation plan
**Supersedes:** `groups/{group}/agents.json` per-group specialist files; the orchestrator-mode dispatch path at `src/index.ts:373-559`.

## Goal

Replace the per-group `agents.json` file with a cluster-wide global catalog of specialists, owned by the orchestrator and consumed by channel pods through a mounted ConfigMap. One specialist definition (e.g. `CodeReview`) is usable from every group — declared once via Helm or registered at runtime through the admin shell — with no per-group config file at all.

The dispatch path remains Path A (channel pod owns the LLM conversation in-process). This change does not add new pods; it relocates the source-of-truth and finally makes per-specialist overrides (`llmProvider`, `memory.isolated`, `tools`) actually take effect in Path A, which is the documented mainline per the four-tier architecture.

## Background

Today's specialist system has two unrelated problems:

1. **Per-group scope.** A specialist defined in `groups/{group}/agents.json` is visible only to that group. Reusing it elsewhere means copying the file. There is no shared catalog.

2. **Path A silently drops overrides.** `channel-runner.ts` reads `agents.json`, wraps the user prompt in `<specialist name="X">…</specialist>`, and calls `runAgent(group, wrappedPrompt, chatJid, onOutput)`. The `s.llmProvider`, `s.containerConfig`, and `s.memory.isolated` fields are never plumbed to `runAgent`. The same `group` object is reused for every specialist, in a strictly sequential `for…of await` loop that aborts on the first error.

A second dispatch path exists at `src/index.ts:373-559` (orchestrator-mode `processGroupMessages`) that does apply `llmProvider`, `containerConfig`, and (nominally) `memory.isolated`. It is dead code: gated by `if (KUBECLAW_MODE !== 'orchestrator')` at `src/index.ts:1089-1100`, never registered in the default `orchestrator` mode, never called from the IPC handler in `src/k8s/ipc-redis.ts`. It is pre-four-tier residue and is deleted as part of this change.

Even in Path B, `memory.isolated` was nominal: the session key was scoped (`${group.folder}:${s.name}`), but `getConversationHistory` in `src/db.ts` queries `WHERE group_folder = ?` — so isolated specialists still pulled the group's full conversation history. This change makes isolation real.

## Design decisions

Resolved during brainstorming:

1. **Cross-group/global specialists are the unit of definition.** No per-group catalog. The motivation explicitly excludes per-group config files; the desired UX is "register `CodeReview` once, every group sees it."
2. **ConfigMap mounted into the channel pod is the delivery channel.** Orchestrator renders the merged catalog into one cluster-wide ConfigMap (`kubeclaw-specialists`). Channel pods mount it and reload on kubelet propagation.
3. **Source of truth is Helm baseline + admin-shell overrides.** Helm declares a curated catalog at install time (GitOps reproducibility). Admin shell can register/edit/remove specialists at runtime via IPC tools. Reconciler merges both.
4. **No per-group customisation in v1.** Every group sees every global. If a group needs different behaviour, that's a signal to define a new global with a different name. Per-group opt-out, prompt addenda, and group-private specialists are explicitly out of scope.
5. **Schema drops `containerConfig`.** Path A has no per-specialist container — the LLM call is in-process in the channel pod. Carrying the field would mislead operators. `llmProvider`, `memory.isolated`, `claudemd`, `triggers` are retained. `tools` allowlist is added (see §3).
6. **`@mention` dispatch UX is unchanged.** Regex parser stays; only the catalog source changes.
7. **Admin-shell registrations win over Helm baseline on name collision.** Lets an operator hotfix a specialist without a `helm upgrade`.
8. **Clean break — `agents.json` is ignored as of this release.** No parallel-support period, no auto-migration. A `CHANGELOG.md` entry documents the breaking change.
9. **One cluster-wide ConfigMap.** Multi-namespace / multi-tenant scoping is out of v1; the project is single-namespace today.
10. **Parallel dispatch via `Promise.all`.** Replaces today's sequential `for…of await`. Errors are per-run and do not abort siblings.
11. **Per-specialist tool allowlist.** Specialists may declare `tools: ['mcp:fetch']` in the schema; channel pod filters its tool surface accordingly before each specialist's LLM call. Absent means full tool surface.
12. **`memory.isolated` becomes real isolation.** `conversation_history` gains a `session_key` column; history queries scope by it. Specialists with `memory.isolated: true` do not see group history.

## Architecture

```
helm/kubeclaw/values.yaml  (specialists: [...])
        │  rendered at install/upgrade
        ▼
ConfigMap: kubeclaw-specialists-baseline       (read-only, Helm-managed)
        │
        ▼
Orchestrator process (KUBECLAW_MODE=orchestrator)
        │  ├── reads baseline ConfigMap at startup
        │  ├── reads admin-shell overrides from orchestrator SQLite
        │  └── reconciler: merge(baseline, overrides) — overrides win on name collision
        │
Admin shell ── register_specialist / edit_specialist / remove_specialist ──▶ Orchestrator SQLite
                                                                                  │
                                                                                  ▼
                                                                            triggers reconcile
                                                                                  │
                                                                                  ▼
                                              ConfigMap: kubeclaw-specialists     (orchestrator-managed)
                                                key=specialists.json (rendered merged catalog)
                                                                                  │
                                            kubelet propagates updates (~60s, atomic symlink swap)
                                                                                  │
                                                                                  ▼
Channel pod (KUBECLAW_MODE=channel)
        ├── mounts /etc/kubeclaw/specialists/specialists.json
        ├── SpecialistCatalogLoader: read on startup, fs.watch for updates, cache in memory
        └── channel-runner.ts processGroupMessages reads cache per turn
```

Two ConfigMaps so the boundary is visible to operators: `kubeclaw-specialists-baseline` (Helm-owned, never written by orchestrator) and `kubeclaw-specialists` (orchestrator-owned, never written by Helm). Channel pods only mount the merged one.

## Schema

```typescript
interface GlobalSpecialist {
  name: string;                    // required; slug-like /^[A-Za-z][A-Za-z0-9_-]*$/; used for @mention
  prompt: string;                  // required; non-empty system prompt body
  triggers?: string[];             // additional @aliases, e.g. ["QA", "Reviewer"]
  llmProvider?: string;            // override channel default; must be configured for the channel
  memory?: { isolated?: boolean }; // true = separate session + scoped history (see §6)
  claudemd?: string;               // appended to the prompt after the <specialist> wrap
  tools?: string[];                // allowlist of tool names; absent or empty = full tool surface
}
```

Wire format inside the ConfigMap (`specialists.json` key):

```json
{
  "version": 1,
  "generation": 17,
  "specialists": [
    { "name": "CodeReview", "prompt": "...", "tools": ["mcp:fetch"] },
    { "name": "Research",   "prompt": "...", "memory": { "isolated": true } }
  ]
}
```

`generation` is incremented by the orchestrator on every reconcile; used by `SpecialistCatalogLoader` to detect no-op reloads and to surface staleness in logs.

Validation (orchestrator, before write):
- `name` matches the regex and is unique across the merged set.
- `prompt` is a non-empty string.
- `triggers`, `tools` are arrays of strings.
- `llmProvider`, if set, is one of the channel's configured providers (validated at admin-shell registration time and at orchestrator startup against Helm config; warn-and-skip if a specialist references an unknown provider at load time, so a misconfig in one entry doesn't break the catalog).
- Unknown top-level fields are rejected.

**Tool name format in the `tools` allowlist** — values are matched against the channel pod's registered tool names. Conventions:
- `propose_skill` and other channel-local tools: bare name.
- MCP-server tools: `mcp:<tool>` (the MCP server is implicit — the channel pod's discovered MCP capabilities collectively expose these).
- Tool-job kinds: bare name (`bash`, `browser`, etc.).
- Wildcards are not supported in v1; list each tool explicitly. An empty array means "no tools" (specialist runs prompt-only); omitting the field entirely means "full tool surface."

## Dispatch flow

`channel-runner.ts processGroupMessages` (the only live dispatch path post-deletion):

```
1. message arrives, prompt built
2. catalog = specialistCatalog.getAll()                       // from mounted ConfigMap, in-memory cache
3. mentioned = detectMentionedSpecialists(prompt, catalog)    // existing regex, unchanged
4. if mentioned.length === 0:
       agentRuns = [{ prompt, sessionKey: group.folder, llmProvider: group.llmProvider, toolFilter: undefined }]
   else:
       agentRuns = mentioned.map(s => ({
         prompt:       `<specialist name="${s.name}">\n${s.prompt}${s.claudemd ? `\n\n${s.claudemd}` : ""}\n</specialist>\n\n${userPrompt}`,
         sessionKey:   s.memory?.isolated ? `${group.folder}:${s.name}` : group.folder,
         llmProvider:  s.llmProvider ?? group.llmProvider,
         toolFilter:   s.tools && s.tools.length > 0 ? new Set(s.tools) : undefined,
         specialistName: s.name,
       }))
5. results = await Promise.all(agentRuns.map(run => runAgent(group, run, chatJid, onOutputFor(run))))
6. each onOutput sends `[@${specialistName}] ${text}` via channel.sendMessage (no prefix when no specialist mentioned)
7. errors captured per-run, logged with specialist name, do NOT abort siblings
```

Three contract changes on `runAgent` / `DirectLLMRunner`:

- Accept `sessionKey` override; pass through to history lookup. Today the code assumes `group.folder` is the session key.
- Accept `llmProvider` override; pick the right model client per call. Today the channel-pod call site never passes this.
- Accept `toolFilter: Set<string> | undefined`; the runtime filters its registered tools to this allowlist before each LLM call. Today the registry is uniform per channel.

Response prefix `[@Name]`: necessary because parallel runs land in nondeterministic order. Without the prefix, users can't tell which specialist replied when two replies arrive within a couple seconds.

Behaviour changes from today's sequential path that must be called out in the implementation plan:

- `for…of await` becomes `Promise.all`. Today, an error in the first specialist aborts the rest; new behaviour is per-run isolation.
- `channel.setTyping(chatJid, true)` still fires before dispatch; `channel.setTyping(chatJid, false)` now fires after `Promise.all` settles (resolves or rejects). Net behaviour is unchanged from the user's perspective — typing indicator goes away when all replies are done.
- The `hadError` and `outputSentToUser` flags must be aggregated across parallel runs (e.g. `results.some(r => r.status === 'error')`) rather than mutated in a loop.

## Helm baseline

`helm/kubeclaw/values.yaml`:

```yaml
specialists:
  - name: Research
    prompt: |
      You are a research specialist. Focus on finding and analysing
      information from authoritative sources.
    triggers: [Researcher, Analysis]
    tools: [mcp:fetch, mcp:web_search]
  - name: CodeReview
    prompt: |
      You are a code-review specialist. Focus on security, performance,
      and maintainability.
    llmProvider: claude
```

`helm/kubeclaw/templates/specialists-baseline-configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubeclaw-specialists-baseline
  namespace: {{ .Release.Namespace }}
  labels:
    app: kubeclaw
    component: specialists-baseline
data:
  specialists.json: |
    {{ toJson (dict "version" 1 "specialists" .Values.specialists) | nindent 4 }}
```

Empty list (`specialists: []`) is supported and renders an empty catalog — no specialists registered, all messages run the main agent.

## Admin shell IPC tools

Mirror the existing `setup_channel` / `install_capability` patterns. Tools live in `src/skills/orchestrator/specialist-registry.ts`:

- `register_specialist({ name, prompt, triggers?, llmProvider?, memory?, claudemd?, tools? })` — insert into orchestrator SQLite `specialist_overrides` table; trigger reconcile; return the merged catalog entry. Fails if `name` violates the regex or `prompt` is empty.
- `edit_specialist({ name, patch })` — partial update on an existing override. Fails if no override row exists with that name (i.e. you cannot edit a Helm baseline entry — you must register an override with the same name, which then wins per design decision 7).
- `remove_specialist({ name })` — delete override row; baseline entry (if any) re-emerges on next reconcile.
- `list_specialists()` — return merged view, each entry annotated `source: "helm" | "admin-shell"`.

SQLite schema:

```sql
CREATE TABLE specialist_overrides (
  name           TEXT PRIMARY KEY,
  spec_json      TEXT NOT NULL,           -- GlobalSpecialist serialised
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
```

## Orchestrator reconciler

`src/specialists/reconciler.ts` (new module):

- `loadBaseline()`: reads `/etc/kubeclaw/specialists-baseline/specialists.json` (mounted from the Helm-managed ConfigMap into the orchestrator pod).
- `loadOverrides()`: reads all rows from `specialist_overrides`.
- `merge(baseline, overrides)`: applies overrides on top of baseline; name collisions resolved override-wins.
- `validate(merged)`: runs the schema validation from §3.
- `render(merged)`: produces the merged ConfigMap body with monotonically-incremented `generation`.
- `apply()`: writes (server-side apply) to `kubeclaw-specialists` ConfigMap via the orchestrator's existing K8s client.

Triggers:
- Orchestrator startup.
- Any successful mutation of `specialist_overrides` (register/edit/remove).
- Watch on the baseline ConfigMap (Helm upgrade detection).

**Helm template change for the orchestrator** — `helm/kubeclaw/templates/orchestrator-deployment.yaml` mounts `kubeclaw-specialists-baseline` at `/etc/kubeclaw/specialists-baseline/` (read-only). The orchestrator's ServiceAccount already has `configmaps` get/list/watch/create/update verbs on the namespace (used for existing capability reconciliation); no RBAC additions needed.

Failures during reconcile are logged with the failing entry's name and the reason; the previous-good ConfigMap is left in place. Channel pods never see an invalid catalog.

## Channel pod consumption

`src/specialists/catalog-loader.ts` (new module, channel-side):

- On startup: `fs.readFileSync('/etc/kubeclaw/specialists/specialists.json')`, parse, cache.
- `fs.watch` on the mount directory. Kubernetes ConfigMap mounts use an atomic `..data` symlink swap, so the watch must follow the symlink and re-read on either `rename` or `change` events. The implementation reads + re-parses; if parse fails, it logs and keeps the previous cache (defensive against partial writes during the swap).
- `getAll()`: returns the cached array.
- `findByMention(name)`: case-insensitive lookup against `name` and `triggers`. Reuses `detectMentionedSpecialists` logic from `src/specialists.ts` against the new source.

The mount goes into the channel-pod manifest. Channel pods are not Helm-templated directly — they're rendered by the orchestrator's job-runner / pod-spec code. Concretely:

- `src/k8s/job-runner.ts` (or wherever the channel-pod PodSpec is constructed — same code that wires `HTTPS_PROXY` and the credential-broker sidecar) adds a `configMap` volume named `specialists-catalog` referencing `kubeclaw-specialists` with `optional: true`, mounted read-only at `/etc/kubeclaw/specialists/`.
- `optional: true` matters: on a fresh install, the orchestrator-managed ConfigMap may not exist before the first reconcile. Channels start with an empty catalog (main-agent-only behaviour) until reconcile completes.
- Existing channel pods do NOT need to be recreated on every ConfigMap update — kubelet propagates the ConfigMap contents in place. Only the initial mount requires the new field on the PodSpec, so existing pods rolled before the upgrade need to be restarted once to pick up the mount.

## Memory isolation (db.ts change)

`memory.isolated: true` must produce actual history isolation, not just a renamed session pointer.

Current schema (`src/db.ts`):

```sql
CREATE TABLE conversation_history (
  group_folder TEXT NOT NULL,
  -- ... role, content, created_at, etc.
  INDEX (group_folder, created_at)
);
```

New schema (additive migration):

```sql
ALTER TABLE conversation_history ADD COLUMN session_key TEXT;
-- Backfill: existing rows get session_key = group_folder
UPDATE conversation_history SET session_key = group_folder WHERE session_key IS NULL;
-- New index
CREATE INDEX idx_conv_session_key ON conversation_history (session_key, created_at);
```

Code changes:
- `appendConversationHistory`: takes `sessionKey` parameter (default `group.folder` for callers that don't care); writes it.
- `getConversationHistory`: takes `sessionKey`; queries `WHERE session_key = ?`.
- All existing call sites pass `group.folder` as `sessionKey` for behavioural parity.
- The dispatch flow in §5 passes `${group.folder}:${s.name}` for isolated specialists; the history fetch in `runAgent` uses that key.

`group.folder` remains a separate column for queryability ("show me all history for group X across all specialists") and for cleanup operations that delete a group's data.

Migration is online: ALTER ADD COLUMN with default NULL is non-blocking in SQLite; the backfill UPDATE runs once at orchestrator startup if any NULLs remain.

## Deletion of legacy code

Removed in this change:

- `src/index.ts:373-559` — orchestrator-mode `processGroupMessages` (Path B). Dead per verification: gated at `src/index.ts:1089-1100` by `KUBECLAW_MODE !== 'orchestrator'`, never registered in default mode, not invoked from `src/k8s/ipc-redis.ts:115-213`.
- `src/index.ts` `_processGroupMessages` export.
- `src/index.test.ts` unit tests for `_processGroupMessages` (the tests mocked dependencies and never exercised the gated entry-point — they were testing dead code).
- `src/specialists.ts` `loadSpecialists()` — the file-based loader for `agents.json`. The `detectMentionedSpecialists()` and `SpecialistDef` interface stay; both are still used.
- The `loadSpecialists(group.folder)` call in `channel-runner.ts:1113`; replaced by `specialistCatalog.getAll()`.

Not removed (per design decision 5): `s.containerConfig` from the existing type is dropped from the new `GlobalSpecialist` interface, but the legacy `SpecialistDef` interface stays only long enough for the deletion PR to compile cleanly — same PR removes the type altogether once no readers remain.

## Tests

New tests:

- **Unit (orchestrator):** schema validation (regex, required fields, unknown fields, unknown `llmProvider`); reconciler merge (override-wins, baseline-only, override-only, empty); generation increment; render output stable.
- **Unit (channel):** `SpecialistCatalogLoader` startup load, fs.watch reload, parse-failure fallback to previous cache.
- **Unit (db):** `conversation_history` session-key scoping; isolated specialist does not see group history; non-isolated specialist does.
- **Unit (dispatch):** `agentRuns` construction for zero / one / N mentions; `toolFilter` set correctly when `tools` allowlist present; `sessionKey` derived correctly per `memory.isolated`.
- **Integration:** admin-shell IPC tools mutate SQLite and trigger reconcile; reconciler writes ConfigMap via fake K8s client; channel-pod loader picks up changes via fs.watch.
- **E2E:** real channel pod, `@Specialist` dispatch using mounted ConfigMap; parallel execution observed via overlapping log windows for two specialists in one message; `memory.isolated` verified by sending a message to `@Isolated`, then asking the main agent — the main agent should not have the isolated specialist's reply in its history; `tools` allowlist enforced by negative test (a `tools: [bash]` specialist cannot invoke browser).

Removed tests:
- `src/index.test.ts` cases targeting `_processGroupMessages`.
- Any test relying on `agents.json` being read from the group folder.

## Telemetry

Add `specialist_usage` table to channel-pod SQLite (mirrors `skill_usage`):

```sql
CREATE TABLE specialist_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder    TEXT NOT NULL,
  specialist_name TEXT NOT NULL,
  used_at         INTEGER NOT NULL,
  duration_ms     INTEGER,
  status          TEXT CHECK(status IN ('success','error'))
);
```

Written by the dispatch loop on each specialist run. Enables a future "which globals are actually used / which never get mentioned" report — relevant to the v2 conversation about per-group customisation.

## Migration / breaking change

- Any existing `groups/{group}/agents.json` files are ignored as of this release.
- `CHANGELOG.md` entry under `Breaking changes`:
  > `agents.json` per-group specialist files are no longer read. Specialists are now declared globally via Helm `values.yaml` (`specialists: [...]`) or registered at runtime via the admin shell (`register_specialist`). See `docs/SPECIALISTS.md` (rewritten).
- `docs/SPECIALISTS.md` rewritten from scratch; old content moved to `docs/legacy-specialists-architecture.md` for reference.
- `README.md` "Agent Swarms" bullet updated: replace the `agents.json` sentence and the `docs/SPECIALISTS.md` link target with a description of the global-catalog model.
- `CLAUDE.md` Key Files: `src/specialists.ts` description updated; new entries added for `src/specialists/catalog-loader.ts` (channel-side) and `src/specialists/reconciler.ts` (orchestrator-side).

## Non-goals

- Per-group activation, opt-out, prompt addenda, or group-private specialists. (Design decision 4 — explicitly v2.)
- Per-specialist container, ServiceAccount, NetworkPolicy, or credential-broker mapping. (Path A constraint — specialists share the channel pod's identity end-to-end.)
- Per-specialist resource limits (`containerConfig` from the old schema). (Design decision 5 — no separate container in Path A.)
- CRDs. (Design decision 3 — Helm + admin shell is K8s-native enough for v1, without the operator complexity.)
- Multi-namespace / multi-tenant ConfigMap scoping. (Design decision 9 — project is single-namespace today.)
- Auto-migration of existing `agents.json` files into the orchestrator catalog. (Design decision 8 — clean break.)
- Skill-harvest integration (a specialist that gets defined globally based on harvested skills). Same machinery may serve both later; out of scope here.

## Open / deferred to v2

- Per-group opt-out and prompt addenda (design decision 4 has the rationale).
- A specialist registry "Hub" comparable to Hermes' Skills Hub or OpenClaw's ClawHub for sharing across installations.
- Per-specialist tool implementations that aren't already exposed as channel-pod tools (e.g. a specialist-scoped MCP server).
- `--dry-run` mode for `register_specialist` that returns the rendered ConfigMap diff without applying.
- Multi-namespace scoping if kubeclaw becomes multi-tenant.
