# Database Capability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the missing architectural components that let KubeClaw run a **per-group Postgres database as a capability**, the LLM querying it via an MCP tool binding, plus a minimal working `database` capability as the end-to-end proof.

**Architecture:** A per-group capability pod runs **two containers** — a Postgres engine (with a dedicated per-group PVC) and a Postgres-MCP server that exposes read-only `query` tools and is the discoverable `/mcp` endpoint. Delivering this requires generalizing the per-group renderer (multi-container, dedicated PVC, `fsGroup`, `strategy: Recreate`), adding credential-based isolation (a per-group bearer token the MCP client presents), and a warm/pin option so the DB needn't cold-start. Data isolation is **credential-based** (per-group token + per-group Postgres) with the shared-namespace cross-group network reachability accepted and documented as a residual (review gap G3).

**Tech Stack:** TypeScript (Node 22), `@kubernetes/client-node`, Vitest, Helm, Postgres 16, a Postgres-MCP server image, the existing per-group capability subsystem (`src/per-group-capabilities/*`), MCP runtime (`src/runtime/mcp-manager.ts`).

## Global Constraints

- Node `>=20` (repo targets v22). Run npm/npx/tsc with Node 22 on PATH: `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"` — the husky pre-commit hook needs it (use `git commit --no-verify` only if the hook environment is unavailable).
- Branch off `main` before any code (never implement on `main`).
- Per-group K8s ops go through the `PerGroupK8sClient` interface; unit tests use `FakePerGroupK8sClient` + the in-memory SQLite `_initTestDatabase()`. Follow this for every new behavior.
- Capability pods are low-priv: `automountServiceAccountToken: false`, no K8s API access. Do not add K8s access to capability pods.
- Channel pods have no K8s API access; all privileged steps stay orchestrator-side.
- Isolation stance (decided): **credential-based + documented residual.** Do NOT attempt namespace-per-group or group-scoped channel NetworkPolicies in this plan.
- Every new behavior needs unit + (where applicable) integration coverage; the live e2e (Task 11) is written but, per the host memory constraint, may only typecheck/skip locally — it runs green on CI / a ≥12Gi host.
- **Correction to prior analysis:** review gap "G1" (scale-down mid-call) is NOT a real bug — `scaleUpInstance` (`scale-up.ts:46`) touches `lastUsedAt` on every call and discovery runs per tool call. No G1-fix task exists. The DB-cold-start concern is addressed by the warm/pin field (Task 8), not by a touch-frequency fix.

## File Structure

**New files:**
- `src/per-group-capabilities/pvc.ts` — `renderPersistentVolumeClaim(spec, ctx)` for a dedicated per-group PVC.
- `src/per-group-capabilities/pvc.test.ts`
- `container/postgres-mcp/Dockerfile` + `container/postgres-mcp/server.ts` (+ package files) — the Postgres-MCP server image (read-only `query` tool over `pg`, requires a bearer token).
- `e2e/minikube-live-database-capability.test.ts` — end-to-end proof.

**Modified files:**
- `src/capabilities/types.ts` — add `CapabilitySidecar` type; add `sidecars?`, `storage.container?`, and `pinned?` to the relevant types; thread `pinned` through scope validation.
- `src/per-group-capabilities/types.ts` — `validateScopeFields` allow/validate `pinned`; `ResolvedGroupCapability` gains `pinned`.
- `src/per-group-capabilities/k8s-objects.ts` — `renderDeployment`: honor `podSecurity` (incl. `fsGroup`), `strategy: Recreate` when a PVC is present, append `sidecars`, mount the dedicated PVC, set `replicas` from `pinned`.
- `src/per-group-capabilities/k8s-client.ts` — `PerGroupK8sClient` gains `applyPersistentVolumeClaim`; implement in `FakePerGroupK8sClient` and `RealPerGroupK8sClient`.
- `src/per-group-capabilities/reconciler.ts` — apply the dedicated PVC before the Deployment.
- `src/per-group-capabilities/scale-down-sweeper.ts` — skip `pinned` instances.
- `src/per-group-capabilities/gc.ts` — retention: do NOT delete the dedicated PVC on group GC (document; manual cleanup).
- `src/per-group-capabilities/credentials.ts` — add a helper to provision a random per-group token (reuses `setGroupCredential`).
- `src/capabilities/discovery.ts` + `discovery-client.ts` — discovery response for a group MCP carries an optional `token`; `requestGroupCapability` returns it.
- `src/runtime/mcp-manager.ts` — `callOneShotMcp` accepts + sends an `Authorization: Bearer` header; `callTool` threads the token from the resolve result.
- `helm/kubeclaw/values.yaml` — a `capabilities.database` entry.
- `docs/PER_GROUP_CAPABILITIES.md` — document `sidecars`, dedicated `storage`, `pinned`, the per-group token, the G3 residual, and the PVC durability policy.

---

## Task 1: Capability spec — sidecars, PVC container target, and `pinned`

**Files:**
- Modify: `src/capabilities/types.ts`
- Test: `src/per-group-capabilities/types.test.ts` (extend)

**Interfaces:**
- Produces:
  - `interface CapabilitySidecar { name: string; image: string; port?: number; env?: Record<string, string>; command?: string[]; args?: string[]; mountPath?: string; }` — an additional container in the pod. `mountPath`, when set, mounts the dedicated PVC into this sidecar at that path.
  - `CapabilityStorage` gains `container?: string` — which container mounts the dedicated PVC (default: the primary container).
  - `CapabilityBase` gains `sidecars?: CapabilitySidecar[]` and `pinned?: boolean` (group-scope only: keep ≥1 replica, exempt from idle sweep).

