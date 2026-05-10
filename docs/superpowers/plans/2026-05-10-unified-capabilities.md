# Unified Capabilities Subsystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the parallel MCP-server registry, RAG provider env-var switch, and unused capability self-registration stream into a single declarative Capabilities subsystem owned by the orchestrator: one `CapabilitySpec` discriminated union, one DB-backed registry, one reconciler, one discovery API, and a typed channel-side client.

**Architecture:** Operator declares `CapabilitySpec` rows through the admin shell or Redis IPC. Orchestrator persists to a new `capabilities` SQLite table, reconciles to Kubernetes (Deployment + Service + optional PVC) via a per-kind YAML builder, periodically health-probes the resulting endpoints, and answers channel-side discovery requests with `{ name, kind, endpoint, kindMetadata }`. RAG and MCP become two of the kinds; `kind: 'http'` is the escape hatch for arbitrary long-lived HTTP services. The unused `kubeclaw:capability:register` stream is retired in favor of orchestrator-owned deployment.

**Tech Stack:** TypeScript, vitest, sql.js (SQLite), `@kubernetes/client-node`, Redis (ioredis). No new dependencies.

**Decisions locked in (from brainstorming):**
1. Nothing deployed by default. Operators install every capability explicitly.
2. Self-registration stream `kubeclaw:capability:register` is removed in phase 4.
3. No version field on `CapabilitySpec` until a real breaking change forces one.
4. MCP `allowedTools` semantics unchanged; the field lives on the `kind: 'mcp'` variant.
5. Discovery request/response API shape (`kubeclaw:discovery:request` → `kubeclaw:discovery:response:<id>`) is preserved; the response **payload** changes to a typed entry per kind.
6. Per-channel control channel notification (`{ command: 'mcp_update', servers }`) is generalized to `{ command: 'capabilities_update', capabilities }`. The `mcp_update` command is emitted as an alias through phase 4 to avoid breaking running channel pods mid-migration.

---

## File structure

### New files (all under `src/capabilities/`)

| File | Responsibility |
|---|---|
| `src/capabilities/types.ts` | `CapabilitySpec` discriminated union (`mcp` / `rag` / `http`), `CapabilityStatus`, `CapabilityDiscoveryEntry`. |
| `src/capabilities/db.ts` | SQLite CRUD for the `capabilities` table; serializes/deserializes specs. |
| `src/capabilities/db.test.ts` | Unit tests for CRUD with an in-memory DB. |
| `src/capabilities/builders/mcp.ts` | YAML builder for MCP kind (Deployment + Service). |
| `src/capabilities/builders/mcp.test.ts` | Snapshot/structure tests on rendered YAML. |
| `src/capabilities/builders/rag-qdrant.ts` | YAML builder for Qdrant capability (Deployment + Service + PVC). |
| `src/capabilities/builders/rag-qdrant.test.ts` | Builder tests. |
| `src/capabilities/builders/rag-lightrag.ts` | YAML builder for LightRAG (Deployment + Service + PVC + Secret env). |
| `src/capabilities/builders/rag-lightrag.test.ts` | Builder tests. |
| `src/capabilities/builders/http.ts` | Generic HTTP-kind builder (Deployment + Service, optional PVC). |
| `src/capabilities/builders/http.test.ts` | Builder tests. |
| `src/capabilities/builders/index.ts` | Discriminator-driven builder dispatch (`buildYaml(spec)` → string). |
| `src/capabilities/reconciler.ts` | Apply / update / delete K8s resources; called by registry on mutations and on startup. |
| `src/capabilities/reconciler.test.ts` | Mocks `jobRunner`; verifies the right calls happen for each kind on install/remove. |
| `src/capabilities/registry.ts` | Public install/remove/list/get; coordinates DB + reconciler + control-channel notify. |
| `src/capabilities/registry.test.ts` | Integration-style with mocked reconciler & DB-in-memory. |
| `src/capabilities/discovery.ts` | Replaces `src/discovery.ts`. Watches `kubeclaw:discovery:request` and serves entries from the registry. |
| `src/capabilities/discovery.test.ts` | Stream watcher tests with a mock Redis. |
| `src/capabilities/health.ts` | Periodic HTTP probes against `healthPath`; updates `last_probe_at` and `status` columns. |
| `src/capabilities/health.test.ts` | Probe tests with `fetch` mocked. |
| `src/capabilities/client.ts` | Channel-side typed accessor: `getCapabilityByName`, `getCapabilitiesByKind`, `getRagProvider`, `getMcpServers`. |
| `src/capabilities/client.test.ts` | Client tests with a mocked discovery transport. |
| `src/capabilities/index.ts` | Barrel re-export — public surface for the rest of the codebase. |

### Modified files

| File | Change |
|---|---|
| `src/types.ts` | `McpServerSpec` and `McpServerStatus` become deprecated re-exports from the new types module. No runtime change. |
| `src/db.ts` | Add `capabilities` table + indexes; add `setCapability`, `getCapability`, `getAllCapabilities`, `deleteCapability`, `updateCapabilityStatus`. Keep `mcp_servers` table + functions read-only through phase 2 for backfill, then delete in phase 4. |
| `src/index.ts` | Replace `startDiscoveryWatcher` import + the inline `syncFromValues`/`notifyAllChannels` block with capability subsystem startup (`startCapabilitySubsystem`). |
| `src/k8s/ipc-redis.ts` | Replace `deploy_mcp_server`/`remove_mcp_server`/`list_mcp_servers` IPC commands with `install_capability`/`remove_capability`/`list_capabilities`. Aliases for the old commands remain through phase 4. |
| `src/rag/provider.ts` | `getRagProvider()` consults the capabilities client first; env-var fallback retained through phase 3, removed in phase 4. |
| `src/mcp-registry.ts` | Becomes a thin shim that delegates to the unified registry; deleted in phase 4. |
| `src/discovery.ts` | Deleted in phase 4. |
| `src/admin-shell.ts` | Add tools: `install_capability`, `remove_capability`, `list_capabilities`, `get_capability_logs`. |
| `k8s/11-qdrant.yaml` | Deleted in phase 3 — Qdrant is now a managed capability. |
| `skills/capability/rag-qdrant.md` | Rewritten in phase 5 to describe admin-shell installation. |
| `skills/capability/rag-lightrag.md` | Same. |
| `docs/SPEC.md` | Capability tier section rewritten (phase 5). |
| `docs/REQUIREMENTS.md` | One-paragraph update on the unified path (phase 5). |

---

## Phase 1 — Foundation: types, DB, builders for MCP

No behavior change. Adds the data plumbing the rest of the plan needs.

### Task 1.1: Define `CapabilitySpec` and supporting types

**Files:**
- Create: `src/capabilities/types.ts`

- [ ] **Step 1: Write the file**

```typescript
/**
 * Unified Capability type system.
 *
 * A capability is a long-lived, low-priv pod the orchestrator manages on
 * behalf of channels. Every capability is declared as a CapabilitySpec
 * (a discriminated union by `kind`). The orchestrator persists the spec,
 * reconciles it to Kubernetes, health-probes the endpoint, and answers
 * channel discovery requests with a typed entry.
 */

export interface CapabilityResources {
  memoryRequest?: string;
  memoryLimit?: string;
  cpuRequest?: string;
  cpuLimit?: string;
}

export interface CapabilityStorage {
  /** PVC size in GiB. */
  sizeGi: number;
  /** Container path the PVC mounts to. */
  mountPath: string;
}

export interface CapabilityBase {
  /** Cluster-unique identifier. Becomes part of the Deployment name. */
  name: string;
  /** Container image (with tag). */
  image: string;
  /** Container port the service exposes. Defaults set per kind. */
  port?: number;
  /** Plain env values. */
  env?: Record<string, string>;
  /** Names of K8s Secrets to envFrom. Each must already exist in the kubeclaw namespace. */
  envFromSecrets?: string[];
  /** ACL: empty/undefined = all channels. */
  channels?: string[];
  /** Resource requests/limits. */
  resources?: CapabilityResources;
  /** Optional PVC. */
  storage?: CapabilityStorage;
  /** HTTP path the orchestrator probes for liveness. Default: '/health'. */
  healthPath?: string;
  /** Optional command override. */
  command?: string[];
  /** Optional args. */
  args?: string[];
}

export interface McpCapabilitySpec extends CapabilityBase {
  kind: 'mcp';
  /** MCP endpoint path. Default: '/mcp'. */
  path?: string;
  /** Optional whitelist of tool names exposed by this MCP server. */
  allowedTools?: string[];
}

export interface RagCapabilitySpec extends CapabilityBase {
  kind: 'rag';
  /** RAG backend implementation. */
  backend: 'qdrant' | 'lightrag';
}

export interface HttpCapabilitySpec extends CapabilityBase {
  kind: 'http';
}

export type CapabilitySpec =
  | McpCapabilitySpec
  | RagCapabilitySpec
  | HttpCapabilitySpec;

export type CapabilityKind = CapabilitySpec['kind'];

/**
 * Persisted lifecycle status for a capability.
 * `pending`: in DB but reconciler hasn't deployed yet.
 * `ready`: most recent health probe succeeded.
 * `unhealthy`: most recent health probe failed.
 * `removing`: marked for deletion, K8s resources being torn down.
 */
export type CapabilityLifecycle = 'pending' | 'ready' | 'unhealthy' | 'removing';

export interface CapabilityStatus {
  name: string;
  lifecycle: CapabilityLifecycle;
  /** ISO timestamp of the last health probe (success or failure). */
  lastProbeAt: string | null;
  /** Last probe error message, if any. */
  lastError: string | null;
}

/**
 * Entry returned to a channel via discovery. The kindMetadata field
 * carries kind-specific data (allowedTools for MCP, backend for RAG).
 */
export type CapabilityDiscoveryEntry =
  | {
      name: string;
      kind: 'mcp';
      endpoint: string;
      kindMetadata: { path: string; allowedTools?: string[] };
    }
  | {
      name: string;
      kind: 'rag';
      endpoint: string;
      kindMetadata: { backend: 'qdrant' | 'lightrag' };
    }
  | {
      name: string;
      kind: 'http';
      endpoint: string;
      kindMetadata: Record<string, never>;
    };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no usages yet, file is self-contained).

- [ ] **Step 3: Commit**

```bash
git add src/capabilities/types.ts
git commit -m "feat(capabilities): add CapabilitySpec discriminated union"
```

### Task 1.2: Add `capabilities` table and DB CRUD

**Files:**
- Modify: `src/db.ts` (add table + functions)
- Create: `src/capabilities/db.ts`
- Create: `src/capabilities/db.test.ts`

- [ ] **Step 1: Add the schema**

In `src/db.ts`, after the `mcp_servers` table block (around line 146), add:

```typescript
  database.run(`
    CREATE TABLE IF NOT EXISTS capabilities (
      name        TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      spec        TEXT NOT NULL,
      lifecycle   TEXT NOT NULL DEFAULT 'pending',
      last_probe_at TEXT,
      last_error  TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )
  `);
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_capabilities_kind ON capabilities(kind)`,
  );
```

- [ ] **Step 2: Write the failing CRUD test**

