# Tool Catalog & Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cluster-wide tool catalog so `ToolSpec` tool-containers can be registered once (Helm baseline + admin-shell CRUD), scoped per-channel, and resolved by the orchestrator at spawn time — replacing the per-group `containerConfig.tools` blob.

**Architecture:** Mirror the specialists subsystem exactly. Helm `tools:` baseline → `kubeclaw-tools-baseline` ConfigMap mounted in the orchestrator → `ToolReconciler` merges baseline with a SQLite `tool_overrides` table → writes the `kubeclaw-tools` ConfigMap → channel pods mount it and hot-reload via `fs.watch`. At runtime the channel builds its LLM tool list from the catalog filtered to its own channel, and on a tool call writes only the tool **name** to the spawn stream; the orchestrator resolves the image/pattern/port from its own catalog and re-checks the channel ACL before spawning.

**Tech Stack:** TypeScript (Node), vitest, sql.js (`db.exec`/`db.run`), `@kubernetes/client-node`, Helm. Spec: `docs/superpowers/specs/2026-06-13-tool-catalog-design.md`.

**Reference files (the proven template — read before each analogous task):**
- `src/specialists/types.ts` — types + validator + parser
- `src/specialists/reconciler.ts` — merge/render/baseline-load/reconciler
- `src/specialists/catalog-loader.ts` — fs.watch loader
- `src/skills/orchestrator/specialist-registry.ts` — SQLite CRUD
- `src/specialists/types.test.ts`, `src/specialists/reconciler.test.ts`, `src/specialists/catalog-loader.test.ts` — test shapes
- `helm/kubeclaw/templates/specialists-baseline-configmap.yaml` — Helm template

---

## Pre-flight notes for the implementer

