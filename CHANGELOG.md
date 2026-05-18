# Changelog

All notable changes to KubeClaw will be documented in this file.

## Unreleased

### Breaking changes

- **`agents.json` per-group specialist files are no longer read.** Specialists are now defined in a cluster-wide catalog via Helm `values.yaml` (`specialists: [...]`) or registered at runtime via the admin shell (`register_specialist`). See `docs/SPECIALISTS.md` (rewritten) and `docs/superpowers/specs/2026-05-16-global-specialist-catalog-design.md`.
- **`src/index.ts:373-559` (orchestrator-mode `processGroupMessages`) and the `_processGroupMessages` export have been removed.** They were dead code post-four-tier architecture.
- **`conversation_history` schema:** new `session_key` column. Additive migration with online backfill; no operator action needed.
- **MCP tool names are now prefixed with `mcp__<capability>__<tool>`.** Both cluster-scoped and group-scoped MCP tools follow this scheme. Pre-existing references in `groups/*/CLAUDE.md`, `groups/*/skills/*.md`, and any scheduled-task prompts must be updated. Grep for unprefixed tool names with:

      grep -rn '<tool-name>' groups/ docs/

  For example, a Qdrant capability's `query_vectors` tool becomes `mcp__qdrant__query_vectors`.

  In-flight conversations may produce one failed tool call after upgrade if the LLM tries a stale name; the next turn picks up the new names from the refreshed tool list.

### Features

- **Global specialist catalog with cluster-wide reuse.** Define a specialist once, every group can `@mention` it. Helm baseline + admin-shell overrides, reconciled into the `kubeclaw-specialists` ConfigMap, mounted into channel pods.
- **Parallel specialist dispatch.** Mentioned specialists run concurrently via `Promise.allSettled`; per-run errors do not abort siblings. Replies prefixed with `[@Name]`.
- **Per-specialist `memory.isolated`** is now real isolation. `conversation_history` is scoped by `session_key`, so isolated specialists do not see group history.
- **Per-specialist `llmProvider` override** for cost-optimised routing (e.g. Claude Opus for `@Expert`, cheap model for `@Helper`).
- **Per-specialist `tools` allowlist** for hardening.
- **`specialist_usage` SQLite telemetry** records dispatch with duration and success/error status.
- **Per-group MCP capability tier (`scope: group`)** — Capabilities can now be
  declared with `scope: group`, deploying one Deployment per (group ×
  capability) pair with scale-to-zero. Each instance has its own per-group K8s
  Secret for env-var credentials and an optional mount of the group's PVC
  subPath. The Redis-stream discovery handler scales pods up on demand. See
  `docs/PER_GROUP_CAPABILITIES.md`.
- New admin-shell IPC tools: `set_group_credential` and
  `unset_group_credential` manage env-var credentials on the per-(group,
  capability) Secret mounted by the per-group MCP Deployment.
- New pod labels: `kubeclaw.io/role` on orchestrator / channel / Redis pods
  (foundational for per-group NetworkPolicy ingress).
- New SQLite table: `per_group_capability_instances` tracks per-(group,
  capability) instance state (current replicas, last used timestamp).
- **Channel runtime consumes per-group MCP capabilities (Phase B, Spec 1).** Group-scoped MCPs now appear in the LLM tool list with `mcp__<capability>__<tool>` names, sourced from cached schemas the orchestrator scrapes on first reconcile. Tool calls resolve to a per-group MCP pod endpoint lazily via a Redis discovery RPC; the orchestrator scales the pod up on demand and back down after the idle threshold. See `docs/PER_GROUP_CAPABILITIES.md`.
- **New SQLite table `capability_tool_schemas`** stores scraped tool schemas per `(capability_name, image)`.
- **New orchestrator background loop:** schema scraper. Runs every 60 s, scrapes any (capability, image) pair without a cached schema, caps retries at 3 per orchestrator-process lifetime.
- **Per-group Deployments now expose a readinessProbe on `/health`** so the K8s API only reports them ready once the MCP server is accepting connections. Removes a race against scrape and discovery RPCs.
- **Filesystem MCP capability (Phase B Spec 2)** — default-on. Each
  registered group gets a per-group `kubeclaw-mcp-bundle` pod (scales to
  zero when idle) exposing five tools to the LLM under the
  `mcp__filesystem__*` prefix: `read_file`, `write_file`, `list_directory`,
  `search_files`, `create_directory`. Files are stored on the group's PVC
  subPath; 100 MiB file-size cap (configurable via
  `KUBECLAW_FS_MAX_FILE_BYTES`).
- **New container image `kubeclaw-mcp-bundle`** — Node-based, hosts
  multiple MCP server kinds selected via `--server` arg. Filesystem is the
  first inhabitant.
- **Helm static-template gate for group-scoped capabilities** —
  capability-pods, serviceaccounts, and metrics-servicemonitor now skip
  entries with `scope: group`, leaving their deployment to the
  orchestrator reconciler. Prevents double-deployment of group-scoped
  capabilities.

## [1.2.0](https://github.com/qwibitai/kubeclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