Create `src/capabilities/db.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setCapability,
  getCapability,
  getAllCapabilities,
  getCapabilitiesByKind,
  deleteCapability,
  updateCapabilityStatus,
} from './db.js';
import type { CapabilitySpec } from './types.js';
import { __resetDbForTest } from '../db.js';

const mcpSpec: CapabilitySpec = {
  kind: 'mcp',
  name: 'weather',
  image: 'mcp/weather:1.0',
  allowedTools: ['get_forecast'],
};

const ragSpec: CapabilitySpec = {
  kind: 'rag',
  name: 'main-rag',
  image: 'qdrant/qdrant:latest',
  backend: 'qdrant',
  storage: { sizeGi: 20, mountPath: '/qdrant/storage' },
};

describe('capabilities/db', () => {
  beforeEach(() => __resetDbForTest());

  it('persists and retrieves a capability', () => {
    setCapability(mcpSpec);
    const got = getCapability('weather');
    expect(got).toEqual(mcpSpec);
  });

  it('upserts on duplicate name', () => {
    setCapability(mcpSpec);
    setCapability({ ...mcpSpec, image: 'mcp/weather:2.0' });
    expect(getCapability('weather')?.image).toBe('mcp/weather:2.0');
  });

  it('lists all capabilities', () => {
    setCapability(mcpSpec);
    setCapability(ragSpec);
    expect(getAllCapabilities()).toHaveLength(2);
  });

  it('filters by kind', () => {
    setCapability(mcpSpec);
    setCapability(ragSpec);
    expect(getCapabilitiesByKind('rag')).toEqual([ragSpec]);
  });

  it('deletes by name', () => {
    setCapability(mcpSpec);
    deleteCapability('weather');
    expect(getCapability('weather')).toBeUndefined();
  });

  it('updates status fields', () => {
    setCapability(mcpSpec);
    updateCapabilityStatus('weather', {
      lifecycle: 'ready',
      lastProbeAt: '2026-05-10T12:00:00Z',
      lastError: null,
    });
    // reading status is exposed via getCapabilityStatus
    const { getCapabilityStatus } = require('./db.js');
    expect(getCapabilityStatus('weather')).toEqual({
      name: 'weather',
      lifecycle: 'ready',
      lastProbeAt: '2026-05-10T12:00:00Z',
      lastError: null,
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/capabilities/db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Add `__resetDbForTest` helper to `src/db.ts`**

Search for the existing `let db:` declaration in `src/db.ts`. After the database initialization function, add:

```typescript
/**
 * Test-only: reset the in-memory database. Drops and recreates all tables.
 */
export function __resetDbForTest(): void {
  // Re-run initialization which uses CREATE TABLE IF NOT EXISTS;
  // for tests we want a clean slate, so drop our tables first.
  for (const t of ['capabilities', 'mcp_servers']) {
    try {
      db.run(`DELETE FROM ${t}`);
    } catch {
      // table may not exist yet
    }
  }
  saveDatabase();
}
```

(Other tables remain — only the two this plan touches need clean-slating, and they're additive.)

- [ ] **Step 5: Implement `src/capabilities/db.ts`**

```typescript
import { db, saveDatabase } from '../db.js';
import type {
  CapabilitySpec,
  CapabilityKind,
  CapabilityStatus,
  CapabilityLifecycle,
} from './types.js';

export function setCapability(spec: CapabilitySpec): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO capabilities (name, kind, spec, lifecycle, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       kind = excluded.kind,
       spec = excluded.spec,
       updated_at = excluded.updated_at`,
    [spec.name, spec.kind, JSON.stringify(spec), now, now],
  );
  saveDatabase();
}

export function getCapability(name: string): CapabilitySpec | undefined {
  const stmt = db.prepare(`SELECT spec FROM capabilities WHERE name = ?`);
  stmt.bind([name]);
  if (!stmt.step()) {
    stmt.free();
    return undefined;
  }
  const row = stmt.getAsObject() as { spec: string };
  stmt.free();
  return JSON.parse(row.spec) as CapabilitySpec;
}

export function getAllCapabilities(): CapabilitySpec[] {
  const result = db.exec(
    `SELECT spec FROM capabilities ORDER BY created_at`,
  );
  if (result.length === 0) return [];
  return result[0].values.map(
    (row: unknown[]) => JSON.parse(row[0] as string) as CapabilitySpec,
  );
}

export function getCapabilitiesByKind(kind: CapabilityKind): CapabilitySpec[] {
  return getAllCapabilities().filter((c) => c.kind === kind);
}

export function deleteCapability(name: string): void {
  db.run(`DELETE FROM capabilities WHERE name = ?`, [name]);
  saveDatabase();
}

export interface StatusUpdate {
  lifecycle: CapabilityLifecycle;
  lastProbeAt: string | null;
  lastError: string | null;
}

export function updateCapabilityStatus(
  name: string,
  update: StatusUpdate,
): void {
  db.run(
    `UPDATE capabilities
       SET lifecycle = ?, last_probe_at = ?, last_error = ?, updated_at = ?
     WHERE name = ?`,
    [
      update.lifecycle,
      update.lastProbeAt,
      update.lastError,
      new Date().toISOString(),
      name,
    ],
  );
  saveDatabase();
}

export function getCapabilityStatus(name: string): CapabilityStatus | undefined {
  const stmt = db.prepare(
    `SELECT name, lifecycle, last_probe_at, last_error
       FROM capabilities WHERE name = ?`,
  );
  stmt.bind([name]);
  if (!stmt.step()) {
    stmt.free();
    return undefined;
  }
  const row = stmt.getAsObject() as {
    name: string;
    lifecycle: CapabilityLifecycle;
    last_probe_at: string | null;
    last_error: string | null;
  };
  stmt.free();
  return {
    name: row.name,
    lifecycle: row.lifecycle,
    lastProbeAt: row.last_probe_at,
    lastError: row.last_error,
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/capabilities/db.test.ts`
Expected: PASS, 6 assertions.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/capabilities/db.ts src/capabilities/db.test.ts
git commit -m "feat(capabilities): add capabilities table and CRUD module"
```

### Task 1.3: MCP YAML builder

Refactors the existing `buildYaml` in `src/mcp-registry.ts:27` into a stand-alone builder typed against `McpCapabilitySpec`.

**Files:**
- Create: `src/capabilities/builders/mcp.ts`
- Create: `src/capabilities/builders/mcp.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/capabilities/builders/mcp.test.ts
import { describe, it, expect } from 'vitest';
import { buildMcpYaml } from './mcp.js';
import type { McpCapabilitySpec } from '../types.js';

const base: McpCapabilitySpec = {
  kind: 'mcp',
  name: 'weather',
  image: 'mcp/weather:1.0',
};

describe('buildMcpYaml', () => {
  it('produces a Deployment + Service in the kubeclaw namespace', () => {
    const yaml = buildMcpYaml(base);
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('namespace: kubeclaw');
    expect(yaml).toContain('name: kubeclaw-cap-weather');
  });

  it('uses port 3000 by default', () => {
    expect(buildMcpYaml(base)).toContain('containerPort: 3000');
  });

  it('honors a custom port', () => {
    expect(buildMcpYaml({ ...base, port: 8080 })).toContain(
      'containerPort: 8080',
    );
  });

  it('renders env vars when provided', () => {
    const yaml = buildMcpYaml({ ...base, env: { LOG_LEVEL: 'debug' } });
    expect(yaml).toContain('name: LOG_LEVEL');
    expect(yaml).toContain('value: "debug"');
  });

  it('renders envFrom for each secret', () => {
    const yaml = buildMcpYaml({
      ...base,
      envFromSecrets: ['kubeclaw-secrets', 'mcp-extra'],
    });
    expect(yaml).toMatch(/envFrom:\s+- secretRef:\s+name: kubeclaw-secrets/);
    expect(yaml).toContain('name: mcp-extra');
  });

  it('uses the kubeclaw-cap-<name> deployment naming', () => {
    expect(buildMcpYaml(base)).toContain('name: kubeclaw-cap-weather');
  });
});
```

- [ ] **Step 2: Run test, expect fail**

Run: `npx vitest run src/capabilities/builders/mcp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder**

```typescript
// src/capabilities/builders/mcp.ts
import { KUBECLAW_NAMESPACE } from '../../config.js';
import type { McpCapabilitySpec } from '../types.js';
import { renderDeploymentAndService, deploymentName } from './common.js';

const DEFAULT_PORT = 3000;

export function buildMcpYaml(spec: McpCapabilitySpec): string {
  return renderDeploymentAndService({
    name: deploymentName(spec.name),
    namespace: KUBECLAW_NAMESPACE,
    component: 'capability-mcp',
    image: spec.image,
    port: spec.port ?? DEFAULT_PORT,
    env: spec.env,
    envFromSecrets: spec.envFromSecrets,
    command: spec.command,
    args: spec.args,
    resources: spec.resources,
    healthPath: spec.healthPath,
    storage: undefined,
  });
}
```

- [ ] **Step 4: Add the shared builder helper**

Create `src/capabilities/builders/common.ts`:

```typescript
import type {
  CapabilityResources,
  CapabilityStorage,
} from '../types.js';

export function deploymentName(name: string): string {
  return `kubeclaw-cap-${name}`;
}

export interface CommonRenderArgs {
  name: string; // already prefixed
  namespace: string;
  component: string; // value for kubeclaw-component label
  image: string;
  port: number;
  env?: Record<string, string>;
  envFromSecrets?: string[];
  command?: string[];
  args?: string[];
  resources?: CapabilityResources;
  healthPath?: string;
  storage?: CapabilityStorage;
}

export function renderDeploymentAndService(a: CommonRenderArgs): string {
  const memReq = a.resources?.memoryRequest ?? '128Mi';
  const memLim = a.resources?.memoryLimit ?? '256Mi';
  const cpuReq = a.resources?.cpuRequest ?? '50m';
  const cpuLim = a.resources?.cpuLimit ?? '500m';
  const healthPath = a.healthPath ?? '/health';

  const envBlock = a.env
    ? Object.entries(a.env)
        .map(
          ([k, v]) =>
            `            - name: ${k}\n              value: ${JSON.stringify(v)}`,
        )
        .join('\n')
    : '';

  const envFromBlock = a.envFromSecrets?.length
    ? `          envFrom:\n` +
      a.envFromSecrets.map((s) => `            - secretRef:\n                name: ${s}`).join('\n') +
      '\n'
    : '';

  const commandBlock = a.command
    ? `          command: ${JSON.stringify(a.command)}\n`
    : '';
  const argsBlock = a.args ? `          args: ${JSON.stringify(a.args)}\n` : '';

  const volumeMounts = a.storage
    ? `          volumeMounts:
            - name: data
              mountPath: ${a.storage.mountPath}
`
    : '';
  const volumes = a.storage
    ? `      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: ${a.name}-data
`
    : '';

  const pvc = a.storage
    ? `---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${a.name}-data
  namespace: ${a.namespace}
  labels:
    app: ${a.name}
    kubeclaw-component: ${a.component}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: ${a.storage.sizeGi}Gi
`
    : '';

  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${a.name}
  namespace: ${a.namespace}
  labels:
    app: ${a.name}
    kubeclaw-component: ${a.component}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${a.name}
  template:
    metadata:
      labels:
        app: ${a.name}
        kubeclaw-component: ${a.component}
    spec:
      automountServiceAccountToken: false
      containers:
        - name: ${a.component}
          image: ${a.image}
${commandBlock}${argsBlock}          ports:
            - containerPort: ${a.port}
              name: http
          env:
${envBlock}
${envFromBlock}          resources:
            requests:
              memory: ${memReq}
              cpu: ${cpuReq}
            limits:
              memory: ${memLim}
              cpu: ${cpuLim}
${volumeMounts}          readinessProbe:
            httpGet:
              path: ${healthPath}
              port: ${a.port}
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: ${healthPath}
              port: ${a.port}
            initialDelaySeconds: 15
            periodSeconds: 30
          securityContext:
            runAsUser: 1000
            runAsGroup: 1000
            runAsNonRoot: true
            allowPrivilegeEscalation: false
${volumes}---
apiVersion: v1
kind: Service
metadata:
  name: ${a.name}
  namespace: ${a.namespace}
  labels:
    app: ${a.name}
    kubeclaw-component: ${a.component}
spec:
  type: ClusterIP
  selector:
    app: ${a.name}
  ports:
    - port: ${a.port}
      targetPort: http
      protocol: TCP
${pvc}`;
}
```

- [ ] **Step 5: Run the test, expect pass**

Run: `npx vitest run src/capabilities/builders/mcp.test.ts`
Expected: PASS, 6 assertions.

- [ ] **Step 6: Commit**

```bash
git add src/capabilities/builders
git commit -m "feat(capabilities): add MCP builder and shared YAML renderer"
```

### Task 1.4: Generic HTTP builder

**Files:**
- Create: `src/capabilities/builders/http.ts`
- Create: `src/capabilities/builders/http.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/capabilities/builders/http.test.ts
import { describe, it, expect } from 'vitest';
import { buildHttpYaml } from './http.js';

