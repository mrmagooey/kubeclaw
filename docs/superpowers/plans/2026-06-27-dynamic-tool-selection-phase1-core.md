# Dynamic Tool Selection — Phase 1: Core Selection (Catalog + Curated Library) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the channel LLM call `find_tools(task_description)` and have a privileged orchestrator-side Tool Selection Agent (TSA) resolve it against the live catalog (tier-1) and a curated library (tier-2), register the chosen tool, persist provenance, and gate credential binding behind an in-channel user approval.

**Architecture:** A new `find_tools` tool is added to the channel LLM toolset. Its dispatch sends a request over a new Redis stream (`kubeclaw:find-tools`) to the orchestrator, mirroring the existing `executeToolViaK8s` → `startToolPodSpawnWatcher` pattern. The orchestrator runs the TSA (a bounded LLM tool-calling loop with selection-only tools), activates/registers the resolved tool via the existing `ToolReconciler` + `tool_overrides` table, records provenance in a new `auto_tool_meta` table, and returns a structured result. A periodic TTL sweep prunes stale auto-acquired tools.

**Tech Stack:** TypeScript, Node, `ioredis`, `sql.js` (SQLite via `src/db.ts`), OpenAI-compatible chat API (existing `DirectLLMRunner` LLM client), Vitest, Helm.

## Global Constraints

- Tool names must not collide with `RESERVED_NAMES` (`src/tools/types.ts:78-113`); registration goes through `validateTool()`.
- All persistence uses the existing `db` helpers in `src/db.ts` (`db.run`, `db.exec`); no new DB engine.
- Tool activation/registration must go through `registerTool`/`editTool` (`src/skills/orchestrator/tool-registry.ts`) so the `ToolReconciler` re-renders the `kubeclaw-tools` ConfigMap.
- Redis stream/channel names are produced only by helpers in `src/k8s/redis-client.ts` — add new helpers there, never inline string literals.
- The TSA never touches user conversation; it receives only the task description, group folder, and channel.
- Tier-3 (open discovery) is OUT OF SCOPE for this phase: `search_registry` returns `unavailable`. Phase 3 implements it.
- This phase introduces NO new network/securityContext behavior; that is Phase 2.

---

## File Structure

| File | Responsibility | Create/Modify |
| ---- | -------------- | ------------- |
| `src/k8s/redis-client.ts` | Add `getFindToolsStream()` + `getFindToolsResultStream(requestId)` | Modify |
| `src/tool-selection/types.ts` | `FindToolsRequest`, `FindToolsResult`, `ToolCandidate`, `Provenance`, `AutoToolMeta` types | Create |
| `src/tool-selection/library.ts` | Load the curated library (Helm-mounted JSON) of inactive `ToolSpec`s | Create |
| `src/tool-selection/matcher.ts` | LLM-reasoning matcher: rank catalog/library specs against a task description | Create |
| `src/tool-selection/provenance.ts` | `auto_tool_meta` CRUD: record/touch/list/prune | Create |
| `src/tool-selection/agent.ts` | The TSA: bounded loop over `search_catalog`/`search_library`/`search_registry`/`register`/`request_credential_binding` | Create |
| `src/tool-selection/credential-gate.ts` | Gate state machine: decide autonomous vs `pending_credential`; mint/verify approval tokens | Create |
| `src/db.ts` | Add `auto_tool_meta` table DDL | Modify |
| `src/k8s/ipc-redis.ts` | `startFindToolsWatcher()` — consume requests, run TSA, write result | Modify |
| `src/index.ts` | Invoke `startFindToolsWatcher()` at startup; register TTL sweep | Modify |
| `src/runtime/direct-llm-runner.ts` | Add `find_tools` + `approve_tool_credential` to `TOOLS`; dispatch → Redis round-trip | Modify |
| `src/runtime/find-tools-client.ts` | Channel-side helper: XADD request, block on result (mirrors `executeToolViaK8s`) | Create |
| `helm/kubeclaw/values.yaml` | Add `toolLibrary:` section (seed image-fetch + exiftool specs) | Modify |
| `helm/kubeclaw/templates/tool-library-configmap.yaml` | Render `toolLibrary` into a mounted ConfigMap | Create |

---

## Task 1: Redis stream helpers for find-tools

**Files:**
- Modify: `src/k8s/redis-client.ts` (after `getSpawnToolJobStream`, ~line 190)
- Test: `src/k8s/redis-client.test.ts`

**Interfaces:**
- Produces: `getFindToolsStream(): string` → `'kubeclaw:find-tools'`; `getFindToolsResultStream(requestId: string): string` → `'kubeclaw:find-tools-result:<id>'`

- [ ] **Step 1: Write the failing test**

```typescript
import { getFindToolsStream, getFindToolsResultStream } from './redis-client';

describe('find-tools stream names', () => {
  it('produces the request stream name', () => {
    expect(getFindToolsStream()).toBe('kubeclaw:find-tools');
  });
  it('produces a per-request result stream name', () => {
    expect(getFindToolsResultStream('abc')).toBe(
      'kubeclaw:find-tools-result:abc',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/k8s/redis-client.test.ts -t 'find-tools stream names'`
Expected: FAIL — `getFindToolsStream is not a function`.

- [ ] **Step 3: Implement the helpers**

```typescript
export function getFindToolsStream(): string {
  return 'kubeclaw:find-tools';
}

export function getFindToolsResultStream(requestId: string): string {
  return `kubeclaw:find-tools-result:${requestId}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/k8s/redis-client.test.ts -t 'find-tools stream names'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/redis-client.ts src/k8s/redis-client.test.ts
git commit -m "feat(tool-selection): add find-tools redis stream helpers"
```

---

## Task 2: Tool-selection types

**Files:**
- Create: `src/tool-selection/types.ts`
- Test: `src/tool-selection/types.test.ts`

**Interfaces:**
- Produces:
  - `type Provenance = 'catalog' | 'library' | 'discovered'`
  - `interface ToolCandidate { name: string; description: string; provenance: Provenance }`
  - `interface FindToolsRequest { requestId: string; groupFolder: string; channel: string; taskDescription: string }`
  - `type FindToolsResult =`
    `{ status: 'ready'; tools: ToolCandidate[]; message: string }` `|`
    `{ status: 'pending_credential'; toolName: string; catalogId: string; host: string; approvalToken: string; message: string }` `|`
    `{ status: 'unavailable'; message: string }`
  - `interface AutoToolMeta { name: string; provenance: Provenance; scopeGroup: string | null; sourceDigest: string | null; acquiredAt: number; lastUsedAt: number; transcript: string | null }`

- [ ] **Step 1: Write the failing test**

```typescript
import type { FindToolsResult, Provenance } from './types';
import { isReadyResult } from './types';

