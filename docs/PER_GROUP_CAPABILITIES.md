# Per-Group MCP Capabilities

KubeClaw supports two capability scopes:

- `scope: cluster` (default) — one Deployment per cluster, shared by all groups.
- `scope: group` — one Deployment per (group × capability) pair, with its own
  credentials, volume, and NetworkPolicy. Scales to zero when idle.

## Declaring a group-scoped capability

In `helm/kubeclaw/values.yaml`:

```yaml
capabilities:
  filesystem:
    kind: mcp
    scope: group
    image: ghcr.io/your-org/kubeclaw-mcp-bundle:1.0.0
    volumeFromGroupPvc: true        # mount /data with group's subPath
    credentialsFrom: none
    scaleDownAfterIdleSeconds: 600  # default 600; min 60
    allowedTools: [read_file, write_file, list_dir, search_files]
```

## Lifecycle

- **Reconcile.** On orchestrator startup and on each group add/remove, the
  reconciler ensures one Deployment + Service + NetworkPolicy exists per
  (group, group-scoped-capability) pair, with `replicas: 0`. A 5-minute
  periodic safety reconcile heals drift.
- **Cold start.** When a channel first discovers the capability for a group,
  the orchestrator patches the Deployment to `replicas: 1` and waits up to
  30 seconds for the pod to become ready. Cold-start latency is dominated by
  image-pull time.
- **Warm calls.** Subsequent calls within the idle window are served by the
  already-running pod.
- **Scale-down.** A background sweeper (default 60-second interval) scales
  Deployments back to `replicas: 0` when idle for longer than
  `scaleDownAfterIdleSeconds`.
- **Group delete.** Removing a group cascades to delete all per-group
  Deployments, Services, NetworkPolicies, and Secrets for that group.

## Per-group credentials

For capabilities with `credentialsFrom: secret`, the orchestrator mounts a
per-(group, capability) K8s Secret named `mcp-{capability}-{group_hash}-creds`
as `envFrom` on the Deployment. Manage credentials via the admin shell:

```
> set_group_credential group_folder=Family capability_name=github \
    env_name=GITHUB_TOKEN value=ghp_xxx
> unset_group_credential group_folder=Family capability_name=github \
    env_name=GITHUB_TOKEN
```

Changes take effect on the next reconcile (immediately for the periodic loop,
~5 minutes worst case if no other trigger fires).

This mechanism is distinct from the credential broker's per-group Secret
(`kubeclaw-group-secrets-{group}`), which is used for Envoy-side Authorization
header stamping for outbound HTTPS calls from tool jobs. Per-group MCP
capabilities use direct envFrom mounting, not broker substitution.

## NetworkPolicy and isolation (v1)

v1 ingress restricts to pods labeled `kubeclaw.io/role: channel` or
`kubeclaw.io/role: orchestrator`. Any channel pod can reach any per-group
Service. Real isolation in v1 comes from three properties that hold
per (group, capability):

1. **Per-group volumes.** `volumeFromGroupPvc: true` mounts only that
   group's subdirectory; the MCP server sees nothing else.
2. **Per-group credentials.** The mounted Secret contains only that
   group's tokens.
3. **Channel runtime correctness.** Channels only call the per-group
   capability associated with the group they are currently processing.

Per-pod identity (SPIFFE / ServiceAccount tokens) for tighter NetworkPolicy
ingress is deferred to v2 hardening.

## Resource accounting

Pod count at rest: 0 for idle groups. Pod count at peak: one per
(active group × group-scoped capability). Personal-AI scale (≤50 groups,
≤5 group-scoped capabilities) results in ≤250 Deployment objects total but
typically <10 active pods at any moment.

## Limitations (v1)

- Always 0 or 1 replicas per instance (no HA per group).
- No anticipatory warm-up; first call after idle pays cold-start latency.
- No automatic GC of orphaned per-group Deployments when a capability spec
  is removed from `values.yaml` — clean up manually with
  `kubectl delete deploy -l kubeclaw.io/capability=<name>` (and the same for
  service, networkpolicy, secret).