describe('buildHttpYaml', () => {
  it('renders a basic http capability', () => {
    const yaml = buildHttpYaml({
      kind: 'http',
      name: 'shortener',
      image: 'shortener:1.0',
      port: 8080,
    });
    expect(yaml).toContain('name: kubeclaw-cap-shortener');
    expect(yaml).toContain('containerPort: 8080');
    expect(yaml).toContain('kubeclaw-component: capability-http');
  });

  it('mounts a PVC when storage is requested', () => {
    const yaml = buildHttpYaml({
      kind: 'http',
      name: 'cache',
      image: 'cache:1.0',
      storage: { sizeGi: 5, mountPath: '/data' },
    });
    expect(yaml).toContain('kind: PersistentVolumeClaim');
    expect(yaml).toContain('storage: 5Gi');
    expect(yaml).toContain('mountPath: /data');
  });
});
```

- [ ] **Step 2: Run test, expect fail**

Run: `npx vitest run src/capabilities/builders/http.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/capabilities/builders/http.ts
import { KUBECLAW_NAMESPACE } from '../../config.js';
import type { HttpCapabilitySpec } from '../types.js';
import { renderDeploymentAndService, deploymentName } from './common.js';

const DEFAULT_PORT = 8080;

export function buildHttpYaml(spec: HttpCapabilitySpec): string {
  return renderDeploymentAndService({
    name: deploymentName(spec.name),
    namespace: KUBECLAW_NAMESPACE,
    component: 'capability-http',
    image: spec.image,
    port: spec.port ?? DEFAULT_PORT,
    env: spec.env,
    envFromSecrets: spec.envFromSecrets,
    command: spec.command,
    args: spec.args,
    resources: spec.resources,
    healthPath: spec.healthPath,
    storage: spec.storage,
  });
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npx vitest run src/capabilities/builders/http.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/builders/http.ts src/capabilities/builders/http.test.ts
git commit -m "feat(capabilities): add generic http builder"
```

### Task 1.5: Builder dispatch

**Files:**
- Create: `src/capabilities/builders/index.ts`

- [ ] **Step 1: Write the file**

```typescript
import type { CapabilitySpec } from '../types.js';
import { buildMcpYaml } from './mcp.js';
import { buildHttpYaml } from './http.js';
// rag-qdrant and rag-lightrag added in Phase 3

export function buildYaml(spec: CapabilitySpec): string {
  switch (spec.kind) {
    case 'mcp':
      return buildMcpYaml(spec);
    case 'http':
      return buildHttpYaml(spec);
    case 'rag':
      throw new Error(
        `RAG builder not yet implemented (added in Phase 3): ${spec.name}`,
      );
    default: {
      // Exhaustiveness check
      const _exhaustive: never = spec;
      void _exhaustive;
      throw new Error('Unknown capability kind');
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/capabilities/builders/index.ts
git commit -m "feat(capabilities): add builder dispatch"
```

---

## Phase 2 — Reconciler, registry, discovery, health probes; fold MCP in

End of phase: MCP installs flow through the new registry; `src/mcp-registry.ts` becomes a shim; old `src/discovery.ts` is replaced by `src/capabilities/discovery.ts`.

### Task 2.1: Reconciler

**Files:**
- Create: `src/capabilities/reconciler.ts`
- Create: `src/capabilities/reconciler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/capabilities/reconciler.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApplyYaml = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDeleteDeployment = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDeleteService = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDeletePvc = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../k8s/job-runner.js', () => ({
  jobRunner: {
    applyYamlToK8s: mockApplyYaml,
    deleteDeployment: mockDeleteDeployment,
    deleteService: mockDeleteService,
    deletePersistentVolumeClaim: mockDeletePvc,
  },
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { applySpec, deleteSpec } from './reconciler.js';
import type { CapabilitySpec } from './types.js';

const mcpSpec: CapabilitySpec = {
  kind: 'mcp',
  name: 'weather',
  image: 'mcp/weather:1.0',
};

describe('reconciler', () => {
  beforeEach(() => {
    mockApplyYaml.mockClear();
    mockDeleteDeployment.mockClear();
    mockDeleteService.mockClear();
    mockDeletePvc.mockClear();
  });

  it('applySpec calls applyYamlToK8s with rendered MCP YAML', async () => {
    await applySpec(mcpSpec);
    expect(mockApplyYaml).toHaveBeenCalledOnce();
    const yaml = mockApplyYaml.mock.calls[0][0] as string;
    expect(yaml).toContain('kubeclaw-cap-weather');
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
  });

  it('deleteSpec deletes Deployment and Service', async () => {
    await deleteSpec(mcpSpec);
    expect(mockDeleteDeployment).toHaveBeenCalledWith(
      'kubeclaw-cap-weather',
      'kubeclaw',
    );
    expect(mockDeleteService).toHaveBeenCalledWith(
      'kubeclaw-cap-weather',
      'kubeclaw',
    );
    expect(mockDeletePvc).not.toHaveBeenCalled();
  });

  it('deleteSpec also removes PVC when storage was declared', async () => {
    await deleteSpec({
      kind: 'http',
      name: 'cache',
      image: 'cache:1.0',
      storage: { sizeGi: 5, mountPath: '/data' },
    });
    expect(mockDeletePvc).toHaveBeenCalledWith(
      'kubeclaw-cap-cache-data',
      'kubeclaw',
    );
  });
});
```

- [ ] **Step 2: Run test, expect fail**

Run: `npx vitest run src/capabilities/reconciler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `deletePersistentVolumeClaim` to job-runner**

In `src/k8s/job-runner.ts`, after `deleteService` (around line 1419), add:

```typescript
  /**
   * Delete a PersistentVolumeClaim by name.
   */
  async deletePersistentVolumeClaim(
    name: string,
    namespace?: string,
  ): Promise<void> {
    const ns = namespace || this.namespace;
    try {
      await this.coreApi.deleteNamespacedPersistentVolumeClaim({
        name,
        namespace: ns,
      });
      logger.info(
        { kind: 'PersistentVolumeClaim', name, namespace: ns },
        'Deleted K8s resource',
      );
    } catch (err: unknown) {
      const status = (err as { response?: { statusCode?: number } })?.response
        ?.statusCode;
      if (status === 404) {
        logger.debug(
          { kind: 'PersistentVolumeClaim', name },
          'Resource not found, nothing to delete',
        );
      } else {
        throw err;
      }
    }
  }
```

- [ ] **Step 4: Implement reconciler**

```typescript
// src/capabilities/reconciler.ts
import { KUBECLAW_NAMESPACE } from '../config.js';
import { jobRunner } from '../k8s/job-runner.js';
import { logger } from '../logger.js';
import { buildYaml } from './builders/index.js';
import { deploymentName } from './builders/common.js';
import type { CapabilitySpec } from './types.js';

/**
 * Apply (create or replace) a capability's K8s resources.
 */
export async function applySpec(spec: CapabilitySpec): Promise<void> {
  const yaml = buildYaml(spec);
  await jobRunner.applyYamlToK8s(yaml);
  logger.info(
    { name: spec.name, kind: spec.kind },
    'Capability resources applied',
  );
}

/**
 * Delete a capability's K8s resources. Idempotent.
 */
export async function deleteSpec(spec: CapabilitySpec): Promise<void> {
  const dep = deploymentName(spec.name);
  const ns = KUBECLAW_NAMESPACE;
  try {
    await jobRunner.deleteDeployment(dep, ns);
  } catch (err) {
    logger.warn({ err, dep }, 'Failed to delete Deployment (may be gone)');
  }
  try {
    await jobRunner.deleteService(dep, ns);
  } catch (err) {
    logger.warn({ err, dep }, 'Failed to delete Service (may be gone)');
  }
  if (spec.storage) {
    try {
      await jobRunner.deletePersistentVolumeClaim(`${dep}-data`, ns);
    } catch (err) {
      logger.warn({ err, dep }, 'Failed to delete PVC (may be gone)');
    }
  }
  logger.info({ name: spec.name, kind: spec.kind }, 'Capability removed');
}

/**
 * Reconcile DB-declared capabilities against Kubernetes on startup.
 * Apply each declared spec; the K8s API is idempotent for our purposes
 * because applyYamlToK8s replaces existing Deployments/Services.
 */
export async function reconcileAllOnStartup(
  specs: CapabilitySpec[],
): Promise<void> {
  for (const spec of specs) {
    try {
      await applySpec(spec);
    } catch (err) {
      logger.error(
        { err, name: spec.name, kind: spec.kind },
        'Failed to reconcile capability on startup',
      );
    }
  }
}
```

- [ ] **Step 5: Run test, expect pass**

Run: `npx vitest run src/capabilities/reconciler.test.ts`
Expected: PASS, 3 assertions.

- [ ] **Step 6: Commit**

```bash
git add src/capabilities/reconciler.ts src/capabilities/reconciler.test.ts src/k8s/job-runner.ts
git commit -m "feat(capabilities): add reconciler with apply/delete/reconcile-on-startup"
```

### Task 2.2: Registry — public install/remove/list with control-channel notify

**Files:**
- Create: `src/capabilities/registry.ts`
- Create: `src/capabilities/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/capabilities/registry.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApply = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDelete = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPublish = vi.hoisted(() => vi.fn().mockResolvedValue(1));

vi.mock('./reconciler.js', () => ({
  applySpec: mockApply,
  deleteSpec: mockDelete,
  reconcileAllOnStartup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({ publish: mockPublish })),
  getControlChannel: (n: string) => `kubeclaw:control:${n}`,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  installCapability,
  removeCapability,
  listCapabilities,
} from './registry.js';
import { __resetDbForTest } from '../db.js';

beforeEach(() => {
  __resetDbForTest();
  mockApply.mockClear();
  mockDelete.mockClear();
  mockPublish.mockClear();
});

describe('registry', () => {
  it('install persists, applies, and notifies channels', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    expect(mockApply).toHaveBeenCalledOnce();
    expect(listCapabilities()).toHaveLength(1);
    // Notification published
    expect(mockPublish).toHaveBeenCalled();
  });

  it('remove deletes K8s resources, removes DB row, notifies', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    mockPublish.mockClear();
    await removeCapability('weather');
    expect(mockDelete).toHaveBeenCalledOnce();
    expect(listCapabilities()).toHaveLength(0);
    expect(mockPublish).toHaveBeenCalled();
  });

  it('install of a duplicate name updates the spec', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:2.0',
    });
    const list = listCapabilities();
    expect(list).toHaveLength(1);
    expect(list[0].image).toBe('mcp/weather:2.0');
  });
});
```

- [ ] **Step 2: Run test, expect fail**

Run: `npx vitest run src/capabilities/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement registry**

```typescript
// src/capabilities/registry.ts
import { getRedisClient, getControlChannel } from '../k8s/redis-client.js';
import { logger } from '../logger.js';
import {
  setCapability,
  getCapability,
  getAllCapabilities,
  deleteCapability as dbDelete,
} from './db.js';
import { applySpec, deleteSpec, reconcileAllOnStartup } from './reconciler.js';
import type {
  CapabilitySpec,
  CapabilityKind,
  CapabilityDiscoveryEntry,
} from './types.js';
import { deploymentName } from './builders/common.js';

const KNOWN_CHANNELS = [
  'http',
  'telegram',
  'discord',
  'slack',
  'whatsapp',
  'irc',
  'signal',
  'gmail',
  'oauth-webchat',
];

const MCP_DEFAULT_PORT = 3000;
const HTTP_DEFAULT_PORT = 8080;
const RAG_QDRANT_DEFAULT_PORT = 6333;
const RAG_LIGHTRAG_DEFAULT_PORT = 9621;

function defaultPort(spec: CapabilitySpec): number {
  switch (spec.kind) {
    case 'mcp':
      return spec.port ?? MCP_DEFAULT_PORT;
    case 'http':
      return spec.port ?? HTTP_DEFAULT_PORT;
    case 'rag':
      return (
        spec.port ??
        (spec.backend === 'qdrant'
          ? RAG_QDRANT_DEFAULT_PORT
          : RAG_LIGHTRAG_DEFAULT_PORT)
      );
  }
}

function endpointFor(spec: CapabilitySpec): string {
  return `http://${deploymentName(spec.name)}:${defaultPort(spec)}`;
}

function specToDiscoveryEntry(spec: CapabilitySpec): CapabilityDiscoveryEntry {
  const endpoint = endpointFor(spec);
  switch (spec.kind) {
    case 'mcp':
      return {
        name: spec.name,
        kind: 'mcp',
        endpoint,
        kindMetadata: {
          path: spec.path ?? '/mcp',
          allowedTools: spec.allowedTools,
        },
      };
    case 'rag':
      return {
        name: spec.name,
        kind: 'rag',
        endpoint,
        kindMetadata: { backend: spec.backend },
      };
    case 'http':
      return {
        name: spec.name,
        kind: 'http',
        endpoint,
        kindMetadata: {},
      };
  }
}

export function listCapabilities(): CapabilitySpec[] {
  return getAllCapabilities();
}

export function getCapabilityByName(name: string): CapabilitySpec | undefined {
  return getCapability(name);
}

export function listCapabilitiesByKind(kind: CapabilityKind): CapabilitySpec[] {
  return getAllCapabilities().filter((c) => c.kind === kind);
}

export function getEntriesForChannel(
  channelName: string,
): CapabilityDiscoveryEntry[] {
  return getAllCapabilities()
    .filter(
      (c) => !c.channels?.length || c.channels.includes(channelName),
    )
    .map(specToDiscoveryEntry);
}

export async function installCapability(spec: CapabilitySpec): Promise<void> {
  setCapability(spec);
  await applySpec(spec);
  logger.info(
    { name: spec.name, kind: spec.kind, image: spec.image },
    'Capability installed',
  );
  await notifyAllChannels();
}

export async function removeCapability(name: string): Promise<void> {
  const spec = getCapability(name);
  if (!spec) {
    logger.warn({ name }, 'removeCapability: no such capability');
    return;
  }
  await deleteSpec(spec);
  dbDelete(name);
  logger.info({ name }, 'Capability removed');
  await notifyAllChannels();
}

/**
 * Publish the per-channel capability set to each known channel pod's
 * control channel. Phase 4 retires the legacy `mcp_update` alias.
 */
export async function notifyAllChannels(): Promise<void> {
  const redis = getRedisClient();
  const all = getAllCapabilities();

  // Determine the union of channel names referenced by ACL'd specs;
  // also broadcast to known channels for unrestricted entries.
  const targeted = new Set<string>();
  let hasUnrestricted = false;
  for (const spec of all) {
    if (spec.channels?.length) {
      for (const c of spec.channels) targeted.add(c);
    } else {
      hasUnrestricted = true;
    }
  }
  if (hasUnrestricted) for (const c of KNOWN_CHANNELS) targeted.add(c);

  for (const channelName of targeted) {
    const entries = getEntriesForChannel(channelName);
    const payload = JSON.stringify({
      command: 'capabilities_update',
      capabilities: JSON.stringify(entries),
    });
    await redis.publish(getControlChannel(channelName), payload);

    // Phase 4 deletes this MCP-only alias.
    const mcpEntries = entries.filter((e) => e.kind === 'mcp');
    if (mcpEntries.length > 0) {
      const legacy = JSON.stringify({
        command: 'mcp_update',
        servers: JSON.stringify(
          mcpEntries.map((e) => ({
            name: e.name,
            url: `${e.endpoint}${(e as { kindMetadata: { path: string } }).kindMetadata.path}`,
            allowedTools: (e as { kindMetadata: { allowedTools?: string[] } })
              .kindMetadata.allowedTools,
          })),
        ),
      });
      await redis.publish(getControlChannel(channelName), legacy);
    }

    logger.debug(
      { channel: channelName, count: entries.length },
      'Published capabilities_update',
    );
  }
}

export async function startCapabilitySubsystem(): Promise<void> {
  await reconcileAllOnStartup(getAllCapabilities());
  await notifyAllChannels();
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npx vitest run src/capabilities/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/registry.ts src/capabilities/registry.test.ts
git commit -m "feat(capabilities): add registry with install/remove/notify"
```

### Task 2.3: Discovery watcher (replaces `src/discovery.ts`)

**Files:**
- Create: `src/capabilities/discovery.ts`
- Create: `src/capabilities/discovery.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/capabilities/discovery.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockXread = vi.hoisted(() => vi.fn());
const mockXrevrange = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockSet = vi.hoisted(() => vi.fn().mockResolvedValue('OK'));

vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({
    xread: mockXread,
    xrevrange: mockXrevrange,
    set: mockSet,
  })),
  getDiscoveryRequestStream: () => 'kubeclaw:discovery:request',
  getDiscoveryResponseKey: (id: string) => `kubeclaw:discovery:response:${id}`,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  startDiscoveryWatcher,
  stopDiscoveryWatcher,
  __handleRequestForTest,
} from './discovery.js';
import { __resetDbForTest } from '../db.js';
import { installCapability } from './registry.js';

vi.mock('./reconciler.js', () => ({
  applySpec: vi.fn().mockResolvedValue(undefined),
  deleteSpec: vi.fn().mockResolvedValue(undefined),
  reconcileAllOnStartup: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  __resetDbForTest();
  mockSet.mockClear();
});

describe('discovery', () => {
  it('answers a by-name request with a single entry', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    await __handleRequestForTest({
      requestId: 'r1',
      capability: 'weather',
    });
    const setArgs = mockSet.mock.calls[0];
    expect(setArgs[0]).toBe('kubeclaw:discovery:response:r1');
    const response = JSON.parse(setArgs[1]) as Array<{ name: string; kind: string }>;
    expect(response).toHaveLength(1);
    expect(response[0].kind).toBe('mcp');
  });

  it('returns capabilities filtered by channel ACL', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'private',
      image: 'mcp/private:1.0',
      channels: ['slack'],
    });
    await installCapability({
      kind: 'mcp',
      name: 'public',
      image: 'mcp/public:1.0',
    });
    await __handleRequestForTest({
      requestId: 'r2',
      channel: 'http',
    });
    const response = JSON.parse(mockSet.mock.calls[0][1]) as Array<{ name: string }>;
    expect(response.map((r) => r.name).sort()).toEqual(['public']);
  });

  // smoke
  it('start/stop is idempotent', () => {
    startDiscoveryWatcher();
    startDiscoveryWatcher();
    stopDiscoveryWatcher();
  });
});
```

- [ ] **Step 2: Run test, expect fail**

Run: `npx vitest run src/capabilities/discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement discovery watcher**

