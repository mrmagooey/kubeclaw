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
    image: ghcr.io/your-org/kubeclaw-agent:1.0.0
    cmd: ["node", "/app/dist/mcp-server.js", "--server", "filesystem", "--root", "/data", "--port", "3000"]
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
its own MCP server pod running `kubeclaw-agent` with `mcp-server.js --server filesystem`
(scaled to zero when idle) exposing five tools under `mcp__filesystem__*`:

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

## Extended capability spec fields

The following fields were added to `CapabilityBase` (in `src/capabilities/types.ts`)
to support stateful, multi-container capabilities such as the database capability.

### `sidecars`

Extra containers co-located in the same pod as the primary MCP container. Each
sidecar shares the pod's network namespace and the per-group credentials Secret
(via `envFrom`). The Service exposes only the primary container's port — sidecar
ports are internal to the pod.

```yaml
sidecars:
  - name: postgres
    image: postgres:16
    port: 5432        # optional; not exposed by the Service
    env:
      POSTGRES_USER: kubeclaw
      POSTGRES_DB: kubeclaw
      PGDATA: /var/lib/postgresql/data/pgdata
      # POSTGRES_PASSWORD comes from the per-group creds Secret (envFrom)
```

### `storage`

Declares a dedicated per-group PersistentVolumeClaim that is provisioned at
reconcile time and mounted into one named container.

```yaml
storage:
  sizeGi: 5                              # PVC size in GiB
  mountPath: /var/lib/postgresql/data    # path inside the target container
  container: postgres                    # which container mounts the PVC (default: primary)
```

The PVC is named `mcp-{capability}-{group_hash}-data` and is created with
`ReadWriteOnce`. See the **PVC durability** section below for retention semantics.

When `storage` is declared, the Deployment's update strategy is set to
`Recreate` (the default `RollingUpdate` is incompatible with `ReadWriteOnce`
PVCs because two pods cannot hold the claim simultaneously).

### `pinned`

When `true`, the Deployment starts with `replicas: 1` (instead of 0) and is
exempt from idle scale-to-zero. The sweeper in
`src/per-group-capabilities/scale-down-sweeper.ts` skips any instance whose
spec has `pinned: true`. Use for capabilities that require a persistent server
process (e.g. a Postgres sidecar that must stay running to preserve WAL state).

```yaml
pinned: true   # group-scoped only; default false
```

A pinned capability's pod is started at reconcile time rather than on first
channel use, so the reconciler provisions credentials before applying the
Deployment.

### `podSecurity.fsGroup`

Pod-level `fsGroup` sets the supplemental GID on all containers in the pod,
which causes the kubelet to `chown` mounted volumes to that GID on attach.
Required when a sidecar image (e.g. `postgres:16`) expects its data directory
to be owned by a specific GID.

```yaml
podSecurity:
  fsGroup: 999   # postgres:16 image runs as uid/gid 999
```

Other `podSecurity` fields (`runAsUser`, `runAsGroup`, `runAsNonRoot`) were
already supported; `fsGroup` is the new addition.

---

## Database capability

The built-in `database` capability ships a per-group Postgres 16 instance
fronted by the `postgres-mcp` server (`container/postgres-mcp/`). It is
declared in `helm/kubeclaw/values.yaml` under `capabilities.database`.

### How to enable

The `database` capability is **not default-on** — it must be explicitly added
to a group via the admin shell:

```
> capabilities add group_folder=Family capability_name=database
```

This triggers reconcile: the orchestrator provisions a dedicated PVC, generates
per-group credentials (MCP bearer token, rw Postgres password, ro Postgres
password), and applies a Deployment containing the `kubeclaw-agent` MCP server
(running `mcp-server.js --server database`) as the primary container and a
`postgres:16` sidecar. Because the capability is `pinned: true`, the pod starts
immediately at `replicas: 1` and never idles down.

To remove the capability (pod and K8s objects only — see PVC note below):

```
> capabilities remove group_folder=Family capability_name=database
```

### Tools

The `postgres-mcp` server exposes two tools:

- **`mcp__database__query`** — runs any SQL string on a SELECT-only Postgres
  connection pool (the `kubeclaw_ro` role). Write operations (`INSERT`,
  `UPDATE`, `DDL`, etc.) are rejected at the database level: the ro role has
  only `SELECT` grants, enforced by Postgres role permissions, not by an
  application-level filter or `SET default_transaction_read_only`.
  `SET default_transaction_read_only = on` is also applied per-session as
  defence-in-depth but is not the primary control.

- **`mcp__database__execute`** — runs any SQL string on the read-write
  connection pool (`kubeclaw` role). This tool is declared by the MCP server
  but hidden from the LLM by default via `allowedTools: [query]` in
  `values.yaml`. A group opts in by overriding `allowedTools`:

  ```yaml
  capabilities:
    database:
      allowedTools: [query, execute]
  ```

  Even with `execute` enabled, the caller is still bound by the database role's
  permissions. The `kubeclaw` role is a standard Postgres superuser by default
  (set by `POSTGRES_USER` in the `postgres:16` image), so enable `execute` only
  for groups that genuinely need write access.

### Read-only enforcement