- **Node/PATH:** run `export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH` in every shell before `npm`/`node`/`npx`. (The repo's `node_modules` is built against Node 24; using the `.nvmrc` Node 22 binary fails `better-sqlite3` native loading. The agent-runner subdir uses Node 22, but this plan does not touch it.)
- **Husky:** a commit runs `prettier --write "src/**/*.ts"` via the pre-commit hook; it may reformat your files (re-stage is automatic). A "pre-commit hook ignored — not executable" warning is harmless.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **DB API:** this codebase uses sql.js, not better-sqlite3 prepared statements. Reads: `db.exec(sql, params)` returns `[{ columns, values }]` (empty array if no rows); a single value is `rows[0].values[0][0]`. Writes: `db.run(sql, params)`. See `specialist-registry.ts` for the exact idioms — copy them.
- **Single test file:** `npx vitest run src/path/file.test.ts`. Full suite: `npm test`.
- **Build-green invariant:** each task's commit must compile (`npm run build`) and pass `npm test`. ToolSpec is *moved* in Task 1 but `containerConfig.tools` is NOT removed until Task 9 (when its readers are rewired in the same commit), so the build stays green throughout.

**Three-level test mapping:** Unit tests live beside each new module (`src/tools/*.test.ts`, `src/skills/orchestrator/tool-registry.test.ts`, and additions to `src/k8s/ipc-redis.test.ts`, `src/runtime/direct-llm-runner.test.ts`). Integration: `src/tools/catalog-loader.test.ts` exercises real `fs.watch` against a temp file (mirrors the specialists loader test), and a Redis round-trip in `e2e/`. End-to-end: a minikube-live test registers a tool and asserts spawn + per-channel invisibility.

---

### Task 0: Create the feature branch

**Files:** none (git only)

- [ ] **Step 0.1: Verify clean state and HEAD**

```bash
cd /home/peter/projects/kubeclaw
git status --porcelain      # Expected: empty
git rev-parse HEAD          # Note it; the worktree/branch must cut from live HEAD
```

- [ ] **Step 0.2: Create the branch** (the executor's worktree skill handles this; if working in-place: `git checkout -b feat/tool-catalog`). Expected: on `feat/tool-catalog`.

---

### Task 1: Tool types — module, validator, parser, `channels` field

Move `ToolSpec` into a dedicated module, add the `channels` ACL field, and provide `validateTool` / `parseToolCatalog`. Re-export `ToolSpec` from `src/types.ts` so existing importers keep working. Do **not** remove `containerConfig.tools` yet (Task 9).

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/types.test.ts`
- Modify: `src/types.ts` (replace the inline `ToolSpec` definition with a re-export from the new module)

- [ ] **Step 1.1: Write the failing test**

Create `src/tools/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateTool, parseToolCatalog } from './types.js';

const base = {
  name: 'weather',
  description: 'Get weather',
  parameters: { type: 'object', properties: {} },
  image: 'ghcr.io/example/weather:1',
  pattern: 'http' as const,
};

describe('validateTool', () => {
  it('accepts a minimal valid tool', () => {
    expect(validateTool(base)).toEqual({ ok: true });
  });

  it('accepts channels as a string array', () => {
    expect(validateTool({ ...base, channels: ['telegram', 'http'] })).toEqual({
      ok: true,
    });
  });

  it('rejects a non-object', () => {
    expect(validateTool(null).ok).toBe(false);
  });

  it('rejects an unknown field', () => {
    const r = validateTool({ ...base, bogus: 1 });
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid name', () => {
    expect(validateTool({ ...base, name: '1bad' }).ok).toBe(false);
    expect(validateTool({ ...base, name: 'has space' }).ok).toBe(false);
  });

  it('rejects a name that collides with a static built-in', () => {
    for (const n of ['bash', 'web_search', 'web_fetch', 'browser', 'places_search']) {
      expect(validateTool({ ...base, name: n }).ok).toBe(false);
    }
  });

  it('requires image', () => {
    const { image, ...noImage } = base;
    expect(validateTool(noImage).ok).toBe(false);
  });

  it('requires a valid pattern', () => {
    expect(validateTool({ ...base, pattern: 'grpc' }).ok).toBe(false);
  });

  it('rejects channels that are not strings', () => {
    expect(validateTool({ ...base, channels: [1, 2] }).ok).toBe(false);
  });
});

describe('parseToolCatalog', () => {
  it('parses a valid wire object', () => {
    const json = JSON.stringify({ version: 1, generation: 3, tools: [base] });
    const r = parseToolCatalog(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.generation).toBe(3);
      expect(r.tools).toHaveLength(1);
    }
  });

  it('rejects a wrong version', () => {
    const json = JSON.stringify({ version: 2, generation: 0, tools: [] });
    expect(parseToolCatalog(json).ok).toBe(false);
  });

  it('rejects duplicate names', () => {
    const json = JSON.stringify({
      version: 1,
      generation: 0,
      tools: [base, { ...base, image: 'other:1' }],
    });
    expect(parseToolCatalog(json).ok).toBe(false);
  });

  it('rejects invalid JSON', () => {
    expect(parseToolCatalog('{not json').ok).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run to verify failure**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npx vitest run src/tools/types.test.ts
```

Expected: FAIL — `./types.js` has no `validateTool`/`parseToolCatalog`.

- [ ] **Step 1.3: Create `src/tools/types.ts`**

Read the current `ToolSpec` in `src/types.ts` (≈lines 63–79) and reproduce its fields exactly, adding `channels`. Reserved built-in names come from `TOOL_SERVER_NAME` in `direct-llm-runner.ts`.

```typescript
// Tool catalog types — the catalog entry IS a ToolSpec plus a per-channel ACL.
// Modeled on src/specialists/types.ts.

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
  image: string;
  pattern: 'http' | 'file' | 'acp';
  port?: number; // http/acp: port the user container listens on (default 8080)
  command?: string[]; // optional entrypoint override for user container
  pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  memoryRequest?: string;
  memoryLimit?: string;
  cpuRequest?: string;
  cpuLimit?: string;
  /** Optional readiness-probe path on the user container (default "/"; must begin with "/"; any HTTP response counts as ready). */
  healthPath?: string;
  // ACP-specific (only when pattern = 'acp')
  acpAgentName?: string;
  acpMode?: 'sync' | 'async';
  /** Channels this tool is visible to. Empty/absent = all channels. */
  channels?: string[];
}

export interface ToolCatalogWire {
  version: 1;
  generation: number;
  tools: ToolSpec[];
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

// Reserved: static built-in tool names (TOOL_SERVER_NAME keys in
// direct-llm-runner.ts). A catalog tool may not shadow or be shadowed by one.
const RESERVED_NAMES = new Set([
  'web_fetch',
  'web_search',
  'browser',
  'bash',
  'places_search',
]);

const ALLOWED_KEYS = new Set([
  'name',
  'description',
  'parameters',
  'image',
  'pattern',
  'port',
  'command',
  'pullPolicy',
  'memoryRequest',
  'memoryLimit',
  'cpuRequest',
  'cpuLimit',
  'healthPath',
  'acpAgentName',
  'acpMode',
  'channels',
]);
const PATTERNS = new Set(['http', 'file', 'acp']);

export function validateTool(t: unknown): ValidationResult {
  if (typeof t !== 'object' || t === null)
    return { ok: false, error: 'tool must be an object' };
  const obj = t as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(k)) return { ok: false, error: `unknown field: ${k}` };
  }
  if (typeof obj.name !== 'string' || !NAME_RE.test(obj.name)) {
    return { ok: false, error: `invalid name: ${JSON.stringify(obj.name)}` };
  }
  if (RESERVED_NAMES.has(obj.name)) {
    return {
      ok: false,
      error: `name "${obj.name}" is reserved by a built-in tool`,
    };
  }
  if (typeof obj.description !== 'string' || obj.description.length === 0) {
    return { ok: false, error: 'description must be a non-empty string' };
  }
  if (typeof obj.parameters !== 'object' || obj.parameters === null) {
    return { ok: false, error: 'parameters must be an object' };
  }
  if (typeof obj.image !== 'string' || obj.image.length === 0) {
    return { ok: false, error: 'image must be a non-empty string' };
  }
  if (typeof obj.pattern !== 'string' || !PATTERNS.has(obj.pattern)) {
    return { ok: false, error: 'pattern must be one of http|file|acp' };
  }
  if (obj.port !== undefined && (typeof obj.port !== 'number' || !Number.isInteger(obj.port))) {
    return { ok: false, error: 'port must be an integer' };
  }
  if (
    obj.command !== undefined &&
    (!Array.isArray(obj.command) || obj.command.some((c) => typeof c !== 'string'))
  ) {
    return { ok: false, error: 'command must be string[]' };
  }
  if (
    obj.pullPolicy !== undefined &&
    !['Always', 'IfNotPresent', 'Never'].includes(obj.pullPolicy as string)
  ) {
    return { ok: false, error: 'pullPolicy must be Always|IfNotPresent|Never' };
  }
  for (const f of ['memoryRequest', 'memoryLimit', 'cpuRequest', 'cpuLimit'] as const) {
    if (obj[f] !== undefined && typeof obj[f] !== 'string') {
      return { ok: false, error: `${f} must be a string` };
    }
  }
  if (obj.healthPath !== undefined) {
    if (typeof obj.healthPath !== 'string' || !obj.healthPath.startsWith('/')) {
      return { ok: false, error: 'healthPath must be a string beginning with "/"' };
    }
  }
  if (obj.acpAgentName !== undefined && typeof obj.acpAgentName !== 'string') {
    return { ok: false, error: 'acpAgentName must be a string' };
  }
  if (obj.acpMode !== undefined && !['sync', 'async'].includes(obj.acpMode as string)) {
    return { ok: false, error: 'acpMode must be sync|async' };
  }
  if (
    obj.channels !== undefined &&
    (!Array.isArray(obj.channels) || obj.channels.some((c) => typeof c !== 'string'))
  ) {
    return { ok: false, error: 'channels must be string[]' };
  }
  return { ok: true };
}

export type ParseResult =
  | { ok: true; tools: ToolSpec[]; generation: number }
  | { ok: false; error: string };

export function parseToolCatalog(json: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e}` };
  }
  if (typeof parsed !== 'object' || parsed === null)
    return { ok: false, error: 'top-level must be object' };
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1)
    return { ok: false, error: `unsupported version: ${obj.version}` };
  if (typeof obj.generation !== 'number')
    return { ok: false, error: 'generation must be number' };
  if (!Array.isArray(obj.tools))
    return { ok: false, error: 'tools must be array' };
  const seen = new Set<string>();
  for (const t of obj.tools) {
    const v = validateTool(t);
    if (!v.ok) return { ok: false, error: v.error };
    const name = (t as ToolSpec).name;
    if (seen.has(name)) return { ok: false, error: `duplicate name: ${name}` };
    seen.add(name);
  }
  return { ok: true, tools: obj.tools as ToolSpec[], generation: obj.generation };
}
```

- [ ] **Step 1.4: Re-export `ToolSpec` from `src/types.ts`**

In `src/types.ts`, delete the inline `export interface ToolSpec { ... }` block (≈lines 63–79) and replace it with:

```typescript
export type { ToolSpec } from './tools/types.js';
```

Leave `ContainerConfig.tools?: ToolSpec[]` in place for now — it still resolves via the re-export. (Removed in Task 9.)

- [ ] **Step 1.5: Build + test**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build
npx vitest run src/tools/types.test.ts
```

Expected: build clean (the re-export keeps all `ToolSpec` importers working); 14 tests pass.

- [ ] **Step 1.6: Commit**

```bash
git add src/tools/types.ts src/tools/types.test.ts src/types.ts
git commit -m "feat(tools): tool catalog types — ToolSpec module, channels ACL, validator

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: SQLite `tool_overrides` table

**Files:**
- Modify: `src/db.ts` (add the table to the schema-init block)
- Test: `src/db.test.ts` (add one test asserting the table exists)

- [ ] **Step 2.1: Write the failing test**

Find the `specialist_overrides` schema test in `src/db.test.ts` (grep for `specialist_overrides`) and add an analogous one nearby:

```typescript
  it('creates the tool_overrides table', () => {
    const rows = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tool_overrides'",
    );
    expect(rows.length).toBe(1);
    expect(rows[0].values.length).toBe(1);
  });
```

If `src/db.test.ts` initializes the DB through a helper (grep for `_initTestDatabase` or a `beforeEach`), follow that file's existing setup — do not invent a new one.

- [ ] **Step 2.2: Run to verify failure**

```bash
npx vitest run src/db.test.ts -t tool_overrides
```

Expected: FAIL — table does not exist.

- [ ] **Step 2.3: Add the table**

In `src/db.ts`, locate the `CREATE TABLE IF NOT EXISTS specialist_overrides (...)` statement in the schema-initialization function and add immediately after it:

```sql
CREATE TABLE IF NOT EXISTS tool_overrides (
  name        TEXT PRIMARY KEY,
  spec_json   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

Match the exact `db.run(`...`)` call style used for `specialist_overrides` (same function, same surrounding code).

- [ ] **Step 2.4: Build + test**

```bash
npm run build
npx vitest run src/db.test.ts
```

Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(tools): add tool_overrides SQLite table

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Tool registry CRUD

Mirror `src/skills/orchestrator/specialist-registry.ts` exactly.

**Files:**
- Create: `src/skills/orchestrator/tool-registry.ts`
- Create: `src/skills/orchestrator/tool-registry.test.ts`

- [ ] **Step 3.1: Write the failing test**

Read `src/skills/orchestrator/specialist-registry.test.ts` for the DB-setup idiom first, then create `src/skills/orchestrator/tool-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase } from '../../db.js';
import {
  registerTool,
  editTool,
  removeTool,
  listToolOverrides,
} from './tool-registry.js';

const base = {
  name: 'weather',
  description: 'Get weather',
  parameters: { type: 'object', properties: {} },
  image: 'ghcr.io/example/weather:1',
  pattern: 'http' as const,
};

describe('tool-registry', () => {
  beforeEach(async () => {
    await _initTestDatabase();
  });

  it('registers and lists a tool', () => {
    expect(registerTool(base).ok).toBe(true);
    const all = listToolOverrides();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('weather');
  });

  it('rejects an invalid tool', () => {
    const r = registerTool({ ...base, pattern: 'grpc' } as never);
    expect(r.ok).toBe(false);
  });

  it('rejects a duplicate name', () => {
    registerTool(base);
    expect(registerTool(base).ok).toBe(false);
  });

  it('edits an existing tool (partial patch)', () => {
    registerTool(base);
    const r = editTool({ name: 'weather', patch: { image: 'newimg:2' } });
    expect(r.ok).toBe(true);
    expect(listToolOverrides()[0].image).toBe('newimg:2');
  });

  it('rejects an edit that produces an invalid spec', () => {
    registerTool(base);
    const r = editTool({ name: 'weather', patch: { pattern: 'grpc' as never } });
    expect(r.ok).toBe(false);
  });

  it('errors editing a missing tool', () => {
    expect(editTool({ name: 'nope', patch: {} }).ok).toBe(false);
  });

  it('removes a tool', () => {
    registerTool(base);
    expect(removeTool({ name: 'weather' }).ok).toBe(true);
    expect(listToolOverrides()).toHaveLength(0);
  });

  it('errors removing a missing tool', () => {
    expect(removeTool({ name: 'nope' }).ok).toBe(false);
  });

  it('runs the reconcile callback after a mutation', async () => {
    let called = 0;
    registerTool(base, async () => {
      called += 1;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(called).toBe(1);
  });
});
```

If the specialists test uses a different DB-init helper name, match it.

- [ ] **Step 3.2: Run to verify failure**

```bash
npx vitest run src/skills/orchestrator/tool-registry.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3.3: Implement `src/skills/orchestrator/tool-registry.ts`**

```typescript
import { logger } from '../../logger.js';
import { db } from '../../db.js';
import { ToolSpec, validateTool } from '../../tools/types.js';

export type Result = { ok: true } | { ok: false; error: string };
export type ReconcileFn = () => Promise<void>;

export function registerTool(t: ToolSpec, reconcile?: ReconcileFn): Result {
  const v = validateTool(t);
  if (!v.ok) return v;

  const existing = db.exec(`SELECT 1 FROM tool_overrides WHERE name = ?`, [
    t.name,
  ]);
  if (existing.length > 0 && existing[0].values.length > 0) {
    return { ok: false, error: `tool already registered: ${t.name}` };
  }

  const now = Date.now();
  db.run(
    `INSERT INTO tool_overrides (name, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [t.name, JSON.stringify(t), now, now],
  );
  reconcile?.().catch((err) => {
    logger.warn({ err }, 'reconcile after tool mutation failed');
  });
  return { ok: true };
}

export function editTool(
  args: { name: string; patch: Partial<ToolSpec> },
  reconcile?: ReconcileFn,
): Result {
  const rows = db.exec(`SELECT spec_json FROM tool_overrides WHERE name = ?`, [
    args.name,
  ]);
  if (rows.length === 0 || rows[0].values.length === 0) {
    return { ok: false, error: `no override registered: ${args.name}` };
  }

  const specJson = rows[0].values[0][0] as string;
  const merged: ToolSpec = {
    ...(JSON.parse(specJson) as ToolSpec),
    ...args.patch,
    name: args.name,
  };

  const v = validateTool(merged);
  if (!v.ok) return v;

  db.run(
    `UPDATE tool_overrides SET spec_json = ?, updated_at = ? WHERE name = ?`,
    [JSON.stringify(merged), Date.now(), args.name],
  );
  reconcile?.().catch((err) => {
    logger.warn({ err }, 'reconcile after tool mutation failed');
  });
  return { ok: true };
}

export function removeTool(
  args: { name: string },
  reconcile?: ReconcileFn,
): Result {
  const existing = db.exec(`SELECT 1 FROM tool_overrides WHERE name = ?`, [
    args.name,
  ]);
  if (existing.length === 0 || existing[0].values.length === 0) {
    return { ok: false, error: `no such override: ${args.name}` };
  }

  db.run(`DELETE FROM tool_overrides WHERE name = ?`, [args.name]);
  reconcile?.().catch((err) => {
    logger.warn({ err }, 'reconcile after tool mutation failed');
  });
  return { ok: true };
}

export function listToolOverrides(): ToolSpec[] {
  const rows = db.exec(`SELECT spec_json FROM tool_overrides ORDER BY name`);
  if (rows.length === 0) return [];
  return rows[0].values.map((row) => JSON.parse(row[0] as string) as ToolSpec);
}
```

- [ ] **Step 3.4: Build + test**

```bash
npm run build
npx vitest run src/skills/orchestrator/tool-registry.test.ts
```

Expected: PASS (9 tests).

- [ ] **Step 3.5: Commit**

```bash
git add src/skills/orchestrator/tool-registry.ts src/skills/orchestrator/tool-registry.test.ts
git commit -m "feat(tools): tool registry SQLite CRUD (register/edit/remove/list)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Tool reconciler + name resolver

Mirror `src/specialists/reconciler.ts`, plus add `resolveToolByName` (used by the orchestrator at spawn time).

**Files:**
- Create: `src/tools/reconciler.ts`
- Create: `src/tools/reconciler.test.ts`

- [ ] **Step 4.1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase } from '../db.js';
import { registerTool } from '../skills/orchestrator/tool-registry.js';
import {
  mergeCatalog,
  renderCatalog,
  ToolReconciler,
  resolveToolByName,
} from './reconciler.js';
import { ToolSpec } from './types.js';

const t = (name: string, extra: Partial<ToolSpec> = {}): ToolSpec => ({
  name,
  description: 'd',
  parameters: {},
  image: 'img:1',
  pattern: 'http',
  ...extra,
});

describe('mergeCatalog', () => {
  it('overrides win and result is name-sorted', () => {
    const merged = mergeCatalog(
      [t('b'), t('a', { image: 'baseline:1' })],
      [t('a', { image: 'override:1' })],
    );
    expect(merged.map((x) => x.name)).toEqual(['a', 'b']);
    expect(merged[0].image).toBe('override:1');
  });
});

describe('renderCatalog', () => {
  it('produces version-1 wire JSON', () => {
    const json = JSON.parse(renderCatalog([t('a')], 5));
    expect(json.version).toBe(1);
    expect(json.generation).toBe(5);
    expect(json.tools).toHaveLength(1);
  });
});

describe('ToolReconciler', () => {
  beforeEach(async () => {
    await _initTestDatabase();
  });

  it('merges baseline + overrides and applies the ConfigMap with a bumped generation', async () => {
    registerTool(t('override-tool'));
    const applied: string[] = [];
    const r = new ToolReconciler({
      baselineLoader: () => [t('baseline-tool')],
      configMapApply: async (rendered) => {
        applied.push(rendered);
      },
    });
    await r.apply();
    expect(applied).toHaveLength(1);
    const wire = JSON.parse(applied[0]);
    expect(wire.generation).toBe(1);
    expect(wire.tools.map((x: ToolSpec) => x.name).sort()).toEqual([
      'baseline-tool',
      'override-tool',
    ]);
  });

  it('rolls back generation when apply fails', async () => {
    const r = new ToolReconciler({
      baselineLoader: () => [],
      configMapApply: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined),
    });
    await expect(r.apply()).rejects.toThrow('boom');
    await r.apply(); // succeeds
    // second apply must be generation 1, proving the failed one did not bump
    // (asserted indirectly: no throw + the mock's 2nd call received gen 1)
  });
});