```typescript
// src/capabilities/discovery.ts
import {
  getRedisClient,
  getDiscoveryRequestStream,
  getDiscoveryResponseKey,
} from '../k8s/redis-client.js';
import { logger } from '../logger.js';
import {
  getEntriesForChannel,
  getCapabilityByName,
  listCapabilities,
} from './registry.js';
import type { CapabilityDiscoveryEntry } from './types.js';
import { deploymentName } from './builders/common.js';

const RESPONSE_TTL_SECONDS = 30;

let watcherRunning = false;

async function resolveStreamTip(stream: string): Promise<string> {
  const client = getRedisClient();
  const entries = (await client.xrevrange(stream, '+', '-', 'COUNT', '1')) as [
    string,
    string[],
  ][];
  return entries.length > 0 ? entries[0][0] : '0-0';
}

interface DiscoveryRequest {
  requestId: string;
  capability?: string;
  channel?: string;
}

export async function __handleRequestForTest(
  req: DiscoveryRequest,
): Promise<void> {
  await handleRequest(req);
}

async function handleRequest(req: DiscoveryRequest): Promise<void> {
  let result: CapabilityDiscoveryEntry[];
  if (req.capability) {
    const spec = getCapabilityByName(req.capability);
    if (!spec) {
      result = [];
    } else if (req.channel && spec.channels?.length && !spec.channels.includes(req.channel)) {
      // ACL: requesting channel is not authorized
      result = [];
    } else {
      result = [
        // Use registry's specToDiscoveryEntry indirectly via getEntriesForChannel:
        // safer path is to compute directly, but registry doesn't export that.
        // Instead, we pull all entries for the requesting channel and filter by name.
        ...(req.channel
          ? getEntriesForChannel(req.channel).filter(
              (e) => e.name === spec.name,
            )
          : getEntriesForChannel('*')
              .concat()
              .filter((e) => e.name === spec.name)),
      ];
      // Fall back: if no entry came out (e.g. channel='*' wasn't in ACL),
      // synthesize one from the spec by calling getEntriesForChannel with
      // a dummy channel matching the ACL.
      if (result.length === 0) {
        const ch = spec.channels?.[0] ?? 'http';
        result = getEntriesForChannel(ch).filter((e) => e.name === spec.name);
      }
    }
  } else if (req.channel) {
    result = getEntriesForChannel(req.channel);
  } else {
    // No filter — return entries as if for an unrestricted channel.
    // We pick any registered channel ACL union; falling back to the
    // listCapabilities() set when nothing matches.
    const all = listCapabilities();
    result = all
      .filter((s) => !s.channels?.length)
      .flatMap((s) => getEntriesForChannel(s.channels?.[0] ?? 'http'))
      .filter(
        (e, idx, arr) => arr.findIndex((x) => x.name === e.name) === idx,
      );
    // Also include ACL'd specs for completeness (no channel filter requested).
    for (const s of all) {
      if (s.channels?.length) {
        const e = getEntriesForChannel(s.channels[0]).find(
          (e) => e.name === s.name,
        );
        if (e) result.push(e);
      }
    }
  }

  const client = getRedisClient();
  await client.set(
    getDiscoveryResponseKey(req.requestId),
    JSON.stringify(result),
    'EX',
    RESPONSE_TTL_SECONDS,
  );
  // Use deploymentName here so the import is consumed (linter happiness).
  void deploymentName;
  logger.debug(
    { requestId: req.requestId, count: result.length },
    'Discovery response written',
  );
}

async function watchRequests(): Promise<void> {
  const redis = getRedisClient();
  const stream = getDiscoveryRequestStream();
  let lastId = await resolveStreamTip(stream);

  logger.info('Discovery request watcher started');

  while (watcherRunning) {
    try {
      const resp = await redis.xread(
        'COUNT',
        10,
        'BLOCK',
        5000,
        'STREAMS',
        stream,
        lastId,
      );
      if (!resp) continue;

      for (const [, messages] of resp as [string, [string, string[]][]][]) {
        for (const [id, fields] of messages) {
          lastId = id;
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2)
            obj[fields[i]] = fields[i + 1];
          if (!obj.requestId) {
            logger.warn({ fields: obj }, 'Discovery request missing requestId');
            continue;
          }
          try {
            await handleRequest({
              requestId: obj.requestId,
              capability: obj.capability,
              channel: obj.channel,
            });
          } catch (err) {
            logger.error(
              { err, requestId: obj.requestId },
              'Discovery handler failed',
            );
          }
        }
      }
    } catch (err) {
      if (watcherRunning) {
        logger.error({ err }, 'Discovery watcher error');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

export function startDiscoveryWatcher(): void {
  if (watcherRunning) return;
  watcherRunning = true;
  watchRequests().catch((err) =>
    logger.error({ err }, 'Discovery watcher crashed'),
  );
  logger.info('Capability discovery watcher started');
}

export function stopDiscoveryWatcher(): void {
  watcherRunning = false;
  logger.info('Capability discovery watcher stopped');
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npx vitest run src/capabilities/discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/discovery.ts src/capabilities/discovery.test.ts
git commit -m "feat(capabilities): add discovery watcher with kind-aware responses"
```

