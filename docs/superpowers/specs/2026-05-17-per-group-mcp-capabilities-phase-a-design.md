# Per-Group MCP Capabilities — Phase A Foundation

**Date:** 2026-05-17
**Status:** Approved (brainstorming)
**Scope:** Phase A only — foundation infrastructure. Phase B (filesystem + docling consumers) is a separate spec/plan.

## Goal

Introduce a `scope: group` tier to kubeclaw's Capability model so MCP servers can be deployed per-(group × capability) pair with their own credentials, volumes, and NetworkPolicy. Each per-group instance scales to zero when idle and scales up on first discovery.

## Background

Today, Capabilities are cluster-wide Deployments. The capability ACL (`channels: []`) restricts which channels can discover them, but channels host many groups, so any capability that needs per-group state (per-group GitHub token, per-group calendar, per-group filesystem mount) becomes either a multi-tenant fork (cross-group leak surface) or an in-process built-in (doesn't scale to heavy/external servers).

The foundation introduces the cleanest architecture: vanilla off-the-shelf MCP servers, configured per-instance with the group's creds/volumes, managed by the orchestrator with scale-to-zero. This unblocks filesystem and docling consumers and any future per-group capability (calendar, GitHub, memory).

Architectural brainstorm: see conversation history for tradeoff analysis of five deployment shapes. The recommended shape (per-group Deployment with scale-to-zero) was chosen because it preserves real K8s-level isolation, reuses upstream MCP servers without forking, and matches the credential-broker / NetworkPolicy story.

## Non-goals for v1

- Per-pod identity / SPIFFE-style ingress restriction (v2 hardening — v1 uses coarse "any channel pod" ingress)
- Pre-warming / anticipatory scale-up (channels scale up only on discovery)
- Broker per-group rules (Secret-mount only in v1 — broker integration when first capability needs it)
- Multi-replica per-group capabilities (always 0 or 1)
- Quotas, billing, metering beyond `last_used_at`
- Filesystem and docling MCP servers themselves (Phase B)
- Helm `values.yaml` consumer entries — capability specs for actual consumers (Phase B). Foundational Helm changes (e.g., `kubeclaw.io/role` labels on existing pods to make NetworkPolicy selectors work) are in scope.
- Automatic GC of orphaned per-group Deployments when a capability spec is removed (admin shell command in v1)

## Architecture

### Component overview

```
                                  ┌─────────────────────────────────┐
                                  │ Orchestrator (existing pod)     │
                                  │  ┌───────────────────────────┐  │
                                  │  │ src/per-group-capabilities/│ │
                                  │  │  • reconciler.ts          │  │
                                  │  │  • discovery.ts ext.      │  │
                                  │  │  • scale-down-sweeper.ts  │  │
                                  │  │  • gc.ts                  │  │
                                  │  │  • credentials.ts         │  │
                                  │  └───────────────────────────┘  │
                                  └───────────┬─────────────────────┘
                                              │ K8s API + Redis IPC + SQLite
                                              ▼
        ┌──────────────────────┐    ┌──────────────────────────────────┐
        │ Channel Pod (existing)│   │ K8s per-(group × capability)     │
        │  • discovery RPC     │◄──►│  Deployment (replicas: 0)        │
        │  • new "warming" state│   │  Service (always exists)         │
        │  • holds groups in    │   │  NetworkPolicy (coarse v1)       │
        │    sequence           │   │  Optional Secret (creds)          │
        └──────────────────────┘    └──────────────────────────────────┘
```

### 1. Capability spec schema additions

`src/capabilities/types.ts` — extend `McpCapabilitySpec`:

```ts
type CapabilityScope = 'cluster' | 'group';

interface McpCapabilitySpec {
  // existing fields...
  scope?: CapabilityScope;                    // default 'cluster'
  // group-scope-only fields (validated to be unset when scope='cluster'):
  scaleDownAfterIdleSeconds?: number;         // default 600
  volumeFromGroupPvc?: boolean;               // default false
  credentialsFrom?: 'none' | 'secret';        // default 'none'
}
```

Validator:
- `scope: cluster` rejects the four group-only fields (with clear error)
- `scope: group` accepts defaults for missing optional fields
- `scaleDownAfterIdleSeconds` must be ≥ 60 (prevents thrash)

### 2. SQLite tracking table

New table `per_group_capability_instances`:

```sql
CREATE TABLE per_group_capability_instances (
  group_folder      TEXT NOT NULL,
  capability_name   TEXT NOT NULL,
  group_hash        TEXT NOT NULL,             -- sha1(group_folder)[:10]
  deployment_name   TEXT NOT NULL,             -- 'mcp-{capability}-{group_hash}'
  service_name      TEXT NOT NULL,             -- same shape as deployment_name
  current_replicas  INTEGER NOT NULL DEFAULT 0,
  last_used_at      INTEGER,                   -- unix seconds
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (group_folder, capability_name)
);

CREATE INDEX idx_per_group_cap_hash
  ON per_group_capability_instances(group_hash);
```

Hash → group lookup needed by GC for human-readable logs. Hash is deterministic, no collision-handling logic in v1 (10 hex chars = 40 bits; for personal-AI scale this is fine).

### 3. Reconciler (`src/per-group-capabilities/reconciler.ts`)

Pure function `diff()` + side-effecting `apply()` pattern (same shape as the global specialist reconciler shipped recently).

**Inputs:**
- List of groups from SQLite (`groups` table)
- List of capability specs filtered to `scope: group` (from the unified capabilities source — Helm baseline + admin overrides)

**Computed desired state:**
For each (group, group-scoped-capability) pair: one Deployment (replicas: 0), one Service, one NetworkPolicy, optionally one Secret if `credentialsFrom: secret` and the user has set creds.

**Apply:**
- Use `@kubernetes/client-node` server-side apply with field manager `kubeclaw-per-group-capability-reconciler`
- Idempotent: re-running over existing K8s state produces no diff
- Labels on every object:
  - `kubeclaw.io/scope: group`
  - `kubeclaw.io/capability: <name>`
  - `kubeclaw.io/group-hash: <hash>`
  - `kubeclaw.io/managed-by: kubeclaw-orchestrator`

**Reconcile triggers:**
- Orchestrator startup (full pass)
- SQLite `groups` table change (group added/removed → narrow reconcile)
- Capability spec change (Helm upgrade or admin shell mutation → full pass)
- 5-minute periodic safety reconcile via a background loop (same pattern as the scale-down sweeper; catches K8s state drift from `kubectl delete` etc.)

**Failure handling:**
- Per-object errors logged at WARN; reconciler continues to next object
- Partial state OK (next reconcile heals)
- No "rollback" — desired state always wins

### 4. Discovery extension (`src/per-group-capabilities/discovery.ts`)

Today's discovery handler in `src/capabilities/discovery.ts` returns endpoint synchronously from the registry. New flow:

```
Channel pod sends discovery request:
  { capability: 'filesystem', group: 'Family' }

Orchestrator handler:
  1. Look up capability spec
  2. If scope='cluster': existing path
  3. If scope='group':
     a. Resolve (group, capability) → deployment_name via SQLite
     b. Read current Deployment replicas
     c. If replicas=0: patch to 1; record state='warming'
     d. Wait for pod Ready condition (timeout configurable, default 30s)
     e. Update last_used_at in Redis AND SQLite
     f. Return { endpoint, state: 'ready' }
  4. On timeout: return { state: 'failed', error: 'pod did not become ready' }
```

**Discovery response schema additions:**
```ts
type DiscoveryResponse =
  | { state: 'ready'; endpoint: string; kindMetadata: ... }
  | { state: 'warming'; estimatedSeconds: number }     // not used in v1 (always blocks)
  | { state: 'failed'; error: string };
```

`'warming'` state is reserved for a future non-blocking variant; v1 always blocks up to the timeout. Documenting the schema now avoids a breaking change later.

**Channel-side handling (extension to `src/runtime/direct-llm-runner.ts`'s MCP manager):**
- `state: 'failed'` → MCP tool call returns a structured error to the LLM ("capability unavailable: pod did not become ready"); the LLM can retry or work around
- `state: 'ready'` → existing path

### 5. Scale-down sweeper (`src/per-group-capabilities/scale-down-sweeper.ts`)

Background async loop in the orchestrator. Runs every 60s (configurable via env `PER_GROUP_SWEEP_INTERVAL_SECONDS`).

```
For each row in per_group_capability_instances where current_replicas > 0:
  last_used = max(SQLite.last_used_at, Redis.last_used_at)  # Redis is hot path
  if (now - last_used) >= capability.scaleDownAfterIdleSeconds:
    patch Deployment to replicas=0
    update SQLite current_replicas=0
    log INFO with (group, capability, idle_seconds)
```

Sweep failures (K8s API error, missing Deployment) logged WARN, retried next sweep.

### 6. GC on group deletion (`src/per-group-capabilities/gc.ts`)

Triggered by group delete in admin shell (existing flow) or by SQLite group row removal.

```
On group delete (group_folder):
  group_hash = sha1(group_folder)[:10]
  K8s: delete all objects (Deployment, Service, NetworkPolicy, Secret) with
       label kubeclaw.io/group-hash=<hash>
  SQLite: DELETE FROM per_group_capability_instances WHERE group_folder=?
  Redis: DEL last_used keys matching pattern
```

Cascade is best-effort. Orphaned K8s objects with `kubeclaw.io/managed-by=kubeclaw-orchestrator` and a `group_hash` label that doesn't match any current SQLite group are cleaned up by the next periodic reconcile (covers orchestrator crash mid-delete).

### 7. Credentials (`src/per-group-capabilities/credentials.ts`)

v1 supports `credentialsFrom: 'secret'` only.

**Admin shell tool:** `set_group_credential(group, capability, env_name, value)`
- Computes group_hash
- Upserts a K8s Secret named `mcp-{capability}-{group_hash}-creds`
- Secret data is a flat `env_name: base64(value)` map
- Reconciler reads Secret existence at apply time and injects `envFrom: [{ secretRef: { name: ... } }]` into the Deployment podSpec

**Lifecycle:**
- Set: creates/updates Secret + triggers Deployment reconcile to pick up envFrom
- Get: not exposed (write-only via admin shell; secrets remain in K8s only)
- Delete: `unset_group_credential(group, capability, env_name)` removes the env key; deletes the Secret if empty
- GC on group delete: removes Secrets via the standard label cascade

Broker per-group rules deferred — when the first capability needs broker stamping (e.g., GitHub token in `Authorization` header), Phase A's `credentialsFrom: 'broker'` variant can be added.

### 8. NetworkPolicy (v1 coarse)

Per per-group MCP Deployment, the reconciler generates:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: mcp-{capability}-{group_hash}
  labels: { kubeclaw.io/scope: group, kubeclaw.io/capability: ..., kubeclaw.io/group-hash: ... }
spec:
  podSelector:
    matchLabels: { kubeclaw.io/scope: group, kubeclaw.io/capability: ..., kubeclaw.io/group-hash: ... }
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - podSelector: { matchLabels: { kubeclaw.io/role: channel } }
        - podSelector: { matchLabels: { kubeclaw.io/role: orchestrator } }
      ports: [{ protocol: TCP, port: 3000 }]
  egress:
    - to: [{ namespaceSelector: {}, podSelector: { matchLabels: { kubeclaw.io/role: redis } } }]
      ports: [{ protocol: TCP, port: 6379 }]
    # DNS (cluster CoreDNS)
    - to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } } }]
      ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]