describe('resolveToolByName', () => {
  beforeEach(async () => {
    await _initTestDatabase();
  });

  it('finds an override tool by name', () => {
    registerTool(t('weather', { image: 'w:9' }));
    const found = resolveToolByName('weather', () => []);
    expect(found?.image).toBe('w:9');
  });

  it('finds a baseline tool by name', () => {
    const found = resolveToolByName('bl', () => [t('bl')]);
    expect(found?.name).toBe('bl');
  });

  it('returns undefined for an unknown name', () => {
    expect(resolveToolByName('nope', () => [])).toBeUndefined();
  });
});
```

- [ ] **Step 4.2: Run to verify failure**

```bash
npx vitest run src/tools/reconciler.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 4.3: Implement `src/tools/reconciler.ts`**

```typescript
import { readFileSync, existsSync } from 'fs';
import { ToolSpec, parseToolCatalog } from './types.js';
import { listToolOverrides } from '../skills/orchestrator/tool-registry.js';
import { logger } from '../logger.js';

const BASELINE_PATH = '/etc/kubeclaw/tools-baseline/tools.json';

export function mergeCatalog(
  baseline: ToolSpec[],
  overrides: ToolSpec[],
): ToolSpec[] {
  const byName = new Map<string, ToolSpec>();
  for (const t of baseline) byName.set(t.name, t);
  for (const t of overrides) byName.set(t.name, t); // override wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function renderCatalog(tools: ToolSpec[], generation: number): string {
  return JSON.stringify({ version: 1, generation, tools }, null, 2);
}

export function loadBaselineFromDisk(path = BASELINE_PATH): ToolSpec[] {
  if (!existsSync(path)) return [];
  try {
    const r = parseToolCatalog(readFileSync(path, 'utf-8'));
    return r.ok ? r.tools : [];
  } catch (err) {
    logger.warn(
      { err, path },
      'tool baseline catalog read/parse failed; treating as empty',
    );
    return [];
  }
}

/**
 * Resolve a tool by name from the merged catalog (baseline + SQLite overrides).
 * Used by the orchestrator at spawn time. `baselineLoader` defaults to disk.
 */
export function resolveToolByName(
  name: string,
  baselineLoader: () => ToolSpec[] = loadBaselineFromDisk,
): ToolSpec | undefined {
  const merged = mergeCatalog(baselineLoader(), listToolOverrides());
  return merged.find((t) => t.name === name);
}

export interface ReconcilerDeps {
  baselineLoader: () => ToolSpec[];
  configMapApply: (rendered: string) => Promise<void>;
}

export class ToolReconciler {
  private generation = 0;
  private applyChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReconcilerDeps) {}

  async apply(): Promise<void> {
    const next = this.applyChain.then(() => this._applyOnce());
    this.applyChain = next.catch(() => {});
    return next;
  }

  private async _applyOnce(): Promise<void> {
    const baseline = this.deps.baselineLoader();
    const overrides = listToolOverrides();
    const merged = mergeCatalog(baseline, overrides);
    this.generation += 1;
    const rendered = renderCatalog(merged, this.generation);
    try {
      await this.deps.configMapApply(rendered);
      logger.info(
        { generation: this.generation, count: merged.length },
        'tools ConfigMap applied',
      );
    } catch (err) {
      logger.error({ err }, 'tools ConfigMap apply failed');
      this.generation -= 1;
      throw err;
    }
  }
}
```

