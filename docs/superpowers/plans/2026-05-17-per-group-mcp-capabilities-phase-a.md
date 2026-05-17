# Per-Group MCP Capabilities — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `scope: group` MCP capability tier to kubeclaw — per-(group × capability) Deployments with scale-to-zero, managed by the orchestrator.

**Architecture:** New module `src/per-group-capabilities/` owns the reconciler, scale-up, scale-down sweeper, GC, and credentials helper. Extends `src/capabilities/types.ts` with a `scope` field and extends `src/capabilities/discovery.ts` to branch on scope. K8s API access via `@kubernetes/client-node` (already a dep, used in `src/k8s/job-runner.ts`).

**Tech Stack:** TypeScript (strict mode), Node 20+, sql.js, `@kubernetes/client-node` v1, pino logger, vitest, Helm.

**Spec:** `docs/superpowers/specs/2026-05-17-per-group-mcp-capabilities-phase-a-design.md`

---

## Pre-flight

Before starting, an engineer should read:

- `docs/superpowers/specs/2026-05-17-per-group-mcp-capabilities-phase-a-design.md` (the spec — answers "why")
- `src/capabilities/types.ts` (existing capability schema)
- `src/capabilities/reconciler.ts` (reconciler pattern to mirror)
- `src/k8s/job-runner.ts` lines 1-80, 260-290 (K8s client usage patterns)
- `src/db.ts` lines 1-100 (sql.js patterns; idempotent `CREATE TABLE IF NOT EXISTS`)
- `helm/kubeclaw/templates/capability-pods.yaml` (existing capability Helm template)

**K8s namespace:** all kubeclaw objects live in the `kubeclaw` namespace (constant `KUBECLAW_NAMESPACE` in `src/config.ts`).

**Test framework:** vitest. Existing pattern is co-located `*.test.ts` next to source.

**Branch:** create a worktree via `superpowers:using-git-worktrees` skill at task execution time. Don't work on `main`.

---

## File map (created and modified)

**New files:**

| File | Responsibility |
|---|---|
| `src/per-group-capabilities/types.ts` | `CapabilityScope` type, helpers, error class |
| `src/per-group-capabilities/hash.ts` | `groupHash()` deterministic group_folder → 10-char hash |
| `src/per-group-capabilities/k8s-objects.ts` | Pure render fns: Deployment / Service / NetworkPolicy / Secret K8s objects from inputs |
| `src/per-group-capabilities/k8s-client.ts` | Thin wrapper around `@kubernetes/client-node` server-side apply, patch, delete-by-label |
| `src/per-group-capabilities/reconciler.ts` | Pure `diff()` + `applyAll()` orchestration |
| `src/per-group-capabilities/scale-up.ts` | Discovery-time replica patch + wait-for-ready |
| `src/per-group-capabilities/scale-down-sweeper.ts` | Background loop, idle scale-down |
| `src/per-group-capabilities/gc.ts` | Group-delete cascade |
| `src/per-group-capabilities/credentials.ts` | Per-group Secret upsert / unset |
| `src/per-group-capabilities/db.ts` | SQLite helpers for `per_group_capability_instances` |
| `src/per-group-capabilities/index.ts` | Public interface, startup wiring |
| `container/echo-mcp/Dockerfile` | Test-only MCP fixture container |
| `container/echo-mcp/index.js` | ~50-line echo MCP server (Streamable HTTP transport) |
| `container/echo-mcp/package.json` | Dependencies for echo container |
| `container/echo-mcp/build.sh` | Build script for echo MCP image |
| `docs/PER_GROUP_CAPABILITIES.md` | User docs (architecture, cold-start, NetworkPolicy soft boundary, admin-shell creds) |

**Modified files:**

| File | Change |
|---|---|
| `src/capabilities/types.ts` | Add `scope`, `scaleDownAfterIdleSeconds`, `volumeFromGroupPvc`, `credentialsFrom` to `CapabilityBase`; validator updates |
| `src/capabilities/discovery.ts` | Branch on `scope`; call scale-up for `group`-scoped |
| `src/db.ts` | Add `per_group_capability_instances` table to `createSchema` |
| `src/index.ts` | Wire reconciler, sweeper, GC on startup |
| `src/admin-shell.ts` | Add `set_group_credential` / `unset_group_credential` tools |
| `helm/kubeclaw/templates/orchestrator.yaml` | Add `kubeclaw.io/role: orchestrator` pod label |
| `helm/kubeclaw/templates/channel-pods.yaml` | Add `kubeclaw.io/role: channel` pod label |
| `helm/kubeclaw/templates/redis.yaml` | Add `kubeclaw.io/role: redis` pod label |
| `CHANGELOG.md` | Unreleased section: Features → per-group MCP capability tier |

---

## Task list

### Task 1: Extend `CapabilitySpec` schema with `scope` field

**Files:**
- Modify: `src/capabilities/types.ts`
- Create: `src/per-group-capabilities/types.ts`
- Test: `src/per-group-capabilities/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/per-group-capabilities/types.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateScopeFields, PerGroupCapabilityError } from './types.js';
import type { CapabilitySpec } from '../capabilities/types.js';

describe('validateScopeFields', () => {
  it('accepts cluster-scoped spec with no group-only fields', () => {
    const spec: CapabilitySpec = {
      name: 'x', kind: 'mcp', image: 'i:1', scope: 'cluster',
    };
    expect(() => validateScopeFields(spec)).not.toThrow();
  });

  it('rejects cluster-scoped spec carrying group-only field', () => {
    const spec: CapabilitySpec = {
      name: 'x', kind: 'mcp', image: 'i:1',
      scope: 'cluster', scaleDownAfterIdleSeconds: 300,
    };
    expect(() => validateScopeFields(spec)).toThrow(PerGroupCapabilityError);
  });

  it('accepts group-scoped spec with defaults', () => {
    const spec: CapabilitySpec = {
      name: 'x', kind: 'mcp', image: 'i:1', scope: 'group',
    };
    expect(() => validateScopeFields(spec)).not.toThrow();
  });

  it('rejects group-scoped spec with scaleDownAfterIdleSeconds < 60', () => {
    const spec: CapabilitySpec = {
      name: 'x', kind: 'mcp', image: 'i:1',
      scope: 'group', scaleDownAfterIdleSeconds: 30,
    };
    expect(() => validateScopeFields(spec)).toThrow(/at least 60/);
  });

  it('defaults scope to cluster when omitted', () => {
    const spec: CapabilitySpec = { name: 'x', kind: 'mcp', image: 'i:1' };
    expect(() => validateScopeFields(spec)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/per-group-capabilities/types.test.ts
```
Expected: FAIL (module not found / types undefined).

- [ ] **Step 3: Extend `src/capabilities/types.ts`**

Add to `CapabilityBase`:
```ts
  /** Deployment scope. Default 'cluster'. */
  scope?: 'cluster' | 'group';
  /** Group-scope only: seconds of idle before scale-to-zero. Min 60. Default 600. */
  scaleDownAfterIdleSeconds?: number;
  /** Group-scope only: mount the group's PVC subPath at /data inside the pod. */
  volumeFromGroupPvc?: boolean;
  /** Group-scope only: where per-group credentials come from. Default 'none'. */
  credentialsFrom?: 'none' | 'secret';
```

- [ ] **Step 4: Create `src/per-group-capabilities/types.ts`**

```ts
import type { CapabilitySpec } from '../capabilities/types.js';

export type CapabilityScope = 'cluster' | 'group';

export class PerGroupCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PerGroupCapabilityError';
  }
}

const GROUP_ONLY_FIELDS = [
  'scaleDownAfterIdleSeconds',
  'volumeFromGroupPvc',
  'credentialsFrom',
] as const;

export function getScope(spec: CapabilitySpec): CapabilityScope {
  return spec.scope ?? 'cluster';
}

export function validateScopeFields(spec: CapabilitySpec): void {
  const scope = getScope(spec);
  if (scope === 'cluster') {
    for (const field of GROUP_ONLY_FIELDS) {
      if (spec[field] !== undefined) {
        throw new PerGroupCapabilityError(
          `Capability ${spec.name}: field '${field}' is only valid for scope: 'group'`,
        );
      }
    }
    return;
  }
  const idle = spec.scaleDownAfterIdleSeconds ?? 600;
  if (idle < 60) {
    throw new PerGroupCapabilityError(
      `Capability ${spec.name}: scaleDownAfterIdleSeconds must be at least 60 (got ${idle})`,
    );
  }
}

export interface ResolvedGroupCapability {
  spec: CapabilitySpec;
  scaleDownAfterIdleSeconds: number;
  volumeFromGroupPvc: boolean;
  credentialsFrom: 'none' | 'secret';
}

export function resolveGroupCapability(spec: CapabilitySpec): ResolvedGroupCapability {
  if (getScope(spec) !== 'group') {
    throw new PerGroupCapabilityError(
      `resolveGroupCapability called on cluster-scoped ${spec.name}`,
    );
  }
  return {
    spec,
    scaleDownAfterIdleSeconds: spec.scaleDownAfterIdleSeconds ?? 600,
    volumeFromGroupPvc: spec.volumeFromGroupPvc ?? false,
    credentialsFrom: spec.credentialsFrom ?? 'none',
  };
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/per-group-capabilities/types.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 6: Type-check the whole repo**

```bash
npm run build
```
Expected: zero TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/capabilities/types.ts src/per-group-capabilities/types.ts src/per-group-capabilities/types.test.ts
git commit -m "feat(capabilities): add scope field and validator for per-group capabilities"
```

---

### Task 2: `groupHash()` deterministic group-folder → 10-char hash

**Files:**
- Create: `src/per-group-capabilities/hash.ts`
- Test: `src/per-group-capabilities/hash.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { groupHash } from './hash.js';

describe('groupHash', () => {
  it('returns a 10-character lowercase hex string', () => {
    const h = groupHash('Family Chat');
    expect(h).toMatch(/^[0-9a-f]{10}$/);
  });

  it('is deterministic across calls', () => {
    expect(groupHash('Foo')).toBe(groupHash('Foo'));
  });

  it('differs for different inputs', () => {
    expect(groupHash('Foo')).not.toBe(groupHash('Bar'));
  });

  it('normalises consistently for unicode and spaces', () => {
    expect(groupHash('  café  ')).toBe(groupHash('café'));
  });

  it('rejects empty string', () => {
    expect(() => groupHash('')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/per-group-capabilities/hash.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/per-group-capabilities/hash.ts`:
```ts
import { createHash } from 'crypto';

export function groupHash(groupFolder: string): string {
  const trimmed = groupFolder.trim();
  if (trimmed.length === 0) {
    throw new Error('groupHash: groupFolder must be non-empty');
  }
  return createHash('sha1').update(trimmed, 'utf8').digest('hex').slice(0, 10);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/per-group-capabilities/hash.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/per-group-capabilities/hash.ts src/per-group-capabilities/hash.test.ts
git commit -m "feat(capabilities): add groupHash helper for K8s-safe naming"
```

---

### Task 3: SQLite `per_group_capability_instances` table + helpers