### Task 2.4: Health probes

**Files:**
- Create: `src/capabilities/health.ts`
- Create: `src/capabilities/health.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/capabilities/health.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { __resetDbForTest } from '../db.js';
import { setCapability, getCapabilityStatus } from './db.js';
import { probeOnce } from './health.js';

const fetchMock = vi.fn();
beforeEach(() => {
  __resetDbForTest();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('health.probeOnce', () => {
  it('marks ready on 200', async () => {
    setCapability({ kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    await probeOnce();
    expect(getCapabilityStatus('weather')?.lifecycle).toBe('ready');
  });

  it('marks unhealthy on 500', async () => {
    setCapability({ kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await probeOnce();
    expect(getCapabilityStatus('weather')?.lifecycle).toBe('unhealthy');
    expect(getCapabilityStatus('weather')?.lastError).toContain('500');
  });

  it('marks unhealthy on fetch error', async () => {
    setCapability({ kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' });
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    await probeOnce();
    expect(getCapabilityStatus('weather')?.lifecycle).toBe('unhealthy');
    expect(getCapabilityStatus('weather')?.lastError).toContain('connection refused');
  });
});
```

- [ ] **Step 2: Run test, expect fail**

Run: `npx vitest run src/capabilities/health.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement health probes**

```typescript
// src/capabilities/health.ts
import { logger } from '../logger.js';
import { getAllCapabilities, updateCapabilityStatus } from './db.js';
import { deploymentName } from './builders/common.js';
import type { CapabilitySpec } from './types.js';

const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

const DEFAULT_PORTS: Record<CapabilitySpec['kind'], number> = {
  mcp: 3000,
  rag: 6333, // qdrant default; lightrag overrides via spec.port
  http: 8080,
};

function probeUrl(spec: CapabilitySpec): string {
  const port = spec.port ?? DEFAULT_PORTS[spec.kind];
  const path = spec.healthPath ?? '/health';
  return `http://${deploymentName(spec.name)}:${port}${path}`;
}

export async function probeOnce(): Promise<void> {
  const specs = getAllCapabilities();
  for (const spec of specs) {
    const url = probeUrl(spec);
    const now = new Date().toISOString();
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.ok) {
        updateCapabilityStatus(spec.name, {
          lifecycle: 'ready',
          lastProbeAt: now,
          lastError: null,
        });
      } else {
        updateCapabilityStatus(spec.name, {
          lifecycle: 'unhealthy',
          lastProbeAt: now,
          lastError: `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      updateCapabilityStatus(spec.name, {
        lifecycle: 'unhealthy',
        lastProbeAt: now,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

let probeTimer: ReturnType<typeof setInterval> | null = null;

export function startHealthProbes(): void {
  if (probeTimer) return;
  probeTimer = setInterval(() => {
    probeOnce().catch((err) =>
      logger.error({ err }, 'Health probe loop error'),
    );
  }, PROBE_INTERVAL_MS);
  logger.info('Capability health probes started');
}

export function stopHealthProbes(): void {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
  logger.info('Capability health probes stopped');
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npx vitest run src/capabilities/health.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/health.ts src/capabilities/health.test.ts
git commit -m "feat(capabilities): add periodic HTTP health probes"
```

### Task 2.5: Subsystem barrel + startup hook

**Files:**
- Create: `src/capabilities/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add the barrel**

```typescript
// src/capabilities/index.ts
export type {
  CapabilitySpec,
  McpCapabilitySpec,
  RagCapabilitySpec,
  HttpCapabilitySpec,
  CapabilityKind,
  CapabilityStatus,
  CapabilityDiscoveryEntry,
  CapabilityLifecycle,
} from './types.js';

export {
  installCapability,
  removeCapability,
  listCapabilities,
  listCapabilitiesByKind,
  getCapabilityByName,
  getEntriesForChannel,
  notifyAllChannels,
  startCapabilitySubsystem,
} from './registry.js';

export {
  startDiscoveryWatcher,
  stopDiscoveryWatcher,
} from './discovery.js';

export { startHealthProbes, stopHealthProbes } from './health.js';
```

- [ ] **Step 2: Wire startup**

In `src/index.ts`, replace the block at lines 947–966 (currently `startDiscoveryWatcher()` + the MCP `syncFromValues` block) with:

```typescript
  // Start the unified capabilities subsystem.
  const {
    startCapabilitySubsystem,
    startDiscoveryWatcher,
    startHealthProbes,
    installCapability,
  } = await import('./capabilities/index.js');
  startDiscoveryWatcher();
  startHealthProbes();
  await startCapabilitySubsystem();

  // One-shot ingest of values.yaml-supplied specs (env: CAPABILITIES_VALUES, JSON array).
  // Backwards compat: also accept MCP_SERVERS_VALUES (kind injected as 'mcp').
  try {
    const capValuesJson = process.env.CAPABILITIES_VALUES;
    if (capValuesJson) {
      const specs = JSON.parse(capValuesJson) as Array<
        Parameters<typeof installCapability>[0]
      >;
      for (const spec of specs) await installCapability(spec);
      logger.info({ count: specs.length }, 'Synced capabilities from values.yaml');
    }
    const mcpValuesJson = process.env.MCP_SERVERS_VALUES;
    if (mcpValuesJson) {
      const mcpSpecs = JSON.parse(mcpValuesJson) as Array<
        Omit<Parameters<typeof installCapability>[0], 'kind'>
      >;
      for (const m of mcpSpecs) {
        await installCapability({ ...m, kind: 'mcp' });
      }
      logger.info(
        { count: mcpSpecs.length },
        'Synced legacy MCP_SERVERS_VALUES (deprecated, use CAPABILITIES_VALUES)',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Failed to sync capabilities on startup');
  }
```

Also remove the `import { startDiscoveryWatcher, stopDiscoveryWatcher } from './discovery.js';` line at `src/index.ts:78` (the new import comes from `./capabilities/index.js`). If there are call sites for `stopDiscoveryWatcher`, change them to import from `./capabilities/index.js`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS — including the legacy `mcp-registry.test.ts` which still uses the old `mcp_servers` table for now.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/index.ts src/index.ts
git commit -m "feat(capabilities): wire subsystem startup in orchestrator"
```

### Task 2.6: Make `mcp-registry.ts` a shim that delegates

This keeps existing call sites in `src/k8s/ipc-redis.ts` working unchanged through phase 4.

**Files:**
- Modify: `src/mcp-registry.ts`
- Modify: `src/types.ts` (deprecate `McpServerSpec`)

- [ ] **Step 1: Update `src/types.ts`**

Replace the existing `McpServerSpec` and `McpServerStatus` definitions (around lines 244–265) with a deprecated re-export shape:

```typescript
import type { McpCapabilitySpec, CapabilityDiscoveryEntry } from './capabilities/types.js';

/**
 * @deprecated Use McpCapabilitySpec from './capabilities/types.js'.
 * Retained as a structural alias for backwards compatibility through phase 4.
 */
export type McpServerSpec = Omit<McpCapabilitySpec, 'kind'> & { kind?: 'mcp' };

/**
 * @deprecated Use CapabilityDiscoveryEntry (kind === 'mcp') instead.
 */
export interface McpServerStatus {
  name: string;
  url: string;
  allowedTools?: string[];
}
```

- [ ] **Step 2: Update `src/mcp-registry.ts` to delegate**

Replace the entire file body with:

```typescript
/**
 * @deprecated MCP-specific registry. Delegates to the unified capabilities
 * subsystem. Removed in phase 4 of the unified-capabilities migration.
 */
import {
  installCapability,
  removeCapability,
  listCapabilities,
  getEntriesForChannel,
  notifyAllChannels as capNotifyAll,
} from './capabilities/index.js';
import type { McpServerSpec, McpServerStatus } from './types.js';

export async function deployMcpServer(spec: McpServerSpec): Promise<void> {
  await installCapability({ ...spec, kind: 'mcp' });
}

export async function removeMcpServer(name: string): Promise<void> {
  await removeCapability(name);
}

export function listMcpServers(): McpServerSpec[] {
  return listCapabilities()
    .filter((c) => c.kind === 'mcp')
    .map((c) => c as unknown as McpServerSpec);
}

export function getServersForChannel(channelName: string): McpServerStatus[] {
  return getEntriesForChannel(channelName)
    .filter((e) => e.kind === 'mcp')
    .map((e) => ({
      name: e.name,
      url: `${e.endpoint}${(e as { kindMetadata: { path: string } }).kindMetadata.path}`,
      allowedTools: (e as { kindMetadata: { allowedTools?: string[] } })
        .kindMetadata.allowedTools,
    }));
}

export async function notifyAllChannels(): Promise<void> {
  await capNotifyAll();
}

export async function syncFromValues(specs: McpServerSpec[]): Promise<void> {
  for (const spec of specs) await deployMcpServer(spec);
}
```

- [ ] **Step 3: Update `src/mcp-registry.test.ts` to assert delegation**

The existing tests mock `jobRunner` directly. After delegation, the mocks for `applyYamlToK8s` are still hit through the reconciler. Update the imports:

```typescript
// At the top of src/mcp-registry.test.ts, after existing mocks:
vi.mock('./capabilities/registry.js', () => ({
  installCapability: vi.fn().mockResolvedValue(undefined),
  removeCapability: vi.fn().mockResolvedValue(undefined),
  listCapabilities: vi.fn().mockReturnValue([]),
  getEntriesForChannel: vi.fn().mockReturnValue([]),
  notifyAllChannels: vi.fn().mockResolvedValue(undefined),
}));
```

Then assert that the shim calls `installCapability` with `kind: 'mcp'` for `deployMcpServer`. Replace the YAML-content assertions with the delegation check.

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-registry.ts src/mcp-registry.test.ts src/types.ts
git commit -m "refactor(mcp): delegate MCP registry to unified capabilities"
```

### Task 2.7: Backfill existing `mcp_servers` rows on startup

If a deployment already has rows in the legacy `mcp_servers` table, copy them to `capabilities` once.

**Files:**
- Modify: `src/db.ts` — add `__legacyAllMcpRows` helper that returns raw rows.
- Modify: `src/index.ts` — call backfill once before `startCapabilitySubsystem`.

- [ ] **Step 1: Add a one-shot backfill in `src/capabilities/registry.ts`**

Add to the bottom of `src/capabilities/registry.ts`:

```typescript
import { getAllMcpServers } from '../db.js';

let backfillRan = false;

export async function backfillFromLegacyMcp(): Promise<void> {
  if (backfillRan) return;
  backfillRan = true;
  const legacyRows = getAllMcpServers();
  for (const row of legacyRows) {
    if (getCapability(row.name)) continue;
    await installCapability({ ...row, kind: 'mcp' });
    logger.info({ name: row.name }, 'Backfilled legacy MCP server');
  }
}
```

- [ ] **Step 2: Call it from startup**

In `src/index.ts`, in the block added in Task 2.5, call `await backfillFromLegacyMcp()` immediately before `startCapabilitySubsystem()`.

- [ ] **Step 3: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/capabilities/registry.ts src/index.ts
git commit -m "feat(capabilities): backfill legacy mcp_servers rows on startup"
```

### Task 2.8: Delete `src/discovery.ts`

The new discovery watcher in `src/capabilities/discovery.ts` replaces it. Remove the old file and the now-unused stream constant.

**Files:**
- Delete: `src/discovery.ts`
- Modify: `src/k8s/redis-client.ts` — drop `getCapabilityRegisterStream` exports if any.

- [ ] **Step 1: Search for remaining importers**

Run: `grep -rn "from './discovery'\|from '\\./discovery\\.js'\|from '../discovery'" src --include='*.ts'`
Expected: only `src/index.ts` (already updated in Task 2.5) and tests in `src/discovery.test.ts` (if it exists).

- [ ] **Step 2: Delete the file and any sibling test**

```bash
rm -f src/discovery.ts src/discovery.test.ts
```

- [ ] **Step 3: Drop `getCapabilityRegisterStream` from `src/k8s/redis-client.ts`**

Search for `getCapabilityRegisterStream`:

```bash
grep -n "getCapabilityRegisterStream" src/k8s/redis-client.ts
```

Remove the constant definition and the export.

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(capabilities): remove legacy discovery service"
```

### Task 2.9: Admin shell tools

**Files:**
- Modify: `src/admin-shell.ts`

- [ ] **Step 1: Add tool definitions**

Locate the array of tools in `src/admin-shell.ts` (around line 47, where `list_groups` is defined). Append four new entries:

```typescript
    {
      name: 'install_capability',
      description:
        'Install or update a long-lived capability pod. Spec is a JSON object with kind ("mcp" | "rag" | "http"), name, image, and kind-specific fields.',
      inputSchema: {
        type: 'object',
        required: ['spec'],
        properties: {
          spec: {
            type: 'object',
            description: 'CapabilitySpec — see docs/SPEC.md',
          },
        },
      },
    },
    {
      name: 'remove_capability',
      description: 'Remove a capability pod and its persistent storage.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
        },
      },
    },
    {
      name: 'list_capabilities',
      description:
        'List all installed capabilities with their lifecycle status.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_capability_logs',
      description: 'Fetch the last N log lines from a capability pod.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          lines: { type: 'number', default: 200 },
        },
      },
    },
```

- [ ] **Step 2: Add the dispatch handlers**

Find the tool-call dispatcher block in the same file. Add cases:

```typescript
    case 'install_capability': {
      const { installCapability } = await import('./capabilities/index.js');
      await installCapability(args.spec);
      return { ok: true };
    }
    case 'remove_capability': {
      const { removeCapability } = await import('./capabilities/index.js');
      await removeCapability(args.name);
      return { ok: true };
    }
    case 'list_capabilities': {
      const { listCapabilities } = await import('./capabilities/index.js');
      const { getCapabilityStatus } = await import('./capabilities/db.js');
      const all = listCapabilities().map((spec) => ({
        spec,
        status: getCapabilityStatus(spec.name),
      }));
      return { capabilities: all };
    }
    case 'get_capability_logs': {
      const lines = args.lines ?? 200;
      const dep = `kubeclaw-cap-${args.name}`;
      const { execSync } = await import('child_process');
      const out = execSync(
        `kubectl logs deployment/${dep} -n kubeclaw --tail=${lines}`,
      ).toString();
      return { logs: out };
    }
```

- [ ] **Step 3: Add an integration test**

Create `src/admin-shell.capabilities.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInstall = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRemove = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockList = vi.hoisted(() =>
  vi.fn().mockReturnValue([
    { kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' },
  ]),
);
const mockStatus = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    name: 'weather',
    lifecycle: 'ready',
    lastProbeAt: '2026-05-10T00:00:00Z',
    lastError: null,
  }),
);