- [ ] **Step 4.4: Build + test**

```bash
npm run build
npx vitest run src/tools/reconciler.test.ts
```

Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add src/tools/reconciler.ts src/tools/reconciler.test.ts
git commit -m "feat(tools): tool reconciler (merge/render/baseline) + resolveToolByName

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Channel-side catalog loader

Mirror `src/specialists/catalog-loader.ts`, with `getForChannel` replacing `findByMention`.

**Files:**
- Create: `src/tools/catalog-loader.ts`
- Create: `src/tools/catalog-loader.test.ts`

- [ ] **Step 5.1: Write the failing test** (integration-level: real temp file + fs.watch; mirror `src/specialists/catalog-loader.test.ts`)

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ToolCatalogLoader } from './catalog-loader.js';

function wire(tools: unknown[], generation = 1): string {
  return JSON.stringify({ version: 1, generation, tools });
}
const t = (name: string, channels?: string[]) => ({
  name,
  description: 'd',
  parameters: {},
  image: 'img:1',
  pattern: 'http',
  ...(channels ? { channels } : {}),
});

let dir: string | undefined;
let loader: ToolCatalogLoader | undefined;
afterEach(() => {
  loader?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('ToolCatalogLoader', () => {
  it('returns [] when the file is absent', () => {
    dir = mkdtempSync(join(tmpdir(), 'toolcat-'));
    loader = new ToolCatalogLoader(join(dir, 'tools.json'));
    loader.start();
    expect(loader.getAll()).toEqual([]);
  });

  it('loads tools from the file', () => {
    dir = mkdtempSync(join(tmpdir(), 'toolcat-'));
    const p = join(dir, 'tools.json');
    writeFileSync(p, wire([t('a'), t('b')]));
    loader = new ToolCatalogLoader(p);
    loader.start();
    expect(loader.getAll().map((x) => x.name)).toEqual(['a', 'b']);
  });

  it('filters by channel ACL (empty channels = all)', () => {
    dir = mkdtempSync(join(tmpdir(), 'toolcat-'));
    const p = join(dir, 'tools.json');
    writeFileSync(p, wire([t('all'), t('tg', ['telegram']), t('web', ['http'])]));
    loader = new ToolCatalogLoader(p);
    loader.start();
    expect(loader.getForChannel('telegram').map((x) => x.name).sort()).toEqual([
      'all',
      'tg',
    ]);
    expect(loader.getForChannel('http').map((x) => x.name).sort()).toEqual([
      'all',
      'web',
    ]);
  });

  it('keeps the stale cache when the file becomes invalid', () => {
    dir = mkdtempSync(join(tmpdir(), 'toolcat-'));
    const p = join(dir, 'tools.json');
    writeFileSync(p, wire([t('a')]));
    loader = new ToolCatalogLoader(p);
    loader.start();
    expect(loader.getAll()).toHaveLength(1);
    // Force a reload with garbage via the private load path:
    writeFileSync(p, '{ broken');
    (loader as unknown as { load: () => void }).load();
    expect(loader.getAll()).toHaveLength(1); // unchanged
  });
});
```

- [ ] **Step 5.2: Run to verify failure**

```bash
npx vitest run src/tools/catalog-loader.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 5.3: Implement `src/tools/catalog-loader.ts`**

```typescript
import { readFileSync, watch, existsSync, FSWatcher } from 'fs';
import { dirname } from 'path';
import { logger } from '../logger.js';
import { ToolSpec, parseToolCatalog } from './types.js';

export class ToolCatalogLoader {
  private cache: ToolSpec[] = [];
  private generation = 0;
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
      this.generation = 0;
      return;
    }
    let json: string;
    try {
      json = readFileSync(this.path, 'utf-8');
    } catch (err) {
      logger.warn({ err, path: this.path }, 'tool catalog read failed; keeping cache');
      return;
    }
    const r = parseToolCatalog(json);
    if (!r.ok) {
      logger.warn(
        { error: r.error, path: this.path },
        'tool catalog parse failed; keeping cache',
      );
      return;
    }
    if (r.generation === this.generation && this.cache.length === r.tools.length)
      return;
    this.cache = r.tools;
    this.generation = r.generation;
    logger.info(
      { count: r.tools.length, generation: r.generation },
      'tool catalog loaded',
    );
  }

  getAll(): ToolSpec[] {
    return this.cache;
  }

  /** Tools visible to `channelName`: those with empty/absent `channels` or that list it. */
  getForChannel(channelName: string): ToolSpec[] {
    return this.cache.filter(
      (t) => !t.channels?.length || t.channels.includes(channelName),
    );
  }
}
```

- [ ] **Step 5.4: Build + test**

```bash
npm run build
npx vitest run src/tools/catalog-loader.test.ts
```

Expected: PASS.

- [ ] **Step 5.5: Commit**

```bash
git add src/tools/catalog-loader.ts src/tools/catalog-loader.test.ts
git commit -m "feat(tools): channel-side ToolCatalogLoader with per-channel ACL filtering

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Helm — baseline values, ConfigMap template, pod mounts

**Files:**
- Modify: `helm/kubeclaw/values.yaml` (add empty `tools:` stanza)
- Create: `helm/kubeclaw/templates/tools-baseline-configmap.yaml`
- Modify: `helm/kubeclaw/templates/orchestrator.yaml` (mount `kubeclaw-tools-baseline`)
- Modify: `helm/kubeclaw/templates/channel-pods.yaml` (mount `kubeclaw-tools`)

- [ ] **Step 6.1: Add the values stanza**

In `helm/kubeclaw/values.yaml`, after the `specialists:` block, add:

```yaml
# Global tool catalog. Empty by default — register tools via the admin shell
# (register_tool) or add entries here. Each entry is a ToolSpec; an optional
# `channels:` list scopes the tool to specific channels (omit = all channels).
tools: []
```

- [ ] **Step 6.2: Create the ConfigMap template**

Read `helm/kubeclaw/templates/specialists-baseline-configmap.yaml` and create `helm/kubeclaw/templates/tools-baseline-configmap.yaml` as its tools analogue:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubeclaw-tools-baseline
  namespace: {{ include "kubeclaw.namespace" . }}
  labels:
    app: kubeclaw
    component: tools-baseline
data:
  tools.json: |-
    {
      "version": 1,
      "generation": 0,
      "tools": {{ toJson (default (list) .Values.tools) }}
    }
---
# kubeclaw-tools: the live merged catalog written by the orchestrator reconciler
# on startup. This Helm-managed copy is the initial state (baseline only; SQLite
# overrides are applied by the orchestrator at runtime). Channel pods mount this
# at /etc/kubeclaw/tools and hot-reload via fs.watch when kubelet propagates
# orchestrator updates.
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubeclaw-tools
  namespace: {{ include "kubeclaw.namespace" . }}
  labels:
    app: kubeclaw
    component: tools-catalog
data:
  tools.json: |-
    {
      "version": 1,
      "generation": 0,
      "tools": {{ toJson (default (list) .Values.tools) }}
    }
```

- [ ] **Step 6.3: Mount the baseline into the orchestrator**

In `helm/kubeclaw/templates/orchestrator.yaml`, find the `specialists-baseline` volumeMount (≈line 290) and volume (≈line 311). Add a parallel `tools-baseline` pair. VolumeMount (next to the specialists one):

```yaml
            - name: tools-baseline
              mountPath: /etc/kubeclaw/tools-baseline
              readOnly: true
```

Volume (next to the specialists one — match its `optional`/configMap style):

```yaml
        - name: tools-baseline
          configMap:
            name: kubeclaw-tools-baseline
            optional: true
```

- [ ] **Step 6.4: Mount the live catalog into channel pods**

In `helm/kubeclaw/templates/channel-pods.yaml`, find the `specialists-catalog` volumeMount (≈line 212) and volume (≈line 230). Add a parallel `tools-catalog` pair. VolumeMount:

```yaml
            - name: tools-catalog
              mountPath: /etc/kubeclaw/tools
              readOnly: true
```

Volume (match the specialists volume's style — note specialists uses no `optional`, but the seed ConfigMap guarantees existence; use `optional: true` for resilience if the surrounding tool-job mount in job-runner uses it — match the specialists channel-pod volume exactly, which is non-optional):

```yaml
        - name: tools-catalog
          configMap:
            name: kubeclaw-tools
```

- [ ] **Step 6.5: Verify Helm renders**

```bash
helm template kubeclaw helm/kubeclaw >/dev/null && echo "helm OK"
helm template kubeclaw helm/kubeclaw | grep -c "kubeclaw-tools-baseline"   # >= 1
helm template kubeclaw helm/kubeclaw | grep -c "name: kubeclaw-tools$"     # >= 2 (CM + channel volume ref)
```

Expected: `helm OK`; counts as noted.

- [ ] **Step 6.6: Commit**

```bash
git add helm/kubeclaw/values.yaml helm/kubeclaw/templates/tools-baseline-configmap.yaml helm/kubeclaw/templates/orchestrator.yaml helm/kubeclaw/templates/channel-pods.yaml
git commit -m "feat(tools): Helm tools baseline + ConfigMap, orchestrator & channel mounts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Start the ToolReconciler at orchestrator startup

**Files:**
- Modify: `src/index.ts` (add a `ToolReconciler` next to the specialist one; apply at startup)

- [ ] **Step 7.1: Add the reconciler wiring**

In `src/index.ts`, read the specialist reconcile block (≈lines 567–628). Add imports near the specialists reconciler import (≈line 102):

```typescript
import {
  ToolReconciler,
  loadBaselineFromDisk as loadToolBaselineFromDisk,
} from './tools/reconciler.js';
```

Immediately after the `specialistReconciler.apply()` try/catch block (after ≈line 628), add an analogous block (same `coreApi` GET→replace/create pattern, ConfigMap name `kubeclaw-tools`, data key `tools.json`):

```typescript
  // ── Tool catalog reconcile ────────────────────────────────────────────────
  if (KUBECLAW_MODE === 'orchestrator') {
    const toolReconciler = new ToolReconciler({
      baselineLoader: loadToolBaselineFromDisk,
      configMapApply: async (rendered: string) => {
        const data: Record<string, string> = { 'tools.json': rendered };
        let resourceVersion: string | undefined;
        try {
          const existing = await coreApi.readNamespacedConfigMap({
            name: 'kubeclaw-tools',
            namespace: KUBECLAW_NAMESPACE,
          });
          resourceVersion = existing.metadata?.resourceVersion;
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } })
            ?.response?.statusCode;
          if (status !== 404) throw err;
        }
        const body = {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: 'kubeclaw-tools',
            namespace: KUBECLAW_NAMESPACE,
            ...(resourceVersion ? { resourceVersion } : {}),
          },
          data,
        };
        if (resourceVersion !== undefined) {
          await coreApi.replaceNamespacedConfigMap({
            name: 'kubeclaw-tools',
            namespace: KUBECLAW_NAMESPACE,
            body,
          });
        } else {
          await coreApi.createNamespacedConfigMap({
            namespace: KUBECLAW_NAMESPACE,
            body,
          });
        }
      },
    });
    try {
      await toolReconciler.apply();
      logger.info('Tools ConfigMap reconciled');
    } catch (err) {
      logger.warn(
        { err },
        'Tool reconcile failed; channel pods will use stale or empty catalog',
      );
    }
  }