describe('tool-selection types', () => {
  it('narrows a ready result', () => {
    const r: FindToolsResult = {
      status: 'ready',
      tools: [{ name: 'x', description: 'd', provenance: 'catalog' }],
      message: 'ok',
    };
    expect(isReadyResult(r)).toBe(true);
  });
  it('rejects a non-ready result', () => {
    const r: FindToolsResult = { status: 'unavailable', message: 'no' };
    expect(isReadyResult(r)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/types.test.ts`
Expected: FAIL — cannot find module `./types`.

- [ ] **Step 3: Implement the types + guard**

```typescript
export type Provenance = 'catalog' | 'library' | 'discovered';

export interface ToolCandidate {
  name: string;
  description: string;
  provenance: Provenance;
}

export interface FindToolsRequest {
  requestId: string;
  groupFolder: string;
  channel: string;
  taskDescription: string;
}

export type FindToolsResult =
  | { status: 'ready'; tools: ToolCandidate[]; message: string }
  | {
      status: 'pending_credential';
      toolName: string;
      catalogId: string;
      host: string;
      approvalToken: string;
      message: string;
    }
  | { status: 'unavailable'; message: string };

export interface AutoToolMeta {
  name: string;
  provenance: Provenance;
  scopeGroup: string | null;
  sourceDigest: string | null;
  acquiredAt: number;
  lastUsedAt: number;
  transcript: string | null;
}

export function isReadyResult(
  r: FindToolsResult,
): r is Extract<FindToolsResult, { status: 'ready' }> {
  return r.status === 'ready';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-selection/types.ts src/tool-selection/types.test.ts
git commit -m "feat(tool-selection): add core types"
```

---

## Task 3: `auto_tool_meta` table + provenance store

**Files:**
- Modify: `src/db.ts` (alongside the `tool_overrides` DDL, ~line 207)
- Create: `src/tool-selection/provenance.ts`
- Test: `src/tool-selection/provenance.test.ts`

**Interfaces:**
- Consumes: `db` from `src/db.ts`; `AutoToolMeta`, `Provenance` from `./types`.
- Produces:
  - `recordAutoTool(meta: { name: string; provenance: Provenance; scopeGroup: string | null; sourceDigest?: string | null; transcript?: string | null; now: number }): void`
  - `touchAutoTool(name: string, now: number): void`
  - `getAutoTool(name: string): AutoToolMeta | undefined`
  - `listAutoTools(): AutoToolMeta[]`
  - `pruneStaleAutoTools(now: number, ttlMs: number): string[]` (returns pruned names)

- [ ] **Step 1: Add the table DDL in `src/db.ts`**

Add next to the `tool_overrides` table creation:

```typescript
db.run(`
  CREATE TABLE IF NOT EXISTS auto_tool_meta (
    name          TEXT PRIMARY KEY,
    provenance    TEXT NOT NULL,
    scope_group   TEXT,
    source_digest TEXT,
    acquired_at   INTEGER NOT NULL,
    last_used_at  INTEGER NOT NULL,
    transcript    TEXT
  )
`);
```

- [ ] **Step 2: Write the failing test**

```typescript
import { resetDbForTest } from '../db';
import {
  recordAutoTool,
  touchAutoTool,
  getAutoTool,
  listAutoTools,
  pruneStaleAutoTools,
} from './provenance';

describe('provenance store', () => {
  beforeEach(() => resetDbForTest());

  it('records and reads back an auto tool', () => {
    recordAutoTool({
      name: 'extract_metadata',
      provenance: 'library',
      scopeGroup: null,
      now: 1000,
    });
    const m = getAutoTool('extract_metadata');
    expect(m?.provenance).toBe('library');
    expect(m?.acquiredAt).toBe(1000);
    expect(m?.lastUsedAt).toBe(1000);
  });

  it('touch updates last_used_at only', () => {
    recordAutoTool({ name: 't', provenance: 'discovered', scopeGroup: 'g', now: 1000 });
    touchAutoTool('t', 5000);
    const m = getAutoTool('t');
    expect(m?.acquiredAt).toBe(1000);
    expect(m?.lastUsedAt).toBe(5000);
  });

  it('prunes only tools idle beyond the TTL', () => {
    recordAutoTool({ name: 'old', provenance: 'discovered', scopeGroup: 'g', now: 0 });
    recordAutoTool({ name: 'fresh', provenance: 'discovered', scopeGroup: 'g', now: 9000 });
    const pruned = pruneStaleAutoTools(10000, 5000); // ttl 5s
    expect(pruned).toEqual(['old']);
    expect(getAutoTool('old')).toBeUndefined();
    expect(getAutoTool('fresh')).toBeDefined();
  });
});
```

> If `resetDbForTest` does not exist, use the existing test DB-reset helper this repo uses in other `*.test.ts` files for `tool_overrides`; match that pattern.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/provenance.test.ts`
Expected: FAIL — cannot find module `./provenance`.

- [ ] **Step 4: Implement the store**

```typescript
import { db } from '../db';
import type { AutoToolMeta, Provenance } from './types';

export function recordAutoTool(meta: {
  name: string;
  provenance: Provenance;
  scopeGroup: string | null;
  sourceDigest?: string | null;
  transcript?: string | null;
  now: number;
}): void {
  db.run(
    `INSERT OR REPLACE INTO auto_tool_meta
       (name, provenance, scope_group, source_digest, acquired_at, last_used_at, transcript)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      meta.name,
      meta.provenance,
      meta.scopeGroup,
      meta.sourceDigest ?? null,
      meta.now,
      meta.now,
      meta.transcript ?? null,
    ],
  );
}

export function touchAutoTool(name: string, now: number): void {
  db.run(`UPDATE auto_tool_meta SET last_used_at = ? WHERE name = ?`, [
    now,
    name,
  ]);
}

function rowToMeta(row: unknown[]): AutoToolMeta {
  return {
    name: row[0] as string,
    provenance: row[1] as Provenance,
    scopeGroup: (row[2] as string | null) ?? null,
    sourceDigest: (row[3] as string | null) ?? null,
    acquiredAt: row[4] as number,
    lastUsedAt: row[5] as number,
    transcript: (row[6] as string | null) ?? null,
  };
}

export function getAutoTool(name: string): AutoToolMeta | undefined {
  const rows = db.exec(`SELECT * FROM auto_tool_meta WHERE name = ?`, [name]);
  if (rows.length === 0 || rows[0].values.length === 0) return undefined;
  return rowToMeta(rows[0].values[0]);
}

export function listAutoTools(): AutoToolMeta[] {
  const rows = db.exec(`SELECT * FROM auto_tool_meta ORDER BY name`);
  if (rows.length === 0) return [];
  return rows[0].values.map(rowToMeta);
}

export function pruneStaleAutoTools(now: number, ttlMs: number): string[] {
  const rows = db.exec(
    `SELECT name FROM auto_tool_meta WHERE (? - last_used_at) > ?`,
    [now, ttlMs],
  );
  if (rows.length === 0 || rows[0].values.length === 0) return [];
  const names = rows[0].values.map((r) => r[0] as string);
  for (const n of names) {
    db.run(`DELETE FROM auto_tool_meta WHERE name = ?`, [n]);
  }
  return names;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/provenance.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/tool-selection/provenance.ts src/tool-selection/provenance.test.ts
git commit -m "feat(tool-selection): add auto_tool_meta table and provenance store"
```

---

## Task 4: Curated library loader

**Files:**
- Create: `src/tool-selection/library.ts`
- Test: `src/tool-selection/library.test.ts`

**Interfaces:**
- Consumes: `parseToolCatalog` from `src/tools/types.ts` (same parser the catalog uses); `ToolSpec`.
- Produces:
  - `class ToolLibraryLoader { constructor(path: string); start(): void; stop(): void; getAll(): ToolSpec[] }`
  - The library JSON has the same shape as the tool catalog (`{ version, generation, tools }`), but its entries are *not* in the live catalog until activated.

- [ ] **Step 1: Write the failing test**

```typescript
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolLibraryLoader } from './library';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lib-'));
  const path = join(dir, 'library.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      generation: 1,
      tools: [
        {
          name: 'extract_metadata',
          description: 'Extract EXIF metadata from an image file',
          parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
          image: 'kubeclaw/exiftool:latest',
          pattern: 'file',
          mount: 'group',
          run: 'exiftool "$(cat "$INPUT_DIR/filename")"',
        },
      ],
    }),
  );
  return path;
}