```

**Known soft boundary (documented in `docs/PER_GROUP_CAPABILITIES.md`):** any channel pod can reach any per-group MCP Service if it knows the Service name. v1 relies on (a) per-group volumes, (b) per-group credentials, (c) channel runtime correctness for real isolation. Tighter per-pod identity ingress deferred to v2.

### 9. Channel pod labels

For the NetworkPolicy ingress selector to work, channel pods need a stable label. Existing channel pods don't have one. Helm change: add `kubeclaw.io/role: channel` to all channel Deployment templates; same for the orchestrator (`kubeclaw.io/role: orchestrator`) and Redis (`kubeclaw.io/role: redis`). This is a one-line addition to each template's pod metadata.

## Telemetry

New structured log events (pino):
- `per_group_capability_reconcile_started` / `_completed` (with diff summary)
- `per_group_capability_scale_up` (group, capability, cold_start_ms)
- `per_group_capability_scale_down` (group, capability, idle_seconds)
- `per_group_capability_gc` (group, deleted_object_count)
- `per_group_capability_discovery_failed` (group, capability, reason)

No new SQLite metrics tables in Phase A. `per_group_capability_instances.last_used_at` is the only persisted activity record.

## Tests

All three levels per project policy.

**Unit (vitest, no K8s, in-process):**
- Schema validator: rejects group-only fields under `scope: cluster`; accepts defaults under `scope: group`; rejects `scaleDownAfterIdleSeconds < 60`
- Reconciler `diff()` against a fake K8s state — desired vs. actual produces correct create/update/delete set
- Hash collision behavior: two distinct group folders → distinct hashes (probabilistic, not enforced)
- Discovery state machine: `replicas=0` → patch → wait → ready transitions correctly; timeout returns `failed`
- Sweeper: idle threshold edge cases (just under, just over, no `last_used_at`)
- GC cascade: SQLite removal triggers correct K8s label selector
- Credentials helper: Secret upsert and unset shapes

**Integration (against real K8s via minikube, in `e2e/integration/`):**
- Reconciler creates Deployment+Service+NetworkPolicy for a (test_group, fake_capability) pair; objects have correct labels and the Deployment has `replicas: 0`
- Patching Deployment to `replicas: 1` causes pod to come up; setting back to `replicas: 0` removes pod
- Secret set via `set_group_credential` is mounted by next reconcile
- Group delete cascades to all four object types
- Sweeper scales down after configured idle (use 60s threshold for the test; assert within 90s)

**E2E (`e2e/per-group-capabilities/`):**
- Full lifecycle: install with one `scope: group` test capability declared in Helm values → create group → channel pod's discovery RPC scales pod up → channel-pod-internal MCP tool call returns expected output → idle period → sweeper scales pod down → delete group → cascade cleanup
- Cold-start latency: first discovery (cold) under 30s; second discovery (warm) under 1s
- Negative: discovery for nonexistent group returns clean error to the channel

Test capability: a minimal `kubeclaw-echo-mcp` container (~30 lines, Node) that exposes one tool `echo(msg) -> msg`. Lives in `container/echo-mcp/`. Used only for tests — not shipped.

## Migration

- Additive — no breaking change to existing capability specs (`scope` defaults to `cluster`)
- New label `kubeclaw.io/role` on channel/orchestrator/Redis pods may invalidate user-customized PodDisruptionBudgets or HorizontalPodAutoscalers that select on existing labels (unlikely — call out in CHANGELOG)
- SQLite migration adds the new table idempotently on orchestrator startup (existing migration pattern)
- No data backfill needed (new feature, no existing per-group capabilities)
- CHANGELOG.md Unreleased section: Features → "Per-group MCP capability tier (`scope: group`) with scale-to-zero"; Breaking changes → none

## Implementation phasing (within Phase A)

Tasks naturally order:
1. Schema (`scope` + validator), SQLite table
2. Reconciler (with fake K8s client; pure logic)
3. Real K8s apply layer (`@kubernetes/client-node` server-side apply)
4. Discovery scale-up extension
5. Scale-down sweeper
6. GC
7. Credentials helper + admin shell tool
8. Channel/orchestrator/Redis label additions in Helm
9. NetworkPolicy generation
10. Echo MCP container for tests
11. Integration tests
12. E2E test
13. Docs (`docs/PER_GROUP_CAPABILITIES.md`)
14. CHANGELOG entry

## Open questions

- **Discovery RPC timeout default.** 30s chosen as conservative; first real consumer (filesystem, ~2s cold start expected; docling, ~20s) will inform tuning. Configurable per-capability via `discoveryTimeoutSeconds` field if needed — not adding to v1 to keep schema small.
- **Reconciler 5-min periodic safety pass.** Adds K8s API load. Could be made event-driven only (group/spec change triggers) — but periodic catches manual `kubectl delete` drift. Keeping for v1.
- **Echo MCP container — bundle or separate?** Going separate (`container/echo-mcp/`) since it's test-only and shouldn't ship in any production image.

## Future work (out of scope for Phase A)

- **Phase B:** Filesystem MCP (per-group consumer of this foundation) + Docling MCP (cluster-scope, separate consumer)
- **v2 hardening:** Per-pod identity for NetworkPolicy ingress (SPIFFE / ServiceAccount tokens)
- **Broker per-group rules:** When first capability needs `Authorization`-header stamping
- **Anticipatory warm-up:** Scheduled-task path can pre-warm capabilities before the task fires
- **Multi-replica per-group capabilities:** If a per-group capability needs HA
- **Cross-channel MCP sharing within a group:** Currently each channel discovers independently

---

**Approval state:** Conversationally approved 2026-05-17. Spec written for reference and to ground the implementation plan.