```

Confirm `coreApi`, `KUBECLAW_NAMESPACE`, `KUBECLAW_MODE`, and `logger` are already in scope at that point (they are — the specialist block uses them).

- [ ] **Step 7.2: Build + targeted test**

```bash
npm run build
npx vitest run src/index.test.ts
```

Expected: build clean; existing `index.test.ts` still passes (it does not assert on the new block, but must not regress).

- [ ] **Step 7.3: Commit**

```bash
git add src/index.ts
git commit -m "feat(tools): reconcile the tools ConfigMap at orchestrator startup

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Orchestrator spawn-watcher resolves tools by name + ACL re-check

The spawn watcher (`startToolPodSpawnWatcher` in `src/k8s/ipc-redis.ts`) currently reads `toolImage`/`toolPattern`/`toolPort`/… from the stream and branches on `if (toolImage)`. Change it so: built-in categories (`execution`/`browser`) still go to `createToolPodJob`; any other `category` (a catalog tool name) is resolved from the catalog, ACL-checked against the stream's `channel`, then spawned — with a clean error to the results stream on failure.

**Files:**
- Modify: `src/k8s/ipc-redis.ts` (`startToolPodSpawnWatcher`, ≈lines 973–1100)
- Test: `src/k8s/ipc-redis.test.ts` (add resolution + ACL tests)

- [ ] **Step 8.1: Read the current watcher AND its existing test**

Read `src/k8s/ipc-redis.ts:973-1100`. Note the field destructure (`agentJobId, groupFolder, category, timeout, channel, toolImage, toolPattern, toolPort, toolCommand`) and the `if (toolImage) { createSidecarToolPodJob(...) } else { createToolPodJob(...) }` branch. Also note how it writes to streams (results stream name: `kubeclaw:toolresults:{agentJobId}:{category}`) and the exact Redis client accessor used (e.g. `getRedisClient()` + `.xadd`).

Then read the existing `startToolPodSpawnWatcher` test in `src/k8s/ipc-redis.test.ts` end-to-end (grep `spawn-tool-pod`): note how it seeds the spawn stream, how it runs exactly one watcher iteration (it likely sets a stop flag or awaits a single drain), how `jobRunner` is mocked, and how it reads back streams. Your three new tests in Step 8.2 reuse this exact harness — do not invent a new one.

- [ ] **Step 8.2: Write the failing tests**

In `src/k8s/ipc-redis.test.ts`, locate the existing `startToolPodSpawnWatcher` describe (grep for `spawn-tool-pod` or `startToolPodSpawnWatcher`). Add tests. The watcher calls a module-level `jobRunner`; the test file already mocks it (grep for `createSidecarToolPodJob` mock). You will inject a tool resolver — design Step 8.3 exposes the watcher's resolver via a parameter with a default, so the test can pass a stub. Tests:

```typescript
  it('resolves a catalog tool by name and spawns a sidecar pod', async () => {
    // Arrange: a spawn message with category = a catalog tool name, no toolImage
    // (see the existing test's harness for writing to the spawn stream and
    // draining one iteration). Provide a resolver returning a ToolSpec.
    // Assert: jobRunner.createSidecarToolPodJob called with that spec's image.
  });

  it('rejects a tool not scoped to the requesting channel', async () => {
    // resolver returns a spec with channels: ['other']; stream channel = 'telegram'
    // Assert: createSidecarToolPodJob NOT called; an error entry written to
    // kubeclaw:toolresults:{agentJobId}:{category}.
  });

  it('writes an error result when the tool name is unknown', async () => {
    // resolver returns undefined
    // Assert: createSidecarToolPodJob NOT called; error result written.
  });
```

Fill these in concretely by copying the existing spawn-watcher test's setup (how it seeds the stream, runs one watcher tick, and asserts on the `jobRunner` mock + a Redis read of the results stream). Keep the three assertions above.

- [ ] **Step 8.3: Implement the watcher change**

Add an import at the top of `src/k8s/ipc-redis.ts`:

```typescript
import { resolveToolByName } from '../tools/reconciler.js';
import type { ToolSpec } from '../tools/types.js';
```