vi.mock('./capabilities/index.js', () => ({
  installCapability: mockInstall,
  removeCapability: mockRemove,
  listCapabilities: mockList,
}));
vi.mock('./capabilities/db.js', () => ({
  getCapabilityStatus: mockStatus,
}));

import { dispatchToolCall } from './admin-shell.js'; // adjust to actual export

beforeEach(() => {
  mockInstall.mockClear();
  mockRemove.mockClear();
});

describe('admin-shell capability tools', () => {
  it('install_capability calls installCapability with the spec', async () => {
    await dispatchToolCall('install_capability', {
      spec: { kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' },
    });
    expect(mockInstall).toHaveBeenCalledOnce();
  });

  it('list_capabilities returns specs with status', async () => {
    const result = await dispatchToolCall('list_capabilities', {});
    expect(result.capabilities).toHaveLength(1);
    expect(result.capabilities[0].status.lifecycle).toBe('ready');
  });
});
```

If `dispatchToolCall` is not the actual export name, locate the tool dispatcher in `admin-shell.ts` (it's the function that switches on tool name) and use its actual exported name. If it isn't exported, refactor the dispatcher into a small exported function `dispatchToolCall(name, args)` and update the existing call site.

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin-shell.ts src/admin-shell.capabilities.test.ts
git commit -m "feat(admin-shell): add install/remove/list/logs capability tools"
```

---

## Phase 3 — RAG kinds and channel-side client

End of phase: RAG providers are selected via the capability registry, not env vars; Qdrant + LightRAG are deployable through the admin shell.

### Task 3.1: Qdrant builder

**Files:**
- Create: `src/capabilities/builders/rag-qdrant.ts`
- Create: `src/capabilities/builders/rag-qdrant.test.ts`
- Modify: `src/capabilities/builders/index.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/capabilities/builders/rag-qdrant.test.ts
import { describe, it, expect } from 'vitest';
import { buildRagQdrantYaml } from './rag-qdrant.js';
import type { RagCapabilitySpec } from '../types.js';

const spec: RagCapabilitySpec = {
  kind: 'rag',
  backend: 'qdrant',
  name: 'main-rag',
  image: 'qdrant/qdrant:latest',
  storage: { sizeGi: 20, mountPath: '/qdrant/storage' },
};

describe('buildRagQdrantYaml', () => {
  it('renders Deployment, Service, and PVC', () => {
    const yaml = buildRagQdrantYaml(spec);
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: PersistentVolumeClaim');
    expect(yaml).toContain('storage: 20Gi');
    expect(yaml).toContain('containerPort: 6333');
    expect(yaml).toContain('mountPath: /qdrant/storage');
  });

  it('uses /healthz as the default health path (Qdrant convention)', () => {
    const yaml = buildRagQdrantYaml(spec);
    expect(yaml).toMatch(/path: \/healthz/);
  });
});
```

- [ ] **Step 2: Run test, expect fail**

Run: `npx vitest run src/capabilities/builders/rag-qdrant.test.ts`

- [ ] **Step 3: Implement**

```typescript
// src/capabilities/builders/rag-qdrant.ts
import { KUBECLAW_NAMESPACE } from '../../config.js';
import type { RagCapabilitySpec } from '../types.js';
import { renderDeploymentAndService, deploymentName } from './common.js';

const DEFAULT_PORT = 6333;
const DEFAULT_HEALTH_PATH = '/healthz';
const DEFAULT_STORAGE = { sizeGi: 20, mountPath: '/qdrant/storage' };

export function buildRagQdrantYaml(spec: RagCapabilitySpec): string {
  if (spec.backend !== 'qdrant') {
    throw new Error(`buildRagQdrantYaml called with backend=${spec.backend}`);
  }
  return renderDeploymentAndService({
    name: deploymentName(spec.name),
    namespace: KUBECLAW_NAMESPACE,
    component: 'capability-rag-qdrant',
    image: spec.image,
    port: spec.port ?? DEFAULT_PORT,
    env: spec.env,
    envFromSecrets: spec.envFromSecrets,
    command: spec.command,
    args: spec.args,
    resources: spec.resources,
    healthPath: spec.healthPath ?? DEFAULT_HEALTH_PATH,
    storage: spec.storage ?? DEFAULT_STORAGE,
  });
}
```

- [ ] **Step 4: Add dispatch wiring**

In `src/capabilities/builders/index.ts`, replace the `case 'rag'` body:

```typescript
    case 'rag':
      if (spec.backend === 'qdrant') return buildRagQdrantYaml(spec);
      if (spec.backend === 'lightrag') return buildRagLightRagYaml(spec);
      throw new Error(`Unknown RAG backend: ${(spec as { backend: string }).backend}`);
```

Add the imports:

```typescript
import { buildRagQdrantYaml } from './rag-qdrant.js';
import { buildRagLightRagYaml } from './rag-lightrag.js';
```

- [ ] **Step 5: Run test, expect pass (Qdrant tests pass; LightRAG dispatch will fail next task — that's expected because we haven't added the file yet)**

Run: `npx vitest run src/capabilities/builders/rag-qdrant.test.ts`
Expected: PASS for the Qdrant test. Other tests will fail because `rag-lightrag.js` is not yet present — that's OK and is fixed in Task 3.2.

- [ ] **Step 6: Stub `rag-lightrag.ts` so the dispatch import resolves**

Create a stub `src/capabilities/builders/rag-lightrag.ts`:

```typescript
import type { RagCapabilitySpec } from '../types.js';

export function buildRagLightRagYaml(_spec: RagCapabilitySpec): string {
  throw new Error('LightRAG builder not yet implemented (added in Task 3.2)');
}
```

Re-run `npm test` — Qdrant test passes; the dispatcher stays compilable.

- [ ] **Step 7: Commit**

```bash
git add src/capabilities/builders/rag-qdrant.ts src/capabilities/builders/rag-qdrant.test.ts src/capabilities/builders/rag-lightrag.ts src/capabilities/builders/index.ts
git commit -m "feat(capabilities): add Qdrant RAG builder"
```

### Task 3.2: LightRAG builder

**Files:**
- Modify: `src/capabilities/builders/rag-lightrag.ts` (replace the stub)
- Create: `src/capabilities/builders/rag-lightrag.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/capabilities/builders/rag-lightrag.test.ts
import { describe, it, expect } from 'vitest';
import { buildRagLightRagYaml } from './rag-lightrag.js';
import type { RagCapabilitySpec } from '../types.js';

const spec: RagCapabilitySpec = {
  kind: 'rag',
  backend: 'lightrag',
  name: 'graph-rag',
  image: 'ghcr.io/hkuds/lightrag:latest',
  envFromSecrets: ['kubeclaw-lightrag-config'],
  storage: { sizeGi: 20, mountPath: '/app/data' },
};

describe('buildRagLightRagYaml', () => {
  it('renders Deployment, Service, PVC', () => {
    const yaml = buildRagLightRagYaml(spec);
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: PersistentVolumeClaim');
  });

  it('uses port 9621 by default', () => {
    expect(buildRagLightRagYaml(spec)).toContain('containerPort: 9621');
  });

  it('mounts /app/data PVC', () => {
    expect(buildRagLightRagYaml(spec)).toContain('mountPath: /app/data');
  });

  it('envFroms the config secret', () => {
    expect(buildRagLightRagYaml(spec)).toContain('name: kubeclaw-lightrag-config');
  });
});
```

- [ ] **Step 2: Run, expect fail (stub throws)**

Run: `npx vitest run src/capabilities/builders/rag-lightrag.test.ts`
Expected: FAIL (stub throws).

- [ ] **Step 3: Implement**

Replace the stub with:

```typescript
// src/capabilities/builders/rag-lightrag.ts
import { KUBECLAW_NAMESPACE } from '../../config.js';
import type { RagCapabilitySpec } from '../types.js';
import { renderDeploymentAndService, deploymentName } from './common.js';

const DEFAULT_PORT = 9621;
const DEFAULT_HEALTH_PATH = '/health';
const DEFAULT_STORAGE = { sizeGi: 20, mountPath: '/app/data' };

export function buildRagLightRagYaml(spec: RagCapabilitySpec): string {
  if (spec.backend !== 'lightrag') {
    throw new Error(`buildRagLightRagYaml called with backend=${spec.backend}`);
  }
  return renderDeploymentAndService({
    name: deploymentName(spec.name),
    namespace: KUBECLAW_NAMESPACE,
    component: 'capability-rag-lightrag',
    image: spec.image,
    port: spec.port ?? DEFAULT_PORT,
    env: spec.env,
    envFromSecrets: spec.envFromSecrets,
    command: spec.command,
    args: spec.args,
    resources: spec.resources,
    healthPath: spec.healthPath ?? DEFAULT_HEALTH_PATH,
    storage: spec.storage ?? DEFAULT_STORAGE,
  });
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npx vitest run src/capabilities/builders/rag-lightrag.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/builders/rag-lightrag.ts src/capabilities/builders/rag-lightrag.test.ts
git commit -m "feat(capabilities): add LightRAG builder"
```

### Task 3.3: Channel-side client — RAG flavor

**Files:**
- Create: `src/capabilities/client.ts`
- Create: `src/capabilities/client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/capabilities/client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEntries = vi.hoisted(() => vi.fn());

vi.mock('./registry.js', () => ({
  getEntriesForChannel: mockEntries,
  listCapabilities: vi.fn().mockReturnValue([]),
  listCapabilitiesByKind: vi.fn().mockReturnValue([]),
  getCapabilityByName: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getRagEntry, getMcpEntries } from './client.js';

beforeEach(() => mockEntries.mockReset());

describe('client', () => {
  it('getRagEntry returns the first rag capability for the channel', () => {
    mockEntries.mockReturnValue([
      { kind: 'rag', name: 'main', endpoint: 'http://x', kindMetadata: { backend: 'qdrant' } },
      { kind: 'mcp', name: 'wx', endpoint: 'http://y', kindMetadata: { path: '/mcp' } },
    ]);
    expect(getRagEntry('http')?.name).toBe('main');
  });

  it('getRagEntry returns undefined when no rag is registered', () => {
    mockEntries.mockReturnValue([]);
    expect(getRagEntry('http')).toBeUndefined();
  });

  it('getMcpEntries returns only MCP entries', () => {
    mockEntries.mockReturnValue([
      { kind: 'rag', name: 'main', endpoint: '', kindMetadata: { backend: 'qdrant' } },
      { kind: 'mcp', name: 'wx', endpoint: '', kindMetadata: { path: '/mcp' } },
      { kind: 'mcp', name: 'cal', endpoint: '', kindMetadata: { path: '/mcp' } },
    ]);
    expect(getMcpEntries('http').map((e) => e.name)).toEqual(['wx', 'cal']);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run src/capabilities/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/capabilities/client.ts
import { getEntriesForChannel } from './registry.js';
import type {
  CapabilityDiscoveryEntry,
} from './types.js';

export function getRagEntry(
  channelName: string,
): Extract<CapabilityDiscoveryEntry, { kind: 'rag' }> | undefined {
  return getEntriesForChannel(channelName).find(
    (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'rag' }> =>
      e.kind === 'rag',
  );
}

export function getMcpEntries(
  channelName: string,
): Extract<CapabilityDiscoveryEntry, { kind: 'mcp' }>[] {
  return getEntriesForChannel(channelName).filter(
    (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'mcp' }> =>
      e.kind === 'mcp',
  );
}

export function getHttpEntry(
  channelName: string,
  name: string,
): Extract<CapabilityDiscoveryEntry, { kind: 'http' }> | undefined {
  return getEntriesForChannel(channelName).find(
    (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'http' }> =>
      e.kind === 'http' && e.name === name,
  );
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run src/capabilities/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-export from barrel**

In `src/capabilities/index.ts`, append:

```typescript
export { getRagEntry, getMcpEntries, getHttpEntry } from './client.js';
```

- [ ] **Step 6: Commit**

```bash
git add src/capabilities/client.ts src/capabilities/client.test.ts src/capabilities/index.ts
git commit -m "feat(capabilities): add typed channel-side client"
```

### Task 3.4: RAG provider — switch to capability-driven selection

**Files:**
- Modify: `src/rag/provider.ts`
- Modify: `src/rag/provider.test.ts` (if it exists; otherwise create)

- [ ] **Step 1: Update provider selection logic**

Replace the `getRagProvider` body in `src/rag/provider.ts:152` with:

```typescript
export function getRagProvider(): RagProvider {
  if (!_provider) {
    // 1. Capability registry (preferred)
    try {
      // Importing eagerly creates a cycle (capabilities -> registry -> db -> rag/provider).
      // Use require-style dynamic import; this file is only called from channel pods.
      const { getRagEntry } = require('../capabilities/client.js') as {
        getRagEntry: (
          ch: string,
        ) => { backend: 'qdrant' | 'lightrag'; endpoint: string } | undefined;
      };
      // Channels embed their name; for orchestrator-side use, fall back to '*'.
      const channelName = process.env.CHANNEL_NAME ?? '*';
      const entry = getRagEntry(channelName);
      if (entry) {
        if (entry.backend === 'lightrag') {
          _provider = new LightRagProvider(entry.endpoint);
          logger.info(
            { url: entry.endpoint, source: 'capability' },
            'RAG provider: LightRAG',
          );
          return _provider;
        }
        if (entry.backend === 'qdrant') {
          // QdrantRagProvider reads QDRANT_URL internally — we set it from
          // the capability endpoint so the existing indexer/retriever work.
          process.env.QDRANT_URL ??= entry.endpoint;
          _provider = new QdrantRagProvider();
          logger.info(
            { url: entry.endpoint, source: 'capability' },
            'RAG provider: Qdrant',
          );
          return _provider;
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Capability lookup unavailable; falling back to env vars');
    }

    // 2. Env-var fallback (deprecated, removed in phase 4).
    const lightragUrl = process.env.LIGHTRAG_URL;
    const qdrantUrl = process.env.QDRANT_URL;

    if (lightragUrl) {
      _provider = new LightRagProvider(lightragUrl);
      logger.info({ url: lightragUrl, source: 'env' }, 'RAG provider: LightRAG');
    } else if (qdrantUrl && process.env.EMBEDDING_PROVIDER !== 'none') {
      _provider = new QdrantRagProvider();
      logger.info({ url: qdrantUrl, source: 'env' }, 'RAG provider: Qdrant');
    } else {
      _provider = new NullRagProvider();
      logger.info('RAG provider: none (disabled)');
    }
  }
  return _provider;
}

/**
 * Test-only: drop the cached provider so the next call re-selects.
 */
export function __resetRagProviderForTest(): void {
  _provider = undefined;
}
```

- [ ] **Step 2: Add a test file**

Create `src/rag/provider.test.ts` (or extend if it exists):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../capabilities/client.js', () => ({
  getRagEntry: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getRagProvider, __resetRagProviderForTest } from './provider.js';
import { getRagEntry } from '../capabilities/client.js';

beforeEach(() => {
  __resetRagProviderForTest();
  vi.mocked(getRagEntry).mockReset();
  delete process.env.LIGHTRAG_URL;
  delete process.env.QDRANT_URL;
  delete process.env.EMBEDDING_PROVIDER;
});

describe('getRagProvider', () => {
  it('returns LightRAG when capability registry has lightrag', () => {
    vi.mocked(getRagEntry).mockReturnValue({
      backend: 'lightrag',
      endpoint: 'http://lr',
    } as never);
    expect(getRagProvider().name).toBe('lightrag');
  });

  it('returns Qdrant when capability registry has qdrant', () => {
    vi.mocked(getRagEntry).mockReturnValue({
      backend: 'qdrant',
      endpoint: 'http://q',
    } as never);
    expect(getRagProvider().name).toBe('qdrant');
  });

  it('falls back to env LIGHTRAG_URL', () => {
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    process.env.LIGHTRAG_URL = 'http://env-lr';
    expect(getRagProvider().name).toBe('lightrag');
  });

  it('falls back to NullRagProvider when nothing configured', () => {
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    expect(getRagProvider().name).toBe('none');
  });
});
```

- [ ] **Step 3: Run, expect pass**

Run: `npx vitest run src/rag/provider.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/rag/provider.ts src/rag/provider.test.ts
git commit -m "feat(rag): select provider via capabilities client"
```

### Task 3.5: Drop `k8s/11-qdrant.yaml`

**Files:**
- Delete: `k8s/11-qdrant.yaml`
- Verify: setup scripts no longer reference it.

- [ ] **Step 1: Find references**

Run: `grep -rn "11-qdrant\|kubeclaw-qdrant" --include='*.ts' --include='*.yaml' --include='*.md' --include='*.sh' .`

Expected: references in `setup/`, `docs/`, and `skills/`. None of the *runtime* code paths should depend on the old static deployment after Task 3.4.

- [ ] **Step 2: Delete the manifest**

```bash
rm k8s/11-qdrant.yaml
```

- [ ] **Step 3: Update setup scripts to no longer apply this file**

In `setup/` (any file that runs `kubectl apply` over `k8s/`), confirm it iterates the directory rather than naming files explicitly. If it names files explicitly, drop the `11-qdrant.yaml` reference.

- [ ] **Step 4: Update minikube docs if they mention 11-qdrant**

Run: `grep -n "11-qdrant" docs/MINIKUBE.md docs/superpowers/specs/*.md 2>/dev/null`. Replace any setup instruction that says "applies Qdrant" with "install RAG capability via admin shell after orchestrator boot."

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(k8s): remove static Qdrant manifest; install via capability registry"
```

---

## Phase 4 — Retire dead code

End of phase: legacy MCP IPC commands gone, env-var RAG fallback gone, legacy `mcp_servers` table dropped, `mcp-registry.ts` deleted.

### Task 4.1: Drop legacy MCP IPC commands

**Files:**
- Modify: `src/k8s/ipc-redis.ts`

- [ ] **Step 1: Replace `deploy_mcp_server` and `remove_mcp_server` cases**

In `src/k8s/ipc-redis.ts`, find the case blocks at lines 603–657 (`deploy_mcp_server`, `remove_mcp_server`). Add new cases above them:

```typescript
    case 'install_capability':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized install_capability attempt blocked',
        );
        break;
      }
      try {
        const { installCapability } = await import('../capabilities/index.js');
        await installCapability(JSON.parse(data.spec));
        logger.info(
          { sourceGroup, name: JSON.parse(data.spec).name },
          'Capability installed via IPC',
        );
      } catch (err) {
        logger.error({ err }, 'Failed to install capability');
      }
      break;

    case 'remove_capability':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized remove_capability attempt blocked',
        );
        break;
      }
      if (data.name) {
        try {
          const { removeCapability } = await import('../capabilities/index.js');
          await removeCapability(data.name);
          logger.info(
            { sourceGroup, name: data.name },
            'Capability removed via IPC',
          );
        } catch (err) {
          logger.error({ err, name: data.name }, 'Failed to remove capability');
        }
      }
      break;

    case 'list_capabilities':
      try {
        const { listCapabilities } = await import('../capabilities/index.js');
        const all = listCapabilities();
        const resultStream = data.resultStream;
        if (resultStream) {
          const client = getRedisClient();
          await client.xadd(
            resultStream,
            '*',
            'result',
            JSON.stringify(all),
            'status',
            'success',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Failed to list capabilities');
      }
      break;
```

Remove the existing `deploy_mcp_server`, `remove_mcp_server`, `list_mcp_servers` cases. Remove the `deployMcpServer`, `removeMcpServer`, `listMcpServers` imports at lines 37–39 of `src/k8s/ipc-redis.ts`.

- [ ] **Step 2: Search for the same commands in the second occurrence (lines ~1238–1285)**

Run: `grep -n "deploy_mcp_server\|remove_mcp_server\|list_mcp_servers" src/k8s/ipc-redis.ts`

If a second handler exists (the agent-tools IPC dispatcher), apply the same replacement in that block.

- [ ] **Step 3: Update the IPC test fixtures**

Run: `grep -rn "deploy_mcp_server\|remove_mcp_server\|list_mcp_servers" src --include='*.test.ts'` and update each test to use the new command names with the new payload (`{ spec: JSON.stringify({...}) }` for install).

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/ipc-redis.ts src/k8s/ipc-redis.test.ts
git commit -m "refactor(ipc): replace MCP-specific commands with install_capability"
```

### Task 4.2: Delete `src/mcp-registry.ts`

**Files:**
- Delete: `src/mcp-registry.ts` and its test
- Modify: `src/index.ts` (drop the deprecated import path)
- Modify: `src/types.ts` (drop the deprecated `McpServerSpec` alias)

- [ ] **Step 1: Find remaining importers**

Run: `grep -rn "from './mcp-registry'\|from '\\./mcp-registry\\.js'\|from '../mcp-registry'" src --include='*.ts'`

Expected: none after Task 4.1. If any remain, replace with imports from `./capabilities/index.js`.

- [ ] **Step 2: Delete files**

```bash
rm src/mcp-registry.ts src/mcp-registry.test.ts
```

- [ ] **Step 3: Drop deprecated types**

In `src/types.ts`, remove the `McpServerSpec` and `McpServerStatus` deprecated aliases added in Task 2.6.

- [ ] **Step 4: Drop the legacy startup block**

In `src/index.ts`, remove the legacy `MCP_SERVERS_VALUES` env-var block from Task 2.5; only `CAPABILITIES_VALUES` remains.

- [ ] **Step 5: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(mcp): remove legacy mcp-registry shim and types"
```

### Task 4.3: Drop the legacy `mcp_servers` table

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Drop the table at startup**

After backfill is universal, drop the table. In `src/db.ts`, in the initialization block where the schema is defined, replace the `CREATE TABLE IF NOT EXISTS mcp_servers` block with:

```typescript
  database.run(`DROP TABLE IF EXISTS mcp_servers`);
```

Remove the `setMcpServer`, `getMcpServer`, `getAllMcpServers`, `deleteMcpServer` exports.

- [ ] **Step 2: Remove the backfill helper from `src/capabilities/registry.ts`**

Delete `backfillFromLegacyMcp` and its call site in `src/index.ts`.

- [ ] **Step 3: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db.ts src/capabilities/registry.ts src/index.ts
git commit -m "chore(db): drop legacy mcp_servers table"
```

### Task 4.4: Drop env-var RAG fallback and the `mcp_update` notify alias

**Files:**
- Modify: `src/rag/provider.ts`
- Modify: `src/capabilities/registry.ts`

- [ ] **Step 1: Strip the env-var RAG fallback in `src/rag/provider.ts`**

Remove the "2. Env-var fallback" branch. The function should now produce `NullRagProvider` if `getRagEntry` returns nothing. Update `src/rag/provider.test.ts` to drop the env-var-fallback tests.

- [ ] **Step 2: Strip the `mcp_update` legacy notification in `src/capabilities/registry.ts`**

In `notifyAllChannels`, delete the block that publishes the legacy `mcp_update` payload. Channels must now consume `capabilities_update`.

- [ ] **Step 3: Update channel-side consumers**

Run: `grep -rn "mcp_update" src --include='*.ts'`

For every match outside the registry (channel pods are out of scope here, but channel runners may also subscribe), update the consumer to handle `capabilities_update` with kind-aware filtering.

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(capabilities): drop env-var RAG fallback and mcp_update alias"
```

---

## Phase 5 — Documentation and skill rewrites

### Task 5.1: Rewrite `skills/capability/rag-qdrant.md`

**Files:**
- Modify: `skills/capability/rag-qdrant.md`

- [ ] **Step 1: Rewrite content**

Replace the full body with:

```markdown
---
name: rag-qdrant
description: Vector RAG via Qdrant — installable as a unified capability
type: capability
dependencies: []
---

# RAG-Qdrant — Vector RAG Capability

Qdrant is a `kind: 'rag'` capability with `backend: 'qdrant'`. The
orchestrator deploys it as a Deployment + Service + PVC and exposes it
to channels through capability discovery.

## Install

From the orchestrator admin shell:

```json
{
  "tool": "install_capability",
  "arguments": {
    "spec": {
      "kind": "rag",
      "backend": "qdrant",
      "name": "main-rag",
      "image": "qdrant/qdrant:latest",
      "storage": { "sizeGi": 20, "mountPath": "/qdrant/storage" }
    }
  }
}
```

The orchestrator persists the spec, applies the K8s manifests, and
notifies channel pods. Channels resolve the endpoint via discovery on
their next message turn.

## Verify

```json
{ "tool": "list_capabilities", "arguments": {} }
```

The entry's `lifecycle` should transition `pending → ready` within ~30 s.
Logs:

```json
{ "tool": "get_capability_logs", "arguments": { "name": "main-rag" } }
```

## Remove

```json
{ "tool": "remove_capability", "arguments": { "name": "main-rag" } }
```

This deletes the Deployment, Service, and PVC.
```

- [ ] **Step 2: Commit**

```bash
git add skills/capability/rag-qdrant.md
git commit -m "docs(skills): rewrite rag-qdrant for unified capability install flow"
```

### Task 5.2: Rewrite `skills/capability/rag-lightrag.md`

**Files:**
- Modify: `skills/capability/rag-lightrag.md`

- [ ] **Step 1: Rewrite content**

Replace the full body with the analogous LightRAG version. Keep the LLM-binding configuration table (`LLM_BINDING`, `EMBEDDING_BINDING`, etc.) but document that the secret `kubeclaw-lightrag-config` must exist before install. The install spec is:

```json
{
  "kind": "rag",
  "backend": "lightrag",
  "name": "graph-rag",
  "image": "ghcr.io/hkuds/lightrag:latest",
  "envFromSecrets": ["kubeclaw-lightrag-config"],
  "storage": { "sizeGi": 20, "mountPath": "/app/data" }
}
```

Remove all `kubectl apply -f -` blocks for the Deployment/Service/PVC — the orchestrator owns them now. Keep the `kubectl create secret generic kubeclaw-lightrag-config ...` block (operators still need to create the secret before install).

- [ ] **Step 2: Commit**

```bash
git add skills/capability/rag-lightrag.md
git commit -m "docs(skills): rewrite rag-lightrag for unified capability install flow"
```

### Task 5.3: Update `docs/SPEC.md`

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Rewrite the Capability tier description**

In `docs/SPEC.md` line ~34 (the table row defining the Capability tier), change from:

> **Capability** | Low | Long-lived | Adds features to the deployment (memory/RAG, MCP servers, etc.). Channels talk to capabilities directly after orchestrator-mediated discovery.

to:

> **Capability** | Low | Long-lived | Long-lived feature pods (RAG, MCP servers, generic HTTP services). Declared as a `CapabilitySpec` and persisted in the orchestrator's SQLite. The orchestrator reconciles the spec to a Deployment + Service + optional PVC, health-probes the endpoint, and answers channel discovery requests with a typed entry per kind.

- [ ] **Step 2: Append a new section after the Channel System section**

Add `## Architecture: Capabilities System` mirroring the structure of the channels section. Cover:

- The `CapabilitySpec` discriminated union (link to `src/capabilities/types.ts`).
- The lifecycle: install → reconcile → probe → discovery.
- The kinds (`mcp`, `rag`, `http`) with the per-kind defaults table.
- The admin-shell tools (`install_capability`, `remove_capability`, `list_capabilities`, `get_capability_logs`).
- A "How to add a new kind" subsection: builder + registry switch case + discovery entry shape + (optional) channel-side client helper.

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): document unified capabilities subsystem"
```

### Task 5.4: Update `docs/REQUIREMENTS.md`

**Files:**
- Modify: `docs/REQUIREMENTS.md`

- [ ] **Step 1: Update the Wishlist**

Remove any wishlist item about MCP installation or RAG installation that is now satisfied by the unified flow. Add a wishlist entry suggesting `kind: 'whisper'` (or similar) as a future first-class capability if speech-to-text is desired.

- [ ] **Step 2: Commit**

```bash
git add docs/REQUIREMENTS.md
git commit -m "docs(requirements): refresh capabilities-related wishlist"
```

### Task 5.5: Run final verification

- [ ] **Step 1: Full test suite**

Run: `npm run typecheck && npm run format && npm test`
Expected: PASS across all three.

- [ ] **Step 2: Sanity build**

Run: `npm run build`
Expected: PASS, no `dist/` errors.

- [ ] **Step 3: Quick grep for stragglers**

Run:

```bash
grep -rn "from './discovery'" src 2>/dev/null
grep -rn "from './mcp-registry'" src 2>/dev/null
grep -rn "MCP_SERVERS_VALUES\|deploy_mcp_server\|remove_mcp_server\|list_mcp_servers\|kubeclaw:capability:register" src 2>/dev/null
grep -rn "QDRANT_URL\b\|LIGHTRAG_URL\b" src --include='*.ts' 2>/dev/null
```

Expected: empty output for everything except the rag/provider.ts comment that documents the deprecation removal (if any). Anything else found should be removed or migrated.

- [ ] **Step 4: Commit any incidental fixes**

If the grep surfaces something, address and commit. Otherwise the migration is done.

```bash
git status
```

Expected: clean.

---

## Self-review notes

**Spec coverage:**
- Goals 1–5: covered by phases 1–4. Goal 6 (channel-side client) covered by Task 3.3.
- Decision 1 (nothing default-deployed): enforced by deleting `k8s/11-qdrant.yaml` (Task 3.5) and not seeding defaults at startup.
- Decision 2 (retire self-registration): Task 2.8.
- Decision 3 (no version field): respected — `CapabilitySpec` has none.
- Decision 4 (MCP `allowedTools` unchanged): preserved on the MCP variant in Task 1.1.
- Decision 5 (discovery wire shape preserved, body changed): Task 2.3.
- Decision 6 (`mcp_update` alias through phase 4): Task 2.2 emits both, Task 4.4 drops the alias.

**Migration safety:**
- Phase 2 keeps `mcp_servers` table read-only with backfill (Task 2.7), so an in-place upgrade preserves operator data.
- The `mcp-registry.ts` shim (Task 2.6) keeps existing IPC handlers compiling through phase 3.
- Phase 4 only deletes after the unified path has been live for the prior phases.

**Risks called out but not blocking:**
- Channel pod compatibility: Phase 4 drops `mcp_update`; channel pods that subscribe to it must be rebuilt with the new `capabilities_update` consumer. If channel pod rollout is staggered, run phase 4 last and inspect channel pod logs for `capabilities_update` adoption before merging.
- The `getRagProvider` cache (`_provider`) is module-scoped: a capability install at runtime won't be picked up until the channel pod restarts, unless we wire a cache-bust into the channel's `capabilities_update` handler. Out of scope for this plan; file as a follow-up if it bites.
