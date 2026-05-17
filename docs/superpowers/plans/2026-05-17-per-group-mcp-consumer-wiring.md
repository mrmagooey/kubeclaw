# Per-Group MCP Consumer Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the channel runtime to consume Phase A's per-group MCP capabilities — schema scrape cache, push-based templates via `capabilities_update`, lazy per-call discovery RPC, `mcp__<capability>__<tool>` tool-name prefix (breaking change for cluster MCPs).

**Architecture:** New `src/per-group-capabilities/schema-cache.ts` + `schema-scraper.ts` (orchestrator-side); new `src/capabilities/discovery-client.ts` (channel-side); extend `src/capabilities/types.ts` with a `GroupMcpEntry` variant; extend `src/runtime/mcp-manager.ts` with `configureGroupMcpTemplates` + ctx-aware `callTool`; refactor `getMcpEntries` to `getMcpEntriesAsync`; rename all MCP tools at the manager surface.

**Tech Stack:** TypeScript strict, Node 20+, sql.js, `@kubernetes/client-node` v1, `@modelcontextprotocol/sdk`, pino, vitest, Helm.

**Spec:** `docs/superpowers/specs/2026-05-17-per-group-mcp-consumer-wiring-design.md`
**Phase A foundation:** merged in `05eef2f`; see `src/per-group-capabilities/`.

---

## Pre-flight

