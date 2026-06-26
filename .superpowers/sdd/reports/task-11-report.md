# Task 11 Report — docs: per-group database capability

## Sections added to `docs/PER_GROUP_CAPABILITIES.md`

1. **Extended capability spec fields** — documents four new fields added to
   `CapabilityBase` in `src/capabilities/types.ts`:
   - `sidecars` — extra containers co-located in the pod, share the
     credentials `envFrom`; verified against `src/per-group-capabilities/k8s-objects.ts`
     (renderDeployment sidecar loop).
   - `storage` — dedicated per-group PVC with `sizeGi`, `mountPath`, and
     `container` fields; also documents the `Recreate` strategy implication
     for RWO PVCs; verified against `src/capabilities/types.ts` `CapabilityStorage`
     interface and `src/per-group-capabilities/k8s-objects.ts`.
   - `pinned` — skips scale-to-zero sweeper, starts at `replicas: 1`;
     verified against `src/per-group-capabilities/scale-down-sweeper.ts`
     (`resolveGroupCapability(spec).pinned` early-continue) and `k8s-objects.ts`
     (`replicas: resolved.pinned ? 1 : 0`).
   - `podSecurity.fsGroup` — pod-level GID for PVC ownership; verified against
     `src/capabilities/types.ts` `CapabilityPodSecurity.fsGroup` and
     `k8s-objects.ts` (`securityContext: { fsGroup: ... }` in pod spec).

2. **Database capability** — covers enabling via admin shell, the two tools
   (`query` / `execute`), `allowedTools: [query]` default with opt-in path,
   read-only enforcement via the `kubeclaw_ro` role (Postgres grants, not
   SET), `KUBECLAW_DB_STATEMENT_TIMEOUT_MS` / `KUBECLAW_DB_MAX_ROWS` guardrails,
   and the four per-group credentials provisioned at reconcile time.

3. **Isolation model and G3 residual** — explains the two isolation layers
   (per-group engine + per-group MCP token) and explicitly documents the G3
   gap: `renderNetworkPolicy` admits any channel/orchestrator pod, not just the
   same group's pod; token is the sole enforcement boundary. Verified against
   `src/per-group-capabilities/k8s-objects.ts` NetworkPolicy ingress rules.

4. **PVC durability** — covers the `kubeclaw.io/retain: "true"` annotation
   (verified in `src/per-group-capabilities/pvc.ts`), the GC comment in
   `src/per-group-capabilities/gc.ts` that PVCs are intentionally excluded
   from `deleteByLabel`, and manual cleanup instructions.

## Claims verified against code

| Claim | Verified in |
|---|---|
| `sidecars` share `envFrom` | `k8s-objects.ts` sidecar loop: `envFrom` passed to each sidecar |
| `storage.container` defaults to primary | `k8s-objects.ts`: `spec.storage?.container ?? 'mcp'` |
| Dedicated PVC uses `Recreate` strategy | `k8s-objects.ts`: `hasPvc ? { strategy: { type: 'Recreate' } } : {}` |
| `pinned` exempt from sweeper | `scale-down-sweeper.ts`: `if (resolveGroupCapability(spec).pinned) continue;` |
| `pinned` starts at replicas: 1 | `k8s-objects.ts`: `replicas: resolved.pinned ? 1 : 0` |
| `fsGroup` in pod securityContext | `k8s-objects.ts`: `spec.podSecurity?.fsGroup !== undefined` guard |
| PVC name is `mcp-{cap}-{hash}-data` | `pvc.ts`: `pvcName = instanceName(...) + '-data'`; `instanceName = mcp-${name}-${hash}` |
| PVC retain annotation | `pvc.ts`: `annotations: { 'kubeclaw.io/retain': 'true' }` |
| GC excludes PVCs | `gc.ts`: comment + `deleteByLabel` targets Deployments/Services/NetPols/Secrets |
| `kubeclaw_ro` role bootstrapped at startup | `container/postgres-mcp/server.ts` bootstrap block before HTTP server opens |
| ro enforcement is ROLE-BASED not SET | server.ts comment + ro pool uses `PG_RO_USER` separate creds |
| `execute` gated by `allowedTools` | `values.yaml`: `allowedTools: [query]`; server advertises both tools in ListTools |
| `KUBECLAW_MCP_TOKEN` required at startup | `server.ts`: exits if `!MCP_TOKEN` |
| NetworkPolicy admits any channel/orch pod | `k8s-objects.ts`: `{ podSelector: { matchLabels: { 'kubeclaw.io/role': 'channel' } } }` — no group scope |
| Group hash is SHA-1 first 10 hex chars | `src/per-group-capabilities/hash.ts` |
| Credentials: 4 keys provisioned | `src/per-group-capabilities/provision-credentials.ts` |

## Correction during authoring

The initial task brief stated the group hash is "first 8 chars of SHA-256".
Actual code (`hash.ts`) uses SHA-1 and takes 10 chars. Documentation reflects
the actual implementation.