`query` uses a dedicated `kubeclaw_ro` Postgres role. The role is bootstrapped
idempotently at server startup (before the HTTP listener opens) by the
`postgres-mcp` server using a combination of:

1. A `DO $$…$$` block guarded by `IF NOT EXISTS` (roles have no `IF NOT EXISTS`
   in Postgres DDL, so the DO block is required).
2. A parameterized `ALTER ROLE … PASSWORD $1` query — the password is never
   string-interpolated.
3. `GRANT CONNECT`, `GRANT USAGE ON SCHEMA public`, `GRANT SELECT ON ALL TABLES`,
   and `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES` — covering existing
   and future tables.

The role name (`PG_RO_USER`, default `kubeclaw_ro`) is validated against the
regex `^[a-z_][a-z0-9_]*$` before any SQL interpolation. A non-compliant value
causes the server to exit non-zero at startup.

### Guardrails

Two env vars cap the impact of a single query:

| Variable | Default | Effect |
|---|---|---|
| `KUBECLAW_DB_STATEMENT_TIMEOUT_MS` | `5000` | Postgres `statement_timeout` set per-session before each query/execute call |
| `KUBECLAW_DB_MAX_ROWS` | `1000` | Result rows are truncated server-side; the JSON response includes `"truncated": true` when the cap is hit |

Override in `values.yaml`:

```yaml
capabilities:
  database:
    env:
      KUBECLAW_DB_STATEMENT_TIMEOUT_MS: "10000"
      KUBECLAW_DB_MAX_ROWS: "2000"
```

### Credentials

At reconcile time the orchestrator calls `ensureGroupDbCredentials`
(`src/per-group-capabilities/provision-credentials.ts`), which idempotently
generates and stores the following keys in the per-group creds Secret:

| Secret key | Purpose |
|---|---|
| `KUBECLAW_MCP_TOKEN` | MCP bearer token — the channel presents this on every call to `/mcp`; the server rejects all requests without a matching `Authorization: Bearer …` header |
| `POSTGRES_PASSWORD` | rw role (`kubeclaw`) password — used by both the MCP server and the `postgres:16` sidecar |
| `PGPASSWORD` | same value as `POSTGRES_PASSWORD` (libpq env alias) |
| `PG_RO_PASSWORD` | ro role (`kubeclaw_ro`) password — distinct from the rw password |

All passwords are 24 cryptographically random bytes encoded as 48-character hex
strings. The MCP token is 32 random bytes (64 hex chars). Keys are written once
and never rotated automatically; rotate manually via `set_group_credential`.

---

## Isolation model and G3 residual

Per-group database pods are isolated from other groups by two properties:

1. **Per-group Postgres engine.** Each group runs its own `postgres:16` container
   and its own PVC. There is no shared database cluster between groups.
2. **Per-group MCP bearer token.** The `KUBECLAW_MCP_TOKEN` is unique per
   (group, capability). Channels present it on every MCP call; the server
   returns `401 Unauthorized` for any request that omits it or uses the wrong
   token.

**G3 residual — network-layer isolation is not group-scoped.** The per-group
NetworkPolicy (generated by `renderNetworkPolicy` in
`src/per-group-capabilities/k8s-objects.ts`) admits ingress from _any_ pod
labeled `kubeclaw.io/role: channel` or `kubeclaw.io/role: orchestrator` — it
does not restrict to the pod serving the matching group. This means a channel
pod processing group A can reach the per-group Service for group B at the
network layer. The token is then the sole enforcement boundary: the server
rejects the call because the channel presents group A's token, not group B's.

This is an accepted residual risk for personal-AI scale (single operator, small
trusted set of channels). Namespace-per-group isolation, with per-namespace
NetworkPolicies, is the identified future hardening path but is not implemented
in the current release.

---

## PVC durability

Dedicated per-group PVCs (created when a capability declares `storage`) carry
the annotation `kubeclaw.io/retain: "true"` in their metadata. The group GC
path (`gcGroup` in `src/per-group-capabilities/gc.ts`) calls
`deleteByLabel(namespace, 'kubeclaw.io/group-hash=<hash>')`, which targets
Deployments, Services, NetworkPolicies, and Secrets — not PVCs. PVCs are
deliberately excluded.

Consequence: **deleting a group does not delete its database PVC or the
Postgres data it contains**. The PVC must be cleaned up manually when the
data is no longer needed:

```bash
# Find PVCs for a group (replace <group_hash> with the hash from the PVC name)
kubectl get pvc -n kubeclaw -l kubeclaw.io/group-hash=<group_hash>

# Delete when safe
kubectl delete pvc -n kubeclaw mcp-database-<group_hash>-data
```

The group hash for a given folder can be derived with:

```bash
# group hash is the first 10 hex chars of SHA-1 of the group folder name
echo -n "Family" | sha1sum | cut -c1-10
```

This retention behaviour is intentional: a reinstated group can be reconnected
to its existing data by re-running `capabilities add` — the reconciler will
create a new Deployment that mounts the existing PVC.

---

## Architecture references

- Spec: `docs/superpowers/specs/2026-05-17-per-group-mcp-capabilities-phase-a-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-17-per-group-mcp-capabilities-phase-a.md`
- Source: `src/per-group-capabilities/`
- MCP server implementations: `container/agent-runner/src/mcp-server.ts`