- Broker per-group rules (for outbound Authorization-header stamping) are
  not yet implemented for the per-group MCP tier; only env-mounted Secrets
  in v1.
- Channel-side consumer wiring (the channel runtime calling discovery and
  routing tools through the per-group MCP) is Phase B; v1 ships only the
  orchestrator-side foundation.

## Channel-side consumer (Phase B Spec 1)

Channels see per-group MCP tools as `mcp__<capability>__<tool>` in the LLM
tool list. Resolution is lazy:

1. Orchestrator pushes a `capabilities_update` over Redis IPC. Group-scoped
   capabilities arrive as `kind: 'mcp-group'` entries with their cached tool
   schemas (or `state: 'pending-schema'` if the scraper hasn't run yet).
2. Channel's MCP manager stores the schemas. `getTools()` returns the
   prefixed tool names to the LLM.
3. When the LLM calls `mcp__filesystem__read_file`, the manager publishes a
   discovery request to Redis, the orchestrator scales the per-group
   Deployment up, returns the endpoint, the manager opens a one-shot MCP
   HTTP session, calls `read_file`, returns the result.
4. The per-group Deployment idles down on the standard sweeper schedule
   (`scaleDownAfterIdleSeconds`, default 600).

### Tool-call latency

- Warm call (recent use, pod still running): single HTTP round-trip to the
  per-group pod (~10s of ms).
- Cold call (first call after idle, pod scaled to 0): orchestrator scale-up
  + pod ready wait + first HTTP call. Dominated by image-pull time. Default
  30 s discovery timeout.

### Tool-call errors

The LLM sees structured MCP-protocol error results (no exceptions):

- `capability unavailable: <reason>` — scale-up failed or timed out.
- `discovery timeout` — orchestrator non-responsive.
- `MCP call failed: <reason>` — the per-group pod returned an error.

No transparent retries; the LLM decides whether to retry, work around, or
report the failure to the user.

### Tool-name prefixing (breaking change)

All MCP tools — both cluster-scoped and group-scoped — are exposed to the
LLM as `mcp__<capability>__<tool>`. For example, a cluster-scoped Qdrant
capability that previously surfaced `query_vectors` now surfaces
`mcp__qdrant__query_vectors`.

Operator action after upgrading:

```bash
# Find any prompts referencing flat MCP tool names:
grep -rn '<tool-name>' groups/*/CLAUDE.md groups/*/skills/*.md
```

Update each match to the prefixed form. In-flight conversations may produce
one failed tool call after upgrade if the LLM tries a stale name; the next
turn picks up the new names from the refreshed tool list.

## Filesystem MCP (Phase B Spec 2)

The filesystem capability ships **default-on**. Every registered group gets
its own `kubeclaw-mcp-bundle` pod (scaled to zero when idle) exposing five
tools under `mcp__filesystem__*`:

- `read_file(path)` — UTF-8 contents
- `write_file(path, content)` — overwrites
- `list_directory(path)` — entries with type and size
- `search_files(path, pattern)` — glob over file paths (`**/*.md` style)
- `create_directory(path)` — recursive + idempotent

All paths are relative to the group's PVC subPath (mounted at `/data` inside
the pod). Absolute paths, traversal escapes, and symlink escapes are rejected.

### File-size cap

Both `read_file` and `write_file` are capped at **100 MiB** per call. The
MCP protocol holds full content in memory during JSON encode/decode, so
larger files would risk OOM-ing the pod (default `memoryLimit: 512Mi`).

To raise the cap, override in `values.yaml`:

```yaml
capabilities:
  filesystem:
    env:
      KUBECLAW_FS_MAX_FILE_BYTES: "524288000"        # 500 MiB
      NODE_OPTIONS: "--max-old-space-size=1024"
    resources:
      memoryLimit: 2Gi
```

Pod memory should be ~3-4× the cap to absorb the JSON-decode peak.

## Architecture references

- Spec: `docs/superpowers/specs/2026-05-17-per-group-mcp-capabilities-phase-a-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-17-per-group-mcp-capabilities-phase-a.md`
- Source: `src/per-group-capabilities/`