**Files:**
- Modify: `src/db.ts` (extend `createSchema`)
- Create: `src/per-group-capabilities/db.ts`
- Test: `src/per-group-capabilities/db.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, closeDb } from '../db.js';
import {
  upsertInstance,
  getInstance,
  listInstances,
  deleteInstancesByGroup,
  setReplicas,
  touchLastUsed,
  listInstancesAtReplicas,
} from './db.js';

beforeEach(async () => {
  await initDb({ inMemory: true });
});

describe('per_group_capability_instances', () => {
  it('upsert + get round-trip', () => {
    upsertInstance({
      groupFolder: 'Family', capabilityName: 'filesystem',
      groupHash: 'abc1234567', deploymentName: 'mcp-filesystem-abc1234567',
      serviceName: 'mcp-filesystem-abc1234567',
    });
    const row = getInstance('Family', 'filesystem');
    expect(row?.deploymentName).toBe('mcp-filesystem-abc1234567');
    expect(row?.currentReplicas).toBe(0);
  });

  it('listInstances returns rows for a group', () => {
    upsertInstance({ groupFolder: 'A', capabilityName: 'x',
      groupHash: 'h1111', deploymentName: 'd1', serviceName: 'd1' });
    upsertInstance({ groupFolder: 'A', capabilityName: 'y',
      groupHash: 'h2222', deploymentName: 'd2', serviceName: 'd2' });
    upsertInstance({ groupFolder: 'B', capabilityName: 'x',
      groupHash: 'h3333', deploymentName: 'd3', serviceName: 'd3' });
    expect(listInstances('A')).toHaveLength(2);
    expect(listInstances('B')).toHaveLength(1);
  });

  it('setReplicas + touchLastUsed update fields', () => {
    upsertInstance({ groupFolder: 'A', capabilityName: 'x',
      groupHash: 'h1', deploymentName: 'd', serviceName: 'd' });
    setReplicas('A', 'x', 1);
    touchLastUsed('A', 'x', 1747500000);
    const row = getInstance('A', 'x');
    expect(row?.currentReplicas).toBe(1);
    expect(row?.lastUsedAt).toBe(1747500000);
  });

  it('deleteInstancesByGroup cascades all caps for the group', () => {
    upsertInstance({ groupFolder: 'A', capabilityName: 'x',
      groupHash: 'h1', deploymentName: 'd1', serviceName: 'd1' });
    upsertInstance({ groupFolder: 'A', capabilityName: 'y',
      groupHash: 'h2', deploymentName: 'd2', serviceName: 'd2' });
    deleteInstancesByGroup('A');
    expect(listInstances('A')).toEqual([]);
  });

  it('listInstancesAtReplicas filters by current_replicas', () => {
    upsertInstance({ groupFolder: 'A', capabilityName: 'x',
      groupHash: 'h1', deploymentName: 'd1', serviceName: 'd1' });
    upsertInstance({ groupFolder: 'B', capabilityName: 'y',
      groupHash: 'h2', deploymentName: 'd2', serviceName: 'd2' });
    setReplicas('A', 'x', 1);
    const at1 = listInstancesAtReplicas(1);
    expect(at1.map(r => r.groupFolder)).toEqual(['A']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/per-group-capabilities/db.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Add table to `src/db.ts` `createSchema()`**

After the existing tables (locate the end of `createSchema()`), append:
```ts
  database.run(`
    CREATE TABLE IF NOT EXISTS per_group_capability_instances (
      group_folder      TEXT NOT NULL,
      capability_name   TEXT NOT NULL,
      group_hash        TEXT NOT NULL,
      deployment_name   TEXT NOT NULL,
      service_name      TEXT NOT NULL,
      current_replicas  INTEGER NOT NULL DEFAULT 0,
      last_used_at      INTEGER,
      created_at        INTEGER NOT NULL,
      PRIMARY KEY (group_folder, capability_name)
    )
  `);
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_per_group_cap_hash ON per_group_capability_instances(group_hash)`,
  );
```

- [ ] **Step 4: Implement `src/per-group-capabilities/db.ts`**

```ts
import { db } from '../db.js';

export interface PerGroupInstanceRow {
  groupFolder: string;
  capabilityName: string;
  groupHash: string;
  deploymentName: string;
  serviceName: string;
  currentReplicas: number;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface UpsertInstanceInput {
  groupFolder: string;
  capabilityName: string;
  groupHash: string;
  deploymentName: string;
  serviceName: string;
}

function rowToInstance(r: Record<string, unknown>): PerGroupInstanceRow {
  return {
    groupFolder: r.group_folder as string,
    capabilityName: r.capability_name as string,
    groupHash: r.group_hash as string,
    deploymentName: r.deployment_name as string,
    serviceName: r.service_name as string,
    currentReplicas: r.current_replicas as number,
    lastUsedAt: (r.last_used_at as number | null) ?? null,
    createdAt: r.created_at as number,
  };
}

function all(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  stmt.bind(params as never);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql: string, params: unknown[] = []): void {
  db.run(sql, params as never);
}

export function upsertInstance(input: UpsertInstanceInput): void {
  const now = Math.floor(Date.now() / 1000);
  run(
    `INSERT INTO per_group_capability_instances
       (group_folder, capability_name, group_hash, deployment_name, service_name, current_replicas, last_used_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, ?)
     ON CONFLICT(group_folder, capability_name) DO UPDATE SET
       group_hash = excluded.group_hash,
       deployment_name = excluded.deployment_name,
       service_name = excluded.service_name`,
    [input.groupFolder, input.capabilityName, input.groupHash,
     input.deploymentName, input.serviceName, now],
  );
}

export function getInstance(groupFolder: string, capabilityName: string): PerGroupInstanceRow | null {
  const rows = all(
    `SELECT * FROM per_group_capability_instances WHERE group_folder=? AND capability_name=?`,
    [groupFolder, capabilityName],
  );
  return rows[0] ? rowToInstance(rows[0]) : null;
}

export function listInstances(groupFolder: string): PerGroupInstanceRow[] {
  return all(
    `SELECT * FROM per_group_capability_instances WHERE group_folder=?`,
    [groupFolder],
  ).map(rowToInstance);
}

export function listAllInstances(): PerGroupInstanceRow[] {
  return all(`SELECT * FROM per_group_capability_instances`).map(rowToInstance);
}

export function listInstancesAtReplicas(replicas: number): PerGroupInstanceRow[] {
  return all(
    `SELECT * FROM per_group_capability_instances WHERE current_replicas=?`,
    [replicas],
  ).map(rowToInstance);
}

export function setReplicas(groupFolder: string, capabilityName: string, replicas: number): void {
  run(
    `UPDATE per_group_capability_instances SET current_replicas=? WHERE group_folder=? AND capability_name=?`,
    [replicas, groupFolder, capabilityName],
  );
}

export function touchLastUsed(groupFolder: string, capabilityName: string, unixSeconds: number): void {
  run(
    `UPDATE per_group_capability_instances SET last_used_at=? WHERE group_folder=? AND capability_name=?`,
    [unixSeconds, groupFolder, capabilityName],
  );
}

export function deleteInstancesByGroup(groupFolder: string): void {
  run(`DELETE FROM per_group_capability_instances WHERE group_folder=?`, [groupFolder]);
}

export function deleteInstance(groupFolder: string, capabilityName: string): void {
  run(
    `DELETE FROM per_group_capability_instances WHERE group_folder=? AND capability_name=?`,
    [groupFolder, capabilityName],
  );
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/per-group-capabilities/db.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 6: Run full suite (no regressions)**

```bash
npm test
```
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/per-group-capabilities/db.ts src/per-group-capabilities/db.test.ts
git commit -m "feat(capabilities): per_group_capability_instances table + crud helpers"
```

---

### Task 4: K8s object renderers (Deployment / Service / NetworkPolicy / Secret)

**Files:**
- Create: `src/per-group-capabilities/k8s-objects.ts`
- Test: `src/per-group-capabilities/k8s-objects.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  renderDeployment,
  renderService,
  renderNetworkPolicy,
  COMMON_LABELS_KEYS,
} from './k8s-objects.js';
import type { CapabilitySpec } from '../capabilities/types.js';

const baseSpec: CapabilitySpec = {
  name: 'filesystem',
  kind: 'mcp',
  image: 'ghcr.io/x/bundle:1.0',
  scope: 'group',
  volumeFromGroupPvc: true,
  credentialsFrom: 'none',
};

const ctx = {
  groupFolder: 'Family',
  groupHash: 'abc1234567',
  namespace: 'kubeclaw',
  groupsPvcName: 'kubeclaw-groups-pvc',
};

describe('renderDeployment', () => {
  it('produces expected metadata, labels, and replicas:0', () => {
    const dep = renderDeployment(baseSpec, ctx);
    expect(dep.metadata?.name).toBe('mcp-filesystem-abc1234567');
    expect(dep.metadata?.namespace).toBe('kubeclaw');
    expect(dep.spec?.replicas).toBe(0);
    expect(dep.metadata?.labels?.['kubeclaw.io/capability']).toBe('filesystem');
    expect(dep.metadata?.labels?.['kubeclaw.io/group-hash']).toBe('abc1234567');
    expect(dep.metadata?.labels?.['kubeclaw.io/scope']).toBe('group');
  });

  it('mounts group PVC subPath when volumeFromGroupPvc is true', () => {
    const dep = renderDeployment(baseSpec, ctx);
    const container = dep.spec!.template.spec!.containers[0];
    const mount = container.volumeMounts?.find(m => m.name === 'groups');
    expect(mount?.mountPath).toBe('/data');
    expect(mount?.subPath).toBe('groups/Family');
    const vol = dep.spec!.template.spec!.volumes?.find(v => v.name === 'groups');
    expect(vol?.persistentVolumeClaim?.claimName).toBe('kubeclaw-groups-pvc');
  });

  it('omits PVC volume when volumeFromGroupPvc is false', () => {
    const spec = { ...baseSpec, volumeFromGroupPvc: false };
    const dep = renderDeployment(spec, ctx);
    const container = dep.spec!.template.spec!.containers[0];
    expect(container.volumeMounts ?? []).toEqual([]);
  });

  it('injects envFrom Secret when credentialsFrom=secret', () => {
    const spec = { ...baseSpec, credentialsFrom: 'secret' as const };
    const dep = renderDeployment(spec, ctx);
    const container = dep.spec!.template.spec!.containers[0];
    expect(container.envFrom?.[0].secretRef?.name).toBe('mcp-filesystem-abc1234567-creds');
  });
});

describe('renderService', () => {
  it('exposes container port', () => {
    const svc = renderService(baseSpec, ctx);
    expect(svc.metadata?.name).toBe('mcp-filesystem-abc1234567');
    expect(svc.spec?.ports?.[0].targetPort).toBe(3000);
    expect(svc.spec?.selector?.['kubeclaw.io/capability']).toBe('filesystem');
  });
});

describe('renderNetworkPolicy', () => {
  it('restricts ingress to channel+orchestrator pods on port 3000', () => {
    const np = renderNetworkPolicy(baseSpec, ctx);
    const ingress = np.spec?.ingress?.[0];
    const sources = ingress?.from ?? [];
    expect(sources.length).toBe(2);
    const roles = sources.map(s => s.podSelector?.matchLabels?.['kubeclaw.io/role']).sort();
    expect(roles).toEqual(['channel', 'orchestrator']);
    expect(ingress?.ports?.[0].port).toBe(3000);
  });

  it('allows egress to redis and DNS', () => {
    const np = renderNetworkPolicy(baseSpec, ctx);
    const egress = np.spec?.egress ?? [];
    expect(egress.length).toBeGreaterThanOrEqual(2);
  });
});

describe('COMMON_LABELS_KEYS', () => {
  it('lists exactly the kubeclaw labels we manage', () => {
    expect(COMMON_LABELS_KEYS).toEqual([
      'kubeclaw.io/scope',
      'kubeclaw.io/capability',
      'kubeclaw.io/group-hash',
      'kubeclaw.io/managed-by',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/per-group-capabilities/k8s-objects.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/per-group-capabilities/k8s-objects.ts`**