Make the resolver injectable (so tests can stub it and the orchestrator uses the real one). Change the `startToolPodSpawnWatcher` signature to accept an optional resolver:

```typescript
export async function startToolPodSpawnWatcher(
  resolveTool: (name: string) => ToolSpec | undefined = (n) => resolveToolByName(n),
): Promise<void> {
```

In the message-processing body, replace the `if (toolImage) { ... } else { ... }` branch with:

```typescript
          const BUILTIN_CATEGORIES = new Set(['execution', 'browser']);
          try {
            if (BUILTIN_CATEGORIES.has(category)) {
              await jobRunner.createToolPodJob({
                agentJobId,
                groupFolder,
                category: category as 'browser' | 'execution',
                timeout: timeoutMs,
                groupsPvc,
                sessionsPvc,
                ...(maxToolOutputBytes !== undefined ? { maxToolOutputBytes } : {}),
              });
              logger.debug({ agentJobId, category }, 'Spawned built-in tool pod');
            } else {
              // Catalog tool: orchestrator resolves the spec by name and re-checks
              // the channel ACL. The channel only sent the name.
              const spec = resolveTool(category);
              if (!spec) {
                await writeToolError(
                  agentJobId,
                  category,
                  `Unknown tool: ${category}`,
                );
                logger.warn({ agentJobId, category }, 'Unknown catalog tool; dropped spawn');
                continue;
              }
              if (spec.channels?.length && !spec.channels.includes(channel ?? '')) {
                await writeToolError(
                  agentJobId,
                  category,
                  `Tool ${category} is not available on this channel`,
                );
                logger.warn(
                  { agentJobId, category, channel },
                  'Catalog tool not scoped to channel; rejected',
                );
                continue;
              }
              await jobRunner.createSidecarToolPodJob({
                agentJobId,
                groupFolder,
                toolName: category,
                toolSpec: spec,
                timeout: timeoutMs,
                groupsPvc,
                sessionsPvc,
              });
              logger.debug(
                { agentJobId, category, image: spec.image },
                'Resolved + spawned catalog sidecar tool pod',
              );
            }
          } catch (err) {
            logger.error({ agentJobId, category, err }, 'Failed to spawn tool pod');
          }
```

Remove `toolImage`, `toolPattern`, `toolPort`, `toolCommand`, and any `toolAcp*`/`toolHealthPath` from the field destructure — they are no longer sent. Add a small helper near the top of the file (after the imports/`jobRunner` declaration):

```typescript
async function writeToolError(
  agentJobId: string,
  category: string,
  message: string,
): Promise<void> {
  const client = getRedisClient();
  const stream = `kubeclaw:toolresults:${agentJobId}:${category}`;
  // The channel matches on requestId; without it the LLM-side read won't match a
  // specific call, but the stream entry surfaces the error in logs/diagnostics.
  // The channel-side TOOL_TIMEOUT bounds the wait. (A future enhancement could
  // thread requestId through the spawn stream for an exact match.)
  await client.xadd(stream, '*', 'error', message);
}
```

Use whatever Redis client accessor the file already uses (grep for `getRedisClient` / `redis.xadd` usage in the same file and match it).

- [ ] **Step 8.4: Update the orchestrator's call site**

In `src/index.ts`, the `startToolPodSpawnWatcher()` call (grep for it, ≈line 930) needs no argument — the default resolver uses `resolveToolByName` against disk + SQLite. Leave the call as-is (the default param handles it). Confirm it still type-checks.

- [ ] **Step 8.5: Build + test**

```bash
npm run build
npx vitest run src/k8s/ipc-redis.test.ts
```

Expected: PASS (existing + 3 new).

- [ ] **Step 8.6: Commit**

