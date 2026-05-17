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

## Architecture references

- Spec: `docs/superpowers/specs/2026-05-17-per-group-mcp-capabilities-phase-a-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-17-per-group-mcp-capabilities-phase-a.md`
- Source: `src/per-group-capabilities/`