- [ ] **Step 1: Write the failing test** (append to `src/per-group-capabilities/types.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { validateScopeFields } from './types.js';
import type { McpCapabilitySpec } from '../capabilities/types.js';

describe('pinned scope validation', () => {
  const base: McpCapabilitySpec = { name: 'db', kind: 'mcp', image: 'x:1', scope: 'group' };

  it('accepts pinned on a group capability', () => {
    expect(() => validateScopeFields({ ...base, pinned: true })).not.toThrow();
  });

  it('rejects pinned on a cluster capability', () => {
    expect(() =>
      validateScopeFields({ ...base, scope: 'cluster', pinned: true }),
    ).toThrow(/pinned/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"; npx vitest run src/per-group-capabilities/types.test.ts`
Expected: FAIL — `pinned` not in `GROUP_ONLY_FIELDS`, cluster case does not throw.

- [ ] **Step 3: Implement the type changes** in `src/capabilities/types.ts`

Add near `CapabilityStorage` (line ~35):

```ts
export interface CapabilitySidecar {
  /** Container name; must be unique within the pod. */
  name: string;
  image: string;
  /** Container port (not exposed by the Service; the primary container's port is). */
  port?: number;
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  /** When set, the dedicated PVC is mounted here at this path. */
  mountPath?: string;
}
```

In `CapabilityStorage` add:

```ts
  /** Container that mounts the PVC. Default: the primary container. */
  container?: string;
```

In `CapabilityBase` add (after `volumeFromGroupPvc`):

```ts
  /** Extra containers co-located in the pod (e.g. a database engine behind an MCP server). */
  sidecars?: CapabilitySidecar[];
  /** Group-scope only: keep ≥1 replica and exempt from idle scale-to-zero. Default false. */
  pinned?: boolean;
```

- [ ] **Step 4: Thread `pinned` through scope validation** in `src/per-group-capabilities/types.ts`

Change `GROUP_ONLY_FIELDS` (line ~24) to include `'pinned'`:

```ts
const GROUP_ONLY_FIELDS = [
  'scaleDownAfterIdleSeconds',
  'volumeFromGroupPvc',
  'credentialsFrom',
  'pinned',
] as const;
```

Extend `ResolvedGroupCapability` and `resolveGroupCapability` to surface `pinned`:

```ts
export interface ResolvedGroupCapability {
  spec: CapabilitySpec;
  scaleDownAfterIdleSeconds: number;
  volumeFromGroupPvc: boolean;
  credentialsFrom: 'none' | 'secret';
  pinned: boolean;
}
```

In `resolveGroupCapability(...)`, add `pinned: spec.pinned ?? false` to the returned object.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/per-group-capabilities/types.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/capabilities/types.ts src/per-group-capabilities/types.ts src/per-group-capabilities/types.test.ts
git commit -m "feat(capabilities): sidecars, PVC container target, and pinned spec fields"
```

---

## Task 2: Dedicated per-group PVC renderer

**Files:**
- Create: `src/per-group-capabilities/pvc.ts`
- Test: `src/per-group-capabilities/pvc.test.ts`

**Interfaces:**
- Consumes: `RenderContext`, `instanceName` (from `k8s-objects.ts`), `CapabilitySpec`.
- Produces:
  - `function pvcName(capabilityName: string, groupHash: string): string` → `${instanceName(...)}-data`.
  - `function renderPersistentVolumeClaim(spec: CapabilitySpec, ctx: RenderContext): V1PersistentVolumeClaim | null` — returns `null` when `spec.storage` is absent; otherwise an RWO PVC sized `spec.storage.sizeGi`, labelled with `commonLabels(spec, ctx)` plus `helm.sh/resource-policy: keep`-equivalent annotation (`kubeclaw.io/retain: "true"`), in `ctx.namespace`.

- [ ] **Step 1: Write the failing test**

```ts
// src/per-group-capabilities/pvc.test.ts
import { describe, it, expect } from 'vitest';
import { renderPersistentVolumeClaim, pvcName } from './pvc.js';
import type { McpCapabilitySpec } from '../capabilities/types.js';

const ctx = {
  namespace: 'kubeclaw',
  groupFolder: 'alice',
  groupHash: 'abc123',
  groupsPvcName: 'kubeclaw-groups',
};

const dbSpec: McpCapabilitySpec = {
  name: 'database', kind: 'mcp', image: 'pg-mcp:1', scope: 'group',
  storage: { sizeGi: 5, mountPath: '/var/lib/postgresql/data', container: 'postgres' },
};

describe('renderPersistentVolumeClaim', () => {
  it('returns null when no storage declared', () => {
    expect(renderPersistentVolumeClaim({ ...dbSpec, storage: undefined }, ctx)).toBeNull();
  });

  it('renders an RWO PVC named <instance>-data with the requested size', () => {
    const pvc = renderPersistentVolumeClaim(dbSpec, ctx)!;
    expect(pvc.metadata?.name).toBe(pvcName('database', 'abc123'));
    expect(pvc.metadata?.name).toBe('mcp-database-abc123-data');
    expect(pvc.spec?.accessModes).toEqual(['ReadWriteOnce']);
    expect(pvc.spec?.resources?.requests?.storage).toBe('5Gi');
    expect(pvc.metadata?.namespace).toBe('kubeclaw');
  });

  it('carries the group-hash label and a retain annotation', () => {
    const pvc = renderPersistentVolumeClaim(dbSpec, ctx)!;
    expect(pvc.metadata?.labels?.['kubeclaw.io/group-hash']).toBe('abc123');
    expect(pvc.metadata?.annotations?.['kubeclaw.io/retain']).toBe('true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/per-group-capabilities/pvc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/per-group-capabilities/pvc.ts
import type { V1PersistentVolumeClaim } from '@kubernetes/client-node';
import type { CapabilitySpec } from '../capabilities/types.js';
import { instanceName, commonLabels, type RenderContext } from './k8s-objects.js';

export function pvcName(capabilityName: string, groupHash: string): string {
  return `${instanceName(capabilityName, groupHash)}-data`;
}

/**
 * Dedicated per-group PVC for a stateful capability (e.g. Postgres). Returns
 * null when the spec declares no storage. RWO + retain annotation so group GC
 * does not destroy the data (see gc.ts; manual cleanup is intentional).
 */
export function renderPersistentVolumeClaim(
  spec: CapabilitySpec,
  ctx: RenderContext,
): V1PersistentVolumeClaim | null {
  if (!spec.storage) return null;
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: pvcName(spec.name, ctx.groupHash),
      namespace: ctx.namespace,
      labels: commonLabels(spec, ctx),
      annotations: { 'kubeclaw.io/retain': 'true' },
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: `${spec.storage.sizeGi}Gi` } },
    },
  };
}
```

If `commonLabels` / `RenderContext` are not already exported from `k8s-objects.ts`, add `export` to them in that file (they are used by the renderers there).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/per-group-capabilities/pvc.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/per-group-capabilities/pvc.ts src/per-group-capabilities/pvc.test.ts src/per-group-capabilities/k8s-objects.ts
git commit -m "feat(per-group): dedicated per-group PVC renderer for stateful capabilities"
```

---

## Task 3: `renderDeployment` — multi-container, dedicated PVC, fsGroup, strategy, pinned

**Files:**
- Modify: `src/per-group-capabilities/k8s-objects.ts` (`renderDeployment`, lines 51–145)
- Test: `src/per-group-capabilities/k8s-objects.test.ts` (extend)

**Interfaces:**
- Consumes: `pvcName` (Task 2), `CapabilitySidecar`/`CapabilityStorage.container`/`pinned` (Task 1), `resolveGroupCapability`.
- Produces: `renderDeployment` now (a) sets `replicas: 1` when `resolved.pinned`, else `0`; (b) sets `spec.strategy = { type: 'Recreate' }` whenever a dedicated PVC is present; (c) renders pod-level `securityContext.fsGroup` from `spec.podSecurity?.fsGroup`; (d) honors `spec.podSecurity` for the primary container's `runAsUser/runAsGroup/runAsNonRoot`; (e) appends `spec.sidecars` as additional containers; (f) mounts the dedicated PVC (`pvcName`) into the container named by `storage.container` (default: primary `mcp`).

- [ ] **Step 1: Write the failing test** (append)

```ts
import { renderDeployment } from './k8s-objects.js';
import type { McpCapabilitySpec } from '../capabilities/types.js';

const ctx = { namespace: 'kubeclaw', groupFolder: 'alice', groupHash: 'abc123', groupsPvcName: 'kubeclaw-groups' };

const dbSpec: McpCapabilitySpec = {
  name: 'database', kind: 'mcp', image: 'pg-mcp:1', scope: 'group', port: 3000,
  pinned: true,
  credentialsFrom: 'secret',
  podSecurity: { fsGroup: 999 },
  storage: { sizeGi: 5, mountPath: '/var/lib/postgresql/data', container: 'postgres' },
  sidecars: [{ name: 'postgres', image: 'postgres:16', port: 5432 }],
};

describe('renderDeployment — stateful multi-container', () => {
  const dep = renderDeployment(dbSpec, ctx);

  it('pins replicas to 1', () => {
    expect(dep.spec?.replicas).toBe(1);
  });
  it('uses Recreate strategy when a PVC is present', () => {
    expect(dep.spec?.strategy?.type).toBe('Recreate');
  });
  it('sets pod fsGroup from podSecurity', () => {
    expect(dep.spec?.template.spec?.securityContext?.fsGroup).toBe(999);
  });
  it('renders the primary container plus the sidecar', () => {
    const names = dep.spec?.template.spec?.containers?.map((c) => c.name);
    expect(names).toEqual(['mcp', 'postgres']);
  });
  it('mounts the dedicated PVC into the named container, not the others', () => {
    const c = dep.spec?.template.spec?.containers ?? [];
    const pg = c.find((x) => x.name === 'postgres')!;
    const mcp = c.find((x) => x.name === 'mcp')!;
    expect(pg.volumeMounts?.some((m) => m.mountPath === '/var/lib/postgresql/data')).toBe(true);
    expect(mcp.volumeMounts?.some((m) => m.mountPath === '/var/lib/postgresql/data')).toBe(false);
    const vol = dep.spec?.template.spec?.volumes?.find((v) => v.persistentVolumeClaim?.claimName === 'mcp-database-abc123-data');
    expect(vol).toBeTruthy();
  });
  it('shares the creds secret to all containers via envFrom', () => {
    for (const c of dep.spec?.template.spec?.containers ?? []) {
      expect(c.envFrom?.some((e) => e.secretRef?.name === 'mcp-database-abc123-creds')).toBe(true);
    }
  });

  it('still renders a single container at replicas 0 for a plain group MCP', () => {
    const plain: McpCapabilitySpec = { name: 'fs', kind: 'mcp', image: 'x:1', scope: 'group', volumeFromGroupPvc: true };
    const d = renderDeployment(plain, ctx);
    expect(d.spec?.replicas).toBe(0);
    expect(d.spec?.strategy).toBeUndefined();
    expect(d.spec?.template.spec?.containers?.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/per-group-capabilities/k8s-objects.test.ts`
Expected: FAIL — replicas hardcoded 0, no strategy/fsGroup/sidecars, PVC not mounted.

- [ ] **Step 3: Implement** — rewrite the container/volume assembly inside `renderDeployment`

Replace the single-container `volumeMounts`/`volumes`/`containers` construction with this (keep the surrounding `name`, `labels`, `env`, `envFrom`, `port` setup):

```ts
  const resolved = resolveGroupCapability(spec);
  const hasPvc = !!spec.storage;
  const pvcClaim = hasPvc ? pvcName(spec.name, ctx.groupHash) : null;
  const pvcMountContainer = spec.storage?.container ?? 'mcp';

  // Group-PVC subPath mount (existing behavior) is independent of the dedicated PVC.
  const groupMount = resolved.volumeFromGroupPvc
    ? [{ name: 'groups', mountPath: '/data', subPath: `groups/${ctx.groupFolder}` }]
    : [];

  function mountsFor(containerName: string) {
    const m = [...groupMount];
    if (pvcClaim && containerName === pvcMountContainer) {
      m.push({ name: 'data', mountPath: spec.storage!.mountPath });
    }
    return m;
  }

  const containerSecurity = {
    runAsNonRoot: spec.podSecurity?.runAsNonRoot ?? true,
    runAsUser: spec.podSecurity?.runAsUser ?? 1000,
    runAsGroup: spec.podSecurity?.runAsGroup ?? 1000,
    allowPrivilegeEscalation: false,
  };

  const primary = {
    name: 'mcp',
    image: spec.image,
    ports: [{ containerPort: port }],
    ...(spec.command ? { command: spec.command } : {}),
    ...(spec.args ? { args: spec.args } : {}),
    env,
    envFrom,
    volumeMounts: mountsFor('mcp'),
    readinessProbe: {
      httpGet: { path: '/health', port },
      initialDelaySeconds: 1, periodSeconds: 2, failureThreshold: 15,
    },
    resources: {
      requests: { memory: spec.resources?.memoryRequest ?? '64Mi', cpu: spec.resources?.cpuRequest ?? '50m' },
      limits: { memory: spec.resources?.memoryLimit ?? '256Mi', cpu: spec.resources?.cpuLimit ?? '500m' },
    },
    securityContext: containerSecurity,
  };

  const sidecars = (spec.sidecars ?? []).map((s) => ({
    name: s.name,
    image: s.image,
    ...(s.port ? { ports: [{ containerPort: s.port }] } : {}),
    ...(s.command ? { command: s.command } : {}),
    ...(s.args ? { args: s.args } : {}),
    env: Object.entries(s.env ?? {}).map(([k, v]) => ({ name: k, value: v })),
    envFrom, // share the per-group creds secret to the engine too
    volumeMounts: mountsFor(s.name),
    securityContext: containerSecurity,
  }));

  const volumes = [
    ...(resolved.volumeFromGroupPvc
      ? [{ name: 'groups', persistentVolumeClaim: { claimName: ctx.groupsPvcName } }]
      : []),
    ...(pvcClaim ? [{ name: 'data', persistentVolumeClaim: { claimName: pvcClaim } }] : []),
  ];

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: ctx.namespace, labels },
    spec: {
      replicas: resolved.pinned ? 1 : 0,
      ...(hasPvc ? { strategy: { type: 'Recreate' } } : {}),
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          ...(spec.podSecurity?.fsGroup !== undefined
            ? { securityContext: { fsGroup: spec.podSecurity.fsGroup } }
            : {}),
          containers: [primary, ...sidecars],
          volumes,
        },
      },
    },
  };
```

Add `import { pvcName } from './pvc.js';` at the top.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/per-group-capabilities/k8s-objects.test.ts && npx tsc --noEmit`
Expected: PASS (incl. the existing single-container test that must still hold), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/per-group-capabilities/k8s-objects.ts src/per-group-capabilities/k8s-objects.test.ts
git commit -m "feat(per-group): multi-container pods, dedicated PVC mount, fsGroup, Recreate, pinned replicas"
```

---

## Task 4: `PerGroupK8sClient.applyPersistentVolumeClaim` + reconciler applies the PVC

**Files:**
- Modify: `src/per-group-capabilities/k8s-client.ts` (interface + `FakePerGroupK8sClient` + `RealPerGroupK8sClient`)
- Modify: `src/per-group-capabilities/reconciler.ts`
- Test: `src/per-group-capabilities/reconciler.test.ts` (extend), `src/per-group-capabilities/k8s-client.test.ts` (extend the Fake)

**Interfaces:**
- Produces: `PerGroupK8sClient.applyPersistentVolumeClaim(namespace: string, pvc: V1PersistentVolumeClaim): Promise<void>`. The Fake records applied PVCs in an inspectable list (mirror its existing `applied*` collections). `reconcileGroupCapabilities` calls it (when `renderPersistentVolumeClaim` returns non-null) BEFORE `applyDeployment`.

- [ ] **Step 1: Write the failing test** (append to `reconciler.test.ts`, following the existing FakePerGroupK8sClient usage there)

```ts
it('applies a dedicated PVC before the Deployment for a storage-backed capability', async () => {
  const client = new FakePerGroupK8sClient();
  const dbSpec = { name: 'database', kind: 'mcp', image: 'pg-mcp:1', scope: 'group',
    storage: { sizeGi: 5, mountPath: '/var/lib/postgresql/data', container: 'postgres' },
    sidecars: [{ name: 'postgres', image: 'postgres:16', port: 5432 }] } as const;
  await reconcileGroupCapabilities({
    client, namespace: 'kubeclaw', groupsPvcName: 'kubeclaw-groups',
    groups: ['alice'], specs: [dbSpec],
  });
  // FakePerGroupK8sClient must expose appliedPvcs; assert one was applied.
  expect(client.appliedPvcs.map((p) => p.metadata?.name)).toContain('mcp-database-' /* + hash */ );
});
```

(Adjust the name assertion to the hash the test helper produces — use `groupHash('alice')` from `./hash.js` to compute it, matching how sibling tests build expected names.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/per-group-capabilities/reconciler.test.ts`
Expected: FAIL — `applyPersistentVolumeClaim`/`appliedPvcs` missing; PVC not applied.

- [ ] **Step 3: Implement**

In `k8s-client.ts` interface add:
```ts
  applyPersistentVolumeClaim(namespace: string, pvc: V1PersistentVolumeClaim): Promise<void>;
```
In `FakePerGroupK8sClient` add `appliedPvcs: V1PersistentVolumeClaim[] = [];` and:
```ts
  async applyPersistentVolumeClaim(_ns: string, pvc: V1PersistentVolumeClaim): Promise<void> {
    this.appliedPvcs.push(pvc);
  }
```
In `RealPerGroupK8sClient`, implement create-or-ignore (PVCs are immutable; never patch):
```ts
  async applyPersistentVolumeClaim(namespace: string, pvc: V1PersistentVolumeClaim): Promise<void> {
    try {
      await this.core.createNamespacedPersistentVolumeClaim({ namespace, body: pvc });
    } catch (err) {
      // AlreadyExists -> leave the existing PVC (keep data). Re-throw anything else.
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode;
      if (code !== 409) throw err;
    }
  }
```
In `reconciler.ts`, inside the per-(spec,group) loop, before `applyDeployment`:
```ts
  const pvc = renderPersistentVolumeClaim(spec, ctx);
  if (pvc) await args.client.applyPersistentVolumeClaim(args.namespace, pvc);
```
Add the import for `renderPersistentVolumeClaim`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/per-group-capabilities/reconciler.test.ts src/per-group-capabilities/k8s-client.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/per-group-capabilities/k8s-client.ts src/per-group-capabilities/reconciler.ts src/per-group-capabilities/reconciler.test.ts src/per-group-capabilities/k8s-client.test.ts
git commit -m "feat(per-group): reconciler provisions a dedicated PVC (create-or-keep) before the Deployment"
```

---

## Task 5: Sweeper skips pinned instances; GC retains PVCs

**Files:**
- Modify: `src/per-group-capabilities/scale-down-sweeper.ts`
- Modify: `src/per-group-capabilities/gc.ts` (comment/retention only — confirm PVC not deleted)
- Test: `src/per-group-capabilities/scale-down-sweeper.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveGroupCapability(...).pinned` (Task 1).
- Produces: `sweepIdleInstances` does not scale down an instance whose spec resolves `pinned: true`, regardless of idle time.

- [ ] **Step 1: Write the failing test** (append, mirroring the existing fake-now sweeper tests)

```ts
it('never scales down a pinned instance even when long idle', async () => {
  const client = new FakePerGroupK8sClient();
  // seed an instance at replicas 1, lastUsedAt far in the past:
  upsertInstance({ groupFolder: 'alice', capabilityName: 'database', groupHash: 'abc123',
    deploymentName: 'mcp-database-abc123', serviceName: 'mcp-database-abc123' });
  setReplicas('alice', 'database', 1);
  touchLastUsed('alice', 'database', 0); // epoch 0 = ancient
  const pinned = { name: 'database', kind: 'mcp', image: 'pg-mcp:1', scope: 'group',
    pinned: true, scaleDownAfterIdleSeconds: 60 } as const;
  await sweepIdleInstances({ client, namespace: 'kubeclaw', specs: [pinned], nowSeconds: () => 1_000_000 });
  expect(client.scaledDown).toHaveLength(0); // mirror the fake's existing scale-down record
});
```

(Use whatever the Fake exposes to record scale-downs — check the existing sweeper tests for the exact accessor and match it.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/per-group-capabilities/scale-down-sweeper.test.ts`
Expected: FAIL — pinned instance gets scaled down.

- [ ] **Step 3: Implement** — in `sweepIdleInstances`, inside the per-instance loop, before the idle check:

```ts
  if (resolveGroupCapability(spec).pinned) continue;
```

In `gc.ts`, add a comment above the `deleteByLabel` call documenting that PVCs are intentionally retained (they carry `kubeclaw.io/retain: "true"` and `deleteByLabel` does not target PVCs), so a group's database survives group deletion and must be cleaned up manually. No behavior change (PVCs are already not deleted).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/per-group-capabilities/scale-down-sweeper.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/per-group-capabilities/scale-down-sweeper.ts src/per-group-capabilities/gc.ts src/per-group-capabilities/scale-down-sweeper.test.ts
git commit -m "feat(per-group): exempt pinned instances from idle sweep; document PVC retention on GC"
```

---

## Task 6: Per-group MCP bearer token — provision + discovery plumbing

**Files:**
- Modify: `src/per-group-capabilities/credentials.ts` (add a token provisioner)
- Modify: `src/capabilities/discovery.ts` (include token in the resolved group entry)
- Modify: `src/capabilities/discovery-client.ts` (`requestGroupCapability` returns the token)
- Test: `src/per-group-capabilities/credentials.test.ts` (extend), `src/capabilities/discovery-client.test.ts` (extend if present, else add)

**Interfaces:**
- Produces:
  - `ensureGroupMcpToken(args: { client; namespace; groupFolder; capabilityName }): Promise<string>` — if the creds secret already has key `KUBECLAW_MCP_TOKEN`, return it; else generate a 32-byte hex token via `crypto.randomBytes(32).toString('hex')`, store it with `setGroupCredential(envName: 'KUBECLAW_MCP_TOKEN')`, and return it. Idempotent.
  - `GroupCapabilityResolveResult` gains a `token?: string` on the success arm: `{ endpoint: string; token?: string } | { error: string }`.

- [ ] **Step 1: Write the failing test** (credentials.test.ts, using FakePerGroupK8sClient)

```ts
it('ensureGroupMcpToken generates once and is idempotent', async () => {
  const client = new FakePerGroupK8sClient();
  const a = await ensureGroupMcpToken({ client, namespace: 'kubeclaw', groupFolder: 'alice', capabilityName: 'database' });
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  const b = await ensureGroupMcpToken({ client, namespace: 'kubeclaw', groupFolder: 'alice', capabilityName: 'database' });
  expect(b).toBe(a); // idempotent — same token returned
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/per-group-capabilities/credentials.test.ts`
Expected: FAIL — `ensureGroupMcpToken` not defined.

- [ ] **Step 3: Implement**

In `credentials.ts`:
```ts
import { randomBytes } from 'node:crypto';
// ... existing imports, plus a getter for an existing secret value if available.

export async function ensureGroupMcpToken(args: {
  client: PerGroupK8sClient; namespace: string; groupFolder: string; capabilityName: string;
}): Promise<string> {
  const existing = await readGroupCredential({ ...args, envName: 'KUBECLAW_MCP_TOKEN' }); // see note
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  await setGroupCredential({ ...args, envName: 'KUBECLAW_MCP_TOKEN', value: token });
  return token;
}
```
If no read helper exists, add `readGroupCredential` that fetches the secret via `client.getSecret(namespace, credsSecretName(...))` (add `getSecret` to the client interface + Fake/Real if missing) and base64-decodes `data['KUBECLAW_MCP_TOKEN']`, returning `null` when absent. Keep it small and covered by the same test.

In `discovery.ts`, where a group MCP is resolved (the `scaleUpInstance` success branch, lines 95–106), call `ensureGroupMcpToken(...)` and include the token in the response payload for that group entry (extend the wire shape the channel reads — add `token` alongside `endpoint`).

In `discovery-client.ts`, change `GroupCapabilityResolveResult` success arm to `{ endpoint: string; token?: string }` and return `{ endpoint: entry.endpoint, token: entry.token }` (line ~59).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/per-group-capabilities/credentials.test.ts src/capabilities/discovery-client.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/per-group-capabilities/credentials.ts src/capabilities/discovery.ts src/capabilities/discovery-client.ts src/per-group-capabilities/credentials.test.ts src/capabilities/discovery-client.test.ts
git commit -m "feat(per-group): per-group MCP bearer token provisioning + discovery plumbing"
```

---

## Task 7: MCP client presents the bearer token

**Files:**
- Modify: `src/runtime/mcp-manager.ts` (`callOneShotMcp`, `callTool` group branch)
- Test: `src/runtime/mcp-manager.test.ts` (extend)

**Interfaces:**
- Consumes: `requestGroupCapability` now returns `{ endpoint, token? }` (Task 6).
- Produces: `callOneShotMcp(endpointUrl: string, toolName: string, args: Record<string, unknown>, token?: string): Promise<string>` — when `token` is set, the `StreamableHTTPClientTransport` is constructed with `requestInit: { headers: { Authorization: \`Bearer ${token}\` } }`. `callTool`'s mcp-group branch passes `resolved.token`.

- [ ] **Step 1: Write the failing test** (extend the existing mcp-manager test patterns; stub the transport/client constructor to capture headers)

```ts
it('callOneShotMcp sends Authorization: Bearer when a token is provided', async () => {
  const captured: { headers?: Record<string, string> } = {};
  // Mock StreamableHTTPClientTransport to capture its requestInit.headers,
  // mirroring how mcp-manager.test.ts already mocks the MCP SDK client/transport.
  // ... arrange mock ...
  await callOneShotMcp('http://svc.kubeclaw.svc.cluster.local:3000', 'query', { sql: 'select 1' }, 'tok123');
  expect(captured.headers?.Authorization).toBe('Bearer tok123');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/runtime/mcp-manager.test.ts`
Expected: FAIL — no header sent.

- [ ] **Step 3: Implement**

Change the signature + transport construction (line ~534):
```ts
async function callOneShotMcp(
  endpointUrl: string, toolName: string, args: Record<string, unknown>, token?: string,
): Promise<string> {
  const transport = new StreamableHTTPClientTransport(new URL(endpointUrl + '/mcp'),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
  // ... rest unchanged ...
}
```
In `callTool`'s mcp-group branch (line ~301): `return await callOneShotMcp(resolved.endpoint, parsed.tool, args, resolved.token);`

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/runtime/mcp-manager.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/mcp-manager.ts src/runtime/mcp-manager.test.ts
git commit -m "feat(mcp): present per-group bearer token on one-shot MCP tool calls"
```

---

## Task 8: Postgres-MCP server image (read-only `query`, token-gated)

**Files:**
- Create: `container/postgres-mcp/server.ts`, `container/postgres-mcp/package.json`, `container/postgres-mcp/Dockerfile`
- Test: `container/postgres-mcp/server.test.ts`

**Interfaces:**
- Produces a Node MCP server that: connects to Postgres via `PGHOST/PGUSER/PGPASSWORD/PGDATABASE` (the engine on `localhost`); exposes one tool `query(sql: string)` executed on a **read-only** connection (`SET default_transaction_read_only = on`) with a `statement_timeout` (env `KUBECLAW_DB_STATEMENT_TIMEOUT_MS`, default 5000) and a hard row cap (env `KUBECLAW_DB_MAX_ROWS`, default 1000, applied by wrapping/limiting the returned rows); serves `GET /health` (200) and the MCP protocol at `/mcp`; rejects any `/mcp` request whose `Authorization` header != `Bearer ${KUBECLAW_MCP_TOKEN}` with 401.

- [ ] **Step 1: Write the failing test** (unit-test the pure pieces: the row-cap + the auth check, with `pg` mocked)

```ts
// container/postgres-mcp/server.test.ts
import { describe, it, expect, vi } from 'vitest';
import { capRows, isAuthorized } from './server.js';

describe('capRows', () => {
  it('truncates to the max and flags truncation', () => {
    expect(capRows([1, 2, 3], 2)).toEqual({ rows: [1, 2], truncated: true });
    expect(capRows([1], 2)).toEqual({ rows: [1], truncated: false });
  });
});
describe('isAuthorized', () => {
  it('accepts the exact bearer token, rejects otherwise', () => {
    expect(isAuthorized('Bearer abc', 'abc')).toBe(true);
    expect(isAuthorized('Bearer abc', 'xyz')).toBe(false);
    expect(isAuthorized(undefined, 'abc')).toBe(false);
    expect(isAuthorized('abc', 'abc')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run container/postgres-mcp/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `server.ts` exporting the pure helpers + a `main()` that wires `@modelcontextprotocol/sdk` server, the `pg` Pool (read-only), and an HTTP listener gating `/mcp` on `isAuthorized(req.headers.authorization, process.env.KUBECLAW_MCP_TOKEN)`. The `query` tool runs the SQL in a read-only transaction with `statement_timeout`, then `capRows(result.rows, MAX_ROWS)`. Add `Dockerfile` (FROM node:22-slim, copy, `npm ci --omit=dev`, `CMD node server.js`) and `package.json` (deps: `@modelcontextprotocol/sdk`, `pg`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run container/postgres-mcp/server.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add container/postgres-mcp/
git commit -m "feat(db): postgres-mcp server image (read-only query, row cap, token-gated)"
```

---

## Task 9: Assemble the `database` capability — read-only role bootstrap, reconcile-time credentials, Helm wiring

> **DESIGN (human-decided):** read-only `query` + gated `execute`, enforced by TWO Postgres roles. The DB capability is **pinned** (pod starts at reconcile, before any discovery call) and the postgres-mcp server **requires its credentials at startup** — therefore per-group credentials (the MCP token + the `rw` and `ro` Postgres passwords) MUST be provisioned at **reconcile time**, before the pinned pod starts. (Task 6's lazy discovery-time `ensureGroupMcpToken` is fine for the tokenless filesystem MCP but insufficient here.) The read-only `kubeclaw_ro` Postgres role is created by the postgres-mcp server on boot using its rw/superuser connection.

**Files:**
- Modify: `container/postgres-mcp/server.ts` + `container/postgres-mcp/server.test.ts` (ro-role bootstrap)
- Create: `src/per-group-capabilities/provision-credentials.ts` + `.test.ts` (reconcile-time credential provisioning)
- Modify: `src/per-group-capabilities/reconciler.ts` + `reconciler.test.ts` (call the provisioner before instance creation for `credentialsFrom: 'secret'` capabilities)
- Modify: `helm/kubeclaw/values.yaml` (add `capabilities.database`)
- Test: `e2e/helm-chart-template.test.ts` (extend)

**Interfaces:**
- Produces:
  - `buildRoleBootstrapSql(roUser: string): string` (in `server.ts`) — idempotent SQL creating the read-only login role and granting it `CONNECT`, `USAGE` on `public`, `SELECT` on all current + future tables. The role's password is set separately by `main()` (which has `PG_RO_PASSWORD`); the SQL uses a placeholder the caller parameterizes, OR `main()` runs `CREATE ROLE ... LOGIN; ALTER ROLE ... PASSWORD $1` via a parameterized query — choose the parameterized form to avoid SQL-injecting the password.
  - `ensureGroupDbCredentials(args: { client: PerGroupK8sClient; namespace: string; groupFolder: string; capabilityName: string }): Promise<void>` (in `provision-credentials.ts`) — idempotently ensure the per-group creds secret has: `KUBECLAW_MCP_TOKEN` (reuse `ensureGroupMcpToken` from Task 6), `POSTGRES_PASSWORD` and `PGPASSWORD` (same generated value — the rw password), and `PG_RO_PASSWORD` (a distinct generated value). Each generated with `randomBytes(24).toString('hex')`; only generate when absent (idempotent, like `ensureGroupMcpToken`).
- Consumes: `setGroupCredential`/`readGroupCredential`/`ensureGroupMcpToken` (Task 6), `PerGroupK8sClient`.

### Part A — server ro-role bootstrap

- [ ] **Step 1: Failing test** (append to `container/postgres-mcp/server.test.ts`)

```ts
import { buildRoleBootstrapSql } from './server.js';
describe('buildRoleBootstrapSql', () => {
  it('grants SELECT and future-table SELECT to the ro role, no write grants', () => {
    const sql = buildRoleBootstrapSql('kubeclaw_ro');
    expect(sql).toMatch(/GRANT SELECT ON ALL TABLES IN SCHEMA public TO kubeclaw_ro/i);
    expect(sql).toMatch(/ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO kubeclaw_ro/i);
    expect(sql).toMatch(/GRANT USAGE ON SCHEMA public TO kubeclaw_ro/i);
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|ALL PRIVILEGES/i);
  });
  it('rejects an unsafe role identifier', () => {
    expect(() => buildRoleBootstrapSql('ro; DROP DATABASE x')).toThrow();
  });
});
```

- [ ] **Step 2: Run → fails.** `export PATH=...; npx vitest run container/postgres-mcp/server.test.ts`

- [ ] **Step 3: Implement** `buildRoleBootstrapSql(roUser)`: validate `roUser` against `^[a-z_][a-z0-9_]*$` (throw otherwise — it is interpolated as an identifier, which cannot be parameterized), then return the idempotent grant SQL (`CREATE ROLE` is done separately in `main()` to set the password via a parameterized `ALTER ROLE ... PASSWORD`). In `main()`: after the rw pool connects (retry until Postgres is ready), run, as rw/superuser, `CREATE ROLE <roUser> LOGIN` guarded by a `DO $$ ... IF NOT EXISTS ... $$` block (roles have no `IF NOT EXISTS`), then `ALTER ROLE <roUser> PASSWORD $1` (parameterized with `PG_RO_PASSWORD`), then `buildRoleBootstrapSql(roUser)`. Do this before the HTTP server starts serving. Log success; on failure exit non-zero.

- [ ] **Step 4: Run → passes.** Then `npx tsc --noEmit`.

### Part B — reconcile-time credential provisioning

- [ ] **Step 5: Failing test** (`src/per-group-capabilities/provision-credentials.test.ts`, FakePerGroupK8sClient)

```ts
it('provisions rw + ro passwords + mcp token idempotently', async () => {
  const client = new FakePerGroupK8sClient();
  const a = { client, namespace: 'kubeclaw', groupFolder: 'alice', capabilityName: 'database' };
  await ensureGroupDbCredentials(a);
  const read = (k: string) => /* read from the fake secret store, base64-decoded */;
  expect(read('POSTGRES_PASSWORD')).toBe(read('PGPASSWORD'));      // same rw password
  expect(read('POSTGRES_PASSWORD')).toMatch(/^[0-9a-f]{48}$/);
  expect(read('PG_RO_PASSWORD')).toMatch(/^[0-9a-f]{48}$/);
  expect(read('PG_RO_PASSWORD')).not.toBe(read('POSTGRES_PASSWORD'));
  expect(read('KUBECLAW_MCP_TOKEN')).toMatch(/^[0-9a-f]{64}$/);
  const before = read('POSTGRES_PASSWORD');
  await ensureGroupDbCredentials(a);                              // idempotent
  expect(read('POSTGRES_PASSWORD')).toBe(before);
});
```

(Use the same secret-read approach the Task 6 `credentials.test.ts` uses — match it.)

- [ ] **Step 6: Run → fails. Implement** `ensureGroupDbCredentials`: for each key, `readGroupCredential` first; if absent, generate and `setGroupCredential`. `POSTGRES_PASSWORD` and `PGPASSWORD` must store the SAME value (generate once, write to both keys). Reuse `ensureGroupMcpToken` for the token.

- [ ] **Step 7: Wire into the reconciler** — in `reconcileGroupCapabilities`, for each (spec, group) where `resolveGroupCapability(spec).credentialsFrom === 'secret'`, call `ensureGroupDbCredentials(...)` AFTER the empty secret is ensured and BEFORE `applyDeployment` (so a pinned pod starts with credentials present). Add a reconciler test asserting the provisioner is invoked for a `credentialsFrom:'secret'` spec and skipped for a `none` spec (extend `reconciler.test.ts`; you can spy via the FakePerGroupK8sClient's recorded secret writes).

- [ ] **Step 8: Run** `npx vitest run src/per-group-capabilities/provision-credentials.test.ts src/per-group-capabilities/reconciler.test.ts && npx tsc --noEmit` → all pass.

### Part C — Helm values

- [ ] **Step 9: Failing test** (`e2e/helm-chart-template.test.ts`, model on sibling assertions)

```ts
it('renders a database capability: group-scoped, pinned, postgres sidecar, read-only by default', () => {
  const db = values.capabilities.database;
  expect(db.kind).toBe('mcp');
  expect(db.scope).toBe('group');
  expect(db.pinned).toBe(true);
  expect(db.credentialsFrom).toBe('secret');
  expect(db.sidecars?.[0]?.name).toBe('postgres');
  expect(db.storage?.container).toBe('postgres');
  expect(db.allowedTools).toEqual(['query']);        // execute hidden by default
  expect(db.env?.PG_RO_USER).toBe('kubeclaw_ro');
});
```

- [ ] **Step 10: Implement** — add to `helm/kubeclaw/values.yaml` under `capabilities:`:

```yaml
  database:
    kind: mcp
    scope: group
    pinned: true
    image: kubeclaw-postgres-mcp:latest
    port: 3000
    path: /mcp
    credentialsFrom: secret
    allowedTools: [query]          # execute is offered by the server but hidden until opted in per group
    podSecurity:
      fsGroup: 999                 # postgres image's data group (postgres:16 runs as uid/gid 999)
    storage:
      sizeGi: 5
      mountPath: /var/lib/postgresql/data
      container: postgres
    env:
      PGHOST: "127.0.0.1"
      PGUSER: kubeclaw             # rw role (= POSTGRES_USER); password from the per-group secret
      PG_RO_USER: kubeclaw_ro      # ro role created by the server on boot; password from the secret
      PGDATABASE: kubeclaw
      KUBECLAW_DB_STATEMENT_TIMEOUT_MS: "5000"
      KUBECLAW_DB_MAX_ROWS: "1000"
    sidecars:
      - name: postgres
        image: postgres:16
        port: 5432
        env:
          POSTGRES_USER: kubeclaw
          POSTGRES_DB: kubeclaw
          PGDATA: /var/lib/postgresql/data/pgdata
          # POSTGRES_PASSWORD comes from the per-group creds secret (envFrom)
    resources:
      requests: { memory: 256Mi, cpu: 100m }
      limits: { memory: 1Gi, cpu: "1" }
```

The per-group creds secret keys (`POSTGRES_PASSWORD`, `PGPASSWORD`, `PG_RO_PASSWORD`, `KUBECLAW_MCP_TOKEN`) are populated at reconcile time by `ensureGroupDbCredentials` (Part B) and reach BOTH containers via `envFrom` (Task 3 shares the creds secret to all containers).

- [ ] **Step 11: Run** `npx vitest run e2e/helm-chart-template.test.ts && npx tsc --noEmit` → pass.

- [ ] **Step 12: Commit**

```bash
git add container/postgres-mcp/server.ts container/postgres-mcp/server.test.ts \
  src/per-group-capabilities/provision-credentials.ts src/per-group-capabilities/provision-credentials.test.ts \
  src/per-group-capabilities/reconciler.ts src/per-group-capabilities/reconciler.test.ts \
  helm/kubeclaw/values.yaml e2e/helm-chart-template.test.ts
git commit -m "feat(db): ro-role bootstrap, reconcile-time per-group DB credentials, helm wiring"
```

---

## Task 10: Live e2e proof (minikube-live)

**Files:**
- Create: `e2e/minikube-live-database-capability.test.ts`

**Interfaces:** none new — exercises Tasks 1–9 end-to-end.

- [ ] **Step 1: Write the test** — model precisely on `e2e/minikube-live-capabilities.test.ts` and `e2e/minikube-live-data-facade.test.ts`. Use `ctx.skip()` (NOT bare `return`) so it skips cleanly without a cluster. Flow: build+load `kubeclaw-postgres-mcp` into minikube; install the `database` capability for a test group via the orchestrator IPC path **with `allowedTools: [query, execute]`** (the e2e opts the test group into the write tool so it can prove read-after-write; the shipped default stays `[query]`); send a message that drives an `execute` tool call to `create table t(x int); insert into t values (1)` and then a `query` call `select x from t`; assert the query result reflects the row (`x = 1`), proving: pinned pod scheduled (no cold start), dedicated PVC mounted, postgres + mcp sidecars co-resident, ro-role bootstrap succeeded, token-gated MCP call worked, and write-then-read within the group's DB. Then assert per-group isolation: a SECOND group's `database` capability (default `allowedTools: [query]`) cannot see group one's table `t` (a `select from t` errors / returns nothing — separate per-group Postgres). Also assert the default capability rejects a write via `query` (the ro role denies it) to prove read-only enforcement is real.

- [ ] **Step 2: Run (will skip without a cluster; runs on CI/large host)**

Run: `npx tsc --noEmit && npx vitest run e2e/minikube-live-database-capability.test.ts`
Expected: tsc clean; SKIPPED locally (no cluster) — must not error. On a ≥12Gi host with the live globalSetup, it runs and passes.

- [ ] **Step 3: Commit**

```bash
git add e2e/minikube-live-database-capability.test.ts
git commit -m "test(e2e): minikube-live database capability (query, isolation, persistence)"
```

---

## Task 11: Documentation

**Files:**
- Modify: `docs/PER_GROUP_CAPABILITIES.md`

- [ ] **Step 1: Document** the new capability fields (`sidecars`, `storage` dedicated-PVC, `storage.container`, `pinned`, `podSecurity.fsGroup`), the per-group MCP **bearer token** (what it protects), the **database capability** (how to enable, read-only guardrails, statement timeout, row cap), the **isolation model** (credential-based: per-group token + per-group Postgres) and explicitly the **G3 residual** (per-group capability pods are reachable cross-group at the network layer; isolation rests on the token + per-group engine; namespace-per-group is the future hardening), and the **PVC durability policy** (dedicated PVCs carry `kubeclaw.io/retain` and survive group deletion — manual cleanup required).

- [ ] **Step 2: Commit**

```bash
git add docs/PER_GROUP_CAPABILITIES.md
git commit -m "docs: per-group database capability, isolation model, PVC retention, G3 residual"
```

---

## Final verification

- [ ] **Full unit/integration suite:** `npx vitest run` → all pass.
- [ ] **Typecheck:** `npx tsc --noEmit` → clean.
- [ ] **E2E (CI/large host):** `npm run test:minikube-live -- minikube-live-database-capability` → passes.
- [ ] **Two-stage review** (spec-compliance then code-quality, separate reviewer subagents) before reporting complete.

## Deferred (explicitly out of scope)

- **Namespace-per-group / network-level cross-group isolation (G3 real fix).** This plan accepts credential-based isolation + documented residual per the chosen stance.
- **The backend-vs-binding split (G9).** This plan ships the DB via `kind: 'mcp'` + `sidecars`, not a new `kind` and not a refactor of the capability model.
- **HA Postgres / StatefulSet, backup/restore, migrations tooling.** Single-replica Deployment + retained PVC for v1; backups are a future ephemeral tool-job.
- **Credential-broker integration for capabilities.** The per-group token + secret cover v1; broker-stamped rotation is a follow-up.

## Self-review notes

- Spec coverage: dedicated PVC (T2/T4), multi-container (T3), fsGroup/strategy/pinned (T1/T3/T5), credential-based isolation/token (T6/T7/T8), the DB capability + guardrails (T8/T9), proof (T10), docs incl. G3 residual + durability (T11). G1 deliberately omitted (verified non-bug; see Global Constraints). ✔
- Type consistency: `CapabilitySidecar`/`storage.container`/`pinned` defined in T1 and consumed by T3/T5/T9; `ResolvedGroupCapability.pinned` (T1) used by T3/T5; `GroupCapabilityResolveResult.token` (T6) consumed by T7; `pvcName` (T2) used by T3/T4. ✔
- Cross-group data isolation is credential-based (per-group token T6/T7 + per-group Postgres) with the network residual documented (T11), matching the decided stance. ✔