```bash
git add src/k8s/ipc-redis.ts src/k8s/ipc-redis.test.ts
git commit -m "feat(tools): orchestrator resolves catalog tools by name + re-checks channel ACL

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Rewire `direct-llm-runner` to the catalog; remove `containerConfig.tools`

Seam 1 sources the LLM tool list from the catalog (filtered to the channel). Seam 2 stops resolving the image on the channel side — it sends only the tool name; in direct (in-orchestrator) mode it resolves via the catalog. Then delete `containerConfig.tools`.

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts` (seams at ≈lines 513 and 1256; the spawnFields block ≈lines 516–546)
- Modify: `src/types.ts` (remove `tools?: ToolSpec[]` from `ContainerConfig`)
- Modify: `src/channel-runner.ts` (Task 10 starts the loader; here add the runner's catalog dependency)
- Test: `src/runtime/direct-llm-runner.test.ts`

- [ ] **Step 9.1: Decide the catalog injection point**

`DirectLLMRunner.runAgent` currently reads `group.containerConfig?.tools`. Replace this source with a catalog accessor. Add a settable module-level catalog on the runner mirroring how `specialistCatalog` is injected into channel-runner. Concretely, add to `DirectLLMRunner` a field and setter:

```typescript
  // Tool catalog source (set by channel-runner; falls back to empty).
  private toolCatalog: { getForChannel: (c: string) => ToolSpec[] } = {
    getForChannel: () => [],
  };
  setToolCatalog(c: { getForChannel: (channel: string) => ToolSpec[] }): void {
    this.toolCatalog = c;
  }
```

Import `KUBECLAW_CHANNEL` (already imported in this file — confirm via grep; if not, add `import { KUBECLAW_CHANNEL } from '../config.js'`).

- [ ] **Step 9.2: Write/adjust the failing test**

In `src/runtime/direct-llm-runner.test.ts`, add a test asserting seam 1 sources from the catalog (the file already constructs a `DirectLLMRunner` and stubs Redis/k8s — follow its harness):

```typescript
  it('builds the LLM tool list from the tool catalog filtered to this channel', async () => {
    const runner = new DirectLLMRunner(/* existing ctor args from neighbouring tests */);
    runner.setToolCatalog({
      getForChannel: () => [
        {
          name: 'weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: {} },
          image: 'img:1',
          pattern: 'http',
        },
      ],
    });
    // Drive a single runAgent turn with a stubbed LLM that records the tools it
    // was given (mirror how the existing tests capture the request), and assert
    // a function tool named 'weather' is present.
  });
```

If the existing test harness makes a full `runAgent` turn heavy, instead extract the seam-1 mapping into a small pure helper `buildCatalogToolDefs(tools: ToolSpec[]): OpenAI.ChatCompletionTool[]` and unit-test that directly; call the helper from `runAgent`. Prefer the helper extraction — it is cleaner and matches the "small focused units" guidance.

```typescript
// in direct-llm-runner.ts
export function buildCatalogToolDefs(
  tools: ToolSpec[],
): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
```

Test:

```typescript
import { buildCatalogToolDefs } from './direct-llm-runner.js';
it('maps ToolSpecs to function tool defs', () => {
  const defs = buildCatalogToolDefs([
    { name: 'weather', description: 'd', parameters: { type: 'object' }, image: 'i:1', pattern: 'http' },
  ]);
  expect(defs[0]).toEqual({
    type: 'function',
    function: { name: 'weather', description: 'd', parameters: { type: 'object' } },
  });
});
```

- [ ] **Step 9.3: Rewire seam 1**

At ≈line 1256, replace:

```typescript
    const customToolDefs: OpenAI.ChatCompletionTool[] = (
      group.containerConfig?.tools ?? []
    ).map((t: ToolSpec) => ({ ... }));
```

with:

```typescript
    const customToolDefs = buildCatalogToolDefs(
      this.toolCatalog.getForChannel(KUBECLAW_CHANNEL),
    );
```

- [ ] **Step 9.4: Rewire seam 2 (`executeToolViaK8s`, ≈lines 479–575)**

The function determines `isCustomTool = !TOOL_CATEGORY[toolName]` and `category = TOOL_CATEGORY[toolName] ?? toolName`. Keep that (reserved-name guard guarantees catalog names never collide with `TOOL_CATEGORY` keys). Changes:

- **Channel mode** (`KUBECLAW_MODE === 'channel'`): remove the `customSpec` lookup and the `toolImage`/`toolPattern`/`toolPort`/`toolAcp*`/`toolHealthPath` pushes onto `spawnFields`. The spawn message now carries only `agentJobId, toolJobId, groupFolder, category, timeout, channel` (and `maxToolOutputBytes` if set). The orchestrator resolves the rest. Concretely, delete the `if (customSpec) { spawnFields.push('toolImage', ...) }` block entirely.
- **Direct mode** (orchestrator running in-process): replace the `customSpec` lookup from `containerConfig.tools` with a catalog resolve. Add a resolver dependency to the runner mirroring `setToolCatalog`, OR call `resolveToolByName(toolName)` directly. Since direct mode only runs inside the orchestrator process (which owns the catalog), import and call `resolveToolByName`:

```typescript
import { resolveToolByName } from '../tools/reconciler.js';
```

and in the direct-mode branch:

```typescript
    } else {
      const spec = isCustomTool ? resolveToolByName(toolName) : undefined;
      if (isCustomTool && !spec) {
        // Unknown catalog tool in direct mode — surface as a tool error.
        return `Tool error: unknown tool ${toolName}`;
      }
      if (spec) {
        await jobRunner.createSidecarToolPodJob({
          agentJobId: toolJobId,
          groupFolder,
          toolName,
          toolSpec: spec,
          timeout: TOOL_TIMEOUT_MS,
        });
      } else {
        await jobRunner.createToolPodJob({
          agentJobId: toolJobId,
          groupFolder,
          category: category as 'browser' | 'execution',
          timeout: TOOL_TIMEOUT_MS,
          maxToolOutputBytes,
        });
      }
    }
```

(Adapt to the exact existing structure — the key change is: image source is `resolveToolByName`, never `group.containerConfig?.tools`.)

- [ ] **Step 9.5: Remove `containerConfig.tools`**

In `src/types.ts`, delete the `tools?: ToolSpec[];` member from `ContainerConfig` and its comment. Keep the `export type { ToolSpec }` re-export (still used elsewhere). Then:

```bash
grep -rn "containerConfig?\.tools\|containerConfig\.tools" src/ --include="*.ts"
```

Expected: no production hits remain (both seams rewired). Fix any test that constructed `containerConfig: { tools: [...] }` — such tests should now register via the catalog or be removed if they were testing the deleted seam.

- [ ] **Step 9.6: Build + test**

```bash
npm run build
npx vitest run src/runtime/direct-llm-runner.test.ts src/types.ts 2>/dev/null
npx vitest run src/runtime/direct-llm-runner.test.ts
```

Expected: build clean; tests pass.

- [ ] **Step 9.7: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/types.ts
git commit -m "feat(tools): source LLM tool list from catalog; send name-only at spawn; drop containerConfig.tools

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Start the ToolCatalogLoader in the channel runner

**Files:**
- Modify: `src/channel-runner.ts` (start a `ToolCatalogLoader` singleton in `main()`; inject it into the `DirectLLMRunner`)

- [ ] **Step 10.1: Wire the loader**

Read how `specialistCatalog` is declared (≈line 552) and started (≈line 3276) in `src/channel-runner.ts`. Add the tools analogue. Import:

```typescript
import { ToolCatalogLoader } from './tools/catalog-loader.js';
```

Module-level singleton near the specialists one:

```typescript
const toolCatalog = new ToolCatalogLoader('/etc/kubeclaw/tools/tools.json');
```

In `main()`, where `specialistCatalog.start()` is called (≈line 3276), start the tool catalog and inject it into the runner:

```typescript
  toolCatalog.start();
  getDirectLLMRunner().setToolCatalog(toolCatalog);
```

(Use whatever accessor returns the `DirectLLMRunner` instance in this file — grep for `getDirectLLMRunner` or the runner variable; if the runner is created elsewhere, inject at that construction point instead. The requirement: the runner used for channel turns has `setToolCatalog(toolCatalog)` called before the first message is processed.)

- [ ] **Step 10.2: Build + test**

```bash
npm run build
npx vitest run src/channel-runner.test.ts
```

Expected: build clean; channel-runner tests pass.

- [ ] **Step 10.3: Commit**

```bash
git add src/channel-runner.ts
git commit -m "feat(tools): start ToolCatalogLoader in channel runner and inject into the runner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Admin-shell registration tools

Add `register_tool`/`edit_tool`/`remove_tool`/`list_tools`, mirroring the specialist tools.

**Files:**
- Modify: `src/admin-shell.ts` (imports, a `ToolReconciler` instance, 4 tool defs in `TOOLS`, 4 handlers, 4 dispatch cases)
- Test: `src/admin-shell.test.ts` (add coverage for the new dispatch handlers if the file tests handlers; otherwise rely on tool-registry unit tests + e2e)

- [ ] **Step 11.1: Imports + reconciler instance**

Near the specialist imports (≈line 46–50) add:

```typescript
import {
  registerTool,
  editTool,
  removeTool,
  listToolOverrides,
} from './skills/orchestrator/tool-registry.js';
import {
  ToolReconciler,
  loadBaselineFromDisk as loadToolBaselineFromDisk,
} from './tools/reconciler.js';
```

After the `specialistReconciler` instance (≈line 111–154), add a `toolReconciler` with the identical `configMapApply` body but ConfigMap name `kubeclaw-tools` and data key `tools.json` (copy the specialist one, substitute the two strings, use `coreV1` as the specialist block does):

```typescript
const toolReconciler = new ToolReconciler({
  baselineLoader: loadToolBaselineFromDisk,
  configMapApply: async (rendered: string) => {
    const data: Record<string, string> = { 'tools.json': rendered };
    let resourceVersion: string | undefined;
    try {
      const existing = await coreV1.readNamespacedConfigMap({
        name: 'kubeclaw-tools',
        namespace: NAMESPACE,
      });
      resourceVersion = existing.metadata?.resourceVersion;
    } catch (err: unknown) {
      const status = (err as { response?: { statusCode?: number } })?.response
        ?.statusCode;
      if (status !== 404) throw err;
    }
    const body = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'kubeclaw-tools',
        namespace: NAMESPACE,
        ...(resourceVersion ? { resourceVersion } : {}),
      },
      data,
    };
    if (resourceVersion !== undefined) {
      await coreV1.replaceNamespacedConfigMap({
        name: 'kubeclaw-tools',
        namespace: NAMESPACE,
        body,
      });
    } else {
      await coreV1.createNamespacedConfigMap({ namespace: NAMESPACE, body });
    }
  },
});
```

- [ ] **Step 11.2: Tool definitions**

In the `TOOLS` array, after the `list_specialists` entry (≈line 997), add four entries:

```typescript
  {
    type: 'function',
    function: {
      name: 'register_tool',
      description:
        'Register a tool container in the tool catalog (tool_overrides SQLite table). The tool is merged into the catalog immediately and channel pods see it within ~30s. The orchestrator resolves its image at spawn time.',
      parameters: {
        type: 'object',
        required: ['name', 'description', 'parameters', 'image', 'pattern'],
        properties: {
          name: {
            type: 'string',
            description:
              'Tool name the LLM calls (letters, digits, hyphens, underscores; must start with a letter). Must not collide with a built-in (bash, web_search, web_fetch, browser, places_search).',
          },
          description: { type: 'string', description: 'What the tool does (shown to the LLM).' },
          parameters: {
            type: 'object',
            description: 'JSON Schema for the tool arguments.',
          },
          image: { type: 'string', description: 'Container image for the tool.' },
          pattern: {
            type: 'string',
            enum: ['http', 'file', 'acp'],
            description: 'Bridge pattern the tool container speaks.',
          },
          port: { type: 'number', description: 'Port the container listens on (http/acp; default 8080).' },
          command: { type: 'array', items: { type: 'string' }, description: 'Entrypoint override.' },
          healthPath: { type: 'string', description: 'Readiness path (must begin with /).' },
          pullPolicy: { type: 'string', enum: ['Always', 'IfNotPresent', 'Never'] },
          channels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Channels this tool is visible to. Omit for all channels.',
          },
          acpAgentName: { type: 'string' },
          acpMode: { type: 'string', enum: ['sync', 'async'] },
          memoryRequest: { type: 'string' },
          memoryLimit: { type: 'string' },
          cpuRequest: { type: 'string' },
          cpuLimit: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_tool',
      description:
        'Update fields on an existing tool override. Only provided fields change. Propagates to channel pods within ~30s.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Name of the tool to edit.' },
          description: { type: 'string' },
          parameters: { type: 'object' },
          image: { type: 'string' },
          pattern: { type: 'string', enum: ['http', 'file', 'acp'] },
          port: { type: 'number' },
          command: { type: 'array', items: { type: 'string' } },
          healthPath: { type: 'string' },
          pullPolicy: { type: 'string', enum: ['Always', 'IfNotPresent', 'Never'] },
          channels: { type: 'array', items: { type: 'string' } },
          acpAgentName: { type: 'string' },
          acpMode: { type: 'string', enum: ['sync', 'async'] },
          memoryRequest: { type: 'string' },
          memoryLimit: { type: 'string' },
          cpuRequest: { type: 'string' },
          cpuLimit: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_tool',
      description:
        'Remove a tool override from the catalog. Excluded immediately; channel pods update within ~30s.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', description: 'Name of the tool to remove.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tools',
      description:
        'List all tool overrides in the catalog (admin-shell managed entries; does not include Helm baseline tools).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
```

- [ ] **Step 11.3: Handlers**

After `handleListSpecialists` (≈line 1725), add (mirroring the specialist handlers, building the spec from `input` fields):

```typescript
// ---- Tool catalog handlers ----

function handleRegisterTool(input: ToolInput): string {
  const spec = {
    name: input.name as string,
    description: input.description as string,
    parameters: input.parameters as Record<string, unknown>,
    image: input.image as string,
    pattern: input.pattern as 'http' | 'file' | 'acp',
    ...(input.port !== undefined && { port: input.port as number }),
    ...(input.command !== undefined && { command: input.command as string[] }),
    ...(input.healthPath !== undefined && { healthPath: input.healthPath as string }),
    ...(input.pullPolicy !== undefined && {
      pullPolicy: input.pullPolicy as 'Always' | 'IfNotPresent' | 'Never',
    }),
    ...(input.channels !== undefined && { channels: input.channels as string[] }),
    ...(input.acpAgentName !== undefined && { acpAgentName: input.acpAgentName as string }),
    ...(input.acpMode !== undefined && { acpMode: input.acpMode as 'sync' | 'async' }),
    ...(input.memoryRequest !== undefined && { memoryRequest: input.memoryRequest as string }),
    ...(input.memoryLimit !== undefined && { memoryLimit: input.memoryLimit as string }),
    ...(input.cpuRequest !== undefined && { cpuRequest: input.cpuRequest as string }),
    ...(input.cpuLimit !== undefined && { cpuLimit: input.cpuLimit as string }),
  };
  const result = registerTool(spec, toolReconciler.apply.bind(toolReconciler));
  if (!result.ok) return `Error: ${result.error}`;
  return `Registered tool "${spec.name}". Changes are live; channel pods will see the updated catalog within ~30s.`;
}

function handleEditTool(input: ToolInput): string {
  const name = input.name as string;
  if (!name) return 'Error: name is required.';
  const patch: Record<string, unknown> = {};
  for (const f of [
    'description', 'parameters', 'image', 'pattern', 'port', 'command',
    'healthPath', 'pullPolicy', 'channels', 'acpAgentName', 'acpMode',
    'memoryRequest', 'memoryLimit', 'cpuRequest', 'cpuLimit',
  ]) {
    if (input[f] !== undefined) patch[f] = input[f];
  }
  const result = editTool({ name, patch }, toolReconciler.apply.bind(toolReconciler));
  if (!result.ok) return `Error: ${result.error}`;
  return `Updated tool "${name}". Changes are live; channel pods will see the updated catalog within ~30s.`;
}

function handleRemoveTool(input: ToolInput): string {
  const name = input.name as string;
  if (!name) return 'Error: name is required.';
  const result = removeTool({ name }, toolReconciler.apply.bind(toolReconciler));
  if (!result.ok) return `Error: ${result.error}`;
  return `Removed tool override "${name}". Changes are live; channel pods will see the updated catalog within ~30s.`;
}

function handleListTools(): string {
  const tools = listToolOverrides();
  if (tools.length === 0)
    return 'No tool overrides registered. (Helm baseline tools are not shown here.)';
  return tools
    .map((t) =>
      [
        `Name: ${t.name}`,
        `  Image: ${t.image}  (${t.pattern})`,
        `  Desc: ${t.description.slice(0, 80)}${t.description.length > 80 ? '…' : ''}`,
        `  Channels: ${t.channels?.length ? t.channels.join(', ') : 'all'}`,
      ].join('\n'),
    )
    .join('\n\n');
}
```

- [ ] **Step 11.4: Dispatch cases**

In the `handleToolCall` switch, after the `list_specialists` case (≈line 2112), add:

```typescript
    case 'register_tool':
      return handleRegisterTool(input);
    case 'edit_tool':
      return handleEditTool(input);
    case 'remove_tool':
      return handleRemoveTool(input);
    case 'list_tools':
      return handleListTools();
```

- [ ] **Step 11.5: Build + test**

```bash
npm run build
npx vitest run src/admin-shell.test.ts
```

Expected: build clean; existing admin-shell tests pass. If `admin-shell.test.ts` enumerates tool names or dispatch coverage, extend it to include the four new tools.

- [ ] **Step 11.6: Commit**

```bash
git add src/admin-shell.ts src/admin-shell.test.ts
git commit -m "feat(tools): admin-shell register/edit/remove/list_tool commands

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Integration + end-to-end tests

**Files:**
- Create: `e2e/tool-catalog-spawn.test.ts` (integration: Redis round-trip, name-only spawn → orchestrator resolves)
- Create or extend: a minikube-live e2e for registration + per-channel scoping (gated on cluster availability)

- [ ] **Step 12.1: Integration — name-only spawn resolves**

Model on `e2e/sidecar-tool-pod.test.ts` / `e2e/tool-pod-spawn.test.ts`. Write a test that: (a) seeds a `tool_overrides` row (or uses a stub resolver via the watcher's injectable parameter), (b) writes a spawn-tool-pod message carrying only `category` = the tool name + `channel`, (c) runs one watcher tick with a mocked `jobRunner`, (d) asserts `createSidecarToolPodJob` was called with the resolved image, and (e) a second message naming a tool scoped to a different channel produces an error result, not a spawn. Reuse `getSharedRedis`/`getRedisUrlForTests` from `e2e/setup.ts`.

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npx vitest run e2e/tool-catalog-spawn.test.ts --config vitest.e2e.config.ts
```

Expected: PASS.

- [ ] **Step 12.2: End-to-end (minikube-live) — register + scope**

Gated on `kubectl get nodes`. Steps: deploy is assumed present; via the orchestrator's tool-registry path (call `registerTool` + reconcile, or exec the admin-shell), register a tool scoped to channel `http`; assert the `kubeclaw-tools` ConfigMap now contains it; assert a channel pod for `http` would surface it and a different channel would not. If a full live registration is too heavy for the harness, assert the narrower invariant: the reconciler writes the ConfigMap with the registered tool present and correctly channel-scoped (this is the load-bearing behavior; the spawn path is covered at the integration level).

```bash
kubectl get nodes >/dev/null 2>&1 && npx vitest run e2e/tool-catalog-spawn.test.ts --config vitest.e2e.config.ts || echo "No cluster — live e2e skipped (note in report)"
```

- [ ] **Step 12.3: Commit**

```bash
git add e2e/tool-catalog-spawn.test.ts
git commit -m "test(tools): integration + e2e for catalog spawn resolution and channel scoping

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Full verification

- [ ] **Step 13.1: Clean build + full unit suite**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build
npm test 2>&1 | grep -E "Test Files|Tests "
```

Expected: all pass. Any failure importing a removed seam (`containerConfig.tools`) is a missed Task-9 reference — fix it.

- [ ] **Step 13.2: Straggler sweep**

```bash
grep -rn "containerConfig?\.tools\|containerConfig\.tools" src/ --include="*.ts"
```

Expected: empty.

- [ ] **Step 13.3: Helm + integration**

```bash
helm template kubeclaw helm/kubeclaw >/dev/null && echo "helm OK"
npm run test:e2e -- e2e/tool-catalog-spawn.test.ts e2e/sidecar-tool-pod.test.ts 2>&1 | tail -4
```

Expected: helm OK; integration green.

- [ ] **Step 13.4: Two-stage review**

Run the repo's spec-compliance then code-quality review (per the project's review policy) before reporting complete.

---

## Out of scope (do not do these here)

- **Per-tool HTTP request-mapping** (arbitrary method/path/body) — separate spec.
- **Converting static built-ins** (`bash`, `web_search`, browser, file ops) into catalog entries — the baseline ships empty.
- **Spawn-path hardening** beyond what exists (SA-token opt-out, user-tool securityContext, imagePullSecrets, output caps, Envoy credential sidecar on tool pods).
- **Threading `requestId` through the spawn stream** for exact error-result matching at the channel — noted as a future enhancement in Task 8; the channel-side `TOOL_TIMEOUT` already bounds the failure case.