```ts
import type {
  V1Deployment,
  V1Service,
  V1NetworkPolicy,
  V1Secret,
} from '@kubernetes/client-node';
import type { CapabilitySpec } from '../capabilities/types.js';
import { resolveGroupCapability } from './types.js';

export const COMMON_LABELS_KEYS = [
  'kubeclaw.io/scope',
  'kubeclaw.io/capability',
  'kubeclaw.io/group-hash',
  'kubeclaw.io/managed-by',
] as const;

export interface RenderContext {
  groupFolder: string;
  groupHash: string;
  namespace: string;
  /** Name of the shared PVC that holds all groups. */
  groupsPvcName: string;
}

export function instanceName(capabilityName: string, groupHash: string): string {
  return `mcp-${capabilityName}-${groupHash}`;
}

export function credsSecretName(capabilityName: string, groupHash: string): string {
  return `${instanceName(capabilityName, groupHash)}-creds`;
}

function commonLabels(spec: CapabilitySpec, ctx: RenderContext): Record<string, string> {
  return {
    'kubeclaw.io/scope': 'group',
    'kubeclaw.io/capability': spec.name,
    'kubeclaw.io/group-hash': ctx.groupHash,
    'kubeclaw.io/managed-by': 'kubeclaw-orchestrator',
  };
}

export function renderDeployment(spec: CapabilitySpec, ctx: RenderContext): V1Deployment {
  const resolved = resolveGroupCapability(spec);
  const name = instanceName(spec.name, ctx.groupHash);
  const port = spec.port ?? 3000;
  const labels = commonLabels(spec, ctx);

  const env = Object.entries(spec.env ?? {}).map(([k, v]) => ({ name: k, value: v }));
  const envFrom = resolved.credentialsFrom === 'secret'
    ? [{ secretRef: { name: credsSecretName(spec.name, ctx.groupHash), optional: true } }]
    : undefined;

  const volumeMounts = resolved.volumeFromGroupPvc
    ? [{ name: 'groups', mountPath: '/data', subPath: `groups/${ctx.groupFolder}` }]
    : [];

  const volumes = resolved.volumeFromGroupPvc
    ? [{ name: 'groups', persistentVolumeClaim: { claimName: ctx.groupsPvcName } }]
    : [];

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: ctx.namespace, labels },
    spec: {
      replicas: 0,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          containers: [{
            name: 'mcp',
            image: spec.image,
            ports: [{ containerPort: port }],
            ...(spec.command ? { command: spec.command } : {}),
            ...(spec.args ? { args: spec.args } : {}),
            env,
            envFrom,
            volumeMounts,
            resources: {
              requests: {
                memory: spec.resources?.memoryRequest ?? '64Mi',
                cpu: spec.resources?.cpuRequest ?? '50m',
              },
              limits: {
                memory: spec.resources?.memoryLimit ?? '256Mi',
                cpu: spec.resources?.cpuLimit ?? '500m',
              },
            },
          }],
          volumes,
        },
      },
    },
  };
}

export function renderService(spec: CapabilitySpec, ctx: RenderContext): V1Service {
  const name = instanceName(spec.name, ctx.groupHash);
  const port = spec.port ?? 3000;
  const labels = commonLabels(spec, ctx);
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: ctx.namespace, labels },
    spec: {
      selector: labels,
      ports: [{ port, targetPort: port, protocol: 'TCP' }],
      type: 'ClusterIP',
    },
  };
}

export function renderNetworkPolicy(spec: CapabilitySpec, ctx: RenderContext): V1NetworkPolicy {
  const name = instanceName(spec.name, ctx.groupHash);
  const port = spec.port ?? 3000;
  const labels = commonLabels(spec, ctx);
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace: ctx.namespace, labels },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{
        from: [
          { podSelector: { matchLabels: { 'kubeclaw.io/role': 'channel' } } },
          { podSelector: { matchLabels: { 'kubeclaw.io/role': 'orchestrator' } } },
        ],
        ports: [{ protocol: 'TCP', port }],
      }],
      egress: [
        {
          to: [{ podSelector: { matchLabels: { 'kubeclaw.io/role': 'redis' } } }],
          ports: [{ protocol: 'TCP', port: 6379 }],
        },
        {
          to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
      ],
    },
  };
}

export function renderEmptySecret(spec: CapabilitySpec, ctx: RenderContext): V1Secret {
  const name = credsSecretName(spec.name, ctx.groupHash);
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: ctx.namespace, labels: commonLabels(spec, ctx) },
    type: 'Opaque',
    data: {},
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/per-group-capabilities/k8s-objects.test.ts
```
Expected: PASS (7 tests).

- [ ] **Step 5: Build**

```bash
npm run build
```
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/per-group-capabilities/k8s-objects.ts src/per-group-capabilities/k8s-objects.test.ts
git commit -m "feat(capabilities): k8s object renderers for per-group instances"
```

---

### Task 5: K8s client wrapper (apply / patch / delete-by-label / wait-for-ready)

**Files:**
- Create: `src/per-group-capabilities/k8s-client.ts`
- Test: `src/per-group-capabilities/k8s-client.test.ts`

The wrapper exposes a narrow interface (`PerGroupK8sClient`) that the reconciler, scale-up, sweeper, and GC depend on. Tests use a fake implementation; integration tests later exercise the real one.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { FakePerGroupK8sClient } from './k8s-client.js';

describe('FakePerGroupK8sClient', () => {
  it('apply + read round-trip a Deployment', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'd1', namespace: 'ns', labels: { x: 'y' } },
      spec: { replicas: 0, selector: { matchLabels: { x: 'y' } },
        template: { metadata: { labels: { x: 'y' } }, spec: { containers: [] } } },
    });
    const got = await c.readDeployment('ns', 'd1');
    expect(got?.spec?.replicas).toBe(0);
  });

  it('patchDeploymentReplicas updates replica count', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'd1', namespace: 'ns' },
      spec: { replicas: 0, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    await c.patchDeploymentReplicas('ns', 'd1', 1);
    const got = await c.readDeployment('ns', 'd1');
    expect(got?.spec?.replicas).toBe(1);
  });

  it('deleteByLabel removes matching objects across all kinds', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'd1', namespace: 'ns', labels: { 'kubeclaw.io/group-hash': 'h1' } },
      spec: { replicas: 0, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    await c.applyService({
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: 's1', namespace: 'ns', labels: { 'kubeclaw.io/group-hash': 'h1' } },
      spec: {},
    });
    await c.deleteByLabel('ns', 'kubeclaw.io/group-hash=h1');
    expect(await c.readDeployment('ns', 'd1')).toBeNull();
    expect(await c.readService('ns', 's1')).toBeNull();
  });

  it('waitForReady resolves when fake marks ready', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'd1', namespace: 'ns' },
      spec: { replicas: 1, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    setTimeout(() => c.markReady('ns', 'd1'), 10);
    await c.waitForReady('ns', 'd1', 1000);
  });

  it('waitForReady throws on timeout', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'd1', namespace: 'ns' },
      spec: { replicas: 1, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    await expect(c.waitForReady('ns', 'd1', 50)).rejects.toThrow(/timeout/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/per-group-capabilities/k8s-client.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/per-group-capabilities/k8s-client.ts`:
```ts
import {
  V1Deployment, V1Service, V1NetworkPolicy, V1Secret,
  KubeConfig, AppsV1Api, CoreV1Api, NetworkingV1Api,
} from '@kubernetes/client-node';
import { logger } from '../logger.js';

export interface PerGroupK8sClient {
  applyDeployment(d: V1Deployment): Promise<void>;
  applyService(s: V1Service): Promise<void>;
  applyNetworkPolicy(p: V1NetworkPolicy): Promise<void>;
  applySecret(s: V1Secret): Promise<void>;
  readDeployment(namespace: string, name: string): Promise<V1Deployment | null>;
  readService(namespace: string, name: string): Promise<V1Service | null>;
  readSecret(namespace: string, name: string): Promise<V1Secret | null>;
  patchDeploymentReplicas(namespace: string, name: string, replicas: number): Promise<void>;
  deleteByLabel(namespace: string, labelSelector: string): Promise<void>;
  deleteSecret(namespace: string, name: string): Promise<void>;
  waitForReady(namespace: string, name: string, timeoutMs: number): Promise<void>;
  listDeploymentsByLabel(namespace: string, labelSelector: string): Promise<V1Deployment[]>;
}

const FIELD_MANAGER = 'kubeclaw-per-group-capability-reconciler';

export class RealPerGroupK8sClient implements PerGroupK8sClient {
  private apps: AppsV1Api;
  private core: CoreV1Api;
  private net: NetworkingV1Api;

  constructor(kc?: KubeConfig) {
    const cfg = kc ?? (() => { const k = new KubeConfig(); k.loadFromCluster(); return k; })();
    this.apps = cfg.makeApiClient(AppsV1Api);
    this.core = cfg.makeApiClient(CoreV1Api);
    this.net  = cfg.makeApiClient(NetworkingV1Api);
  }

  async applyDeployment(d: V1Deployment): Promise<void> {
    const ns = d.metadata!.namespace!;
    const name = d.metadata!.name!;
    try {
      await this.apps.patchNamespacedDeployment({
        name, namespace: ns, body: d, fieldManager: FIELD_MANAGER, force: true,
      } as never, { headers: { 'Content-Type': 'application/apply-patch+yaml' } });
    } catch (err) {
      logger.error({ err, name }, 'applyDeployment failed');
      throw err;
    }
  }

  async applyService(s: V1Service): Promise<void> {
    const ns = s.metadata!.namespace!;
    const name = s.metadata!.name!;
    await this.core.patchNamespacedService({
      name, namespace: ns, body: s, fieldManager: FIELD_MANAGER, force: true,
    } as never, { headers: { 'Content-Type': 'application/apply-patch+yaml' } });
  }

  async applyNetworkPolicy(p: V1NetworkPolicy): Promise<void> {
    const ns = p.metadata!.namespace!;
    const name = p.metadata!.name!;
    await this.net.patchNamespacedNetworkPolicy({
      name, namespace: ns, body: p, fieldManager: FIELD_MANAGER, force: true,
    } as never, { headers: { 'Content-Type': 'application/apply-patch+yaml' } });
  }

  async applySecret(s: V1Secret): Promise<void> {
    const ns = s.metadata!.namespace!;
    const name = s.metadata!.name!;
    await this.core.patchNamespacedSecret({
      name, namespace: ns, body: s, fieldManager: FIELD_MANAGER, force: true,
    } as never, { headers: { 'Content-Type': 'application/apply-patch+yaml' } });
  }

  async readDeployment(namespace: string, name: string): Promise<V1Deployment | null> {
    try { return await this.apps.readNamespacedDeployment({ name, namespace }); }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  }
  async readService(namespace: string, name: string): Promise<V1Service | null> {
    try { return await this.core.readNamespacedService({ name, namespace }); }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  }
  async readSecret(namespace: string, name: string): Promise<V1Secret | null> {
    try { return await this.core.readNamespacedSecret({ name, namespace }); }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  }

  async patchDeploymentReplicas(namespace: string, name: string, replicas: number): Promise<void> {
    await this.apps.patchNamespacedDeploymentScale({
      name, namespace, body: { spec: { replicas } },
    } as never, { headers: { 'Content-Type': 'application/merge-patch+json' } });
  }

  async deleteByLabel(namespace: string, labelSelector: string): Promise<void> {
    await this.apps.deleteCollectionNamespacedDeployment({ namespace, labelSelector });
    await this.core.deleteCollectionNamespacedService({ namespace, labelSelector });
    await this.net.deleteCollectionNamespacedNetworkPolicy({ namespace, labelSelector });
    await this.core.deleteCollectionNamespacedSecret({ namespace, labelSelector });
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    try { await this.core.deleteNamespacedSecret({ name, namespace }); }
    catch (err) { if (!isNotFound(err)) throw err; }
  }

  async waitForReady(namespace: string, name: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const d = await this.readDeployment(namespace, name);
      const ready = d?.status?.readyReplicas ?? 0;
      const desired = d?.spec?.replicas ?? 0;
      if (desired > 0 && ready >= desired) return;
      await sleep(500);
    }
    throw new Error(`waitForReady: timeout after ${timeoutMs}ms for ${namespace}/${name}`);
  }

  async listDeploymentsByLabel(namespace: string, labelSelector: string): Promise<V1Deployment[]> {
    const res = await this.apps.listNamespacedDeployment({ namespace, labelSelector });
    return res.items ?? [];
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 404;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ----- Fake (for tests) ---------------------------------------------------

interface FakeStore {
  deployments: Map<string, V1Deployment>;
  services: Map<string, V1Service>;
  policies: Map<string, V1NetworkPolicy>;
  secrets: Map<string, V1Secret>;
  ready: Set<string>;
}

function key(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

function labelMatch(labels: Record<string, string> | undefined, selector: string): boolean {
  if (!labels) return false;
  const [k, v] = selector.split('=');
  return labels[k] === v;
}

export class FakePerGroupK8sClient implements PerGroupK8sClient {
  store: FakeStore = {
    deployments: new Map(), services: new Map(),
    policies: new Map(), secrets: new Map(), ready: new Set(),
  };

  async applyDeployment(d: V1Deployment): Promise<void> {
    this.store.deployments.set(key(d.metadata!.namespace!, d.metadata!.name!), structuredClone(d));
  }
  async applyService(s: V1Service): Promise<void> {
    this.store.services.set(key(s.metadata!.namespace!, s.metadata!.name!), structuredClone(s));
  }
  async applyNetworkPolicy(p: V1NetworkPolicy): Promise<void> {
    this.store.policies.set(key(p.metadata!.namespace!, p.metadata!.name!), structuredClone(p));
  }
  async applySecret(s: V1Secret): Promise<void> {
    this.store.secrets.set(key(s.metadata!.namespace!, s.metadata!.name!), structuredClone(s));
  }
  async readDeployment(ns: string, name: string) { return this.store.deployments.get(key(ns, name)) ?? null; }
  async readService(ns: string, name: string)    { return this.store.services.get(key(ns, name)) ?? null; }
  async readSecret(ns: string, name: string)     { return this.store.secrets.get(key(ns, name)) ?? null; }

  async patchDeploymentReplicas(ns: string, name: string, replicas: number): Promise<void> {
    const d = this.store.deployments.get(key(ns, name));
    if (!d) throw new Error('not found');
    d.spec!.replicas = replicas;
  }

  async deleteByLabel(namespace: string, labelSelector: string): Promise<void> {
    for (const map of [this.store.deployments, this.store.services, this.store.policies, this.store.secrets]) {
      for (const [k, v] of map.entries()) {
        if (v.metadata?.namespace !== namespace) continue;
        if (labelMatch(v.metadata?.labels, labelSelector)) map.delete(k);
      }
    }
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    this.store.secrets.delete(key(namespace, name));
  }

  async waitForReady(ns: string, name: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.store.ready.has(key(ns, name))) return;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error(`waitForReady: timeout after ${timeoutMs}ms for ${ns}/${name}`);
  }

  markReady(ns: string, name: string): void {
    this.store.ready.add(key(ns, name));
  }

  async listDeploymentsByLabel(namespace: string, labelSelector: string): Promise<V1Deployment[]> {
    const out: V1Deployment[] = [];
    for (const d of this.store.deployments.values()) {
      if (d.metadata?.namespace === namespace && labelMatch(d.metadata?.labels, labelSelector)) {
        out.push(d);
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/per-group-capabilities/k8s-client.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Build**

```bash
npm run build
```
Expected: zero errors. If the `@kubernetes/client-node` v1 signatures differ from the body shape shown, adjust calls per the actual SDK signature — the FIELD_MANAGER value and field selectors should remain identical.

- [ ] **Step 6: Commit**

```bash
git add src/per-group-capabilities/k8s-client.ts src/per-group-capabilities/k8s-client.test.ts
git commit -m "feat(capabilities): k8s client wrapper with fake for tests"
```

---

### Task 6: Reconciler (pure diff + applyAll)

**Files:**
- Create: `src/per-group-capabilities/reconciler.ts`
- Test: `src/per-group-capabilities/reconciler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { reconcileGroupCapabilities } from './reconciler.js';
import { listAllInstances } from './db.js';
import type { CapabilitySpec } from '../capabilities/types.js';