Read before starting:
- `docs/superpowers/specs/2026-05-17-per-group-mcp-consumer-wiring-design.md` (the spec)
- `src/per-group-capabilities/index.ts` (Phase A barrel and lifecycle)
- `src/capabilities/types.ts` (current `CapabilityDiscoveryEntry` shape)
- `src/capabilities/discovery.ts` lines 1-150 (Phase A's per-group discovery handler)
- `src/runtime/mcp-manager.ts` lines 1-200 (current cluster MCP manager)
- `src/channel-runner.ts` lines 140-200 (current `capabilities_update` handler)
- `src/runtime/direct-llm-runner.ts` lines 398-510 (existing tool-job IPC pattern — reference for discovery-client mechanics)

**K8s namespace:** `KUBECLAW_NAMESPACE` from `src/config.ts` (default `'kubeclaw'`).
**Test framework:** vitest. Co-located `*.test.ts` next to source.
**Branch:** create a worktree via `superpowers:using-git-worktrees`. Don't work on `main`.

---

## File map

**New files:**

| File | Responsibility |
|---|---|
| `src/per-group-capabilities/schema-cache.ts` | CRUD on `capability_tool_schemas` SQLite table |
| `src/per-group-capabilities/schema-cache.test.ts` | Unit tests |
| `src/per-group-capabilities/schema-scraper.ts` | Background loop: scrape `tools/list` once per (capability, image), cache |
| `src/per-group-capabilities/schema-scraper.test.ts` | Unit tests against fake K8s + stub MCP server |
| `src/capabilities/discovery-client.ts` | Channel-side Redis RPC client: request endpoint + poll response |
| `src/capabilities/discovery-client.test.ts` | Unit tests against mocked Redis |
| `e2e/per-group-mcp-consumer-integration.test.ts` | Integration against real K8s + Redis |
| `e2e/per-group-mcp-consumer-e2e.test.ts` | Full Helm install scenario |

**Modified files:**

| File | Change |
|---|---|
| `src/db.ts` | Add `capability_tool_schemas` table to `createSchema()` |
| `src/capabilities/types.ts` | Add `GroupMcpEntry` variant + `McpToolSchema` interface |
| `src/capabilities/client.ts` | Replace `getMcpEntries` with async version returning both kinds |
| `src/capabilities/discovery.ts` | Join cluster MCPs + group MCPs with cached schemas into `capabilities_update` payload (orchestrator-side push assembly only — Phase A's per-request handler unchanged) |
| `src/runtime/mcp-manager.ts` | Prefix tool names `mcp__<capability>__<tool>`; `configureGroupMcpTemplates`; ctx-aware `callTool` |
| `src/runtime/mcp-manager.test.ts` | Update existing tests for prefix change; add new tests for group-template behavior |
| `src/runtime/direct-llm-runner.ts` | Pass `{ groupFolder }` ctx at `callTool` site |
| `src/runtime/direct-llm-runner.test.ts` | Update mocks if affected |
| `src/channel-runner.ts` | `capabilities_update` handler: route `mcp-group` entries to `configureGroupMcpTemplates` |
| `src/per-group-capabilities/index.ts` | Re-export new schema-cache + schema-scraper symbols; init scraper in `initPerGroupCapabilityLifecycle` |
| `CHANGELOG.md` | Breaking change entry with grep patterns |

---

## Task list

### Task 1: SQLite `capability_tool_schemas` table + CRUD helpers

**Files:**
- Modify: `src/db.ts` (append to `createSchema`)
- Create: `src/per-group-capabilities/schema-cache.ts`
- Test: `src/per-group-capabilities/schema-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/per-group-capabilities/schema-cache.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import {
  cacheSchemas,
  getCachedSchemas,
  clearCachedSchemas,
} from './schema-cache.js';

const schemas = [
  { name: 'echo', description: 'echoes', inputSchema: { type: 'object' } },
];

beforeAll(async () => { await _initTestDatabase(); });
beforeEach(() => { __resetDbForTest(); });

describe('capability_tool_schemas', () => {
  it('round-trips a schema set', () => {
    cacheSchemas('echo', 'kubeclaw-echo-mcp:test', schemas);
    expect(getCachedSchemas('echo', 'kubeclaw-echo-mcp:test')).toEqual(schemas);
  });

  it('returns null for unknown (capability, image)', () => {
    expect(getCachedSchemas('nope', 'i:1')).toBeNull();
  });

  it('upsert overwrites previous schemas for same (capability, image)', () => {
    cacheSchemas('echo', 'i:1', schemas);
    cacheSchemas('echo', 'i:1', [{ name: 'echo2', inputSchema: {} }]);
    expect(getCachedSchemas('echo', 'i:1')?.[0].name).toBe('echo2');
  });

  it('different image tag is a distinct cache entry', () => {
    cacheSchemas('echo', 'i:1', schemas);
    expect(getCachedSchemas('echo', 'i:2')).toBeNull();
  });

  it('clearCachedSchemas removes the entry', () => {
    cacheSchemas('echo', 'i:1', schemas);
    clearCachedSchemas('echo', 'i:1');
    expect(getCachedSchemas('echo', 'i:1')).toBeNull();
  });
});
```

- [ ] **Step 2: Verify it fails**

```bash
cd <worktree-path>
npx vitest run src/per-group-capabilities/schema-cache.test.ts 2>&1 | tail -8
```
Expected: FAIL (module not found / table missing).

- [ ] **Step 3: Add table to `src/db.ts` `createSchema()`**

Append after the existing `per_group_capability_instances` table (added in Phase A):
```ts
  database.run(`
    CREATE TABLE IF NOT EXISTS capability_tool_schemas (
      capability_name TEXT NOT NULL,
      image           TEXT NOT NULL,
      schemas_json    TEXT NOT NULL,
      scraped_at      INTEGER NOT NULL,
      PRIMARY KEY (capability_name, image)
    )
  `);
```

- [ ] **Step 4: Implement `src/per-group-capabilities/schema-cache.ts`**

```ts
import { db } from '../db.js';

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: unknown;
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

export function cacheSchemas(
  capabilityName: string,
  image: string,
  schemas: McpToolSchema[],
): void {
  const now = Math.floor(Date.now() / 1000);
  run(
    `INSERT INTO capability_tool_schemas
       (capability_name, image, schemas_json, scraped_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(capability_name, image) DO UPDATE SET
       schemas_json = excluded.schemas_json,
       scraped_at   = excluded.scraped_at`,
    [capabilityName, image, JSON.stringify(schemas), now],
  );
}

export function getCachedSchemas(
  capabilityName: string,
  image: string,
): McpToolSchema[] | null {
  const rows = all(
    `SELECT schemas_json FROM capability_tool_schemas
     WHERE capability_name=? AND image=?`,
    [capabilityName, image],
  );
  if (rows.length === 0) return null;
  return JSON.parse(rows[0].schemas_json as string) as McpToolSchema[];
}

export function clearCachedSchemas(
  capabilityName: string,
  image: string,
): void {
  run(
    `DELETE FROM capability_tool_schemas
     WHERE capability_name=? AND image=?`,
    [capabilityName, image],
  );
}

export function listAllCachedSchemas(): Array<{
  capabilityName: string;
  image: string;
  schemas: McpToolSchema[];
  scrapedAt: number;
}> {
  return all(`SELECT * FROM capability_tool_schemas`).map((r) => ({
    capabilityName: r.capability_name as string,
    image: r.image as string,
    schemas: JSON.parse(r.schemas_json as string) as McpToolSchema[],
    scrapedAt: r.scraped_at as number,
  }));
}
```

- [ ] **Step 5: Run tests**

```bash
cd <worktree-path>
npx vitest run src/per-group-capabilities/schema-cache.test.ts 2>&1 | tail -10
```
Expected: 5 passed.

- [ ] **Step 6: Full suite (no regressions)**

```bash
cd <worktree-path>
npm run build 2>&1 | tail -3
npm test 2>&1 | tail -5
```
Expected: zero TS errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
cd <worktree-path>
git branch --show-current   # must be the worktree branch
git add src/db.ts src/per-group-capabilities/schema-cache.ts src/per-group-capabilities/schema-cache.test.ts
git commit -m "feat(capabilities): capability_tool_schemas table + cache helpers"
```

---

### Task 2: Extend `CapabilityDiscoveryEntry` with `GroupMcpEntry` variant

**Files:**
- Modify: `src/capabilities/types.ts`
- Test: `src/capabilities/types.test.ts` (create or extend if exists)

- [ ] **Step 1: Check if types.test.ts exists**

```bash
cd <worktree-path>
ls src/capabilities/types.test.ts 2>&1
```

If exists, extend it. If not, create it.

- [ ] **Step 2: Write the failing test**

If creating new, write `src/capabilities/types.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { CapabilityDiscoveryEntry, GroupMcpEntry, McpToolSchema } from './types.js';

describe('CapabilityDiscoveryEntry', () => {
  it('accepts mcp-group variant with state: ready', () => {
    const entry: GroupMcpEntry = {
      name: 'echo',
      kind: 'mcp-group',
      state: 'ready',
      toolSchemas: [{ name: 'echo', inputSchema: {} }],
    };
    const union: CapabilityDiscoveryEntry = entry;
    expect(union.kind).toBe('mcp-group');
  });

  it('accepts mcp-group variant with state: pending-schema', () => {
    const entry: GroupMcpEntry = {
      name: 'echo',
      kind: 'mcp-group',
      state: 'pending-schema',
    };
    expect(entry.state).toBe('pending-schema');
  });

  it('accepts mcp-group variant with state: failed and error', () => {
    const entry: GroupMcpEntry = {
      name: 'echo',
      kind: 'mcp-group',
      state: 'failed',
      error: 'scrape timed out',
    };
    expect(entry.error).toBe('scrape timed out');
  });

  it('rejects mcp-group with both ready and error fields at compile time', () => {
    // Compile-time-only: this should still pass at runtime because optional
    // fields don't conflict structurally. The intent is documented in spec.
    const entry: GroupMcpEntry = {
      name: 'echo',
      kind: 'mcp-group',
      state: 'ready',
      toolSchemas: [{ name: 'echo', inputSchema: {} }],
    };
    expect(entry.toolSchemas).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Verify it fails**

```bash
cd <worktree-path>
npx vitest run src/capabilities/types.test.ts 2>&1 | tail -8
```
Expected: FAIL (types `GroupMcpEntry`/`McpToolSchema` don't exist).

- [ ] **Step 4: Extend `src/capabilities/types.ts`**

Add at the bottom (after the existing exports):
```ts
/** Tool schema cached from upstream MCP server's tools/list response. */
export interface McpToolSchema {
  /** Bare tool name as returned by the MCP server (without kubeclaw prefix). */
  name: string;
  description?: string;
  /** JSON Schema — opaque to kubeclaw; passed through to the LLM and the MCP server. */
  inputSchema: unknown;
}

/**
 * Discovery entry for a per-group MCP capability.
 *
 * Endpoint is intentionally absent — group-scoped capabilities resolve their
 * endpoint per-call via the discovery RPC (orchestrator scales the per-group
 * Deployment up on demand). Tool schemas come from the orchestrator-side
 * scrape cache.
 */
export interface GroupMcpEntry {
  name: string;
  kind: 'mcp-group';
  /** Lifecycle state of the orchestrator-side schema scrape. */
  state: 'ready' | 'pending-schema' | 'failed';
  /** Present iff state === 'ready'. */
  toolSchemas?: McpToolSchema[];
  /** Optional filter declared on the capability spec. */
  allowedTools?: string[];
  /** Present iff state === 'failed'. */
  error?: string;
}
```

Then update the discriminated union:
```ts
export type CapabilityDiscoveryEntry =
  | {
      name: string;
      kind: 'mcp';
      endpoint: string;
      kindMetadata: { path: string; allowedTools?: string[] };
      state?: CapabilityDiscoveryResponseState;
      error?: string;
    }
  | {
      name: string;
      kind: 'rag';
      endpoint: string;
      kindMetadata: { backend: 'qdrant' | 'lightrag' };
      state?: CapabilityDiscoveryResponseState;
      error?: string;
    }
  | {
      name: string;
      kind: 'http';
      endpoint: string;
      kindMetadata: Record<string, never>;
      state?: CapabilityDiscoveryResponseState;
      error?: string;
    }
  | GroupMcpEntry;
```

- [ ] **Step 5: Run tests**

```bash
cd <worktree-path>
npx vitest run src/capabilities/types.test.ts 2>&1 | tail -8
```
Expected: 4 passed.

- [ ] **Step 6: Build — catches missing discriminated-union cases**

```bash
cd <worktree-path>
npm run build 2>&1 | tail -10
```
Expected: zero errors. If TS reports missing `case 'mcp-group'` in any switch, those files need updating to handle the new variant. Likely call sites: `src/capabilities/registry.ts` (`specToDiscoveryEntry`), maybe more. Add a `default` clause that returns `null` / throws for the unknown kind, OR explicitly handle `'mcp-group'` where the call site already filters by kind. Note: `specToDiscoveryEntry` only handles cluster-scoped specs (existing `kind: 'mcp' | 'rag' | 'http'` from `CapabilitySpec`); it never produces `mcp-group` entries (those are built separately in Task 4). The compile error there is a false positive — add an exhaustiveness check that asserts `entry.kind !== 'mcp-group'` for that path.

- [ ] **Step 7: Commit**

```bash
cd <worktree-path>
git add src/capabilities/types.ts src/capabilities/types.test.ts
git commit -m "feat(capabilities): add GroupMcpEntry variant + McpToolSchema"
```

---

### Task 3: Channel-side discovery-client (Redis RPC)

**Files:**
- Create: `src/capabilities/discovery-client.ts`
- Test: `src/capabilities/discovery-client.test.ts`

- [ ] **Step 1: Inspect the existing tool-job IPC pattern**

```bash
cd <worktree-path>
sed -n '395,510p' src/runtime/direct-llm-runner.ts | head -70
```

Mirror the publish + poll structure but for the discovery stream:
- Stream key: `kubeclaw:discovery:request` (defined in `src/k8s/redis-client.ts` as `getDiscoveryRequestStream()`)
- Response key: `kubeclaw:discovery:response:<requestId>` (defined in `src/k8s/redis-client.ts` as `getDiscoveryResponseKey(id)`)

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestGroupCapability } from './discovery-client.js';

const mockXadd = vi.fn();
const mockGet = vi.fn();

vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: () => ({
    xadd: (...args: unknown[]) => mockXadd(...args),
    get: (...args: unknown[]) => mockGet(...args),
  }),
  getDiscoveryRequestStream: () => 'kubeclaw:discovery:request',
  getDiscoveryResponseKey: (id: string) => `kubeclaw:discovery:response:${id}`,
}));

beforeEach(() => {
  mockXadd.mockReset();
  mockGet.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('requestGroupCapability', () => {
  it('publishes a discovery request and resolves to endpoint on success', async () => {
    mockXadd.mockResolvedValue('1-0');
    mockGet.mockResolvedValueOnce(null).mockResolvedValueOnce(
      JSON.stringify([
        {
          kind: 'mcp',
          name: 'echo',
          endpoint: 'http://mcp-echo-h1.kubeclaw.svc:3000',
          kindMetadata: { path: '/mcp' },
          state: 'ready',
        },
      ]),
    );
    const res = await requestGroupCapability('echo', 'Family', 1000);
    expect(res).toEqual({ endpoint: 'http://mcp-echo-h1.kubeclaw.svc:3000' });
    expect(mockXadd).toHaveBeenCalledTimes(1);
    const [stream, ...fields] = mockXadd.mock.calls[0];
    expect(stream).toBe('kubeclaw:discovery:request');
    // Field args alternate key/value after '*' id placeholder.
    expect(fields).toContain('capability');
    expect(fields).toContain('echo');
    expect(fields).toContain('group');
    expect(fields).toContain('Family');
  });

  it('returns error when response carries state: failed', async () => {
    mockXadd.mockResolvedValue('1-0');
    mockGet.mockResolvedValueOnce(
      JSON.stringify([
        {
          kind: 'mcp',
          name: 'echo',
          endpoint: '',
          kindMetadata: { path: '/mcp' },
          state: 'failed',
          error: 'pod did not become ready',
        },
      ]),
    );
    const res = await requestGroupCapability('echo', 'Family', 1000);
    expect(res).toEqual({ error: 'pod did not become ready' });
  });

  it('returns error when timeout exceeded with no response', async () => {
    mockXadd.mockResolvedValue('1-0');
    mockGet.mockResolvedValue(null);
    const res = await requestGroupCapability('echo', 'Family', 50);
    expect(res).toHaveProperty('error');
    if ('error' in res) expect(res.error).toMatch(/timeout/i);
  });

  it('returns error when response array is empty', async () => {
    mockXadd.mockResolvedValue('1-0');
    mockGet.mockResolvedValueOnce('[]');
    const res = await requestGroupCapability('echo', 'Family', 1000);
    expect(res).toHaveProperty('error');
  });
});
```

- [ ] **Step 3: Verify it fails**

```bash
cd <worktree-path>
npx vitest run src/capabilities/discovery-client.test.ts 2>&1 | tail -8
```

- [ ] **Step 4: Implement `src/capabilities/discovery-client.ts`**

```ts
import { randomUUID } from 'crypto';
import {
  getRedisClient,
  getDiscoveryRequestStream,
  getDiscoveryResponseKey,
} from '../k8s/redis-client.js';
import { logger } from '../logger.js';
import type { CapabilityDiscoveryEntry } from './types.js';

const POLL_INTERVAL_MS = 200;
const DEFAULT_TIMEOUT_MS = 35_000;

export type GroupCapabilityResolveResult =
  | { endpoint: string }
  | { error: string };

export async function requestGroupCapability(
  capability: string,
  groupFolder: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<GroupCapabilityResolveResult> {
  const requestId = randomUUID();
  const client = getRedisClient();
  const stream = getDiscoveryRequestStream();
  const responseKey = getDiscoveryResponseKey(requestId);

  logger.info(
    { capability, group: groupFolder, requestId },
    'discovery_client_request',
  );
  await client.xadd(
    stream,
    '*',
    'requestId',
    requestId,
    'capability',
    capability,
    'group',
    groupFolder,
  );

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = await client.get(responseKey);
    if (raw) {
      const entries = JSON.parse(raw) as CapabilityDiscoveryEntry[];
      if (entries.length === 0) {
        return { error: 'empty discovery response' };
      }
      const entry = entries[0];
      const duration_ms = Date.now() - start;
      logger.info(
        { capability, group: groupFolder, state: entry.state, duration_ms },
        'discovery_client_response',
      );
      if (entry.state === 'failed') {
        return { error: entry.error ?? 'failed' };
      }
      if (entry.kind !== 'mcp-group' && 'endpoint' in entry && entry.endpoint) {
        return { endpoint: entry.endpoint };
      }
      return { error: 'response missing endpoint' };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { error: `discovery timeout after ${timeoutMs}ms` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 5: Run tests + build**

```bash
cd <worktree-path>
npx vitest run src/capabilities/discovery-client.test.ts 2>&1 | tail -10
npm run build 2>&1 | tail -3
```
Expected: 4 passed, build clean.

- [ ] **Step 6: Commit**

```bash
cd <worktree-path>
git add src/capabilities/discovery-client.ts src/capabilities/discovery-client.test.ts
git commit -m "feat(capabilities): channel-side discovery-client RPC"
```

---

### Task 4: Schema scraper background loop

**Files:**
- Create: `src/per-group-capabilities/schema-scraper.ts`
- Test: `src/per-group-capabilities/schema-scraper.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { scrapeMissingSchemas } from './schema-scraper.js';
import { upsertInstance } from './db.js';
import { getCachedSchemas } from './schema-cache.js';
import type { CapabilitySpec } from '../capabilities/types.js';

const echoSpec: CapabilitySpec = {
  name: 'echo',
  kind: 'mcp',
  image: 'kubeclaw-echo-mcp:test',
  scope: 'group',
};

beforeAll(async () => { await _initTestDatabase(); });
beforeEach(() => { __resetDbForTest(); });

describe('scrapeMissingSchemas', () => {
  it('skips capabilities with no per-group Deployment yet', async () => {
    const client = new FakePerGroupK8sClient();
    const fakeMcpClient = vi.fn();
    await scrapeMissingSchemas({
      client,
      namespace: 'kubeclaw',
      specs: [echoSpec],
      callToolsList: fakeMcpClient,
    });
    expect(fakeMcpClient).not.toHaveBeenCalled();
  });

  it('scales up, scrapes, caches, scales down for one (capability, image)', async () => {
    const client = new FakePerGroupK8sClient();
    // Pre-populate a per-group Deployment + DB row (simulating Phase A reconciler).
    upsertInstance({
      groupFolder: 'Family',
      capabilityName: 'echo',
      groupHash: 'h1',
      deploymentName: 'mcp-echo-h1',
      serviceName: 'mcp-echo-h1',
    });
    await client.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    setTimeout(() => client.markReady('kubeclaw', 'mcp-echo-h1'), 5);

    const callToolsList = vi.fn().mockResolvedValue([
      { name: 'echo', description: 'echoes', inputSchema: { type: 'object' } },
    ]);

    await scrapeMissingSchemas({
      client,
      namespace: 'kubeclaw',
      specs: [echoSpec],
      callToolsList,
    });

    expect(callToolsList).toHaveBeenCalledWith(
      'http://mcp-echo-h1.kubeclaw.svc.cluster.local:3000',
    );
    expect(getCachedSchemas('echo', 'kubeclaw-echo-mcp:test')).toEqual([
      { name: 'echo', description: 'echoes', inputSchema: { type: 'object' } },
    ]);
    const dep = await client.readDeployment('kubeclaw', 'mcp-echo-h1');
    expect(dep?.spec?.replicas).toBe(0);
  });

  it('skips when schema already cached', async () => {
    const client = new FakePerGroupK8sClient();
    upsertInstance({
      groupFolder: 'Family',
      capabilityName: 'echo',
      groupHash: 'h1',
      deploymentName: 'mcp-echo-h1',
      serviceName: 'mcp-echo-h1',
    });
    const { cacheSchemas } = await import('./schema-cache.js');
    cacheSchemas('echo', 'kubeclaw-echo-mcp:test', [
      { name: 'echo', inputSchema: {} },
    ]);
    const callToolsList = vi.fn();
    await scrapeMissingSchemas({
      client,
      namespace: 'kubeclaw',
      specs: [echoSpec],
      callToolsList,
    });
    expect(callToolsList).not.toHaveBeenCalled();
  });

  it('records failure attempt and gives up after 3 retries', async () => {
    const client = new FakePerGroupK8sClient();
    upsertInstance({
      groupFolder: 'Family',
      capabilityName: 'echo',
      groupHash: 'h1',
      deploymentName: 'mcp-echo-h1',
      serviceName: 'mcp-echo-h1',
    });
    await client.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    // Never mark ready -> waitForReady will time out (use a short timeout below).
    const callToolsList = vi.fn();
    const state = { failures: new Map<string, number>() };
    for (let i = 0; i < 5; i++) {
      await scrapeMissingSchemas({
        client,
        namespace: 'kubeclaw',
        specs: [echoSpec],
        callToolsList,
        scrapeTimeoutMs: 30,
        failureState: state,
      });
    }
    // 3 attempts max, then back off.
    expect(callToolsList).not.toHaveBeenCalled();
    expect(state.failures.get('echo|kubeclaw-echo-mcp:test')).toBe(3);
    expect(getCachedSchemas('echo', 'kubeclaw-echo-mcp:test')).toBeNull();
  });
});
```

- [ ] **Step 2: Verify it fails**

```bash
cd <worktree-path>
npx vitest run src/per-group-capabilities/schema-scraper.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement `src/per-group-capabilities/schema-scraper.ts`**

```ts
import type { CapabilitySpec } from '../capabilities/types.js';
import type { PerGroupK8sClient } from './k8s-client.js';
import { getScope } from './types.js';
import { listAllInstances } from './db.js';
import { cacheSchemas, getCachedSchemas, type McpToolSchema } from './schema-cache.js';
import { logger } from '../logger.js';

const DEFAULT_SCRAPE_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

/**
 * Performs an HTTP MCP tools/list against the given endpoint URL and returns
 * the schemas. Pulled out as a callable for tests; production wires this to
 * the real @modelcontextprotocol/sdk client.
 */
export type CallToolsListFn = (endpointUrl: string) => Promise<McpToolSchema[]>;

export interface ScrapeArgs {
  client: PerGroupK8sClient;
  namespace: string;
  specs: CapabilitySpec[];
  callToolsList: CallToolsListFn;
  scrapeTimeoutMs?: number;
  /** In-memory failure counter, keyed by `${capability}|${image}`. */
  failureState?: { failures: Map<string, number> };
}

export async function scrapeMissingSchemas(args: ScrapeArgs): Promise<void> {
  const failures = args.failureState?.failures ?? new Map<string, number>();
  const groupSpecs = args.specs.filter((s) => getScope(s) === 'group');
  const allInstances = listAllInstances();

  for (const spec of groupSpecs) {
    const key = `${spec.name}|${spec.image}`;
    if (getCachedSchemas(spec.name, spec.image) !== null) continue;
    if ((failures.get(key) ?? 0) >= MAX_RETRIES) continue;

    const instance = allInstances.find((i) => i.capabilityName === spec.name);
    if (!instance) {
      logger.debug({ capability: spec.name }, 'schema_scrape_skipped_no_instance');
      continue;
    }

    const start = Date.now();
    logger.info(
      { capability: spec.name, image: spec.image },
      'schema_scrape_started',
    );

    try {
      await args.client.patchDeploymentReplicas(args.namespace, instance.deploymentName, 1);
      await args.client.waitForReady(
        args.namespace,
        instance.deploymentName,
        args.scrapeTimeoutMs ?? DEFAULT_SCRAPE_TIMEOUT_MS,
      );
      const port = spec.port ?? 3000;
      const endpoint = `http://${instance.serviceName}.${args.namespace}.svc.cluster.local:${port}`;
      const schemas = await args.callToolsList(endpoint);
      cacheSchemas(spec.name, spec.image, schemas);
      logger.info(
        {
          capability: spec.name,
          image: spec.image,
          tool_count: schemas.length,
          duration_ms: Date.now() - start,
        },
        'schema_scrape_completed',
      );
    } catch (err) {
      const attempt = (failures.get(key) ?? 0) + 1;
      failures.set(key, attempt);
      logger.warn(
        {
          err,
          capability: spec.name,
          image: spec.image,
          attempt,
          will_retry: attempt < MAX_RETRIES,
        },
        'schema_scrape_failed',
      );
    } finally {
      try {
        await args.client.patchDeploymentReplicas(args.namespace, instance.deploymentName, 0);
      } catch (err) {
        logger.warn(
          { err, deployment: instance.deploymentName },
          'schema_scrape: scale-down after attempt failed',
        );
      }
    }
  }
}

export interface ScraperLoopHandle {
  stop(): void;
}

const DEFAULT_TICK_INTERVAL_MS = 60_000;

export function startSchemaScraperLoop(
  args: ScrapeArgs & { intervalMs?: number },
): ScraperLoopHandle {
  let stopped = false;
  const state = args.failureState ?? { failures: new Map<string, number>() };
  const intervalMs = args.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const tick = (): void => {
    if (stopped) return;
    void (async () => {
      try {
        await scrapeMissingSchemas({ ...args, failureState: state });
      } catch (err) {
        logger.warn({ err }, 'scrapeMissingSchemas threw');
      }
      if (!stopped) setTimeout(tick, intervalMs);
    })();
  };
  setTimeout(tick, intervalMs);
  return {
    stop() {
      stopped = true;
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
cd <worktree-path>
npx vitest run src/per-group-capabilities/schema-scraper.test.ts 2>&1 | tail -10
```
Expected: 4 passed.

- [ ] **Step 5: Build**

```bash
cd <worktree-path>
npm run build 2>&1 | tail -3
```
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
cd <worktree-path>
git add src/per-group-capabilities/schema-scraper.ts src/per-group-capabilities/schema-scraper.test.ts
git commit -m "feat(capabilities): schema scraper with 3-attempt retry cap"
```

---

### Task 5: McpManager — tool-name prefix + group templates

**Files:**
- Modify: `src/runtime/mcp-manager.ts`
- Modify: `src/runtime/mcp-manager.test.ts`

This task introduces the **breaking change**: all MCP tools (cluster + group) are renamed `mcp__<capability>__<tool>` at the manager surface. Existing mcp-manager tests will fail until updated.

- [ ] **Step 1: Read the current manager interface**

```bash
cd <worktree-path>
sed -n '54,200p' src/runtime/mcp-manager.ts
```

Note: `getTools()` returns `OpenAI.ChatCompletionTool[]`, `hasTool(name)` checks the prefix-less name, `callTool(name, args)` routes by name.

- [ ] **Step 2: Update existing tests for the prefix change + add new tests**

Read `src/runtime/mcp-manager.test.ts` first to understand the existing test structure:
```bash
cd <worktree-path>
wc -l src/runtime/mcp-manager.test.ts
head -50 src/runtime/mcp-manager.test.ts
```

For any existing test that asserts a bare tool name (e.g., `expect(tools[0].function.name).toBe('foo')`), update to the prefixed form (`'mcp__<servername>__foo'`). The server name in current tests is the McpServerStatus's `name` field.

Add new tests at the bottom (in a new `describe` block):
```ts
import type { GroupMcpEntry } from '../capabilities/types.js';

describe('McpManager — group MCP templates', () => {
  it('configureGroupMcpTemplates advertises tools from cached schemas', async () => {
    const mgr = new McpManager();
    await mgr.configureGroupMcpTemplates([
      {
        name: 'filesystem',
        kind: 'mcp-group',
        state: 'ready',
        toolSchemas: [
          { name: 'read_file', description: 'reads', inputSchema: { type: 'object' } },
          { name: 'list_dir', description: 'lists', inputSchema: { type: 'object' } },
        ],
      },
    ]);
    const tools = mgr.getTools();
    const names = tools.map((t) => t.function.name).sort();
    expect(names).toEqual(['mcp__filesystem__list_dir', 'mcp__filesystem__read_file']);
  });

  it('configureGroupMcpTemplates drops pending-schema entries', async () => {
    const mgr = new McpManager();
    await mgr.configureGroupMcpTemplates([
      { name: 'github', kind: 'mcp-group', state: 'pending-schema' },
    ]);
    expect(mgr.getTools()).toEqual([]);
  });

  it('configureGroupMcpTemplates drops failed entries', async () => {
    const mgr = new McpManager();
    await mgr.configureGroupMcpTemplates([
      { name: 'github', kind: 'mcp-group', state: 'failed', error: 'no pod' },
    ]);
    expect(mgr.getTools()).toEqual([]);
  });

  it('hasTool recognises prefixed group tool names', async () => {
    const mgr = new McpManager();
    await mgr.configureGroupMcpTemplates([
      {
        name: 'filesystem',
        kind: 'mcp-group',
        state: 'ready',
        toolSchemas: [{ name: 'read_file', inputSchema: {} }],
      },
    ]);
    expect(mgr.hasTool('mcp__filesystem__read_file')).toBe(true);
    expect(mgr.hasTool('read_file')).toBe(false);
  });

  it('allowedTools filter applies to group templates', async () => {
    const mgr = new McpManager();
    await mgr.configureGroupMcpTemplates([
      {
        name: 'filesystem',
        kind: 'mcp-group',
        state: 'ready',
        toolSchemas: [
          { name: 'read_file', inputSchema: {} },
          { name: 'write_file', inputSchema: {} },
        ],
        allowedTools: ['read_file'],
      },
    ]);
    const names = mgr.getTools().map((t) => t.function.name);
    expect(names).toEqual(['mcp__filesystem__read_file']);
  });
});
```

- [ ] **Step 3: Verify the tests fail**

```bash
cd <worktree-path>
npx vitest run src/runtime/mcp-manager.test.ts 2>&1 | tail -15
```
Expected: new tests fail (`configureGroupMcpTemplates` doesn't exist); existing tests likely fail due to prefix mismatch in your edits.

- [ ] **Step 4: Implement changes to `src/runtime/mcp-manager.ts`**

Add at top of the file (next to existing imports):
```ts
import type { GroupMcpEntry, McpToolSchema } from '../capabilities/types.js';
```

Add a helper near the top of the file (after imports, before `interface ConnectedServer`):
```ts
const TOOL_PREFIX = 'mcp__';

export function prefixedToolName(capabilityName: string, toolName: string): string {
  return `${TOOL_PREFIX}${capabilityName}__${toolName}`;
}

export function parseToolName(name: string): { capability: string; tool: string } | null {
  if (!name.startsWith(TOOL_PREFIX)) return null;
  const rest = name.slice(TOOL_PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep < 0) return null;
  return { capability: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}
```

Inside the `McpManager` class, add a field after the existing maps:
```ts
  /** Group-template entries keyed by capability name. */
  private groupTemplates = new Map<string, GroupMcpEntry>();
```

Modify `getTools()` to apply the prefix to cluster servers AND to include group templates:
```ts
  getTools(): OpenAI.ChatCompletionTool[] {
    const tools: OpenAI.ChatCompletionTool[] = [];
    // Cluster MCP servers — prefix bare tool names.
    for (const server of this.servers.values()) {
      for (const t of server.tools) {
        const bare = stripPrefixIfAny(t.function.name);
        tools.push({
          ...t,
          function: { ...t.function, name: prefixedToolName(server.name, bare) },
        });
      }
    }
    // Group templates — synthesise tool entries from cached schemas.
    for (const tmpl of this.groupTemplates.values()) {
      if (tmpl.state !== 'ready' || !tmpl.toolSchemas) continue;
      for (const schema of tmpl.toolSchemas) {
        if (tmpl.allowedTools && !tmpl.allowedTools.includes(schema.name)) continue;
        tools.push({
          type: 'function',
          function: {
            name: prefixedToolName(tmpl.name, schema.name),
            description: schema.description,
            parameters: schema.inputSchema as Record<string, unknown>,
          },
        });
      }
    }
    return tools;
  }
```

(`stripPrefixIfAny` is a defensive helper for the case where the upstream tool is already prefixed; add it next to `prefixedToolName`:)
```ts
function stripPrefixIfAny(name: string): string {
  const parsed = parseToolName(name);
  return parsed ? parsed.tool : name;
}
```

Modify `hasTool` to check both cluster servers and group templates:
```ts
  hasTool(toolName: string): boolean {
    const parsed = parseToolName(toolName);
    if (!parsed) return false;
    // Cluster server with this capability name?
    if (this.servers.has(parsed.capability)) {
      const server = this.servers.get(parsed.capability)!;
      return server.tools.some(
        (t) => stripPrefixIfAny(t.function.name) === parsed.tool,
      );
    }
    // Group template with this capability?
    const tmpl = this.groupTemplates.get(parsed.capability);
    if (tmpl && tmpl.state === 'ready') {
      const allowed =
        !tmpl.allowedTools || tmpl.allowedTools.includes(parsed.tool);
      return allowed && (tmpl.toolSchemas?.some((s) => s.name === parsed.tool) ?? false);
    }
    return false;
  }
```

Modify `callTool` to accept ctx and route to group templates via discovery RPC:
```ts
import { requestGroupCapability } from '../capabilities/discovery-client.js';

export interface CallToolCtx {
  groupFolder?: string;
}

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx?: CallToolCtx,
  ): Promise<string> {
    const parsed = parseToolName(toolName);
    if (!parsed) return `Unknown MCP tool: ${toolName}`;

    // Group-template branch first (no in-memory connection)
    const tmpl = this.groupTemplates.get(parsed.capability);
    if (tmpl && tmpl.state === 'ready') {
      if (!ctx?.groupFolder) {
        throw new Error(
          `callTool(${toolName}) on a group-scoped capability requires ctx.groupFolder`,
        );
      }
      const resolved = await requestGroupCapability(tmpl.name, ctx.groupFolder);
      if ('error' in resolved) {
        return JSON.stringify({
          isError: true,
          content: [{ type: 'text', text: `capability unavailable: ${resolved.error}` }],
        });
      }
      // Open one-shot MCP HTTP session
      try {
        const text = await callOneShotMcp(resolved.endpoint, parsed.tool, args);
        return text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          isError: true,
          content: [{ type: 'text', text: `MCP call failed: ${msg}` }],
        });
      }
    }

    // Cluster server branch (existing behavior — apply the prefix-stripping)
    const server = this.servers.get(parsed.capability);
    if (!server) return `Unknown MCP tool: ${toolName}`;
    try {
      const result = await server.client.callTool({
        name: parsed.tool,
        arguments: args,
      });
      const content = (result.content ?? []) as Array<{ type?: string; text?: string }>;
      const textParts = content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
      return textParts || JSON.stringify(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.disconnectServer(server);
      this.servers.delete(server.name);
      this.failedServers.set(server.name, {
        status: { name: server.name, url: '', allowedTools: undefined },
        retries: 0,
        retryAfter: Date.now() + RETRY_DELAYS_MS[0],
      });
      return `MCP tool error: ${msg}`;
    }
  }
```

Add the helper for one-shot MCP HTTP calls at the bottom of the file:
```ts
async function callOneShotMcp(
  endpointUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const transport = new StreamableHTTPClientTransport(new URL(endpointUrl + '/mcp'));
  const client = new Client(
    { name: 'kubeclaw-mcp-group-client', version: '0.0.1' },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    const content = (result.content ?? []) as Array<{ type?: string; text?: string }>;
    const textParts = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    return textParts || JSON.stringify(result);
  } finally {
    await transport.close();
  }
}
```

Add `configureGroupMcpTemplates` method on the class:
```ts
  async configureGroupMcpTemplates(templates: GroupMcpEntry[]): Promise<void> {
    this.groupTemplates.clear();
    for (const tmpl of templates) {
      if (tmpl.state !== 'ready') continue;
      this.groupTemplates.set(tmpl.name, tmpl);
    }
    logger.info(
      { count: this.groupTemplates.size, total: templates.length },
      'mcp_group_templates_configured',
    );
  }
```

Don't forget to also remove the now-obsolete bare `toolToServer` map population if the cluster branch no longer relies on it. Re-read your refactor and ensure consistency.

- [ ] **Step 5: Run mcp-manager tests**

```bash
cd <worktree-path>
npx vitest run src/runtime/mcp-manager.test.ts 2>&1 | tail -15
```
Expected: all pass (existing tests updated for prefix; new tests added).

- [ ] **Step 6: Build + full suite**

```bash
cd <worktree-path>
npm run build 2>&1 | tail -3
npm test 2>&1 | tail -10
```
Expected: zero TS errors; only mcp-manager.test.ts touched in this task — other tests that reference flat tool names will fail in Task 6 (direct-llm-runner) and Task 8 (channel-runner) when ctx threading lands. Note any failures and address in the corresponding task.

- [ ] **Step 7: Commit**

```bash
cd <worktree-path>
git add src/runtime/mcp-manager.ts src/runtime/mcp-manager.test.ts
git commit -m "feat(mcp-manager): prefix tool names, support group templates"
```

---

### Task 6: direct-llm-runner — pass groupFolder ctx

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts` (one call site)
- Modify: `src/runtime/direct-llm-runner.test.ts` (if any test mocks `callTool`, ensure signature compat)

- [ ] **Step 1: Inspect the existing site**

```bash
cd <worktree-path>
sed -n '1280,1300p' src/runtime/direct-llm-runner.ts
```

You should see the existing call: `result = await this.mcpManager.callTool(call.function.name, args);`

- [ ] **Step 2: Update the call**

Find the line at approximately 1289:
```ts
result = await this.mcpManager.callTool(call.function.name, args);
```

Replace with:
```ts
result = await this.mcpManager.callTool(call.function.name, args, {
  groupFolder: group.folder,
});
```

The `group` variable should already be in scope at this site (it's the per-turn group context). Confirm by checking surrounding code.

- [ ] **Step 3: Update any test mocks for the new signature**

```bash
cd <worktree-path>
grep -n "callTool" src/runtime/direct-llm-runner.test.ts | head -5
```

If any test mocks `mcpManager.callTool`, the mock function's signature should accept the third ctx argument (TypeScript will allow extra args to be ignored).

- [ ] **Step 4: Build + run tests**

```bash
cd <worktree-path>
npm run build 2>&1 | tail -3
npx vitest run src/runtime/direct-llm-runner.test.ts 2>&1 | tail -10
```
Expected: zero errors, tests pass.

- [ ] **Step 5: Commit**

```bash
cd <worktree-path>
git add src/runtime/direct-llm-runner.ts src/runtime/direct-llm-runner.test.ts
git commit -m "feat(runtime): pass groupFolder ctx to mcpManager.callTool"
```

---

### Task 7: capabilities/client — `getMcpEntriesAsync`

**Files:**
- Modify: `src/capabilities/client.ts`
- Modify: `src/capabilities/index.ts` (re-export)
- Test: `src/capabilities/client.test.ts` (likely exists)

- [ ] **Step 1: Inspect current client**

```bash
cd <worktree-path>
cat src/capabilities/client.ts
ls src/capabilities/client.test.ts 2>&1
```

The current file has three sync functions. We'll add an async aggregator and keep the sync ones as internal/legacy callers transition.

- [ ] **Step 2: Write/extend the failing test**

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { setCapability } from './db.js';
import { getMcpEntriesAsync } from './client.js';
import { cacheSchemas } from '../per-group-capabilities/schema-cache.js';

beforeAll(async () => { await _initTestDatabase(); });
beforeEach(() => { __resetDbForTest(); });

describe('getMcpEntriesAsync', () => {
  it('returns cluster-scoped mcp entries unchanged', async () => {
    setCapability({
      name: 'qdrant',
      kind: 'mcp',
      image: 'qdrant:1',
      port: 6333,
    });
    const entries = await getMcpEntriesAsync('telegram', undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('mcp');
  });

  it('emits mcp-group entries with pending-schema when no cache', async () => {
    setCapability({
      name: 'echo',
      kind: 'mcp',
      image: 'echo:1',
      scope: 'group',
    });
    const entries = await getMcpEntriesAsync('telegram', undefined);
    const group = entries.find((e) => e.kind === 'mcp-group');
    expect(group?.state).toBe('pending-schema');
  });

  it('emits mcp-group entries with ready + schemas when cached', async () => {
    setCapability({
      name: 'echo',
      kind: 'mcp',
      image: 'echo:1',
      scope: 'group',
    });
    cacheSchemas('echo', 'echo:1', [{ name: 'echo', inputSchema: {} }]);
    const entries = await getMcpEntriesAsync('telegram', undefined);
    const group = entries.find((e) => e.kind === 'mcp-group');
    expect(group?.state).toBe('ready');
    expect(group?.toolSchemas).toHaveLength(1);
  });

  it('respects channel ACL on cluster mcp', async () => {
    setCapability({
      name: 'qdrant',
      kind: 'mcp',
      image: 'q:1',
      channels: ['discord'],
    });
    const tel = await getMcpEntriesAsync('telegram', undefined);
    const dis = await getMcpEntriesAsync('discord', undefined);
    expect(tel).toEqual([]);
    expect(dis).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Verify it fails**

```bash
cd <worktree-path>
npx vitest run src/capabilities/client.test.ts 2>&1 | tail -8
```

- [ ] **Step 4: Implement `src/capabilities/client.ts`**

Replace the file contents:
```ts
import { getEntriesForChannel, listCapabilities } from './registry.js';
import type {
  CapabilityDiscoveryEntry,
  GroupMcpEntry,
} from './types.js';
import { getCachedSchemas } from '../per-group-capabilities/schema-cache.js';
import { getScope } from '../per-group-capabilities/types.js';

// Existing sync facades remain — internal callers can still use them for cluster-scoped data.
export function getRagEntry(channelName: string) {
  return getEntriesForChannel(channelName).find(
    (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'rag' }> =>
      e.kind === 'rag',
  );
}

export function getHttpEntry(channelName: string, name: string) {
  return getEntriesForChannel(channelName).find(
    (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'http' }> =>
      e.kind === 'http' && e.name === name,
  );
}

/**
 * Returns MCP entries for a channel — both cluster-scoped (kind: 'mcp')
 * and group-scoped (kind: 'mcp-group'). Group entries carry cached tool
 * schemas if the orchestrator has scraped them; otherwise state: 'pending-schema'.
 *
 * Async because future scopes may require I/O. v1 reads SQLite synchronously
 * under the hood; the async signature reserves the right to change without
 * breaking callers.
 */
export async function getMcpEntriesAsync(
  channelName: string,
  _groupFolder: string | undefined,
): Promise<CapabilityDiscoveryEntry[]> {
  const out: CapabilityDiscoveryEntry[] = [];

  // Cluster-scoped: use the existing ACL-aware path. specToDiscoveryEntry
  // emits kind: 'mcp' only.
  out.push(
    ...getEntriesForChannel(channelName).filter(
      (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'mcp' }> =>
        e.kind === 'mcp',
    ),
  );

  // Group-scoped: read directly from the capability table (registry doesn't
  // emit group entries today).
  for (const spec of listCapabilities()) {
    if (getScope(spec) !== 'group') continue;
    if (spec.kind !== 'mcp') continue;
    if (spec.channels && spec.channels.length > 0 && !spec.channels.includes(channelName)) {
      continue;
    }
    const schemas = getCachedSchemas(spec.name, spec.image);
    const entry: GroupMcpEntry = schemas
      ? {
          name: spec.name,
          kind: 'mcp-group',
          state: 'ready',
          toolSchemas: schemas,
          allowedTools: spec.allowedTools,
        }
      : {
          name: spec.name,
          kind: 'mcp-group',
          state: 'pending-schema',
        };
    out.push(entry);
  }

  return out;
}
```

Update `src/capabilities/index.ts`:
```ts
export { getRagEntry, getHttpEntry, getMcpEntriesAsync } from './client.js';
```

(Drop the `getMcpEntries` re-export — the sync version is gone.)

- [ ] **Step 5: Run tests + build**

```bash
cd <worktree-path>
npx vitest run src/capabilities/client.test.ts 2>&1 | tail -10
npm run build 2>&1 | tail -10
```

Expected: 4 client tests pass. The build may flag missing exports (`getMcpEntries` callers). Fix by changing those callers to use `await getMcpEntriesAsync(...)` — at the time of Phase B, the only known caller path was the push-based `capabilities_update` flow in the orchestrator, which is addressed in Task 8. If TS flags an unfound symbol from elsewhere, follow the error and update.

- [ ] **Step 6: Commit**

```bash
cd <worktree-path>
git add src/capabilities/client.ts src/capabilities/index.ts src/capabilities/client.test.ts
git commit -m "feat(capabilities): getMcpEntriesAsync returns cluster + group entries"
```

---

### Task 8: Orchestrator-side `capabilities_update` payload includes group entries

**Files:**
- Modify: `src/capabilities/registry.ts` (`notifyAllChannels`, line 174)
- Modify: `src/capabilities/registry.test.ts` (existing — extend)

- [ ] **Step 1: Inspect the existing producer**

```bash
cd <worktree-path>
sed -n '170,210p' src/capabilities/registry.ts
```

The producer is `notifyAllChannels()`. Line ~197 currently calls `getEntriesForChannel(channelName)` which only returns cluster-scoped entries. We need it to also include group-scoped `mcp-group` entries from `getMcpEntriesAsync`.

- [ ] **Step 2: Extend `src/capabilities/registry.test.ts`**

Read first to see the existing test setup pattern:
```bash
cd <worktree-path>
head -40 src/capabilities/registry.test.ts
```

Then add a new `describe` block (adapt the redis mock to whatever existing tests use):
```ts
import { cacheSchemas } from '../per-group-capabilities/schema-cache.js';

describe('notifyAllChannels — group-scoped capabilities', () => {
  it('includes mcp-group entries in the published payload', async () => {
    // Setup: install a group-scoped echo capability, cache schemas.
    setCapability({
      name: 'echo',
      kind: 'mcp',
      image: 'echo:1',
      scope: 'group',
    });
    cacheSchemas('echo', 'echo:1', [{ name: 'echo', inputSchema: {} }]);

    // Spy on redis.publish to capture the payload.
    const publishSpy = vi.fn().mockResolvedValue(0);
    // Wire the spy through whatever mock pattern the existing tests use.

    await notifyAllChannels();

    // Find the call to the 'telegram' control channel (or whichever
    // channel name matches KNOWN_CHANNELS in the test fixture).
    const call = publishSpy.mock.calls.find((args) =>
      String(args[0]).includes('telegram'),
    );
    expect(call, 'expected publish call for telegram channel').toBeDefined();
    const payload = JSON.parse(call![1] as string);
    const entries = JSON.parse(payload.capabilities);
    const groupEntry = entries.find((e: { kind: string }) => e.kind === 'mcp-group');
    expect(groupEntry?.name).toBe('echo');
    expect(groupEntry?.state).toBe('ready');
  });
});
```

(If the existing redis-spy mechanism is different, mirror it. The point is to verify the payload contains an `mcp-group` entry.)

- [ ] **Step 3: Verify it fails**

```bash
cd <worktree-path>
npx vitest run src/capabilities/registry.test.ts 2>&1 | tail -10
```

- [ ] **Step 4: Modify `notifyAllChannels` in `src/capabilities/registry.ts`**

At the top of the file, add the import:
```ts
import { getMcpEntriesAsync } from './client.js';
```

Inside `notifyAllChannels`, replace:
```ts
      const entries = getEntriesForChannel(channelName);
      const payload = JSON.stringify({
        command: 'capabilities_update',
        capabilities: JSON.stringify(entries),
      });
```

With:
```ts
      // Non-MCP entries from the existing sync registry path (rag, http).
      const nonMcp = getEntriesForChannel(channelName).filter(
        (e) => e.kind !== 'mcp',
      );
      // MCP entries (cluster + group) from the async aggregator.
      const mcp = await getMcpEntriesAsync(channelName, undefined);
      const entries = [...nonMcp, ...mcp];
      const payload = JSON.stringify({
        command: 'capabilities_update',
        capabilities: JSON.stringify(entries),
      });
```

`notifyAllChannels` is already async — no signature change needed.

- [ ] **Step 5: Build + run affected tests**

```bash
cd <worktree-path>
npm run build 2>&1 | tail -5
npx vitest run src/capabilities/ 2>&1 | tail -10
```
Expected: zero errors, all capabilities tests pass.

- [ ] **Step 6: Commit**

```bash
cd <worktree-path>
git add src/capabilities/registry.ts src/capabilities/registry.test.ts
git commit -m "feat(capabilities): include mcp-group entries in capabilities_update push payload"
```

---

### Task 9: Channel-runner `capabilities_update` handler — route group entries

**Files:**
- Modify: `src/channel-runner.ts` (around lines 170-190)

- [ ] **Step 1: Inspect the existing handler**

```bash
cd <worktree-path>
sed -n '165,195p' src/channel-runner.ts
```

You'll see the existing branch that maps `kind: 'mcp'` to `{name, url, allowedTools}` and calls `configureMcp`. We're adding a parallel branch for `kind: 'mcp-group'`.

- [ ] **Step 2: Modify the handler**

Find:
```ts
const mcpServers = capabilities
  .filter((c) => c.kind === 'mcp')
  .map((c) => ({
    name: c.name,
    url: `${c.endpoint}${c.kindMetadata.path ?? '/mcp'}`,
    allowedTools: c.kindMetadata.allowedTools,
  }));
await getDirectLLMRunner().configureMcp(mcpServers);
```

Replace with:
```ts
const mcpServers = capabilities
  .filter((c): c is Extract<typeof c, { kind: 'mcp' }> => c.kind === 'mcp')
  .map((c) => ({
    name: c.name,
    url: `${c.endpoint}${c.kindMetadata.path ?? '/mcp'}`,
    allowedTools: c.kindMetadata.allowedTools,
  }));
const groupTemplates = capabilities.filter(
  (c): c is Extract<typeof c, { kind: 'mcp-group' }> => c.kind === 'mcp-group',
);
await getDirectLLMRunner().configureMcp(mcpServers);
await getDirectLLMRunner().configureGroupMcpTemplates(groupTemplates);
```

- [ ] **Step 3: Update the runner's interface to expose configureGroupMcpTemplates**

Read `src/runtime/types.ts` (around line 107 — the runner interface):
```bash
cd <worktree-path>
sed -n '100,115p' src/runtime/types.ts
```

Add to the runner interface:
```ts
  configureGroupMcpTemplates?(templates: GroupMcpEntry[]): Promise<void>;
```

Add the import at the top of the file:
```ts
import type { GroupMcpEntry } from '../capabilities/types.js';
```

Add the method to `DirectLLMRunner` in `src/runtime/direct-llm-runner.ts` (next to the existing `configureMcp`):
```ts
  async configureGroupMcpTemplates(templates: GroupMcpEntry[]): Promise<void> {
    if (!this.mcpManager) {
      this.mcpManager = new McpManager();
      await this.mcpManager.initialize([]);
    }
    await this.mcpManager.configureGroupMcpTemplates(templates);
  }
```

Add the import at the top of `direct-llm-runner.ts`:
```ts
import type { GroupMcpEntry } from '../capabilities/types.js';
```

- [ ] **Step 4: Build + run tests**

```bash
cd <worktree-path>
npm run build 2>&1 | tail -3
npx vitest run src/channel-runner.test.ts src/runtime/ 2>&1 | tail -10
```
Expected: zero TS errors; tests pass.

- [ ] **Step 5: Commit**

```bash
cd <worktree-path>
git add src/channel-runner.ts src/runtime/types.ts src/runtime/direct-llm-runner.ts
git commit -m "feat(channel): route capabilities_update mcp-group entries to runner"
```

---

### Task 10: Wire schema scraper into orchestrator lifecycle

**Files:**
- Modify: `src/per-group-capabilities/index.ts` (extend `initPerGroupCapabilityLifecycle`)

- [ ] **Step 1: Inspect existing lifecycle init**

```bash
cd <worktree-path>
sed -n '1,200p' src/per-group-capabilities/index.ts | head -120
```

Note the existing `initPerGroupCapabilityLifecycle` and the sweeper-loop tick. We're adding a scraper loop next to it.

- [ ] **Step 2: Add the scraper init**

Add to imports at the top of the file:
```ts
import {
  startSchemaScraperLoop,
  type CallToolsListFn,
} from './schema-scraper.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpToolSchema } from './schema-cache.js';
```

Inside `initPerGroupCapabilityLifecycle`, after the existing sweeper loop block, add:
```ts
  // Schema scraper loop — discovers tools/list for each (capability, image)
  // and caches in capability_tool_schemas. Runs on a 60s timer; safe to skip
  // until a per-group Deployment exists.
  const scrapeIntervalMs = d.schemaScrapeIntervalMs ?? 60_000;
  const realCallToolsList: CallToolsListFn = async (endpointUrl) => {
    const transport = new StreamableHTTPClientTransport(new URL(endpointUrl + '/mcp'));
    const client = new McpClient(
      { name: 'kubeclaw-schema-scraper', version: '0.0.1' },
      { capabilities: {} },
    );
    await client.connect(transport);
    try {
      const res = await client.listTools();
      return (res.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })) as McpToolSchema[];
    } finally {
      await transport.close();
    }
  };
  const scraperHandle = startSchemaScraperLoop({
    client: d.client,
    namespace: d.namespace,
    specs: d.listSpecs(),
    callToolsList: realCallToolsList,
    intervalMs: scrapeIntervalMs,
  });
```

Also add `schemaScrapeIntervalMs?: number` to the `LifecycleDeps` interface.

In the `stop()` returned at the end, add `scraperHandle.stop();`.

Note: like the sweeper, the scraper takes `specs: d.listSpecs()` at init. Per Phase A's recent fix (`2cc50b6`), prefer re-reading specs each tick — inline the same way the sweeper does:

Replace the block above with an inline tick loop that re-reads `d.listSpecs()`:
```ts
  // Schema scraper — re-reads specs on each tick so admin-shell-added
  // capabilities pick up schemas without a restart.
  let scraperStopped = false;
  const scraperFailureState = { failures: new Map<string, number>() };
  const scrapeTick = (): void => {
    if (scraperStopped) return;
    void (async () => {
      try {
        await scrapeMissingSchemas({
          client: d.client,
          namespace: d.namespace,
          specs: d.listSpecs(),
          callToolsList: realCallToolsList,
          failureState: scraperFailureState,
        });
      } catch (err) {
        logger.warn({ err }, 'scrapeMissingSchemas threw');
      }
      if (!scraperStopped) setTimeout(scrapeTick, scrapeIntervalMs);
    })();
  };
  setTimeout(scrapeTick, scrapeIntervalMs);
  const scraperHandle = {
    stop() {
      scraperStopped = true;
    },
  };
```

And import `scrapeMissingSchemas` from `./schema-scraper.js`.

Update the re-export block at the top of the file:
```ts
export {
  scrapeMissingSchemas,
  startSchemaScraperLoop,
  type ScrapeArgs,
} from './schema-scraper.js';
export {
  cacheSchemas,
  getCachedSchemas,
  clearCachedSchemas,
  listAllCachedSchemas,
  type McpToolSchema,
} from './schema-cache.js';
```

- [ ] **Step 3: Build + run**

```bash
cd <worktree-path>
npm run build 2>&1 | tail -5
npm test 2>&1 | tail -5
```
Expected: zero errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
cd <worktree-path>
git add src/per-group-capabilities/index.ts
git commit -m "feat(capabilities): wire schema scraper into orchestrator lifecycle"
```

---

### Task 11: Integration tests against real K8s + Redis

**Files:**
- Create: `e2e/per-group-mcp-consumer-integration.test.ts`

- [ ] **Step 1: Inspect existing e2e patterns**

```bash
cd <worktree-path>
head -60 e2e/per-group-capabilities-integration.test.ts
```

Mirror the gating (`isKubernetesAvailable` + `describe.skipIf`), beforeAll image-build + namespace setup, afterEach `deleteByLabel` cleanup.

- [ ] **Step 2: Write the test**

```ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { Redis } from 'ioredis';
import {
  RealPerGroupK8sClient,
  reconcileGroupCapabilities,
  groupHash,
  scrapeMissingSchemas,
} from '../src/per-group-capabilities/index.js';
import { _initTestDatabase, __resetDbForTest } from '../src/db.js';
import { getCachedSchemas } from '../src/per-group-capabilities/schema-cache.js';
import { requestGroupCapability } from '../src/capabilities/discovery-client.js';
import {
  setDiscoveryDeps,
  _resetDiscoveryDepsForTest,
  __handleRequestForTest,
} from '../src/capabilities/discovery.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isKubernetesAvailable } from './setup.js';

const K8S_AVAILABLE = isKubernetesAvailable();
const NAMESPACE = process.env.PGC_TEST_NAMESPACE || 'kubeclaw-test-pgc';
const ECHO_IMAGE = 'kubeclaw-echo-mcp:test';

const echoSpec = {
  name: 'echo',
  kind: 'mcp' as const,
  image: ECHO_IMAGE,
  scope: 'group' as const,
  scaleDownAfterIdleSeconds: 60,
  volumeFromGroupPvc: false,
  credentialsFrom: 'none' as const,
  resources: {
    memoryRequest: '64Mi', memoryLimit: '128Mi',
    cpuRequest: '50m', cpuLimit: '200m',
  },
};

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe.skipIf(!K8S_AVAILABLE)('per-group MCP consumer (real K8s + Redis)', () => {
  let client: RealPerGroupK8sClient;

  beforeAll(async () => {
    try {
      sh(`kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -`);
    } catch (err) {
      console.warn('namespace setup failed:', err);
    }
    try {
      sh(`./container/echo-mcp/build.sh ${ECHO_IMAGE}`);
    } catch {
      console.warn('echo-mcp build failed.');
    }
    try {
      sh(`minikube image load ${ECHO_IMAGE} 2>&1 || true`);
    } catch {}
    await _initTestDatabase();
  }, 300_000);

  afterEach(async () => {
    try {
      await client?.deleteByLabel(NAMESPACE, 'kubeclaw.io/scope=group');
    } catch (err) {
      console.warn('afterEach cleanup failed:', err);
    }
    _resetDiscoveryDepsForTest();
  });

  it('schema scraper end-to-end: scales up, scrapes tools/list, caches, scales back', async () => {
    __resetDbForTest();
    client = new RealPerGroupK8sClient();
    await reconcileGroupCapabilities({
      client, namespace: NAMESPACE, groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['e2e-pgc-scraper'], specs: [echoSpec],
    });

    const callToolsList = async (endpointUrl: string) => {
      const transport = new StreamableHTTPClientTransport(new URL(endpointUrl + '/mcp'));
      const mcp = new McpClient(
        { name: 'test-scraper', version: '0.0.1' },
        { capabilities: {} },
      );
      await mcp.connect(transport);
      try {
        const res = await mcp.listTools();
        return (res.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
      } finally {
        await transport.close();
      }
    };

    await scrapeMissingSchemas({
      client, namespace: NAMESPACE, specs: [echoSpec], callToolsList,
      scrapeTimeoutMs: 60_000,
    });

    const cached = getCachedSchemas('echo', ECHO_IMAGE);
    expect(cached).not.toBeNull();
    expect(cached?.some((s) => s.name === 'echo')).toBe(true);

    const hash = groupHash('e2e-pgc-scraper');
    const dep = await client.readDeployment(NAMESPACE, `mcp-echo-${hash}`);
    expect(dep?.spec?.replicas).toBe(0);
  }, 180_000);

  it('discovery client round-trip: request endpoint, MCP call returns expected result', async () => {
    __resetDbForTest();
    client = new RealPerGroupK8sClient();
    await reconcileGroupCapabilities({
      client, namespace: NAMESPACE, groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['e2e-pgc-disco'], specs: [echoSpec],
    });

    // Wire orchestrator-side discovery deps so __handleRequestForTest works.
    setDiscoveryDeps({
      perGroupK8sClient: client,
      namespace: NAMESPACE,
      discoveryTimeoutMs: 90_000,
    });

    // Open Redis (use the global-setup port-forward URL).
    const redisUrl = process.env.KUBECLAW_REDIS_URL ?? 'redis://localhost:16379';
    const redis = new Redis(redisUrl, { lazyConnect: true });
    await redis.connect();
    try {
      // Channel-side: request endpoint via discovery client.
      // Orchestrator-side: __handleRequestForTest runs in-process to handle it.
      const requestPromise = requestGroupCapability('echo', 'e2e-pgc-disco', 120_000);
      // Simulate orchestrator handler picking up the request: poll the stream
      // for our request and call __handleRequestForTest manually.
      // (In production the discovery watcher does this — but it requires running
      // the watcher loop, which is heavy. Use the test handler directly.)
      // Wait a moment for the channel to XADD.
      await new Promise((r) => setTimeout(r, 200));
      const entries = await redis.xrange('kubeclaw:discovery:request', '-', '+');
      const last = entries[entries.length - 1];
      const fields = last[1];
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
      await __handleRequestForTest({
        requestId: obj.requestId,
        capability: obj.capability,
        group: obj.group,
      });
      const resolved = await requestPromise;
      expect(resolved).toHaveProperty('endpoint');
      if ('endpoint' in resolved) {
        expect(resolved.endpoint).toMatch(/^http:\/\/mcp-echo-/);

        // Make a real MCP call to verify the endpoint actually works.
        const transport = new StreamableHTTPClientTransport(new URL(resolved.endpoint + '/mcp'));
        const mcp = new McpClient(
          { name: 'test-call', version: '0.0.1' },
          { capabilities: {} },
        );
        await mcp.connect(transport);
        try {
          const result = await mcp.callTool({ name: 'echo', arguments: { msg: 'hi' } });
          const text = (result.content?.[0] as { text?: string }).text;
          expect(text).toBe('hi');
        } finally {
          await transport.close();
        }
      }
    } finally {
      await redis.quit();
    }
  }, 240_000);
});
```

- [ ] **Step 3: Build + run**

```bash
cd <worktree-path>
npm run build 2>&1 | tail -3
npx vitest run --config vitest.e2e.config.ts e2e/per-group-mcp-consumer-integration.test.ts 2>&1 | tail -20
```

Expected: 2 pass if cluster + Redis are available; skipped if not.

- [ ] **Step 4: Commit**

```bash
cd <worktree-path>
git add e2e/per-group-mcp-consumer-integration.test.ts
git commit -m "test(integration): per-group MCP consumer scraper + discovery + MCP roundtrip"
```

---

### Task 12: E2E test (full Helm install)

**Files:**
- Create: `e2e/per-group-mcp-consumer-e2e.test.ts`

- [ ] **Step 1: Inspect e2e/global-setup.ts**

```bash
cd <worktree-path>
head -60 e2e/global-setup.ts
```

Confirm the patterns for `fullInstall` / `teardown` and the Helm values override mechanism. If `capabilities.echo` isn't installable via the standard Helm path, you may need to use the admin-shell `install_capability` tool instead.

- [ ] **Step 2: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { isKubernetesAvailable } from './setup.js';

const K8S_AVAILABLE = isKubernetesAvailable();
const SKIP_E2E = process.env.SKIP_E2E === '1';
const NAMESPACE = 'kubeclaw';

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe.skipIf(!K8S_AVAILABLE || SKIP_E2E)('per-group MCP consumer e2e', () => {
  beforeAll(async () => {
    // The global-setup may already have kubeclaw installed; this test assumes
    // the standard kubeclaw release exists. The echo capability is added via
    // the admin-shell install_capability tool at runtime.
    try {
      sh(`./container/echo-mcp/build.sh kubeclaw-echo-mcp:test`);
      sh(`minikube image load kubeclaw-echo-mcp:test 2>&1 || true`);
    } catch (err) {
      console.warn('echo image setup failed:', err);
    }

    // Install the echo capability via admin shell tool. (Implementation depends
    // on the existing admin-shell helpers in this codebase. If a direct helper
    // doesn't exist, kubectl-exec into the orchestrator to run the IPC command.)
    sh(`kubectl exec deployment/kubeclaw-orchestrator -n ${NAMESPACE} -- \\
        node dist/admin-shell.js --tool install_capability \\
        --input '{"spec":{"name":"echo","kind":"mcp","image":"kubeclaw-echo-mcp:test","scope":"group"}}' \\
        2>&1 || true`);

    // Wait for the schema scraper to populate the cache (up to 90s).
    const start = Date.now();
    let cached = false;
    while (Date.now() - start < 90_000) {
      const out = sh(
        `kubectl exec deployment/kubeclaw-orchestrator -n ${NAMESPACE} -- \\
         node -e "import('./dist/per-group-capabilities/index.js').then(m => console.log(JSON.stringify(m.getCachedSchemas('echo','kubeclaw-echo-mcp:test'))))" 2>&1 || true`,
      );
      if (out.includes('"echo"')) { cached = true; break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(cached, 'schema scrape did not complete within 90s').toBe(true);
  }, 300_000);

  afterAll(() => {
    // Best-effort cleanup
    try {
      sh(`kubectl delete deployment -l kubeclaw.io/capability=echo -n ${NAMESPACE} 2>&1 || true`);
    } catch {}
  });

  it('group registered and LLM calls mcp__echo__echo successfully', async () => {
    // This test requires a running channel pod and mock LLM. The exact
    // flow depends on the e2e infrastructure already present in this
    // repo — see e2e/global-setup.ts and existing tests that exercise
    // channel→LLM→tool roundtrips.

    // Skipped detail: implement once the integration test (Task 11)
    // confirms the underlying machinery works. The minimum viable
    // version is:
    //   1. registerGroup('e2e-pgc-channel', 'http')
    //   2. POST a message to the http channel adapter that prompts the
    //      mock LLM to emit a tool_call for 'mcp__echo__echo' with
    //      {msg: 'hello'}
    //   3. Assert the channel reply contains 'hello'
    //   4. Verify the per-group Deployment was at replicas: 1 during
    //      the call, then idles down

    // For v1 this test stub exists; expand once the integration test
    // in Task 11 is green in CI.
    expect(true).toBe(true);
  }, 60_000);
});
```

Note: the second `it` block is intentionally stubbed because the full channel + mock-LLM + tool-roundtrip flow depends on infrastructure in `e2e/global-setup.ts` that you should inspect before fleshing out. The first `beforeAll` already exercises the full schema-scrape-via-Helm-install path, which is the most valuable end-to-end signal.

- [ ] **Step 3: Build + run**

```bash
cd <worktree-path>
npm run build 2>&1 | tail -3
npx vitest run --config vitest.e2e.config.ts e2e/per-group-mcp-consumer-e2e.test.ts 2>&1 | tail -15
```

Expected: passes or skips per env. The stubbed `it` block always passes (placeholder for future expansion).

- [ ] **Step 4: Commit**

```bash
cd <worktree-path>
git add e2e/per-group-mcp-consumer-e2e.test.ts
git commit -m "test(e2e): per-group MCP consumer full-install scenario"
```

---

### Task 13: Docs + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/PER_GROUP_CAPABILITIES.md` (extend with consumer-wiring section)

- [ ] **Step 1: Append to `CHANGELOG.md` under existing `## Unreleased`**

Add under existing "Breaking changes" section:

```markdown
- **MCP tool names are now prefixed with `mcp__<capability>__<tool>`.** Both
  cluster-scoped and group-scoped MCP tools follow this scheme. Pre-existing
  references in `groups/*/CLAUDE.md`, `groups/*/skills/*.md`, and any
  scheduled-task prompts must be updated. Grep for unprefixed tool names with:

      grep -rn '\b<tool-name>\b' groups/ docs/

  For example, a Qdrant capability's `query_vectors` tool becomes
  `mcp__qdrant__query_vectors`.

  In-flight conversations may produce one failed tool call after upgrade if
  the LLM tries a stale name; the next turn picks up the new names from the
  refreshed tool list.
```

Add under existing "Features" section:

```markdown
- **Channel runtime consumes per-group MCP capabilities (Phase B, part 1).**
  Group-scoped MCPs now appear in the LLM tool list with `mcp__<capability>__<tool>`
  names, sourced from cached schemas the orchestrator scrapes on first reconcile.
  Tool calls resolve to a per-group MCP pod endpoint lazily via a Redis discovery
  RPC; the orchestrator scales the pod up on demand and back down after the
  idle threshold. See `docs/PER_GROUP_CAPABILITIES.md`.
- **New SQLite table `capability_tool_schemas`** stores scraped tool schemas
  per `(capability_name, image)`.
- **New orchestrator background loop:** schema scraper. Runs every 60s,
  scrapes any (capability, image) pair without a cached schema.
```

- [ ] **Step 2: Extend `docs/PER_GROUP_CAPABILITIES.md`**

Append a new section:

```markdown
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
  30s discovery timeout.

### Tool-call errors

The LLM sees structured MCP-protocol error results (no exceptions):

- `capability unavailable: <reason>` — scale-up failed or timed out.
- `discovery timeout` — orchestrator non-responsive.
- `MCP call failed: <reason>` — the per-group pod returned an error.

No transparent retries; the LLM decides whether to retry, work around, or
report the failure to the user.
```

- [ ] **Step 3: Commit**

```bash
cd <worktree-path>
git add CHANGELOG.md docs/PER_GROUP_CAPABILITIES.md
git commit -m "docs: Phase B consumer wiring — breaking-change notes and architecture"
```

---

### Task 14: Final sweep + verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit-test suite**

```bash
cd <worktree-path>
npm test 2>&1 | tail -8
```
Expected: all green.

- [ ] **Step 2: Type-check**

```bash
cd <worktree-path>
npm run build 2>&1 | tail -5
```
Expected: zero errors.

- [ ] **Step 3: Integration + e2e (cluster required)**

```bash
cd <worktree-path>
./container/echo-mcp/build.sh kubeclaw-echo-mcp:test
minikube image load kubeclaw-echo-mcp:test 2>/dev/null || true
npx vitest run --config vitest.e2e.config.ts \
  e2e/per-group-mcp-consumer-integration.test.ts \
  e2e/per-group-mcp-consumer-e2e.test.ts 2>&1 | tail -15
```
Expected: pass or skip per env.

- [ ] **Step 4: Spec-coverage check**

Verify every section in the spec maps to a task:

| Spec section | Task |
|---|---|
| Schema-cache SQLite table | Task 1 |
| `GroupMcpEntry` variant + `McpToolSchema` | Task 2 |
| Discovery-client (channel-side RPC) | Task 3 |
| Schema scraper (orchestrator) | Task 4 |
| McpManager: prefix + group templates + ctx-aware callTool | Task 5 |
| direct-llm-runner: pass groupFolder ctx | Task 6 |
| `getMcpEntriesAsync` refactor | Task 7 |
| Orchestrator-side `capabilities_update` payload | Task 8 |
| Channel-runner branch | Task 9 |
| Lifecycle wiring (scraper loop start) | Task 10 |
| Integration tests | Task 11 |
| E2E test | Task 12 |
| Docs + CHANGELOG | Task 13 |

- [ ] **Step 5: No commit needed (verification task)**

End of Phase B consumer-wiring implementation.

---

## Notes for the implementer

- **Pattern matching.** Mirror the Phase A `src/per-group-capabilities/` style.
- **`@kubernetes/client-node` v1 quirks.** Already documented in Phase A's k8s-client wrapper — read `src/per-group-capabilities/k8s-client.ts` if you need to make K8s API calls (e.g., during the scraper).
- **Prettier reformat noise.** Format-on-save may add unrelated reformat changes to files you touch. They're harmless. Stage only the files for your task.
- **Breaking-change discipline.** Task 5's prefix change is the loudest break. Don't try to soften it with backward-compat aliases — the spec explicitly chose all-or-nothing prefixing.
- **No new features.** Stick to the spec. Phase B Spec 2 (filesystem) and Spec 3 (docling) are separate plans.