describe('ToolLibraryLoader', () => {
  it('loads library specs from disk', () => {
    const loader = new ToolLibraryLoader(fixture());
    loader.start();
    const all = loader.getAll();
    expect(all.map((t) => t.name)).toEqual(['extract_metadata']);
    loader.stop();
  });

  it('returns empty when the file is absent', () => {
    const loader = new ToolLibraryLoader('/nonexistent/library.json');
    loader.start();
    expect(loader.getAll()).toEqual([]);
    loader.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/library.test.ts`
Expected: FAIL — cannot find module `./library`.

- [ ] **Step 3: Implement the loader** (mirror `ToolCatalogLoader` in `src/tools/catalog-loader.ts`)

```typescript
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { parseToolCatalog } from '../tools/types';
import type { ToolSpec } from '../tools/types';
import { logger } from '../logger';

export class ToolLibraryLoader {
  private cache: ToolSpec[] = [];
  private watcher?: FSWatcher;

  constructor(private readonly path: string) {}

  start(): void {
    this.load();
    const dir = dirname(this.path);
    if (!existsSync(dir)) return;
    this.watcher = watch(dir, { persistent: false }, () => {
      setTimeout(() => this.load(), 50);
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.cache = [];
      return;
    }
    try {
      const r = parseToolCatalog(readFileSync(this.path, 'utf-8'));
      if (!r.ok) {
        logger.warn({ error: r.error, path: this.path }, 'tool library parse failed; keeping cache');
        return;
      }
      this.cache = r.tools;
      logger.info({ count: r.tools.length }, 'tool library loaded');
    } catch (err) {
      logger.warn({ err, path: this.path }, 'tool library read failed; keeping cache');
    }
  }

  getAll(): ToolSpec[] {
    return this.cache;
  }
}
```

> Verify `parseToolCatalog` and `logger` import paths against the repo (`src/tools/types.ts`, `src/logger.ts`); adjust if the export names differ.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/library.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-selection/library.ts src/tool-selection/library.test.ts
git commit -m "feat(tool-selection): add curated library loader"
```

---

## Task 5: LLM matcher

**Files:**
- Create: `src/tool-selection/matcher.ts`
- Test: `src/tool-selection/matcher.test.ts`

**Interfaces:**
- Consumes: `ToolSpec`; an injected `chat` function (so tests stub the LLM) with signature `(messages: {role: string; content: string}[]) => Promise<string>`.
- Produces:
  - `interface MatchResult { name: string | null; confidence: number; reason: string }`
  - `async function matchTool(taskDescription: string, specs: ToolSpec[], chat: ChatFn): Promise<MatchResult>` — asks the LLM to pick the single best-fitting spec (by name + description + params) or return none; parses a strict JSON response.

- [ ] **Step 1: Write the failing test**

```typescript
import { matchTool } from './matcher';
import type { ToolSpec } from '../tools/types';

const specs: ToolSpec[] = [
  { name: 'web_search', description: 'Text web search', parameters: {}, image: 'x', pattern: 'http' },
  { name: 'extract_metadata', description: 'Extract EXIF metadata from an image', parameters: {}, image: 'y', pattern: 'file' },
];

describe('matchTool', () => {
  it('returns the spec the LLM selects', async () => {
    const chat = async () =>
      JSON.stringify({ name: 'extract_metadata', confidence: 0.9, reason: 'EXIF match' });
    const r = await matchTool('get the exif data from a photo', specs, chat);
    expect(r.name).toBe('extract_metadata');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('returns null when the LLM finds no fit', async () => {
    const chat = async () => JSON.stringify({ name: null, confidence: 0, reason: 'no match' });
    const r = await matchTool('play chess', specs, chat);
    expect(r.name).toBeNull();
  });

  it('treats a hallucinated name not in specs as no-match', async () => {
    const chat = async () => JSON.stringify({ name: 'made_up_tool', confidence: 1, reason: 'x' });
    const r = await matchTool('anything', specs, chat);
    expect(r.name).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/matcher.test.ts`
Expected: FAIL — cannot find module `./matcher`.

- [ ] **Step 3: Implement the matcher**

```typescript
import type { ToolSpec } from '../tools/types';

export type ChatFn = (
  messages: { role: string; content: string }[],
) => Promise<string>;

export interface MatchResult {
  name: string | null;
  confidence: number;
  reason: string;
}

export async function matchTool(
  taskDescription: string,
  specs: ToolSpec[],
  chat: ChatFn,
): Promise<MatchResult> {
  if (specs.length === 0) return { name: null, confidence: 0, reason: 'empty set' };

  const catalogText = specs
    .map((s) => `- ${s.name}: ${s.description} (params: ${JSON.stringify(s.parameters)})`)
    .join('\n');

  const system =
    'You select the single best tool for a task. Respond with STRICT JSON only: ' +
    '{"name": <tool name or null>, "confidence": <0..1>, "reason": <string>}. ' +
    'Pick a tool only if it genuinely fits; otherwise name=null.';
  const user = `Task: ${taskDescription}\n\nAvailable tools:\n${catalogText}`;

  const raw = await chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);

  let parsed: MatchResult;
  try {
    parsed = JSON.parse(raw) as MatchResult;
  } catch {
    return { name: null, confidence: 0, reason: 'unparseable LLM response' };
  }

  // Guard against hallucinated names.
  if (parsed.name !== null && !specs.some((s) => s.name === parsed.name)) {
    return { name: null, confidence: 0, reason: 'selected name not in candidate set' };
  }
  return {
    name: parsed.name ?? null,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    reason: parsed.reason ?? '',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/matcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-selection/matcher.ts src/tool-selection/matcher.test.ts
git commit -m "feat(tool-selection): add LLM tool matcher with hallucination guard"
```

---

## Task 6: Credential-gate state machine

**Files:**
- Create: `src/tool-selection/credential-gate.ts`
- Test: `src/tool-selection/credential-gate.test.ts`

**Interfaces:**
- Consumes: `ToolSpec`; a `catalogHostLookup: (catalogId: string) => string | undefined` (resolves a broker-catalog id to its host).
- Produces:
  - `interface GateDecision { needsApproval: boolean; catalogId?: string; host?: string }`
  - `function evaluateGate(spec: ToolSpec, lookup: (id: string) => string | undefined): GateDecision` — returns `needsApproval:true` iff `spec.credentials` is non-empty.
  - `function mintApprovalToken(toolName: string, catalogId: string, nonce: string): string`
  - `function verifyApprovalToken(token: string, toolName: string, catalogId: string, nonce: string): boolean`

> Token = HMAC over `toolName|catalogId` keyed by a per-request `nonce` the watcher stores; this prevents a channel from approving an arbitrary tool/credential pairing it was never offered.

- [ ] **Step 1: Write the failing test**

```typescript
import { evaluateGate, mintApprovalToken, verifyApprovalToken } from './credential-gate';
import type { ToolSpec } from '../tools/types';

const lookup = (id: string) => (id === 'brave-search' ? 'api.search.brave.com' : undefined);

describe('credential gate', () => {
  it('no approval for a credential-free tool', () => {
    const spec: ToolSpec = { name: 'exif', description: 'd', parameters: {}, image: 'i', pattern: 'file' };
    expect(evaluateGate(spec, lookup).needsApproval).toBe(false);
  });

  it('requires approval and resolves the host for a credentialed tool', () => {
    const spec: ToolSpec = {
      name: 'image_search', description: 'd', parameters: {}, image: 'i', pattern: 'http',
      credentials: ['brave-search'],
    };
    const d = evaluateGate(spec, lookup);
    expect(d).toEqual({ needsApproval: true, catalogId: 'brave-search', host: 'api.search.brave.com' });
  });

  it('round-trips a valid approval token', () => {
    const t = mintApprovalToken('image_search', 'brave-search', 'nonce123');
    expect(verifyApprovalToken(t, 'image_search', 'brave-search', 'nonce123')).toBe(true);
  });

  it('rejects a token for a different tool/credential/nonce', () => {
    const t = mintApprovalToken('image_search', 'brave-search', 'nonce123');
    expect(verifyApprovalToken(t, 'other_tool', 'brave-search', 'nonce123')).toBe(false);
    expect(verifyApprovalToken(t, 'image_search', 'openai', 'nonce123')).toBe(false);
    expect(verifyApprovalToken(t, 'image_search', 'brave-search', 'wrong')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/credential-gate.test.ts`
Expected: FAIL — cannot find module `./credential-gate`.

- [ ] **Step 3: Implement the gate**

```typescript
import { createHmac } from 'node:crypto';
import type { ToolSpec } from '../tools/types';

export interface GateDecision {
  needsApproval: boolean;
  catalogId?: string;
  host?: string;
}

export function evaluateGate(
  spec: ToolSpec,
  lookup: (id: string) => string | undefined,
): GateDecision {
  const id = spec.credentials?.[0];
  if (!id) return { needsApproval: false };
  return { needsApproval: true, catalogId: id, host: lookup(id) };
}

export function mintApprovalToken(
  toolName: string,
  catalogId: string,
  nonce: string,
): string {
  return createHmac('sha256', nonce)
    .update(`${toolName}|${catalogId}`)
    .digest('hex');
}

export function verifyApprovalToken(
  token: string,
  toolName: string,
  catalogId: string,
  nonce: string,
): boolean {
  return token === mintApprovalToken(toolName, catalogId, nonce);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/credential-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-selection/credential-gate.ts src/tool-selection/credential-gate.test.ts
git commit -m "feat(tool-selection): add credential-gate state machine"
```

---

## Task 7: The Tool Selection Agent (orchestration)

**Files:**
- Create: `src/tool-selection/agent.ts`
- Test: `src/tool-selection/agent.test.ts`

**Interfaces:**
- Consumes: `matchTool`/`ChatFn` (Task 5); `evaluateGate`/`mintApprovalToken` (Task 6); `recordAutoTool` (Task 3); `registerTool`/`editTool` (`src/skills/orchestrator/tool-registry.ts`); `ToolReconciler.apply` (`src/tools/reconciler.ts`); `resolveToolByName` (`src/tools/reconciler.ts`); `ToolLibraryLoader.getAll` (Task 4); `FindToolsRequest`/`FindToolsResult`/`ToolCandidate` (Task 2).
- Produces:
  - `interface TsaDeps { chat: ChatFn; liveCatalog: () => ToolSpec[]; library: () => ToolSpec[]; catalogHostLookup: (id: string) => string | undefined; reconcile: () => Promise<void>; now: () => number; nonce: string; searchRegistry?: (task: string) => Promise<ToolSpec | null> }`
  - `async function runToolSelection(req: FindToolsRequest, deps: TsaDeps): Promise<FindToolsResult>`

Behavior (tier order):
1. `matchTool` over `liveCatalog()`. Confident match (confidence ≥ 0.5) → `ready` (touch provenance if it is an auto tool).
2. Else `matchTool` over `library()`. Match → evaluate gate. If credential-free: `registerTool` (provenance `library`, global scope = no channel restriction), `reconcile`, record provenance, return `ready`. If gate trips: return `pending_credential` with a minted token (do NOT register yet).
3. Else `searchRegistry?.(task)` (Phase 3 injects this; Phase 1 leaves it undefined → skip).
4. Else `unavailable`.

- [ ] **Step 1: Write the failing test**

```typescript
import { runToolSelection, type TsaDeps } from './agent';
import { resetDbForTest } from '../db';
import { getAutoTool } from './provenance';
import type { ToolSpec } from '../tools/types';

const exif: ToolSpec = {
  name: 'extract_metadata', description: 'Extract EXIF metadata from an image',
  parameters: {}, image: 'kubeclaw/exiftool:latest', pattern: 'file', mount: 'group',
};
const imageSearch: ToolSpec = {
  name: 'image_search', description: 'Search the web for images',
  parameters: {}, image: 'kubeclaw/image-search:latest', pattern: 'http',
  credentials: ['brave-search'],
};

function deps(over: Partial<TsaDeps> = {}): TsaDeps {
  return {
    chat: async () => JSON.stringify({ name: null, confidence: 0, reason: 'no' }),
    liveCatalog: () => [],
    library: () => [],
    catalogHostLookup: (id) => (id === 'brave-search' ? 'api.search.brave.com' : undefined),
    reconcile: async () => {},
    now: () => 1000,
    nonce: 'n',
    ...over,
  };
}

describe('runToolSelection', () => {
  beforeEach(() => resetDbForTest());

  it('returns ready from the live catalog without registering', async () => {
    const r = await runToolSelection(
      { requestId: 'r', groupFolder: 'g', channel: 'http', taskDescription: 'exif' },
      deps({
        liveCatalog: () => [exif],
        chat: async () => JSON.stringify({ name: 'extract_metadata', confidence: 0.9, reason: 'ok' }),
      }),
    );
    expect(r.status).toBe('ready');
  });

  it('activates a credential-free library tool and records provenance=library', async () => {
    const r = await runToolSelection(
      { requestId: 'r', groupFolder: 'g', channel: 'http', taskDescription: 'exif' },
      deps({
        library: () => [exif],
        chat: async () => JSON.stringify({ name: 'extract_metadata', confidence: 0.9, reason: 'ok' }),
      }),
    );
    expect(r.status).toBe('ready');
    expect(getAutoTool('extract_metadata')?.provenance).toBe('library');
  });

  it('returns pending_credential (and does NOT register) for a credentialed library tool', async () => {
    const r = await runToolSelection(
      { requestId: 'r', groupFolder: 'g', channel: 'http', taskDescription: 'image' },
      deps({
        library: () => [imageSearch],
        chat: async () => JSON.stringify({ name: 'image_search', confidence: 0.9, reason: 'ok' }),
      }),
    );
    expect(r.status).toBe('pending_credential');
    if (r.status === 'pending_credential') {
      expect(r.catalogId).toBe('brave-search');
      expect(r.host).toBe('api.search.brave.com');
      expect(r.approvalToken).toBeTruthy();
    }
    expect(getAutoTool('image_search')).toBeUndefined();
  });

  it('returns unavailable when nothing matches', async () => {
    const r = await runToolSelection(
      { requestId: 'r', groupFolder: 'g', channel: 'http', taskDescription: 'xyz' },
      deps(),
    );
    expect(r.status).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/agent.test.ts`
Expected: FAIL — cannot find module `./agent`.

- [ ] **Step 3: Implement the TSA**

```typescript
import type { ToolSpec } from '../tools/types';
import { registerTool } from '../skills/orchestrator/tool-registry';
import { matchTool, type ChatFn } from './matcher';
import { evaluateGate, mintApprovalToken } from './credential-gate';
import { recordAutoTool } from './provenance';
import type { FindToolsRequest, FindToolsResult, ToolCandidate } from './types';
import { logger } from '../logger';

const MIN_CONFIDENCE = 0.5;

export interface TsaDeps {
  chat: ChatFn;
  liveCatalog: () => ToolSpec[];
  library: () => ToolSpec[];
  catalogHostLookup: (id: string) => string | undefined;
  reconcile: () => Promise<void>;
  now: () => number;
  nonce: string;
  searchRegistry?: (task: string) => Promise<ToolSpec | null>;
}

function candidate(spec: ToolSpec, provenance: ToolCandidate['provenance']): ToolCandidate {
  return { name: spec.name, description: spec.description, provenance };
}

export async function runToolSelection(
  req: FindToolsRequest,
  deps: TsaDeps,
): Promise<FindToolsResult> {
  // Tier 1: live catalog.
  const live = deps.liveCatalog();
  const m1 = await matchTool(req.taskDescription, live, deps.chat);
  if (m1.name && m1.confidence >= MIN_CONFIDENCE) {
    const spec = live.find((s) => s.name === m1.name)!;
    return { status: 'ready', tools: [candidate(spec, 'catalog')], message: `Using existing tool ${spec.name}.` };
  }

  // Tier 2: curated library.
  const lib = deps.library();
  const m2 = await matchTool(req.taskDescription, lib, deps.chat);
  if (m2.name && m2.confidence >= MIN_CONFIDENCE) {
    const spec = lib.find((s) => s.name === m2.name)!;
    const gate = evaluateGate(spec, deps.catalogHostLookup);
    if (gate.needsApproval) {
      const token = mintApprovalToken(spec.name, gate.catalogId!, deps.nonce);
      return {
        status: 'pending_credential',
        toolName: spec.name,
        catalogId: gate.catalogId!,
        host: gate.host ?? '(unknown host)',
        approvalToken: token,
        message: `Tool ${spec.name} needs your ${gate.catalogId} credential. Approve to enable it.`,
      };
    }
    const reg = registerTool(spec, deps.reconcile);
    if (!reg.ok) return { status: 'unavailable', message: `Could not register ${spec.name}: ${reg.error}` };
    recordAutoTool({ name: spec.name, provenance: 'library', scopeGroup: null, now: deps.now() });
    return { status: 'ready', tools: [candidate(spec, 'library')], message: `Activated ${spec.name} from the library.` };
  }

  // Tier 3: open discovery (Phase 3 injects searchRegistry).
  if (deps.searchRegistry) {
    try {
      const discovered = await deps.searchRegistry(req.taskDescription);
      if (discovered) {
        // Phase 3 owns gating, scope, and registration of discovered tools.
        return { status: 'ready', tools: [candidate(discovered, 'discovered')], message: `Discovered ${discovered.name}.` };
      }
    } catch (err) {
      logger.warn({ err, requestId: req.requestId }, 'registry discovery failed');
    }
  }

  return { status: 'unavailable', message: 'No suitable tool found.' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-selection/agent.ts src/tool-selection/agent.test.ts
git commit -m "feat(tool-selection): add Tool Selection Agent (tier-1/2 + gate)"
```

---

## Task 8: Credential approval finalizer

**Files:**
- Modify: `src/tool-selection/agent.ts` (add `finalizeCredentialApproval`)
- Test: `src/tool-selection/agent.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `interface ApprovalDeps { library: () => ToolSpec[]; catalogHostLookup: (id: string) => string | undefined; reconcile: () => Promise<void>; now: () => number; nonce: string }`
  - `async function finalizeCredentialApproval(args: { toolName: string; catalogId: string; approvalToken: string }, deps: ApprovalDeps): Promise<FindToolsResult>` — verifies the token, then registers the library spec WITH its `credentials` field intact and records provenance `library`.

- [ ] **Step 1: Write the failing test (append to agent.test.ts)**

```typescript
import { finalizeCredentialApproval } from './agent';
import { mintApprovalToken } from './credential-gate';

describe('finalizeCredentialApproval', () => {
  beforeEach(() => resetDbForTest());

  it('registers the credentialed tool when the token is valid', async () => {
    const token = mintApprovalToken('image_search', 'brave-search', 'n');
    const r = await finalizeCredentialApproval(
      { toolName: 'image_search', catalogId: 'brave-search', approvalToken: token },
      { library: () => [imageSearch], catalogHostLookup: () => 'api.search.brave.com', reconcile: async () => {}, now: () => 1, nonce: 'n' },
    );
    expect(r.status).toBe('ready');
    expect(getAutoTool('image_search')?.provenance).toBe('library');
  });

  it('rejects an invalid token without registering', async () => {
    const r = await finalizeCredentialApproval(
      { toolName: 'image_search', catalogId: 'brave-search', approvalToken: 'bad' },
      { library: () => [imageSearch], catalogHostLookup: () => 'api.search.brave.com', reconcile: async () => {}, now: () => 1, nonce: 'n' },
    );
    expect(r.status).toBe('unavailable');
    expect(getAutoTool('image_search')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/agent.test.ts -t finalizeCredentialApproval`
Expected: FAIL — `finalizeCredentialApproval is not a function`.

- [ ] **Step 3: Implement the finalizer (in `agent.ts`)**

```typescript
import { verifyApprovalToken } from './credential-gate';

export interface ApprovalDeps {
  library: () => ToolSpec[];
  catalogHostLookup: (id: string) => string | undefined;
  reconcile: () => Promise<void>;
  now: () => number;
  nonce: string;
}

export async function finalizeCredentialApproval(
  args: { toolName: string; catalogId: string; approvalToken: string },
  deps: ApprovalDeps,
): Promise<FindToolsResult> {
  if (!verifyApprovalToken(args.approvalToken, args.toolName, args.catalogId, deps.nonce)) {
    return { status: 'unavailable', message: 'Invalid or expired approval.' };
  }
  const spec = deps.library().find((s) => s.name === args.toolName);
  if (!spec) return { status: 'unavailable', message: `Tool ${args.toolName} no longer available.` };
  const reg = registerTool(spec, deps.reconcile);
  if (!reg.ok) return { status: 'unavailable', message: `Could not register ${spec.name}: ${reg.error}` };
  recordAutoTool({ name: spec.name, provenance: 'library', scopeGroup: null, now: deps.now() });
  return { status: 'ready', tools: [candidate(spec, 'library')], message: `Enabled ${spec.name}.` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-selection/agent.ts src/tool-selection/agent.test.ts
git commit -m "feat(tool-selection): add credential approval finalizer"
```

---

## Task 9: Orchestrator watcher (`startFindToolsWatcher`)

**Files:**
- Modify: `src/k8s/ipc-redis.ts` (new exported watcher near `startToolPodSpawnWatcher`)
- Modify: `src/index.ts` (invoke at startup)
- Test: `src/k8s/find-tools-watcher.test.ts`

**Interfaces:**
- Consumes: `getFindToolsStream`/`getFindToolsResultStream` (Task 1); `runToolSelection`/`finalizeCredentialApproval` (Tasks 7–8); the live catalog (`resolveToolByName`/merged catalog), library loader, broker catalog host lookup, and the orchestrator's `ToolReconciler`.
- Produces: `async function startFindToolsWatcher(deps: FindToolsWatcherDeps): Promise<void>` where `FindToolsWatcherDeps` supplies `chat`, `liveCatalog`, `library`, `catalogHostLookup`, `reconcile`, and `nonceFor(requestId)`.

The watcher: XREAD the request stream; each message has fields `requestId, groupFolder, channel, taskDescription` (and, for the approval variant, `kind='approve', toolName, catalogId, approvalToken`). It runs the appropriate function, then `XADD`s the JSON result to `getFindToolsResultStream(requestId)`.

> Per-request nonce: derive deterministically as `hmac(serverSecret, requestId)` so the approval round-trip (a *second* request carrying the original `requestId`) recomputes the same nonce without server-side state. Store the secret in an env var (`TOOL_SELECTION_SECRET`), defaulting to a process-lifetime random value.

- [ ] **Step 1: Write the failing test** (drive the watcher's per-message handler directly — factor the message handler into an exported `handleFindToolsMessage(obj, deps)` so it is unit-testable without a live Redis loop)

```typescript
import { handleFindToolsMessage } from './ipc-redis';
import type { ToolSpec } from '../tools/types';

const exif: ToolSpec = { name: 'extract_metadata', description: 'EXIF', parameters: {}, image: 'i', pattern: 'file', mount: 'group' };

describe('handleFindToolsMessage', () => {
  it('returns a serialized ready result for a library match', async () => {
    const written: Record<string, string> = {};
    await handleFindToolsMessage(
      { requestId: 'r1', groupFolder: 'g', channel: 'http', taskDescription: 'exif' },
      {
        chat: async () => JSON.stringify({ name: 'extract_metadata', confidence: 0.9, reason: 'ok' }),
        liveCatalog: () => [],
        library: () => [exif],
        catalogHostLookup: () => undefined,
        reconcile: async () => {},
        writeResult: async (id, json) => { written[id] = json; },
        secret: 's',
      },
    );
    const parsed = JSON.parse(written['r1']);
    expect(parsed.status).toBe('ready');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/k8s/find-tools-watcher.test.ts`
Expected: FAIL — `handleFindToolsMessage is not a function`.

- [ ] **Step 3: Implement the handler + watcher loop** (in `src/k8s/ipc-redis.ts`)

```typescript
import { createHmac } from 'node:crypto';
import { getFindToolsStream, getFindToolsResultStream } from './redis-client';
import { runToolSelection, finalizeCredentialApproval } from '../tool-selection/agent';
import type { ChatFn } from '../tool-selection/matcher';
import type { ToolSpec } from '../tools/types';

export interface FindToolsHandlerDeps {
  chat: ChatFn;
  liveCatalog: () => ToolSpec[];
  library: () => ToolSpec[];
  catalogHostLookup: (id: string) => string | undefined;
  reconcile: () => Promise<void>;
  writeResult: (requestId: string, json: string) => Promise<void>;
  secret: string;
}

function nonceFor(secret: string, requestId: string): string {
  return createHmac('sha256', secret).update(requestId).digest('hex');
}

export async function handleFindToolsMessage(
  obj: Record<string, string>,
  deps: FindToolsHandlerDeps,
): Promise<void> {
  const { requestId } = obj;
  if (!requestId) return;
  const nonce = nonceFor(deps.secret, requestId);

  let result;
  if (obj.kind === 'approve') {
    result = await finalizeCredentialApproval(
      { toolName: obj.toolName, catalogId: obj.catalogId, approvalToken: obj.approvalToken },
      { library: deps.library, catalogHostLookup: deps.catalogHostLookup, reconcile: deps.reconcile, now: () => Date.now(), nonce },
    );
  } else {
    result = await runToolSelection(
      { requestId, groupFolder: obj.groupFolder, channel: obj.channel ?? '', taskDescription: obj.taskDescription ?? '' },
      { chat: deps.chat, liveCatalog: deps.liveCatalog, library: deps.library, catalogHostLookup: deps.catalogHostLookup, reconcile: deps.reconcile, now: () => Date.now(), nonce },
    );
  }
  await deps.writeResult(requestId, JSON.stringify(result));
}

export async function startFindToolsWatcher(
  deps: Omit<FindToolsHandlerDeps, 'writeResult'>,
): Promise<void> {
  const redis = createStreamWatcherClient();
  const stream = getFindToolsStream();
  let lastId = await resolveStreamTip(redis, stream);
  const writeResult = async (requestId: string, json: string) => {
    await getRedisClient().xadd(getFindToolsResultStream(requestId), '*', 'result', json);
  };
  logger.info('find-tools watcher started');
  while (ipcWatcherRunning) {
    try {
      const resp = await redis.xread('COUNT', 10, 'BLOCK', 5000, 'STREAMS', stream, lastId);
      if (!resp) continue;
      for (const [, messages] of resp as [string, [string, string[]][]][]) {
        for (const [id, fields] of messages) {
          lastId = id;
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
          await handleFindToolsMessage(obj, { ...deps, writeResult });
        }
      }
    } catch (err) {
      if (ipcWatcherRunning) {
        logger.error({ err }, 'find-tools watcher error');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
```

> Reuse the existing `createStreamWatcherClient`, `resolveStreamTip`, `ipcWatcherRunning`, `logger`, and `getRedisClient` already present in `src/k8s/ipc-redis.ts` — do not redeclare them.

- [ ] **Step 4: Wire it up in `src/index.ts`** (next to the existing `startToolPodSpawnWatcher()` call, ~line 1178). Build `deps` from the orchestrator's existing LLM client (wrap it as a `ChatFn`), the merged catalog accessor, the library loader, the broker catalog host lookup, and the `ToolReconciler.apply`:

```typescript
startFindToolsWatcher({
  chat: makeOrchestratorChatFn(),            // wrap existing LLM client → ChatFn
  liveCatalog: () => mergeCatalog(loadBaselineFromDisk(), listToolOverrides()),
  library: () => toolLibraryLoader.getAll(),
  catalogHostLookup: (id) => brokerCatalog.find((e) => e.id === id)?.host,
  reconcile: () => toolReconciler.apply(),
  secret: process.env.TOOL_SELECTION_SECRET ?? crypto.randomUUID(),
}).catch((err) => logger.error({ err }, 'find-tools watcher failed'));
```

> `toolLibraryLoader`, `brokerCatalog`, and `toolReconciler` must be instantiated at orchestrator startup near where the existing catalog/reconciler are set up. `makeOrchestratorChatFn` is a thin adapter returning the assistant message string from the existing chat client; place it in `src/tool-selection/chat-adapter.ts`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/k8s/find-tools-watcher.test.ts && npm run build`
Expected: PASS and a clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/k8s/ipc-redis.ts src/index.ts src/tool-selection/chat-adapter.ts
git commit -m "feat(tool-selection): orchestrator find-tools watcher + startup wiring"
```

---

## Task 10: Channel-side `find_tools` client + tool surface

**Files:**
- Create: `src/runtime/find-tools-client.ts`
- Modify: `src/runtime/direct-llm-runner.ts` (TOOLS entries + dispatch)
- Test: `src/runtime/find-tools-client.test.ts`

**Interfaces:**
- Consumes: `getFindToolsStream`/`getFindToolsResultStream` (Task 1); `getRedisClient`; `FindToolsResult` (Task 2).
- Produces:
  - `async function requestFindTools(args: { groupFolder: string; channel: string; taskDescription: string }): Promise<string>` — XADD request, block-read result (mirror `executeToolViaK8s` polling), return a human-readable string for the LLM.
  - `async function requestCredentialApproval(args: { groupFolder: string; channel: string; requestId: string; toolName: string; catalogId: string; approvalToken: string }): Promise<string>`

- [ ] **Step 1: Write the failing test** (inject a fake redis so no live server is needed — factor the polling into `awaitFindToolsResult(redis, requestId, deadlineMs)`)

```typescript
import { formatFindToolsResult } from './find-tools-client';

describe('formatFindToolsResult', () => {
  it('formats a ready result for the LLM', () => {
    const s = formatFindToolsResult(JSON.stringify({ status: 'ready', tools: [{ name: 'extract_metadata', description: 'EXIF', provenance: 'library' }], message: 'Activated.' }));
    expect(s).toContain('extract_metadata');
    expect(s).toContain('ready');
  });

  it('formats a pending_credential result with the approval ask', () => {
    const s = formatFindToolsResult(JSON.stringify({ status: 'pending_credential', toolName: 'image_search', catalogId: 'brave-search', host: 'api.search.brave.com', approvalToken: 't', message: 'needs key' }));
    expect(s).toContain('approval');
    expect(s).toContain('brave-search');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/runtime/find-tools-client.test.ts`
Expected: FAIL — cannot find module `./find-tools-client`.

- [ ] **Step 3: Implement the client** (model polling on `executeToolViaK8s`, `src/runtime/direct-llm-runner.ts:456-485`)

```typescript
import crypto from 'node:crypto';
import { getRedisClient } from '../k8s/redis-client';
import { getFindToolsStream, getFindToolsResultStream } from '../k8s/redis-client';
import type { FindToolsResult } from '../tool-selection/types';

const FIND_TOOLS_TIMEOUT_MS = 120_000;

export function formatFindToolsResult(json: string): string {
  let r: FindToolsResult;
  try {
    r = JSON.parse(json) as FindToolsResult;
  } catch {
    return 'Tool search failed: malformed result.';
  }
  if (r.status === 'ready') {
    const names = r.tools.map((t) => `${t.name} (${t.provenance}): ${t.description}`).join('; ');
    return `status=ready. ${r.message} Now available: ${names}. Call the tool by name.`;
  }
  if (r.status === 'pending_credential') {
    return (
      `status=pending_credential. ${r.message} ` +
      `Ask the user to approve using the "${r.catalogId}" credential (host ${r.host}) for tool "${r.toolName}". ` +
      `If they agree, call approve_tool_credential with tool_name="${r.toolName}", catalog_id="${r.catalogId}", approval_token="${r.approvalToken}".`
    );
  }
  return `status=unavailable. ${r.message}`;
}

async function awaitFindToolsResult(requestId: string): Promise<string> {
  const redis = getRedisClient();
  const resultsStream = getFindToolsResultStream(requestId);
  const deadline = Date.now() + FIND_TOOLS_TIMEOUT_MS;
  let lastId = '0-0';
  while (Date.now() < deadline) {
    const blockMs = Math.min(deadline - Date.now(), 5000);
    const resp = await redis.xread('COUNT', 10, 'BLOCK', blockMs, 'STREAMS', resultsStream, lastId);
    if (!resp) continue;
    for (const [, messages] of resp as [string, [string, string[]][]][]) {
      for (const [msgId, fields] of messages) {
        lastId = msgId;
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        if (obj.result) return formatFindToolsResult(obj.result);
      }
    }
  }
  return 'Tool search timed out.';
}

export async function requestFindTools(args: {
  groupFolder: string;
  channel: string;
  taskDescription: string;
}): Promise<string> {
  const requestId = crypto.randomUUID();
  await getRedisClient().xadd(
    getFindToolsStream(), '*',
    'requestId', requestId,
    'groupFolder', args.groupFolder,
    'channel', args.channel,
    'taskDescription', args.taskDescription,
  );
  return awaitFindToolsResult(requestId);
}

export async function requestCredentialApproval(args: {
  groupFolder: string;
  channel: string;
  toolName: string;
  catalogId: string;
  approvalToken: string;
}): Promise<string> {
  const requestId = crypto.randomUUID();
  await getRedisClient().xadd(
    getFindToolsStream(), '*',
    'requestId', requestId,
    'kind', 'approve',
    'groupFolder', args.groupFolder,
    'channel', args.channel,
    'toolName', args.toolName,
    'catalogId', args.catalogId,
    'approvalToken', args.approvalToken,
  );
  return awaitFindToolsResult(requestId);
}
```

- [ ] **Step 4: Add the TOOLS entries** in `src/runtime/direct-llm-runner.ts` (append to the `TOOLS` array, matching the existing entry shape):

```typescript
{
  type: 'function',
  function: {
    name: 'find_tools',
    description:
      'Find and enable a tool capability you do not currently have (e.g. image search, ' +
      'metadata extraction). Describe the capability you need in plain language. The system ' +
      'searches trusted tools first and enables the best match. If the tool needs a secret, ' +
      'you will get a pending_credential result to relay to the user for approval.',
    parameters: {
      type: 'object',
      properties: {
        task_description: { type: 'string', description: 'The capability you need, in plain language.' },
      },
      required: ['task_description'],
    },
  },
},
{
  type: 'function',
  function: {
    name: 'approve_tool_credential',
    description:
      'Call ONLY after the user explicitly approves using a credential that a prior find_tools ' +
      'result reported as pending_credential. Pass the exact tool_name, catalog_id, and approval_token ' +
      'from that result.',
    parameters: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        catalog_id: { type: 'string' },
        approval_token: { type: 'string' },
      },
      required: ['tool_name', 'catalog_id', 'approval_token'],
    },
  },
},
```

> Also add `'find_tools'` and `'approve_tool_credential'` to `RESERVED_NAMES` in `src/tools/types.ts` so a registered tool can never shadow them.

- [ ] **Step 5: Add dispatch branches** in the tool-dispatch if/else (`src/runtime/direct-llm-runner.ts:~1285`), BEFORE the catalog fallthrough:

```typescript
} else if (call.function.name === 'find_tools') {
  result = await requestFindTools({
    groupFolder: input.groupFolder,
    channel: KUBECLAW_CHANNEL,
    taskDescription: String(args.task_description ?? ''),
  });
} else if (call.function.name === 'approve_tool_credential') {
  result = await requestCredentialApproval({
    groupFolder: input.groupFolder,
    channel: KUBECLAW_CHANNEL,
    toolName: String(args.tool_name ?? ''),
    catalogId: String(args.catalog_id ?? ''),
    approvalToken: String(args.approval_token ?? ''),
  });
```

- [ ] **Step 6: Run tests + build**

Run: `npx vitest run src/runtime/find-tools-client.test.ts && npm run build`
Expected: PASS and clean compile.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/find-tools-client.ts src/runtime/direct-llm-runner.ts src/tools/types.ts src/runtime/find-tools-client.test.ts
git commit -m "feat(tool-selection): add find_tools + approve_tool_credential channel tools"
```

---

## Task 11: TTL sweep

**Files:**
- Modify: `src/index.ts` (register a recurring sweep) OR `src/task-scheduler.ts` (preferred: add an internal recurring job)
- Create: `src/tool-selection/sweep.ts`
- Test: `src/tool-selection/sweep.test.ts`

**Interfaces:**
- Consumes: `pruneStaleAutoTools` (Task 3); `removeTool` (`src/skills/orchestrator/tool-registry.ts`); `ToolReconciler.apply`.
- Produces: `async function sweepStaleAutoTools(deps: { now: number; ttlMs: number; reconcile: () => Promise<void> }): Promise<string[]>` — prunes provenance rows AND removes the corresponding `tool_overrides` entries, then reconciles once if anything changed.

- [ ] **Step 1: Write the failing test**

```typescript
import { resetDbForTest } from '../db';
import { recordAutoTool, getAutoTool } from './provenance';
import { registerTool, listToolOverrides } from '../skills/orchestrator/tool-registry';
import { sweepStaleAutoTools } from './sweep';
import type { ToolSpec } from '../tools/types';

const spec: ToolSpec = { name: 'stale_tool', description: 'd', parameters: {}, image: 'i', pattern: 'file' };

describe('sweepStaleAutoTools', () => {
  beforeEach(() => resetDbForTest());

  it('removes the override and provenance for an idle auto tool and reconciles', async () => {
    registerTool(spec);
    recordAutoTool({ name: 'stale_tool', provenance: 'discovered', scopeGroup: 'g', now: 0 });
    let reconciled = 0;
    const pruned = await sweepStaleAutoTools({ now: 10_000, ttlMs: 5_000, reconcile: async () => { reconciled++; } });
    expect(pruned).toEqual(['stale_tool']);
    expect(getAutoTool('stale_tool')).toBeUndefined();
    expect(listToolOverrides().some((t) => t.name === 'stale_tool')).toBe(false);
    expect(reconciled).toBe(1);
  });

  it('does not reconcile when nothing is stale', async () => {
    let reconciled = 0;
    await sweepStaleAutoTools({ now: 1, ttlMs: 5_000, reconcile: async () => { reconciled++; } });
    expect(reconciled).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/sweep.test.ts`
Expected: FAIL — cannot find module `./sweep`.

- [ ] **Step 3: Implement the sweep**

```typescript
import { pruneStaleAutoTools } from './provenance';
import { removeTool } from '../skills/orchestrator/tool-registry';

export async function sweepStaleAutoTools(deps: {
  now: number;
  ttlMs: number;
  reconcile: () => Promise<void>;
}): Promise<string[]> {
  const pruned = pruneStaleAutoTools(deps.now, deps.ttlMs);
  for (const name of pruned) {
    removeTool({ name }); // no per-call reconcile; we reconcile once below
  }
  if (pruned.length > 0) await deps.reconcile();
  return pruned;
}
```

- [ ] **Step 4: Register the recurring sweep** at orchestrator startup in `src/index.ts` using a simple interval (the sweep is internal, not a user `ScheduledTask`):

```typescript
const TOOL_TTL_MS = Number(process.env.AUTO_TOOL_TTL_MS ?? 14 * 24 * 60 * 60 * 1000); // 14d
const SWEEP_INTERVAL_MS = Number(process.env.AUTO_TOOL_SWEEP_MS ?? 60 * 60 * 1000); // hourly
setInterval(() => {
  void sweepStaleAutoTools({ now: Date.now(), ttlMs: TOOL_TTL_MS, reconcile: () => toolReconciler.apply() })
    .then((pruned) => { if (pruned.length) logger.info({ pruned }, 'pruned stale auto tools'); })
    .catch((err) => logger.warn({ err }, 'auto-tool sweep failed'));
}, SWEEP_INTERVAL_MS);
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run src/tool-selection/sweep.test.ts && npm run build`
Expected: PASS and clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/tool-selection/sweep.ts src/index.ts src/tool-selection/sweep.test.ts
git commit -m "feat(tool-selection): add TTL sweep for stale auto-acquired tools"
```

---

## Task 12: Seed the curated library (Helm) + provenance touch on use

**Files:**
- Modify: `helm/kubeclaw/values.yaml` (add `toolLibrary:`)
- Create: `helm/kubeclaw/templates/tool-library-configmap.yaml`
- Modify: orchestrator startup to mount/point `ToolLibraryLoader` at the rendered library path
- Modify: `src/k8s/ipc-redis.ts` `startToolPodSpawnWatcher` — call `touchAutoTool(category, Date.now())` when a spawned tool is an auto tool (so TTL reflects real use)
- Test: `helm/kubeclaw/tests/` (helm template render test, matching existing helm test pattern) + extend `find-tools-watcher.test.ts` for the touch behavior

**Interfaces:**
- Consumes: `touchAutoTool` (Task 3); `getAutoTool`.
- Produces: a mounted `kubeclaw-tool-library` ConfigMap at a known path (e.g. `/etc/kubeclaw/tool-library/library.json`) consumed by `ToolLibraryLoader`.

- [ ] **Step 1: Add the library seed to `helm/kubeclaw/values.yaml`** (two credential-free-friendly seeds; image-fetch declares `brave-search` to exercise the gate):

```yaml
# Curated library of vetted-but-inactive tools the Tool Selection Agent can activate on demand.
toolLibrary:
  tools:
    - name: extract_metadata
      description: Extract EXIF and file metadata from an image stored in the group workspace.
      parameters:
        type: object
        properties:
          filename: { type: string, description: "Path to the image file under the group workspace" }
        required: [filename]
      image: kubeclaw/exiftool:latest
      pattern: file
      mount: group
      run: 'exiftool "$(cat "$INPUT_DIR/filename")"'
    - name: image_search
      description: Search the web for an image matching a query and download it into the group workspace.
      parameters:
        type: object
        properties:
          query: { type: string }
        required: [query]
      image: kubeclaw/image-search:latest
      pattern: http
      credentials: [brave-search]
```

- [ ] **Step 2: Create the ConfigMap template** `helm/kubeclaw/templates/tool-library-configmap.yaml` (mirror the existing tool-catalog ConfigMap template):

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubeclaw-tool-library
  namespace: {{ include "kubeclaw.namespace" . }}
data:
  library.json: |
    {{ dict "version" 1 "generation" 1 "tools" .Values.toolLibrary.tools | toJson | nindent 4 }}
```

- [ ] **Step 3: Write a helm render test** (match the repo's existing helm test harness; assert the ConfigMap renders both tool names). Run the repo's helm test command (e.g. `npm run test:helm` if present, else `helm template`):

```bash
helm template helm/kubeclaw | grep -A2 'kubeclaw-tool-library' | grep -q 'extract_metadata' && echo OK
```
Expected: `OK`.

- [ ] **Step 4: Mount the ConfigMap** on the orchestrator deployment (`helm/kubeclaw/templates/orchestrator.yaml`) at `/etc/kubeclaw/tool-library` and point `ToolLibraryLoader` there in `src/index.ts`:

```typescript
const toolLibraryLoader = new ToolLibraryLoader(
  process.env.TOOL_LIBRARY_PATH ?? '/etc/kubeclaw/tool-library/library.json',
);
toolLibraryLoader.start();
```

- [ ] **Step 5: Add the provenance touch** in `startToolPodSpawnWatcher` (after a successful `createSidecarToolPodJob`):

```typescript
if (getAutoTool(category)) touchAutoTool(category, Date.now());
```

- [ ] **Step 6: Run tests + build**

Run: `npm run build && npx vitest run src/tool-selection src/k8s/find-tools-watcher.test.ts`
Expected: PASS and clean compile.

- [ ] **Step 7: Commit**

```bash
git add helm/kubeclaw/values.yaml helm/kubeclaw/templates/tool-library-configmap.yaml helm/kubeclaw/templates/orchestrator.yaml src/index.ts src/k8s/ipc-redis.ts
git commit -m "feat(tool-selection): seed curated library and touch provenance on use"
```

---

## Task 13: Integration test — full tier-1/2 round-trip over Redis

**Files:**
- Create: `src/tool-selection/integration.test.ts` (uses a real in-process Redis client against the test Redis the repo already uses for IPC tests, or `ioredis-mock` if that is the existing convention — match the pattern in existing `src/k8s/*.test.ts`)

**Interfaces:**
- Consumes: `requestFindTools` (Task 10), `startFindToolsWatcher`/`handleFindToolsMessage` (Task 9), a stubbed `chat`.

- [ ] **Step 1: Write the integration test**

```typescript
// Spins the watcher handler against a real/mock redis; asserts a request
// produces a ready result on the result stream and the tool is registered.
import { handleFindToolsMessage } from '../k8s/ipc-redis';
import { resetDbForTest } from '../db';
import { listToolOverrides } from '../skills/orchestrator/tool-registry';
import type { ToolSpec } from '../tools/types';

const exif: ToolSpec = { name: 'extract_metadata', description: 'EXIF', parameters: {}, image: 'i', pattern: 'file', mount: 'group' };

describe('find-tools integration', () => {
  beforeEach(() => resetDbForTest());

  it('activates a library tool end-to-end through the handler', async () => {
    const written: Record<string, string> = {};
    let reconciled = 0;
    await handleFindToolsMessage(
      { requestId: 'rid', groupFolder: 'g', channel: 'http', taskDescription: 'extract exif' },
      {
        chat: async () => JSON.stringify({ name: 'extract_metadata', confidence: 0.95, reason: 'ok' }),
        liveCatalog: () => [],
        library: () => [exif],
        catalogHostLookup: () => undefined,
        reconcile: async () => { reconciled++; },
        writeResult: async (id, json) => { written[id] = json; },
        secret: 's',
      },
    );
    expect(JSON.parse(written['rid']).status).toBe('ready');
    expect(listToolOverrides().some((t) => t.name === 'extract_metadata')).toBe(true);
    expect(reconciled).toBe(1);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/tool-selection/integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tool-selection/integration.test.ts
git commit -m "test(tool-selection): integration test for tier-1/2 find-tools round-trip"
```

---

## Phase 1 E2E (deferred to a combined e2e in Phase 2/3)

The full channel→minikube e2e (find_tools → activate exiftool → save to group PVC → read back → report) requires the network/securityContext work and the seeded images to be buildable. The e2e is specified in Phase 2 (hardened path) and Phase 3 (discovery path). Phase 1 ships with unit + integration coverage above. **State this explicitly in the Phase 1 completion report** — do not claim e2e coverage for Phase 1 alone.

---

## Self-Review Notes (addressed)

- **Spec coverage:** tiers 1–2 (Tasks 5,7,12), `find_tools` surface + privileged orchestrator subagent (Tasks 9,10), in-channel credential gate (Tasks 6,8,10), promote + provenance + TTL/GC (Tasks 3,11), tier-dependent scope (library global here; discovered/group-scope is Phase 3), seeded library (Task 12). Tier-3 explicitly deferred. Network containment explicitly deferred to Phase 2.
- **Type consistency:** `FindToolsResult`, `ToolCandidate`, `Provenance`, `ChatFn`, `TsaDeps`, `ApprovalDeps` are defined once and reused; `registerTool`/`removeTool`/`ToolReconciler.apply` signatures match the reference sheet.
- **Placeholders:** none — every code step is complete. Two verification notes ("confirm import path", "match existing test reset helper") are integration checks, not deferred work.