beforeEach(async () => {
  await initDb({ inMemory: true });
});

const fakeSpec: CapabilitySpec = {
  name: 'echo', kind: 'mcp', image: 'echo:1',
  scope: 'group', volumeFromGroupPvc: false, credentialsFrom: 'none',
};

describe('reconcileGroupCapabilities', () => {
  it('creates Deployment, Service, NetworkPolicy for each (group, capability) pair', async () => {
    const c = new FakePerGroupK8sClient();
    await reconcileGroupCapabilities({
      client: c, namespace: 'kubeclaw', groupsPvcName: 'pvc',
      groups: ['Family', 'Work'], specs: [fakeSpec],
    });
    expect(c.store.deployments.size).toBe(2);
    expect(c.store.services.size).toBe(2);
    expect(c.store.policies.size).toBe(2);
    expect(listAllInstances()).toHaveLength(2);
  });

  it('is idempotent (second call produces no extra objects)', async () => {
    const c = new FakePerGroupK8sClient();
    const args = { client: c, namespace: 'kubeclaw', groupsPvcName: 'pvc',
      groups: ['Family'], specs: [fakeSpec] };
    await reconcileGroupCapabilities(args);
    await reconcileGroupCapabilities(args);
    expect(c.store.deployments.size).toBe(1);
  });

  it('does not deploy cluster-scoped specs', async () => {
    const c = new FakePerGroupK8sClient();
    const clusterSpec: CapabilitySpec = { name: 'docling', kind: 'mcp', image: 'd:1' };
    await reconcileGroupCapabilities({
      client: c, namespace: 'kubeclaw', groupsPvcName: 'pvc',
      groups: ['Family'], specs: [clusterSpec, fakeSpec],
    });
    expect(c.store.deployments.size).toBe(1);
    const dep = [...c.store.deployments.values()][0];
    expect(dep.metadata?.labels?.['kubeclaw.io/capability']).toBe('echo');
  });

  it('records SQLite rows tagged with the correct group_hash', async () => {
    const c = new FakePerGroupK8sClient();
    await reconcileGroupCapabilities({
      client: c, namespace: 'kubeclaw', groupsPvcName: 'pvc',
      groups: ['Family'], specs: [fakeSpec],
    });
    const rows = listAllInstances();
    expect(rows).toHaveLength(1);
    expect(rows[0].groupHash).toMatch(/^[0-9a-f]{10}$/);
    expect(rows[0].deploymentName).toBe(`mcp-echo-${rows[0].groupHash}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/per-group-capabilities/reconciler.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/per-group-capabilities/reconciler.ts`**

```ts
import type { CapabilitySpec } from '../capabilities/types.js';
import type { PerGroupK8sClient } from './k8s-client.js';
import { getScope, validateScopeFields } from './types.js';
import { groupHash } from './hash.js';
import {
  renderDeployment, renderService, renderNetworkPolicy, instanceName,
} from './k8s-objects.js';
import { upsertInstance } from './db.js';
import { logger } from '../logger.js';

export interface ReconcileArgs {
  client: PerGroupK8sClient;
  namespace: string;
  groupsPvcName: string;
  groups: string[];
  specs: CapabilitySpec[];
}

export async function reconcileGroupCapabilities(args: ReconcileArgs): Promise<void> {
  const groupSpecs = args.specs.filter(s => getScope(s) === 'group');
  for (const spec of groupSpecs) validateScopeFields(spec);

  const desired: { spec: CapabilitySpec; groupFolder: string; groupHash: string }[] = [];
  for (const groupFolder of args.groups) {
    const hash = groupHash(groupFolder);
    for (const spec of groupSpecs) {
      desired.push({ spec, groupFolder, groupHash: hash });
    }
  }

  let errors = 0;
  for (const { spec, groupFolder, groupHash: hash } of desired) {
    try {
      const ctx = {
        groupFolder,
        groupHash: hash,
        namespace: args.namespace,
        groupsPvcName: args.groupsPvcName,
      };
      await args.client.applyNetworkPolicy(renderNetworkPolicy(spec, ctx));
      await args.client.applyService(renderService(spec, ctx));
      await args.client.applyDeployment(renderDeployment(spec, ctx));
      const name = instanceName(spec.name, hash);
      upsertInstance({
        groupFolder, capabilityName: spec.name, groupHash: hash,
        deploymentName: name, serviceName: name,
      });
    } catch (err) {
      errors += 1;
      logger.warn({ err, groupFolder, capability: spec.name },
        'per-group capability reconcile failed for pair');
    }
  }

  logger.info(
    { desired_count: desired.length, errors },
    'per-group capability reconcile complete',
  );
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/per-group-capabilities/reconciler.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/per-group-capabilities/reconciler.ts src/per-group-capabilities/reconciler.test.ts
git commit -m "feat(capabilities): per-group capability reconciler"
```

---

### Task 7: Scale-up helper (patch replicas + wait for ready)

**Files:**
- Create: `src/per-group-capabilities/scale-up.ts`
- Test: `src/per-group-capabilities/scale-up.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { scaleUpInstance } from './scale-up.js';
import { upsertInstance, getInstance } from './db.js';

beforeEach(async () => {
  await initDb({ inMemory: true });
  upsertInstance({
    groupFolder: 'Family', capabilityName: 'echo',
    groupHash: 'h1', deploymentName: 'mcp-echo-h1', serviceName: 'mcp-echo-h1',
  });
});

describe('scaleUpInstance', () => {
  it('returns ready when fake reaches ready', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: { replicas: 0, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    setTimeout(() => c.markReady('kubeclaw', 'mcp-echo-h1'), 10);
    const res = await scaleUpInstance({
      client: c, namespace: 'kubeclaw',
      groupFolder: 'Family', capabilityName: 'echo', timeoutMs: 1000,
    });
    expect(res.state).toBe('ready');
    expect(getInstance('Family', 'echo')?.currentReplicas).toBe(1);
  });

  it('returns failed on timeout', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: { replicas: 0, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    const res = await scaleUpInstance({
      client: c, namespace: 'kubeclaw',
      groupFolder: 'Family', capabilityName: 'echo', timeoutMs: 50,
    });
    expect(res.state).toBe('failed');
  });

  it('returns failed if instance not in db', async () => {
    const c = new FakePerGroupK8sClient();
    const res = await scaleUpInstance({
      client: c, namespace: 'kubeclaw',
      groupFolder: 'Unknown', capabilityName: 'x', timeoutMs: 50,
    });
    expect(res.state).toBe('failed');
    expect(res.error).toMatch(/no instance/i);
  });

  it('records last_used_at on success', async () => {
    const c = new FakePerGroupK8sClient();
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: { replicas: 0, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    setTimeout(() => c.markReady('kubeclaw', 'mcp-echo-h1'), 10);
    await scaleUpInstance({
      client: c, namespace: 'kubeclaw',
      groupFolder: 'Family', capabilityName: 'echo', timeoutMs: 1000,
    });
    expect(getInstance('Family', 'echo')?.lastUsedAt).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/per-group-capabilities/scale-up.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/per-group-capabilities/scale-up.ts`:
```ts
import type { PerGroupK8sClient } from './k8s-client.js';
import { getInstance, setReplicas, touchLastUsed } from './db.js';
import { logger } from '../logger.js';

export type ScaleUpResult =
  | { state: 'ready'; endpoint: string; coldStartMs: number }
  | { state: 'failed'; error: string };

export interface ScaleUpArgs {
  client: PerGroupK8sClient;
  namespace: string;
  groupFolder: string;
  capabilityName: string;
  timeoutMs: number;
  port?: number;
}

export async function scaleUpInstance(args: ScaleUpArgs): Promise<ScaleUpResult> {
  const inst = getInstance(args.groupFolder, args.capabilityName);
  if (!inst) {
    return { state: 'failed', error: `no instance recorded for (${args.groupFolder}, ${args.capabilityName})` };
  }
  const start = Date.now();
  const port = args.port ?? 3000;
  const endpoint = `http://${inst.serviceName}.${args.namespace}.svc.cluster.local:${port}`;

  try {
    if (inst.currentReplicas === 0) {
      await args.client.patchDeploymentReplicas(args.namespace, inst.deploymentName, 1);
      setReplicas(args.groupFolder, args.capabilityName, 1);
    }
    await args.client.waitForReady(args.namespace, inst.deploymentName, args.timeoutMs);
    touchLastUsed(args.groupFolder, args.capabilityName, Math.floor(Date.now() / 1000));
    const coldStartMs = Date.now() - start;
    logger.info(
      { group: args.groupFolder, capability: args.capabilityName, coldStartMs },
      'per_group_capability_scale_up',
    );
    return { state: 'ready', endpoint, coldStartMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, group: args.groupFolder, capability: args.capabilityName },
      'per_group_capability_discovery_failed',
    );
    return { state: 'failed', error: msg };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/per-group-capabilities/scale-up.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/per-group-capabilities/scale-up.ts src/per-group-capabilities/scale-up.test.ts
git commit -m "feat(capabilities): scale-up helper with cold-start wait"
```

---

### Task 8: Scale-down sweeper

**Files:**
- Create: `src/per-group-capabilities/scale-down-sweeper.ts`
- Test: `src/per-group-capabilities/scale-down-sweeper.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { sweepIdleInstances } from './scale-down-sweeper.js';
import { upsertInstance, setReplicas, touchLastUsed, getInstance } from './db.js';
import type { CapabilitySpec } from '../capabilities/types.js';

beforeEach(async () => {
  await initDb({ inMemory: true });
});

const spec: CapabilitySpec = {
  name: 'echo', kind: 'mcp', image: 'echo:1',
  scope: 'group', scaleDownAfterIdleSeconds: 600,
};

describe('sweepIdleInstances', () => {
  it('scales down instance idle longer than threshold', async () => {
    const c = new FakePerGroupK8sClient();
    upsertInstance({ groupFolder: 'Family', capabilityName: 'echo',
      groupHash: 'h1', deploymentName: 'mcp-echo-h1', serviceName: 'mcp-echo-h1' });
    setReplicas('Family', 'echo', 1);
    touchLastUsed('Family', 'echo', Math.floor(Date.now() / 1000) - 700);
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: { replicas: 1, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    await sweepIdleInstances({ client: c, namespace: 'kubeclaw', specs: [spec] });
    expect(getInstance('Family', 'echo')?.currentReplicas).toBe(0);
    expect((await c.readDeployment('kubeclaw', 'mcp-echo-h1'))?.spec?.replicas).toBe(0);
  });

  it('leaves instance alone if recently used', async () => {
    const c = new FakePerGroupK8sClient();
    upsertInstance({ groupFolder: 'Family', capabilityName: 'echo',
      groupHash: 'h1', deploymentName: 'mcp-echo-h1', serviceName: 'mcp-echo-h1' });
    setReplicas('Family', 'echo', 1);
    touchLastUsed('Family', 'echo', Math.floor(Date.now() / 1000) - 30);
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: { replicas: 1, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    await sweepIdleInstances({ client: c, namespace: 'kubeclaw', specs: [spec] });
    expect(getInstance('Family', 'echo')?.currentReplicas).toBe(1);
  });

  it('treats missing last_used_at as idle (scales down)', async () => {
    const c = new FakePerGroupK8sClient();
    upsertInstance({ groupFolder: 'Family', capabilityName: 'echo',
      groupHash: 'h1', deploymentName: 'mcp-echo-h1', serviceName: 'mcp-echo-h1' });
    setReplicas('Family', 'echo', 1);
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: { replicas: 1, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    await sweepIdleInstances({ client: c, namespace: 'kubeclaw', specs: [spec] });
    expect(getInstance('Family', 'echo')?.currentReplicas).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/per-group-capabilities/scale-down-sweeper.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/per-group-capabilities/scale-down-sweeper.ts`:
```ts
import type { CapabilitySpec } from '../capabilities/types.js';
import type { PerGroupK8sClient } from './k8s-client.js';
import { listInstancesAtReplicas, setReplicas } from './db.js';
import { resolveGroupCapability, getScope } from './types.js';
import { logger } from '../logger.js';

export interface SweepArgs {
  client: PerGroupK8sClient;
  namespace: string;
  specs: CapabilitySpec[];
  /** Override for tests. */
  nowSeconds?: () => number;
}

export async function sweepIdleInstances(args: SweepArgs): Promise<void> {
  const now = args.nowSeconds ? args.nowSeconds() : Math.floor(Date.now() / 1000);
  const specByName = new Map<string, CapabilitySpec>();
  for (const s of args.specs) {
    if (getScope(s) === 'group') specByName.set(s.name, s);
  }

  const live = listInstancesAtReplicas(1);
  for (const inst of live) {
    const spec = specByName.get(inst.capabilityName);
    if (!spec) continue;
    const threshold = resolveGroupCapability(spec).scaleDownAfterIdleSeconds;
    const idleFor = inst.lastUsedAt === null ? Infinity : now - inst.lastUsedAt;
    if (idleFor < threshold) continue;
    try {
      await args.client.patchDeploymentReplicas(args.namespace, inst.deploymentName, 0);
      setReplicas(inst.groupFolder, inst.capabilityName, 0);
      logger.info(
        { group: inst.groupFolder, capability: inst.capabilityName,
          idleSeconds: idleFor === Infinity ? -1 : idleFor },
        'per_group_capability_scale_down',
      );
    } catch (err) {
      logger.warn({ err, deployment: inst.deploymentName }, 'sweepIdleInstances: scale-down failed');
    }
  }
}

export interface SweeperLoopHandle {
  stop(): void;
}

export function startSweeperLoop(args: SweepArgs & { intervalMs: number }): SweeperLoopHandle {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await sweepIdleInstances(args); }
    catch (err) { logger.warn({ err }, 'sweepIdleInstances threw'); }
    if (!stopped) setTimeout(tick, args.intervalMs);
  };
  setTimeout(tick, args.intervalMs);
  return { stop() { stopped = true; } };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/per-group-capabilities/scale-down-sweeper.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/per-group-capabilities/scale-down-sweeper.ts src/per-group-capabilities/scale-down-sweeper.test.ts
git commit -m "feat(capabilities): scale-down sweeper with idle threshold"
```

---

### Task 9: GC cascade on group deletion

**Files:**
- Create: `src/per-group-capabilities/gc.ts`
- Test: `src/per-group-capabilities/gc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { gcGroup } from './gc.js';
import { upsertInstance, listInstances } from './db.js';

beforeEach(async () => {
  await initDb({ inMemory: true });
});

describe('gcGroup', () => {
  it('deletes all K8s objects and DB rows for the group', async () => {
    const c = new FakePerGroupK8sClient();
    const hash = 'h1';
    upsertInstance({ groupFolder: 'Family', capabilityName: 'echo',
      groupHash: hash, deploymentName: 'mcp-echo-h1', serviceName: 'mcp-echo-h1' });
    await c.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw',
        labels: { 'kubeclaw.io/group-hash': hash } },
      spec: { replicas: 0, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    await c.applyService({
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw',
        labels: { 'kubeclaw.io/group-hash': hash } },
      spec: {},
    });

    await gcGroup({ client: c, namespace: 'kubeclaw', groupFolder: 'Family' });

    expect(await c.readDeployment('kubeclaw', 'mcp-echo-h1')).toBeNull();
    expect(await c.readService('kubeclaw', 'mcp-echo-h1')).toBeNull();
    expect(listInstances('Family')).toEqual([]);
  });

  it('is safe to call on a group with no instances', async () => {
    const c = new FakePerGroupK8sClient();
    await expect(gcGroup({ client: c, namespace: 'kubeclaw', groupFolder: 'Empty' }))
      .resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/per-group-capabilities/gc.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/per-group-capabilities/gc.ts`:
```ts
import type { PerGroupK8sClient } from './k8s-client.js';
import { groupHash } from './hash.js';
import { deleteInstancesByGroup, listInstances } from './db.js';
import { logger } from '../logger.js';

export interface GcArgs {
  client: PerGroupK8sClient;
  namespace: string;
  groupFolder: string;
}

export async function gcGroup(args: GcArgs): Promise<void> {
  const hash = groupHash(args.groupFolder);
  const selector = `kubeclaw.io/group-hash=${hash}`;
  const instanceCount = listInstances(args.groupFolder).length;
  try {
    await args.client.deleteByLabel(args.namespace, selector);
  } catch (err) {
    logger.warn({ err, group: args.groupFolder, selector },
      'per_group_capability_gc: deleteByLabel partial failure');
  }
  deleteInstancesByGroup(args.groupFolder);
  logger.info({ group: args.groupFolder, instances_removed: instanceCount },
    'per_group_capability_gc');
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/per-group-capabilities/gc.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/per-group-capabilities/gc.ts src/per-group-capabilities/gc.test.ts
git commit -m "feat(capabilities): per-group GC cascade on group delete"
```

---

### Task 10: Credentials helper + admin shell tools

**Files:**
- Create: `src/per-group-capabilities/credentials.ts`
- Test: `src/per-group-capabilities/credentials.test.ts`
- Modify: `src/admin-shell.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { setGroupCredential, unsetGroupCredential } from './credentials.js';
import { credsSecretName } from './k8s-objects.js';
import { groupHash } from './hash.js';

describe('setGroupCredential', () => {
  it('creates a Secret with the env key/value', async () => {
    const c = new FakePerGroupK8sClient();
    await setGroupCredential({
      client: c, namespace: 'kubeclaw',
      groupFolder: 'Family', capabilityName: 'github',
      envName: 'GITHUB_TOKEN', value: 'ghp_xxx',
    });
    const name = credsSecretName('github', groupHash('Family'));
    const sec = await c.readSecret('kubeclaw', name);
    expect(sec).not.toBeNull();
    expect(sec?.data?.GITHUB_TOKEN).toBe(Buffer.from('ghp_xxx').toString('base64'));
  });

  it('merges multiple keys into the same Secret', async () => {
    const c = new FakePerGroupK8sClient();
    await setGroupCredential({
      client: c, namespace: 'kubeclaw',
      groupFolder: 'Family', capabilityName: 'github',
      envName: 'A', value: '1',
    });
    await setGroupCredential({
      client: c, namespace: 'kubeclaw',
      groupFolder: 'Family', capabilityName: 'github',
      envName: 'B', value: '2',
    });
    const name = credsSecretName('github', groupHash('Family'));
    const sec = await c.readSecret('kubeclaw', name);
    expect(Object.keys(sec?.data ?? {}).sort()).toEqual(['A', 'B']);
  });
});

describe('unsetGroupCredential', () => {
  it('removes a single key and keeps the others', async () => {
    const c = new FakePerGroupK8sClient();
    await setGroupCredential({
      client: c, namespace: 'kubeclaw',
      groupFolder: 'Family', capabilityName: 'github',
      envName: 'A', value: '1',
    });
    await setGroupCredential({
      client: c, namespace: 'kubeclaw',
      groupFolder: 'Family', capabilityName: 'github',
      envName: 'B', value: '2',
    });
    await unsetGroupCredential({
      client: c, namespace: 'kubeclaw',
      groupFolder: 'Family', capabilityName: 'github', envName: 'A',
    });
    const name = credsSecretName('github', groupHash('Family'));
    const sec = await c.readSecret('kubeclaw', name);
    expect(Object.keys(sec?.data ?? {})).toEqual(['B']);
  });

  it('deletes the Secret when all keys are unset', async () => {
    const c = new FakePerGroupK8sClient();
    await setGroupCredential({
      client: c, namespace: 'kubeclaw',
      groupFolder: 'Family', capabilityName: 'github',
      envName: 'A', value: '1',
    });
    await unsetGroupCredential({
      client: c, namespace: 'kubeclaw',
      groupFolder: 'Family', capabilityName: 'github', envName: 'A',
    });
    const name = credsSecretName('github', groupHash('Family'));
    expect(await c.readSecret('kubeclaw', name)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/per-group-capabilities/credentials.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/per-group-capabilities/credentials.ts`:
```ts
import type { V1Secret } from '@kubernetes/client-node';
import type { PerGroupK8sClient } from './k8s-client.js';
import { groupHash } from './hash.js';
import { credsSecretName } from './k8s-objects.js';

export interface SetCredentialArgs {
  client: PerGroupK8sClient;
  namespace: string;
  groupFolder: string;
  capabilityName: string;
  envName: string;
  value: string;
}

export interface UnsetCredentialArgs {
  client: PerGroupK8sClient;
  namespace: string;
  groupFolder: string;
  capabilityName: string;
  envName: string;
}

export async function setGroupCredential(args: SetCredentialArgs): Promise<void> {
  const hash = groupHash(args.groupFolder);
  const name = credsSecretName(args.capabilityName, hash);
  const existing = await args.client.readSecret(args.namespace, name);
  const data = { ...(existing?.data ?? {}) };
  data[args.envName] = Buffer.from(args.value).toString('base64');
  const sec: V1Secret = {
    apiVersion: 'v1', kind: 'Secret',
    metadata: {
      name, namespace: args.namespace,
      labels: {
        'kubeclaw.io/scope': 'group',
        'kubeclaw.io/capability': args.capabilityName,
        'kubeclaw.io/group-hash': hash,
        'kubeclaw.io/managed-by': 'kubeclaw-orchestrator',
      },
    },
    type: 'Opaque', data,
  };
  await args.client.applySecret(sec);
}

export async function unsetGroupCredential(args: UnsetCredentialArgs): Promise<void> {
  const hash = groupHash(args.groupFolder);
  const name = credsSecretName(args.capabilityName, hash);
  const existing = await args.client.readSecret(args.namespace, name);
  if (!existing) return;
  const data = { ...(existing.data ?? {}) };
  delete data[args.envName];
  if (Object.keys(data).length === 0) {
    await args.client.deleteSecret(args.namespace, name);
    return;
  }
  await args.client.applySecret({
    apiVersion: 'v1', kind: 'Secret',
    metadata: existing.metadata, type: 'Opaque', data,
  });
}
```

- [ ] **Step 4: Add admin-shell IPC tools**

In `src/admin-shell.ts`, locate the `TOOLS` registry (similar to the just-added specialist tools). Add entries:

```ts
{
  name: 'set_group_credential',
  description: 'Set an env-var credential for a per-group MCP capability. Writes/updates a K8s Secret mounted into the per-group Deployment. Note: takes effect on next reconcile.',
  inputSchema: {
    type: 'object',
    properties: {
      group_folder: { type: 'string' },
      capability_name: { type: 'string' },
      env_name: { type: 'string' },
      value: { type: 'string' },
    },
    required: ['group_folder', 'capability_name', 'env_name', 'value'],
  },
  handler: async (args, ctx) => {
    const { setGroupCredential } = await import('./per-group-capabilities/credentials.js');
    await setGroupCredential({
      client: ctx.perGroupK8sClient,
      namespace: KUBECLAW_NAMESPACE,
      groupFolder: args.group_folder as string,
      capabilityName: args.capability_name as string,
      envName: args.env_name as string,
      value: args.value as string,
    });
    return { ok: true };
  },
},
{
  name: 'unset_group_credential',
  description: 'Remove an env-var credential. Deletes the Secret when the last key is removed.',
  inputSchema: {
    type: 'object',
    properties: {
      group_folder: { type: 'string' },
      capability_name: { type: 'string' },
      env_name: { type: 'string' },
    },
    required: ['group_folder', 'capability_name', 'env_name'],
  },
  handler: async (args, ctx) => {
    const { unsetGroupCredential } = await import('./per-group-capabilities/credentials.js');
    await unsetGroupCredential({
      client: ctx.perGroupK8sClient,
      namespace: KUBECLAW_NAMESPACE,
      groupFolder: args.group_folder as string,
      capabilityName: args.capability_name as string,
      envName: args.env_name as string,
    });
    return { ok: true };
  },
},
```

If the admin-shell context (`ctx`) doesn't yet expose `perGroupK8sClient`, add it: import `RealPerGroupK8sClient` from `./per-group-capabilities/k8s-client.js`, instantiate it once at admin-shell startup (mirroring how other K8s clients are constructed), and add `perGroupK8sClient: PerGroupK8sClient` to the AdminShellContext type.

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/per-group-capabilities/credentials.test.ts
npm run build
```
Expected: PASS + zero TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/per-group-capabilities/credentials.ts src/per-group-capabilities/credentials.test.ts src/admin-shell.ts
git commit -m "feat(capabilities): per-group credentials + admin-shell IPC tools"
```

---

### Task 11: Discovery extension (branch on scope)

**Files:**
- Modify: `src/capabilities/discovery.ts`
- Modify: `src/capabilities/types.ts` (extend `CapabilityDiscoveryEntry` if needed for `state` field — see below)
- Test: `src/capabilities/discovery.test.ts` (extend)

- [ ] **Step 1: Read the existing discovery flow**

```bash
sed -n '1,150p' src/capabilities/discovery.ts
```

Identify where the discovery handler resolves a capability name to an endpoint and returns a `CapabilityDiscoveryEntry`. The extension wraps this resolution: if the spec's `scope === 'group'`, call `scaleUpInstance` first; otherwise existing path.

- [ ] **Step 2: Add a state field to the discovery response**

In `src/capabilities/types.ts`, extend the discriminated union to include an optional `state`:

```ts
export type CapabilityDiscoveryResponseState = 'ready' | 'warming' | 'failed';

export type CapabilityDiscoveryEntry =
  | { name: string; kind: 'mcp'; endpoint: string;
      kindMetadata: { path: string; allowedTools?: string[] };
      state?: CapabilityDiscoveryResponseState; error?: string }
  | { name: string; kind: 'rag'; endpoint: string;
      kindMetadata: { backend: 'qdrant' | 'lightrag' };
      state?: CapabilityDiscoveryResponseState; error?: string }
  | { name: string; kind: 'http'; endpoint: string;
      kindMetadata: Record<string, never>;
      state?: CapabilityDiscoveryResponseState; error?: string };
```

`state` is optional — for cluster-scoped responses, callers can treat unset as `'ready'`. Document this in the type.

- [ ] **Step 3: Write the failing test**

Append to `src/capabilities/discovery.test.ts`:
```ts
import { FakePerGroupK8sClient } from '../per-group-capabilities/k8s-client.js';
import { upsertInstance } from '../per-group-capabilities/db.js';
import { groupHash } from '../per-group-capabilities/hash.js';
// Import the discovery handler / resolver factory under test from this file.
// If it is currently inlined, refactor minimally to export a function named
// resolveEntryForChannel(spec, groupFolder, deps) so it can be unit-tested.

describe('discovery for group-scoped capability', () => {
  const groupSpec: CapabilitySpec = {
    name: 'echo', kind: 'mcp', image: 'echo:1',
    scope: 'group', volumeFromGroupPvc: false, credentialsFrom: 'none',
  };

  beforeEach(async () => {
    await initDb({ inMemory: true });
  });

  it('triggers scale-up and returns the per-group endpoint', async () => {
    const client = new FakePerGroupK8sClient();
    const hash = groupHash('Family');
    const depName = `mcp-echo-${hash}`;
    upsertInstance({
      groupFolder: 'Family', capabilityName: 'echo',
      groupHash: hash, deploymentName: depName, serviceName: depName,
    });
    await client.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: depName, namespace: 'kubeclaw' },
      spec: { replicas: 0, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    setTimeout(() => client.markReady('kubeclaw', depName), 10);

    const entry = await resolveEntryForChannel(groupSpec, 'Family', {
      perGroupK8sClient: client, namespace: 'kubeclaw', discoveryTimeoutMs: 1000,
    });

    expect(entry.state).toBe('ready');
    expect(entry.endpoint).toBe(`http://${depName}.kubeclaw.svc.cluster.local:3000`);
    expect(entry.kind).toBe('mcp');
  });

  it('returns state=failed when the per-group Deployment never becomes ready', async () => {
    const client = new FakePerGroupK8sClient();
    const hash = groupHash('Family');
    const depName = `mcp-echo-${hash}`;
    upsertInstance({
      groupFolder: 'Family', capabilityName: 'echo',
      groupHash: hash, deploymentName: depName, serviceName: depName,
    });
    await client.applyDeployment({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: depName, namespace: 'kubeclaw' },
      spec: { replicas: 0, selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } } },
    });
    // never markReady → wait times out

    const entry = await resolveEntryForChannel(groupSpec, 'Family', {
      perGroupK8sClient: client, namespace: 'kubeclaw', discoveryTimeoutMs: 50,
    });

    expect(entry.state).toBe('failed');
    expect(entry.error).toBeTruthy();
  });
});
```

The integration test in Task 15 covers the full round-trip through the real discovery RPC; this unit test exercises only the resolver branch.

- [ ] **Step 4: Run test to verify it fails**

```bash
npx vitest run src/capabilities/discovery.test.ts
```
Expected: FAIL on the new tests.

- [ ] **Step 5: Implement the branch in `src/capabilities/discovery.ts`**

In the discovery request handler (the function that today calls `getEntriesForChannel` or equivalent), add:

```ts
import { getScope } from '../per-group-capabilities/types.js';
import { scaleUpInstance } from '../per-group-capabilities/scale-up.js';
import type { PerGroupK8sClient } from '../per-group-capabilities/k8s-client.js';

// At handler-construction time, inject perGroupK8sClient and namespace as deps.

async function resolveEntry(
  spec: CapabilitySpec,
  groupFolder: string,
  deps: { perGroupK8sClient: PerGroupK8sClient; namespace: string; discoveryTimeoutMs: number },
): Promise<CapabilityDiscoveryEntry> {
  if (getScope(spec) === 'cluster') {
    return clusterEntryForSpec(spec); // existing helper, unchanged
  }
  const res = await scaleUpInstance({
    client: deps.perGroupK8sClient,
    namespace: deps.namespace,
    groupFolder, capabilityName: spec.name,
    timeoutMs: deps.discoveryTimeoutMs,
  });
  if (res.state === 'failed') {
    return {
      name: spec.name, kind: spec.kind as 'mcp',
      endpoint: '',
      kindMetadata: { path: (spec as McpCapabilitySpec).path ?? '/mcp',
        allowedTools: (spec as McpCapabilitySpec).allowedTools },
      state: 'failed', error: res.error,
    };
  }
  return {
    name: spec.name, kind: 'mcp',
    endpoint: res.endpoint,
    kindMetadata: { path: (spec as McpCapabilitySpec).path ?? '/mcp',
      allowedTools: (spec as McpCapabilitySpec).allowedTools },
    state: 'ready',
  };
}
```

Wire `resolveEntry` into the existing response loop. The `groupFolder` comes from the discovery request payload (channels already supply it as part of the call — confirm by reading the existing discovery request schema and extend if needed).

- [ ] **Step 6: Run tests**

```bash
npx vitest run src/capabilities/discovery.test.ts
npm run build
```
Expected: PASS + zero TS errors.

- [ ] **Step 7: Commit**

```bash
git add src/capabilities/discovery.ts src/capabilities/discovery.test.ts src/capabilities/types.ts
git commit -m "feat(capabilities): discovery scales up group-scoped capabilities on demand"
```

---

### Task 12: Helm `kubeclaw.io/role` labels on channel / orchestrator / Redis pods

**Files:**
- Modify: `helm/kubeclaw/templates/orchestrator.yaml`
- Modify: `helm/kubeclaw/templates/channel-pods.yaml`
- Modify: `helm/kubeclaw/templates/redis.yaml`

These labels are required for the per-group NetworkPolicy ingress selector.

- [ ] **Step 1: Inspect each template to find the pod metadata**

```bash
grep -n "labels:" helm/kubeclaw/templates/orchestrator.yaml | head -5
grep -n "labels:" helm/kubeclaw/templates/channel-pods.yaml | head -5
grep -n "labels:" helm/kubeclaw/templates/redis.yaml | head -5
```

For each Deployment/StatefulSet template, find the `spec.template.metadata.labels` block (the *pod* template labels, not the Deployment labels).

- [ ] **Step 2: Add the label**

In each template, add to the pod-template labels block:

- `orchestrator.yaml` pod labels:
  ```yaml
  kubeclaw.io/role: orchestrator
  ```
- `channel-pods.yaml` (this is a range/loop over channels — add inside the per-channel pod template):
  ```yaml
  kubeclaw.io/role: channel
  ```
- `redis.yaml` (this is the Redis StatefulSet) pod labels:
  ```yaml
  kubeclaw.io/role: redis
  ```

Be careful: the *selector* fields (`spec.selector.matchLabels` for Deployments, `spec.selector` for Services) must NOT change — adding the role label there would break upgrade. Add the label only on pod metadata.

- [ ] **Step 3: Render the Helm chart locally to verify**

```bash
helm template helm/kubeclaw | grep -B2 -A1 "kubeclaw.io/role" | head -40
```
Expected: the three role values appear on the appropriate pod templates.

- [ ] **Step 4: Validate no selector duplication**

```bash
helm template helm/kubeclaw > /tmp/rendered.yaml
# Confirm matchLabels blocks do not contain role:
grep -B2 -A8 "matchLabels:" /tmp/rendered.yaml | grep "kubeclaw.io/role" || echo "OK: no role in matchLabels"
```
Expected: prints "OK".

- [ ] **Step 5: Commit**

```bash
git add helm/kubeclaw/templates/orchestrator.yaml helm/kubeclaw/templates/channel-pods.yaml helm/kubeclaw/templates/redis.yaml
git commit -m "feat(helm): add kubeclaw.io/role labels on orchestrator, channel, redis pods"
```

---

### Task 13: Echo MCP container (test fixture)

**Files:**
- Create: `container/echo-mcp/Dockerfile`
- Create: `container/echo-mcp/index.js`
- Create: `container/echo-mcp/package.json`
- Create: `container/echo-mcp/build.sh`

A minimal MCP server with one tool `echo(msg) → msg`, served over Streamable HTTP at `/mcp:3000`. Used only by integration / e2e tests.

- [ ] **Step 1: Create `container/echo-mcp/package.json`**

```json
{
  "name": "kubeclaw-echo-mcp",
  "version": "0.0.1",
  "type": "module",
  "main": "index.js",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

- [ ] **Step 2: Create `container/echo-mcp/index.js`**

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'http';

const mcp = new Server(
  { name: 'echo', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'Returns the input string.',
    inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  }],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'echo') throw new Error(`unknown tool: ${req.params.name}`);
  return { content: [{ type: 'text', text: String(req.params.arguments?.msg ?? '') }] };
});

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await mcp.connect(transport);

const server = createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200); res.end('ok'); return;
  }
  if (req.url === '/mcp') return transport.handleRequest(req, res);
  res.writeHead(404); res.end();
});

server.listen(3000, () => console.log('echo-mcp listening on 3000'));
```

- [ ] **Step 3: Create `container/echo-mcp/Dockerfile`**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./
EXPOSE 3000
CMD ["node", "index.js"]
```

- [ ] **Step 4: Create `container/echo-mcp/build.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
TAG="${1:-kubeclaw-echo-mcp:latest}"
cd "$(dirname "$0")"
docker build -t "$TAG" .
```

Make executable:
```bash
chmod +x container/echo-mcp/build.sh
```

- [ ] **Step 5: Build to verify it works**

```bash
./container/echo-mcp/build.sh kubeclaw-echo-mcp:test
```
Expected: image builds without errors.

- [ ] **Step 6: Commit**

```bash
git add container/echo-mcp/
git commit -m "feat(test-fixtures): echo MCP container for per-group capability tests"
```

---

### Task 14: Wire reconciler / sweeper / GC into orchestrator startup

**Files:**
- Create: `src/per-group-capabilities/index.ts`
- Modify: `src/index.ts` (orchestrator main)

- [ ] **Step 1: Create the public interface module**

`src/per-group-capabilities/index.ts`:
```ts
export { reconcileGroupCapabilities } from './reconciler.js';
export { scaleUpInstance } from './scale-up.js';
export { sweepIdleInstances, startSweeperLoop } from './scale-down-sweeper.js';
export { gcGroup } from './gc.js';
export { setGroupCredential, unsetGroupCredential } from './credentials.js';
export {
  RealPerGroupK8sClient, FakePerGroupK8sClient,
  type PerGroupK8sClient,
} from './k8s-client.js';
export { groupHash } from './hash.js';
export type { CapabilityScope, ResolvedGroupCapability } from './types.js';
export { getScope, validateScopeFields, resolveGroupCapability } from './types.js';
```

- [ ] **Step 2: Wire into `src/index.ts`**

Locate the orchestrator startup sequence in `src/index.ts` (search for the existing capabilities reconciler call). Add, after the existing capabilities reconcile:

```ts
import {
  reconcileGroupCapabilities,
  startSweeperLoop,
  gcGroup,
  RealPerGroupK8sClient,
  type PerGroupK8sClient,
} from './per-group-capabilities/index.js';
import { KUBECLAW_NAMESPACE } from './config.js';

const perGroupK8s: PerGroupK8sClient = new RealPerGroupK8sClient();
const PER_GROUP_SWEEP_INTERVAL_MS =
  Number(process.env.PER_GROUP_SWEEP_INTERVAL_SECONDS ?? '60') * 1000;
const PER_GROUP_GROUPS_PVC =
  process.env.PER_GROUP_GROUPS_PVC ?? 'kubeclaw-groups-pvc';

// Startup: reconcile current desired state
await reconcileGroupCapabilities({
  client: perGroupK8s,
  namespace: KUBECLAW_NAMESPACE,
  groupsPvcName: PER_GROUP_GROUPS_PVC,
  groups: listAllGroupFolders(),         // existing helper that lists registered groups
  specs: getAllCapabilitySpecs(),         // existing helper that returns the merged Helm+admin spec set
});

// Background loops
startSweeperLoop({
  client: perGroupK8s,
  namespace: KUBECLAW_NAMESPACE,
  specs: getAllCapabilitySpecs(),
  intervalMs: PER_GROUP_SWEEP_INTERVAL_MS,
});

// 5-minute periodic safety reconcile
setInterval(async () => {
  try {
    await reconcileGroupCapabilities({
      client: perGroupK8s,
      namespace: KUBECLAW_NAMESPACE,
      groupsPvcName: PER_GROUP_GROUPS_PVC,
      groups: listAllGroupFolders(),
      specs: getAllCapabilitySpecs(),
    });
  } catch (err) {
    logger.warn({ err }, 'per-group periodic reconcile failed');
  }
}, 5 * 60 * 1000);

// Hook GC into group delete flow
onGroupDeleted(async (groupFolder) => {           // existing event hook
  await gcGroup({ client: perGroupK8s, namespace: KUBECLAW_NAMESPACE, groupFolder });
});

// Hook narrow reconcile into group add
onGroupAdded(async (groupFolder) => {              // existing event hook
  await reconcileGroupCapabilities({
    client: perGroupK8s,
    namespace: KUBECLAW_NAMESPACE,
    groupsPvcName: PER_GROUP_GROUPS_PVC,
    groups: [groupFolder],
    specs: getAllCapabilitySpecs(),
  });
});
```

Function names `listAllGroupFolders`, `getAllCapabilitySpecs`, `onGroupDeleted`, `onGroupAdded` may already exist under different names — read `src/index.ts` and adapt. If `onGroupDeleted` / `onGroupAdded` do not exist, add them to the existing group-management code path: in the function that removes a group from SQLite (likely in `src/admin-shell.ts` or `src/db.ts`), call the GC; in the group-registration flow, call the reconciler.

- [ ] **Step 3: Pass `perGroupK8s` into the discovery handler**

The change in Task 11 introduced `perGroupK8sClient` as a discovery dep. In `src/index.ts`, inject `perGroupK8s` where the discovery handler is constructed.

- [ ] **Step 4: Build**

```bash
npm run build
```
Expected: zero TS errors.

- [ ] **Step 5: Run full unit-test suite (no regressions)**

```bash
npm test
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/per-group-capabilities/index.ts src/index.ts
git commit -m "feat(capabilities): wire per-group reconciler/sweeper/GC into orchestrator"
```

---

### Task 15: Integration tests against real K8s (minikube)

**Files:**
- Create: `e2e/integration/per-group-capabilities.test.ts`

These tests require minikube running. Skip via `it.skipIf(!clusterAvailable)` so the suite doesn't fail in dev environments without K8s.

- [ ] **Step 1: Determine cluster-detection pattern**

```bash
grep -rn "skipIf\|shouldSkip\|clusterAvailable" e2e/ | head -10
```
Use the existing pattern (likely a check on `process.env.KUBECONFIG` or a probe RPC).

- [ ] **Step 2: Write integration tests**

`e2e/integration/per-group-capabilities.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  RealPerGroupK8sClient,
  reconcileGroupCapabilities,
  scaleUpInstance,
  sweepIdleInstances,
  gcGroup,
  groupHash,
} from '../../src/per-group-capabilities/index.js';
import { initDb } from '../../src/db.js';
import { setReplicas, touchLastUsed } from '../../src/per-group-capabilities/db.js';
import type { CapabilitySpec } from '../../src/capabilities/types.js';
import { clusterAvailable } from './helpers.js';   // existing helper; create if missing

const NAMESPACE = 'kubeclaw-test';
const skipIf = !await clusterAvailable();

const echoSpec: CapabilitySpec = {
  name: 'echo', kind: 'mcp', image: 'kubeclaw-echo-mcp:test',
  scope: 'group', scaleDownAfterIdleSeconds: 60,
  volumeFromGroupPvc: false, credentialsFrom: 'none',
};

describe.skipIf(skipIf)('per-group capabilities (real K8s)', () => {
  let client: RealPerGroupK8sClient;

  beforeAll(async () => {
    await initDb({ inMemory: true });
    client = new RealPerGroupK8sClient();
    // Ensure namespace exists (kubectl create namespace kubeclaw-test --dry-run=client -o yaml | kubectl apply -f -)
  });

  afterEach(async () => {
    await client.deleteByLabel(NAMESPACE, 'kubeclaw.io/scope=group');
  });

  it('reconciler creates Deployment+Service+NetworkPolicy at replicas: 0', async () => {
    await reconcileGroupCapabilities({
      client, namespace: NAMESPACE, groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['itest-1'], specs: [echoSpec],
    });
    const hash = groupHash('itest-1');
    const dep = await client.readDeployment(NAMESPACE, `mcp-echo-${hash}`);
    expect(dep?.spec?.replicas).toBe(0);
    expect(dep?.metadata?.labels?.['kubeclaw.io/managed-by']).toBe('kubeclaw-orchestrator');
  }, 60_000);

  it('scaleUpInstance brings pod to ready then sweeper scales down', async () => {
    await reconcileGroupCapabilities({
      client, namespace: NAMESPACE, groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['itest-2'], specs: [echoSpec],
    });
    const res = await scaleUpInstance({
      client, namespace: NAMESPACE,
      groupFolder: 'itest-2', capabilityName: 'echo', timeoutMs: 60_000,
    });
    expect(res.state).toBe('ready');

    // Force last_used into the past
    touchLastUsed('itest-2', 'echo', Math.floor(Date.now() / 1000) - 120);
    await sweepIdleInstances({ client, namespace: NAMESPACE, specs: [echoSpec] });
    const hash = groupHash('itest-2');
    const dep = await client.readDeployment(NAMESPACE, `mcp-echo-${hash}`);
    expect(dep?.spec?.replicas).toBe(0);
  }, 120_000);

  it('gcGroup removes all K8s objects for a group', async () => {
    await reconcileGroupCapabilities({
      client, namespace: NAMESPACE, groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['itest-3'], specs: [echoSpec],
    });
    await gcGroup({ client, namespace: NAMESPACE, groupFolder: 'itest-3' });
    const hash = groupHash('itest-3');
    expect(await client.readDeployment(NAMESPACE, `mcp-echo-${hash}`)).toBeNull();
    expect(await client.readService(NAMESPACE, `mcp-echo-${hash}`)).toBeNull();
  }, 60_000);
});
```

If `e2e/integration/helpers.ts` doesn't exist, create it:
```ts
export async function clusterAvailable(): Promise<boolean> {
  try {
    const { KubeConfig, CoreV1Api } = await import('@kubernetes/client-node');
    const kc = new KubeConfig(); kc.loadFromDefault();
    const api = kc.makeApiClient(CoreV1Api);
    await api.listNamespace();
    return true;
  } catch { return false; }
}
```

- [ ] **Step 3: Prepare cluster (if available)**

```bash
kubectl create namespace kubeclaw-test --dry-run=client -o yaml | kubectl apply -f -
./container/echo-mcp/build.sh kubeclaw-echo-mcp:test
# If using minikube:
minikube image load kubeclaw-echo-mcp:test
```

- [ ] **Step 4: Run integration tests**

```bash
npx vitest run e2e/integration/per-group-capabilities.test.ts
```
Expected: PASS (3 tests) if cluster available, all skipped otherwise.

- [ ] **Step 5: Commit**

```bash
git add e2e/integration/per-group-capabilities.test.ts e2e/integration/helpers.ts
git commit -m "test(integration): per-group capabilities against real k8s"
```

---

### Task 16: End-to-end test (full lifecycle scenario)

**Files:**
- Create: `e2e/per-group-capabilities.test.ts`

- [ ] **Step 1: Inspect existing e2e patterns**

```bash
ls e2e/ | head -20
grep -ln "setup:minikube\|fullInstall" e2e/*.ts | head -3
```
Identify how existing e2e tests bootstrap an install. Mirror that pattern.

- [ ] **Step 2: Write the e2e test**

`e2e/per-group-capabilities.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fullInstall, teardown, sendChannelMessage,
         registerGroup, deleteGroup } from './helpers.js';        // existing helpers

const shouldSkip = process.env.SKIP_E2E === '1';

describe.skipIf(shouldSkip)('per-group capabilities — end-to-end', () => {
  beforeAll(async () => {
    await fullInstall({
      capabilities: {
        echo: {
          kind: 'mcp', image: 'kubeclaw-echo-mcp:test',
          scope: 'group', scaleDownAfterIdleSeconds: 60,
          volumeFromGroupPvc: false, credentialsFrom: 'none',
        },
      },
    });
  }, 300_000);

  afterAll(async () => { await teardown(); }, 120_000);

  it('cold start: first call after group creation succeeds within 60s', async () => {
    await registerGroup('e2e-pgc-1', 'http');
    const start = Date.now();
    const reply = await sendChannelMessage('e2e-pgc-1', 'use the echo tool with msg=hello');
    const elapsed = Date.now() - start;
    expect(reply).toMatch(/hello/);
    expect(elapsed).toBeLessThan(60_000);
  }, 90_000);

  it('warm call: subsequent call returns under 5s', async () => {
    const start = Date.now();
    const reply = await sendChannelMessage('e2e-pgc-1', 'echo back the word warm');
    expect(reply).toMatch(/warm/);
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 30_000);

  it('idle scale-down: replicas drop to 0 after threshold', async () => {
    await new Promise(r => setTimeout(r, 75_000));   // exceed 60s threshold + sweep window
    // Query K8s directly via helper to assert replicas
    const { kubectlGet } = await import('./helpers.js');
    const dep = await kubectlGet('deployment', /^mcp-echo-/, 'kubeclaw');
    expect(dep?.spec?.replicas).toBe(0);
  }, 120_000);

  it('group delete cascades all per-group objects', async () => {
    await deleteGroup('e2e-pgc-1');
    const { kubectlGet } = await import('./helpers.js');
    const dep = await kubectlGet('deployment', /^mcp-echo-/, 'kubeclaw');
    expect(dep).toBeNull();
  }, 60_000);
});
```

If `kubectlGet` doesn't exist in e2e helpers, add this thin shell-out wrapper to `e2e/helpers.ts`:

```ts
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileP = promisify(execFile);

/** Returns the first object matching the name pattern, or null. */
export async function kubectlGet(
  resource: string,
  namePattern: RegExp,
  namespace: string,
): Promise<{ spec?: { replicas?: number } } | null> {
  const { stdout } = await execFileP('kubectl',
    ['get', resource, '-n', namespace, '-o', 'json']);
  const list = JSON.parse(stdout) as { items: Array<{ metadata: { name: string } }> };
  const match = list.items.find(it => namePattern.test(it.metadata.name));
  return match ?? null;
}
```

- [ ] **Step 3: Run the e2e test**

```bash
npm run test:e2e -- per-group-capabilities
```
Expected: 4 tests pass (or skipped via `SKIP_E2E=1` in environments without a cluster).

- [ ] **Step 4: Commit**

```bash
git add e2e/per-group-capabilities.test.ts e2e/helpers.ts
git commit -m "test(e2e): per-group capability full lifecycle scenario"
```

---

### Task 17: User docs + CHANGELOG

**Files:**
- Create: `docs/PER_GROUP_CAPABILITIES.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write `docs/PER_GROUP_CAPABILITIES.md`**

```markdown
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
    volumeFromGroupPvc: true       # mount /data with group's subPath
    credentialsFrom: none
    scaleDownAfterIdleSeconds: 600  # default 600; min 60
    allowedTools: [read_file, write_file, list_dir, search_files]
```

## Lifecycle

- **Reconcile.** On orchestrator startup and on each group add/remove, the
  reconciler ensures one Deployment+Service+NetworkPolicy exists per
  (group, group-scoped-capability) pair, with `replicas: 0`.
- **Cold start.** When a channel first discovers the capability for a group,
  the orchestrator patches the Deployment to `replicas: 1` and waits up to
  30s for the pod to become ready. Latency is dominated by image-pull time.
- **Warm calls.** Subsequent calls within the idle window are served by the
  already-running pod.
- **Scale-down.** A background sweeper (default 60s interval) scales
  Deployments back to `replicas: 0` when idle for longer than
  `scaleDownAfterIdleSeconds`.
- **Group delete.** Removing a group cascades to delete all per-group
  Deployments, Services, NetworkPolicies, and Secrets for that group.

## Per-group credentials

For capabilities with `credentialsFrom: secret`, the orchestrator mounts a
per-(group, capability) K8s Secret as `envFrom`. Manage credentials via the
admin shell:

```
> set_group_credential group_folder=Family capability_name=github \
    env_name=GITHUB_TOKEN value=ghp_xxx
> unset_group_credential group_folder=Family capability_name=github \
    env_name=GITHUB_TOKEN
```

Changes take effect on the next reconcile (immediately for the periodic loop,
~5 minutes worst case).

## NetworkPolicy and isolation (v1)

v1 ingress restricts to pods labeled `kubeclaw.io/role: channel` or
`kubeclaw.io/role: orchestrator`. Any channel pod can reach any per-group
Service. Real isolation in v1 comes from three properties that hold per
(group, capability):

1. **Per-group volumes.** `volumeFromGroupPvc: true` mounts only that group's
   subdirectory; the MCP server sees nothing else.
2. **Per-group credentials.** The mounted Secret contains only that group's
   tokens.
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

- Always 0 or 1 replicas per instance (no HA per group)
- No anticipatory warm-up; first call after idle pays cold-start latency
- No automatic GC of orphaned per-group Deployments when a capability spec
  is removed from `values.yaml` — clean up via `kubectl delete deploy -l
  kubeclaw.io/capability=<name>`
- Broker per-group rules (for outbound Authorization stamping) not yet
  implemented; only env-mounted Secrets in v1
```

- [ ] **Step 2: Update `CHANGELOG.md`**

Under the existing `## Unreleased` section, add:

```markdown
### Features

- **Per-group MCP capability tier (`scope: group`)** — Capabilities can now
  be declared with `scope: group`, deploying one Deployment per (group ×
  capability) pair with scale-to-zero. Each instance has its own per-group
  K8s Secret for credentials and an optional mount of the group's PVC
  subPath. See `docs/PER_GROUP_CAPABILITIES.md`.
- New admin-shell IPC tools: `set_group_credential`,
  `unset_group_credential`.
- New pod labels: `kubeclaw.io/role` on orchestrator / channel / Redis
  pods (foundational for per-group NetworkPolicy ingress).
```

- [ ] **Step 3: Commit**

```bash
git add docs/PER_GROUP_CAPABILITIES.md CHANGELOG.md
git commit -m "docs: per-group MCP capabilities and changelog entry"
```

---

### Task 18: Final sweep — full test suite, build, lint

**Files:** none (verification only)

- [ ] **Step 1: Full unit-test suite**

```bash
npm test
```
Expected: all green, no skipped tests beyond intentional `it.skipIf` for cluster-dependent tests.

- [ ] **Step 2: Type-check**

```bash
npm run build
```
Expected: zero errors.

- [ ] **Step 3: Lint (if configured)**

```bash
npm run lint 2>/dev/null || echo "no lint script"
```

- [ ] **Step 4: Integration & e2e (cluster required)**

```bash
# Build echo MCP and load into minikube
./container/echo-mcp/build.sh kubeclaw-echo-mcp:test
minikube image load kubeclaw-echo-mcp:test 2>/dev/null || true
# Integration tests
npx vitest run e2e/integration/per-group-capabilities.test.ts
# E2E (requires fresh install)
npm run test:e2e -- per-group-capabilities
```
Expected: all pass, or all skipped if no cluster.

- [ ] **Step 5: Summary check**

Verify the spec coverage:
- [x] Schema with `scope` field + validator
- [x] SQLite `per_group_capability_instances` table
- [x] K8s object renderers
- [x] K8s client wrapper (real + fake)
- [x] Reconciler with idempotent apply
- [x] Discovery extension with scale-up
- [x] Scale-down sweeper with idle threshold
- [x] GC cascade on group delete
- [x] Per-group credentials helper + admin-shell tools
- [x] Helm `kubeclaw.io/role` labels
- [x] Echo MCP test fixture
- [x] Orchestrator startup wiring
- [x] Integration tests (real K8s)
- [x] E2E test (full lifecycle)
- [x] Docs + CHANGELOG

- [ ] **Step 6: No commit needed (verification task)**

End of Phase A implementation.

---

## Notes for the implementer

- **Pattern matching matters.** Mirror the existing capability reconciler (`src/capabilities/reconciler.ts`) for style and error-handling conventions.
- **K8s client signatures.** `@kubernetes/client-node` v1 has occasionally different signatures from the docs. If a call fails to compile, check `node_modules/@kubernetes/client-node/dist/gen/api/*.d.ts` for the actual signature shape and adjust. Don't fight the SDK — match what it gives you.
- **Don't optimize prematurely.** The 5-minute periodic reconcile is intentional belt-and-braces; do not remove it during code review.
- **Don't add features.** No HPA, no PDB, no broker integration. Phase A's scope is exactly what's in the spec. Phase B and beyond add the actual filesystem and docling consumers.
