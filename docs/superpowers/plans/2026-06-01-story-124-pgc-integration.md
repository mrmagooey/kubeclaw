# Story 124: Per-Group Capabilities Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and verify the per-group MCP capability lifecycle — reconcile, scale-up, idle sweep, and GC — against a real Kubernetes cluster via `RealPerGroupK8sClient`.

**Architecture:** Four pure functions (`reconcileGroupCapabilities`, `scaleUpInstance`, `sweepIdleInstances`, `gcGroup`) each live in their own module under `src/per-group-capabilities/` and are barrel-exported through `src/per-group-capabilities/index.ts`. State is persisted in SQLite (via `src/per-group-capabilities/db.ts`) so the sweeper can track `last_used` timestamps without a round-trip to Kubernetes. The e2e tests run against real K8s (minikube) using `RealPerGroupK8sClient` and a dedicated `kubeclaw-test-pgc` namespace, with `afterEach` cleanup via label selector to keep tests hermetic.

**Tech Stack:** TypeScript, Vitest (e2e suite), `@kubernetes/client-node`, SQLite (better-sqlite3), kubectl CLI (namespace setup), minikube (image loading), `kubeclaw-echo-mcp:test` container image.

---

## RETROSPECTIVE NOTE

Implementation was complete before this plan was written. All 3 e2e tests pass (`3/3`). This document records the design decisions and AC mapping for future reference.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/per-group-capabilities/index.ts` | Barrel re-exports + orchestrator lifecycle hooks |
| `src/per-group-capabilities/reconciler.ts` | `reconcileGroupCapabilities` — apply-only Deployment/Service/NetworkPolicy upsert |
| `src/per-group-capabilities/scale-up.ts` | `scaleUpInstance` — patch replicas to 1, wait for ready, update SQLite |
| `src/per-group-capabilities/scale-down-sweeper.ts` | `sweepIdleInstances` + `startSweeperLoop` — query SQLite for idle instances, patch to 0 |
| `src/per-group-capabilities/gc.ts` | `gcGroup` — delete by label selector + SQLite row removal |
| `src/per-group-capabilities/k8s-client.ts` | `RealPerGroupK8sClient` / `FakePerGroupK8sClient` interface + impls |
| `src/per-group-capabilities/db.ts` | SQLite helpers: `upsertInstance`, `getInstance`, `setReplicas`, `touchLastUsed`, `listInstancesAtReplicas`, `listInstances`, `deleteInstancesByGroup` |
| `src/per-group-capabilities/k8s-objects.ts` | Template renderers: `renderDeployment`, `renderService`, `renderNetworkPolicy`, `instanceName` |
| `src/per-group-capabilities/hash.ts` | `groupHash(groupFolder)` — stable short hash for K8s name suffix |
| `src/per-group-capabilities/types.ts` | `CapabilityScope`, `ResolvedGroupCapability`, `resolveGroupCapability`, `getScope`, `validateScopeFields`, `PerGroupCapabilityError` |
| `e2e/per-group-capabilities-integration.test.ts` | 3-test e2e suite against real K8s |
| `container/echo-mcp/build.sh` | Builds `kubeclaw-echo-mcp:test` image used by tests |

---

## AC → Task Mapping

### AC 1: `reconcileGroupCapabilities` creates Deployments/Services on first call

**Test:** `it('reconciler creates Deployment+Service+NetworkPolicy at replicas: 0')`

- [x] **Task 1.1:** Define `ReconcileArgs` interface in `src/per-group-capabilities/reconciler.ts`
- [x] **Task 1.2:** Implement `reconcileGroupCapabilities` — filter to `scope: group` specs, compute `groupHash`, call `applyNetworkPolicy` / `applyService` / `applyDeployment` on the client, then `upsertInstance` in SQLite
- [x] **Task 1.3:** Implement `renderDeployment` / `renderService` / `renderNetworkPolicy` in `k8s-objects.ts` — templates carry `kubeclaw.io/managed-by`, `kubeclaw.io/capability`, `kubeclaw.io/group-hash` labels; Deployment starts at `replicas: 0`; Service exposes `targetPort: 3000`
- [x] **Task 1.4:** Implement `RealPerGroupK8sClient.applyDeployment` / `applyService` / `applyNetworkPolicy` using server-side apply (`kubectl apply --server-side`)
- [x] **Task 1.5:** Run e2e test; verify `dep.spec.replicas === 0` and labels/port assertions pass

### AC 2: `scaleUpInstance` brings a scaled-to-zero deployment to ready

**Test:** first half of `it('scaleUpInstance brings pod to ready then sweeper scales down')`

- [x] **Task 2.1:** Implement `scaleUpInstance` in `src/per-group-capabilities/scale-up.ts` — read instance row from SQLite (`getInstance`), skip patch if already at 1, call `patchDeploymentReplicas(ns, name, 1)`, call `waitForReady`, update `setReplicas` + `touchLastUsed` in SQLite, return `{ state: 'ready', endpoint, coldStartMs }`
- [x] **Task 2.2:** Implement `RealPerGroupK8sClient.patchDeploymentReplicas` (strategic merge patch on `spec.replicas`)
- [x] **Task 2.3:** Implement `RealPerGroupK8sClient.waitForReady` — poll `readDeployment` until `status.readyReplicas >= 1` or timeout

### AC 3: `sweepIdleInstances` scales idle instances back to 0

**Test:** second half of `it('scaleUpInstance brings pod to ready then sweeper scales down')`

- [x] **Task 3.1:** Implement `sweepIdleInstances` in `src/per-group-capabilities/scale-down-sweeper.ts` — call `listInstancesAtReplicas(1)` from SQLite, compare `now - lastUsedAt` vs `scaleDownAfterIdleSeconds`, call `patchDeploymentReplicas(ns, name, 0)` for idle ones, update `setReplicas`
- [x] **Task 3.2:** Export `touchLastUsed` from `src/per-group-capabilities/db.ts` so tests can backdate `last_used` to simulate idleness
- [x] **Task 3.3:** Run second half of e2e test — back-date `last_used` by 120s (well past 60s threshold on `echoSpec`), call `sweepIdleInstances`, assert `dep.spec.replicas === 0`

### AC 4: `gcGroup` removes all K8s resources for a deleted group

**Test:** `it('gcGroup removes all K8s objects for the group')`

- [x] **Task 4.1:** Implement `gcGroup` in `src/per-group-capabilities/gc.ts` — compute `groupHash`, build label selector `kubeclaw.io/group-hash=<hash>`, call `deleteByLabel(ns, selector)`, call `deleteInstancesByGroup(groupFolder)` in SQLite
- [x] **Task 4.2:** Implement `RealPerGroupK8sClient.deleteByLabel` — delete Deployments, Services, NetworkPolicies matching the label selector (used both in `gcGroup` and in `afterEach` cleanup)
- [x] **Task 4.3:** Run e2e test — assert `readDeployment` and `readService` both return `null` after GC

### AC 5: All ops use `RealPerGroupK8sClient` against a real cluster

- [x] **Task 5.1:** `beforeAll` in test file creates the `kubeclaw-test-pgc` namespace via `kubectl apply --dry-run=client -o yaml | kubectl apply -f -`
- [x] **Task 5.2:** `beforeAll` builds + loads `kubeclaw-echo-mcp:test` via `./container/echo-mcp/build.sh` + `minikube image load` (best-effort; warns on failure)
- [x] **Task 5.3:** `describe.skipIf(!K8S_AVAILABLE)` gates the entire suite on `isKubernetesAvailable()` from `e2e/setup.ts` — non-cluster CI skips cleanly

---

## Verification

```bash
npm run test:e2e -- per-group-capabilities-integration
```

Expected output:
```
Test Files  1 passed (1)
      Tests  3 passed (3)
```

All 3 tests pass in ~18s on a live minikube cluster with the echo-mcp image pre-loaded.
