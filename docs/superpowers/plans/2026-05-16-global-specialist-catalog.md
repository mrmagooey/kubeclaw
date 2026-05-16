# Global Specialist Catalog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-group `agents.json` with a cluster-wide global specialist catalog, mounted into channel pods via ConfigMap. Finally make Path A honour per-specialist `llmProvider`, `memory.isolated`, and `tools` overrides; make memory isolation real (not nominal); delete the dead orchestrator-mode dispatch path.

**Architecture:** Helm values define baseline specialists, admin-shell IPC tools mutate an orchestrator SQLite override table, orchestrator reconciler merges and writes a cluster-wide `kubeclaw-specialists` ConfigMap. Channel pods mount the ConfigMap and consume via an in-memory cache with `fs.watch` for updates. Channel-runner dispatch becomes parallel (`Promise.all`) with per-specialist `sessionKey` / `llmProvider` / `toolFilter` plumbed into `runAgent`. `conversation_history` gains a `session_key` column so isolated specialists don't pull group history.

**Tech Stack:** TypeScript, Node.js, SQLite (better-sqlite3), Kubernetes client (@kubernetes/client-node), Helm, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-16-global-specialist-catalog-design.md`

---

## File Structure

**Created:**
- `src/specialists/types.ts` — `GlobalSpecialist` interface + validator
- `src/specialists/types.test.ts`
- `src/specialists/catalog-loader.ts` — channel-side ConfigMap loader with `fs.watch`
- `src/specialists/catalog-loader.test.ts`
- `src/specialists/reconciler.ts` — orchestrator-side baseline + overrides merge → ConfigMap write
- `src/specialists/reconciler.test.ts`
- `src/skills/orchestrator/specialist-registry.ts` — admin-shell IPC tools
- `src/skills/orchestrator/specialist-registry.test.ts`
- `helm/kubeclaw/templates/specialists-baseline-configmap.yaml`
- `docs/legacy-specialists-architecture.md` — old `docs/SPECIALISTS.md` content preserved
- `docs/SPECIALISTS.md` — rewritten

**Modified:**
- `src/db.ts` — `session_key` column on `conversation_history`; new `specialist_overrides` (orchestrator) and `specialist_usage` (channel) tables; updated `appendConversationHistory` / `getConversationHistory` signatures
- `src/db.test.ts`
- `src/runtime/direct-llm-runner.ts` — `runAgent` accepts `sessionKey`, `llmProvider`, `toolFilter`
- `src/runtime/direct-llm-runner.test.ts`
- `src/channel-runner.ts` — dispatch flow: load catalog from `specialistCatalog`; parallel `Promise.all`; per-specialist overrides; `[@Name]` prefix; per-run error isolation
- `src/channel-runner.test.ts`
- `src/specialists.ts` — remove `loadSpecialists()`, retain `detectMentionedSpecialists()` (now typed against `GlobalSpecialist`)
- `src/specialists.test.ts`
- `src/index.ts` — DELETE lines 373-559 (`processGroupMessages` Path B) and `_processGroupMessages` export; DELETE the `KUBECLAW_MODE !== 'orchestrator'` registration block at 1089-1100
- `src/index.test.ts` — DELETE tests covering `_processGroupMessages`
- `src/k8s/job-runner.ts` — channel-pod PodSpec adds `specialists-catalog` volume + mount
- `src/k8s/job-runner.test.ts`
- `helm/kubeclaw/templates/orchestrator-deployment.yaml` — mount `kubeclaw-specialists-baseline` ConfigMap
- `helm/kubeclaw/values.yaml` — add `specialists: []` default
- `README.md` — Agent Swarms bullet updated to describe global catalog
- `CLAUDE.md` — Key Files: new entries for `src/specialists/catalog-loader.ts`, `src/specialists/reconciler.ts`
- `CHANGELOG.md` — Breaking change entry

---

## Task 1: `session_key` column on `conversation_history`

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/db.test.ts`:

```ts
describe('conversation_history session_key', () => {
  it('stores and retrieves rows keyed by session_key, scoped by session not group', () => {
    const db = openTestDb();
    appendConversationHistory(db, {
      groupFolder: 'mygroup',
      sessionKey: 'mygroup',
      role: 'user', content: 'hello',
    });
    appendConversationHistory(db, {
      groupFolder: 'mygroup',
      sessionKey: 'mygroup:Research',
      role: 'user', content: 'research-private',
    });
    const groupHist = getConversationHistory(db, { sessionKey: 'mygroup' });
    const researchHist = getConversationHistory(db, { sessionKey: 'mygroup:Research' });
    expect(groupHist).toHaveLength(1);
    expect(groupHist[0].content).toBe('hello');
    expect(researchHist).toHaveLength(1);
    expect(researchHist[0].content).toBe('research-private');
  });

  it('backfills existing NULL session_key rows with group_folder on startup', () => {
    const db = openTestDb();
    db.prepare(
      `INSERT INTO conversation_history (group_folder, role, content, created_at) VALUES (?, ?, ?, ?)`
    ).run('legacygroup', 'user', 'legacy', Date.now());
    runSessionKeyBackfill(db);
    const row = db.prepare(`SELECT session_key FROM conversation_history WHERE group_folder = ?`).get('legacygroup') as any;
    expect(row.session_key).toBe('legacygroup');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/db.test.ts -t "session_key"
```
Expected: FAIL — `runSessionKeyBackfill` undefined, `getConversationHistory` doesn't accept `sessionKey` option.

- [ ] **Step 3: Implement schema + backfill + updated functions**

In `src/db.ts`, find the `conversation_history` `CREATE TABLE` and the migration runner. Add the column and a backfill helper:

```ts
// In schema setup (idempotent; runs at db open):
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_folder TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Additive migration — safe to run repeatedly:
const cols = db.prepare(`PRAGMA table_info(conversation_history)`).all() as Array<{ name: string }>;
if (!cols.some(c => c.name === 'session_key')) {
  db.exec(`ALTER TABLE conversation_history ADD COLUMN session_key TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_session_key ON conversation_history (session_key, created_at)`);
}

export function runSessionKeyBackfill(db: Database): void {
  db.prepare(
    `UPDATE conversation_history SET session_key = group_folder WHERE session_key IS NULL`
  ).run();
}
```

Update the existing functions:

```ts
export interface AppendConversationArgs {
  groupFolder: string;
  sessionKey: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export function appendConversationHistory(db: Database, args: AppendConversationArgs): void {
  db.prepare(
    `INSERT INTO conversation_history (group_folder, session_key, role, content, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(args.groupFolder, args.sessionKey, args.role, args.content, Date.now());
}

export function getConversationHistory(db: Database, args: { sessionKey: string; limit?: number }): ConversationRow[] {
  const limit = args.limit ?? 100;
  return db.prepare(
    `SELECT * FROM conversation_history WHERE session_key = ? ORDER BY created_at DESC LIMIT ?`
  ).all(args.sessionKey, limit) as ConversationRow[];
}
```

Call `runSessionKeyBackfill(db)` from the db-open function once, right after the migration runs.

- [ ] **Step 4: Update all existing callers to pass `sessionKey: group.folder`**

Grep: `rg "appendConversationHistory|getConversationHistory" src/ --files-with-matches`

For each call site, pass `sessionKey: groupFolder` (or the local equivalent) — matches today's effective behaviour. No semantic change for non-specialist call sites.

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/db.test.ts
```
Expected: PASS. All other test suites still green.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/db.test.ts $(rg -l "appendConversationHistory|getConversationHistory" src/)
git commit -m "feat(db): scope conversation_history by session_key with backfill"
```

---

## Task 2: `GlobalSpecialist` type and validator

**Files:**
- Create: `src/specialists/types.ts`
- Create: `src/specialists/types.test.ts`

- [ ] **Step 1: Write the failing test**

`src/specialists/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateSpecialist, parseSpecialists } from './types.js';

describe('validateSpecialist', () => {
  it('accepts a minimal valid specialist', () => {
    expect(validateSpecialist({ name: 'CodeReview', prompt: 'be sharp' })).toEqual({ ok: true });
  });

  it('rejects empty name', () => {
    expect(validateSpecialist({ name: '', prompt: 'x' })).toEqual({ ok: false, error: expect.stringContaining('name') });
  });

  it('rejects name with disallowed characters', () => {
    expect(validateSpecialist({ name: 'Code Review', prompt: 'x' }).ok).toBe(false);
    expect(validateSpecialist({ name: '1Bad', prompt: 'x' }).ok).toBe(false);
  });

  it('rejects empty prompt', () => {
    expect(validateSpecialist({ name: 'X', prompt: '' }).ok).toBe(false);
  });

  it('rejects unknown top-level fields', () => {
    expect(validateSpecialist({ name: 'X', prompt: 'y', surprise: 1 } as any).ok).toBe(false);
  });

  it('accepts all optional fields with correct types', () => {
    const ok = validateSpecialist({
      name: 'Research',
      prompt: 'p',
      triggers: ['Researcher'],
      llmProvider: 'claude',
      memory: { isolated: true },
      claudemd: 'extra',
      tools: ['mcp:fetch'],
    });
    expect(ok).toEqual({ ok: true });
  });
});

describe('parseSpecialists', () => {
  it('parses the wire format', () => {
    const r = parseSpecialists(JSON.stringify({
      version: 1, generation: 1,
      specialists: [{ name: 'A', prompt: 'p' }],
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.specialists).toHaveLength(1);
  });

  it('rejects wire format with duplicate names', () => {
    const r = parseSpecialists(JSON.stringify({
      version: 1, generation: 1,
      specialists: [{ name: 'A', prompt: 'p' }, { name: 'A', prompt: 'q' }],
    }));
    expect(r.ok).toBe(false);
  });

  it('rejects wrong version', () => {
    const r = parseSpecialists(JSON.stringify({ version: 2, generation: 1, specialists: [] }));
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/specialists/types.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

`src/specialists/types.ts`:

```ts
export interface GlobalSpecialist {
  name: string;
  prompt: string;
  triggers?: string[];
  llmProvider?: string;
  memory?: { isolated?: boolean };
  claudemd?: string;
  tools?: string[];
}

export interface CatalogWire {
  version: 1;
  generation: number;
  specialists: GlobalSpecialist[];
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ALLOWED_KEYS = new Set(['name', 'prompt', 'triggers', 'llmProvider', 'memory', 'claudemd', 'tools']);

export function validateSpecialist(s: unknown): ValidationResult {
  if (typeof s !== 'object' || s === null) return { ok: false, error: 'specialist must be an object' };
  const obj = s as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(k)) return { ok: false, error: `unknown field: ${k}` };
  }
  if (typeof obj.name !== 'string' || !NAME_RE.test(obj.name)) {
    return { ok: false, error: `invalid name: ${JSON.stringify(obj.name)}` };
  }
  if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) {
    return { ok: false, error: 'prompt must be a non-empty string' };
  }
  if (obj.triggers !== undefined && (!Array.isArray(obj.triggers) || obj.triggers.some(t => typeof t !== 'string'))) {
    return { ok: false, error: 'triggers must be string[]' };
  }
  if (obj.llmProvider !== undefined && typeof obj.llmProvider !== 'string') {
    return { ok: false, error: 'llmProvider must be a string' };
  }
  if (obj.memory !== undefined) {
    if (typeof obj.memory !== 'object' || obj.memory === null) return { ok: false, error: 'memory must be an object' };
    const m = obj.memory as Record<string, unknown>;
    if (m.isolated !== undefined && typeof m.isolated !== 'boolean') return { ok: false, error: 'memory.isolated must be boolean' };
  }
  if (obj.claudemd !== undefined && typeof obj.claudemd !== 'string') {
    return { ok: false, error: 'claudemd must be a string' };
  }
  if (obj.tools !== undefined && (!Array.isArray(obj.tools) || obj.tools.some(t => typeof t !== 'string'))) {
    return { ok: false, error: 'tools must be string[]' };
  }
  return { ok: true };
}

export type ParseResult =
  | { ok: true; specialists: GlobalSpecialist[]; generation: number }
  | { ok: false; error: string };

export function parseSpecialists(json: string): ParseResult {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch (e) { return { ok: false, error: `invalid JSON: ${e}` }; }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: 'top-level must be object' };
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) return { ok: false, error: `unsupported version: ${obj.version}` };
  if (typeof obj.generation !== 'number') return { ok: false, error: 'generation must be number' };
  if (!Array.isArray(obj.specialists)) return { ok: false, error: 'specialists must be array' };
  const seen = new Set<string>();
  for (const s of obj.specialists) {
    const v = validateSpecialist(s);
    if (!v.ok) return { ok: false, error: v.error };
    const name = (s as GlobalSpecialist).name;
    if (seen.has(name)) return { ok: false, error: `duplicate name: ${name}` };
    seen.add(name);
  }
  return { ok: true, specialists: obj.specialists as GlobalSpecialist[], generation: obj.generation };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/specialists/types.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/specialists/types.ts src/specialists/types.test.ts
git commit -m "feat(specialists): add GlobalSpecialist type and validator"
```

---

## Task 3: Channel-side catalog loader with `fs.watch`

**Files:**
- Create: `src/specialists/catalog-loader.ts`
- Create: `src/specialists/catalog-loader.test.ts`

- [ ] **Step 1: Write the failing test**

`src/specialists/catalog-loader.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SpecialistCatalogLoader } from './catalog-loader.js';

describe('SpecialistCatalogLoader', () => {
  let dir: string;
  let loader: SpecialistCatalogLoader;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'specialists-'));
  });
  afterEach(() => {
    loader?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty catalog when file is absent', () => {
    loader = new SpecialistCatalogLoader(join(dir, 'specialists.json'));
    loader.start();
    expect(loader.getAll()).toEqual([]);
  });

  it('loads specialists from the file at startup', () => {
    writeFileSync(join(dir, 'specialists.json'),
      JSON.stringify({ version: 1, generation: 1, specialists: [{ name: 'A', prompt: 'p' }] }));
    loader = new SpecialistCatalogLoader(join(dir, 'specialists.json'));
    loader.start();
    expect(loader.getAll()).toHaveLength(1);
    expect(loader.getAll()[0].name).toBe('A');
  });

  it('reloads when the file changes (atomic write)', async () => {
    const path = join(dir, 'specialists.json');
    writeFileSync(path, JSON.stringify({ version: 1, generation: 1, specialists: [{ name: 'A', prompt: 'p' }] }));
    loader = new SpecialistCatalogLoader(path);
    loader.start();
    expect(loader.getAll()[0].name).toBe('A');
    // Atomic write: write to temp then rename
    writeFileSync(path + '.tmp', JSON.stringify({ version: 1, generation: 2, specialists: [{ name: 'B', prompt: 'q' }] }));
    const { renameSync } = await import('fs');
    renameSync(path + '.tmp', path);
    await new Promise(r => setTimeout(r, 150));
    expect(loader.getAll()[0].name).toBe('B');
  });

  it('keeps previous cache when reload encounters invalid JSON', async () => {
    const path = join(dir, 'specialists.json');
    writeFileSync(path, JSON.stringify({ version: 1, generation: 1, specialists: [{ name: 'A', prompt: 'p' }] }));
    loader = new SpecialistCatalogLoader(path);
    loader.start();
    writeFileSync(path, 'not-json');
    await new Promise(r => setTimeout(r, 150));
    expect(loader.getAll()[0].name).toBe('A'); // still A, parse-failure fallback
  });

  it('findByMention matches name and triggers case-insensitively', () => {
    writeFileSync(join(dir, 'specialists.json'), JSON.stringify({
      version: 1, generation: 1,
      specialists: [{ name: 'CodeReview', prompt: 'p', triggers: ['QA'] }],
    }));
    loader = new SpecialistCatalogLoader(join(dir, 'specialists.json'));
    loader.start();
    expect(loader.findByMention('codereview')?.name).toBe('CodeReview');
    expect(loader.findByMention('qa')?.name).toBe('CodeReview');
    expect(loader.findByMention('nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/specialists/catalog-loader.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/specialists/catalog-loader.ts`:

```ts
import { readFileSync, watch, existsSync, FSWatcher } from 'fs';
import { dirname } from 'path';
import { logger } from '../logger.js';
import { GlobalSpecialist, parseSpecialists } from './types.js';

export class SpecialistCatalogLoader {
  private cache: GlobalSpecialist[] = [];
  private generation = 0;
  private watcher?: FSWatcher;

  constructor(private readonly path: string) {}

  start(): void {
    this.load();
    // Watch the parent dir so kubelet's atomic symlink swap (..data → new) is observed.
    const dir = dirname(this.path);
    if (!existsSync(dir)) return;
    this.watcher = watch(dir, { persistent: false }, () => {
      // Debounce by always re-reading; load() is idempotent on no change.
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
    try { json = readFileSync(this.path, 'utf-8'); }
    catch (err) { logger.warn({ err, path: this.path }, 'specialist catalog read failed; keeping cache'); return; }
    const r = parseSpecialists(json);
    if (!r.ok) { logger.warn({ error: r.error, path: this.path }, 'specialist catalog parse failed; keeping cache'); return; }
    if (r.generation === this.generation && this.cache.length === r.specialists.length) return; // no-op
    this.cache = r.specialists;
    this.generation = r.generation;
    logger.info({ count: r.specialists.length, generation: r.generation }, 'specialist catalog loaded');
  }

  getAll(): GlobalSpecialist[] {
    return this.cache;
  }

  findByMention(name: string): GlobalSpecialist | undefined {
    const lower = name.toLowerCase();
    return this.cache.find(s =>
      s.name.toLowerCase() === lower ||
      (s.triggers ?? []).some(t => t.toLowerCase() === lower),
    );
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/specialists/catalog-loader.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/specialists/catalog-loader.ts src/specialists/catalog-loader.test.ts
git commit -m "feat(specialists): channel-side catalog loader with fs.watch"
```

---

## Task 4: `specialist_overrides` table + admin-shell IPC tools

**Files:**
- Modify: `src/db.ts` (add `specialist_overrides` schema)
- Create: `src/skills/orchestrator/specialist-registry.ts`
- Create: `src/skills/orchestrator/specialist-registry.test.ts`

- [ ] **Step 1: Write the failing test**

`src/skills/orchestrator/specialist-registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSpecialist, editSpecialist, removeSpecialist, listSpecialistOverrides,
} from './specialist-registry.js';
import { openTestDb } from '../../db.js';

describe('specialist-registry', () => {
  let db: ReturnType<typeof openTestDb>;
  beforeEach(() => { db = openTestDb(); });

  it('register inserts a valid override', () => {
    const r = registerSpecialist(db, { name: 'A', prompt: 'p' });
    expect(r.ok).toBe(true);
    expect(listSpecialistOverrides(db)).toHaveLength(1);
  });

  it('register rejects invalid name', () => {
    const r = registerSpecialist(db, { name: '1bad', prompt: 'p' });
    expect(r.ok).toBe(false);
  });

  it('register fails on duplicate name', () => {
    registerSpecialist(db, { name: 'A', prompt: 'p' });
    const r = registerSpecialist(db, { name: 'A', prompt: 'q' });
    expect(r.ok).toBe(false);
  });

  it('edit updates fields, fails if name missing', () => {
    registerSpecialist(db, { name: 'A', prompt: 'p' });
    const ok = editSpecialist(db, { name: 'A', patch: { prompt: 'new' } });
    expect(ok.ok).toBe(true);
    const missing = editSpecialist(db, { name: 'Z', patch: { prompt: 'x' } });
    expect(missing.ok).toBe(false);
    expect(listSpecialistOverrides(db)[0].prompt).toBe('new');
  });

  it('remove deletes the row', () => {
    registerSpecialist(db, { name: 'A', prompt: 'p' });
    removeSpecialist(db, { name: 'A' });
    expect(listSpecialistOverrides(db)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/skills/orchestrator/specialist-registry.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Add the table to db.ts**

In `src/db.ts` schema setup (orchestrator side — keep guarded by `KUBECLAW_MODE` if the db open function distinguishes):

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS specialist_overrides (
    name        TEXT PRIMARY KEY,
    spec_json   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
`);
```

- [ ] **Step 4: Implement the module**

`src/skills/orchestrator/specialist-registry.ts`:

```ts
import type { Database } from 'better-sqlite3';
import { GlobalSpecialist, validateSpecialist } from '../../specialists/types.js';

export type Result = { ok: true } | { ok: false; error: string };

export function registerSpecialist(db: Database, s: GlobalSpecialist): Result {
  const v = validateSpecialist(s);
  if (!v.ok) return v;
  const existing = db.prepare(`SELECT 1 FROM specialist_overrides WHERE name = ?`).get(s.name);
  if (existing) return { ok: false, error: `specialist already registered: ${s.name}` };
  const now = Date.now();
  db.prepare(
    `INSERT INTO specialist_overrides (name, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run(s.name, JSON.stringify(s), now, now);
  return { ok: true };
}

export function editSpecialist(db: Database, args: { name: string; patch: Partial<GlobalSpecialist> }): Result {
  const row = db.prepare(`SELECT spec_json FROM specialist_overrides WHERE name = ?`).get(args.name) as { spec_json: string } | undefined;
  if (!row) return { ok: false, error: `no override registered: ${args.name}` };
  const merged = { ...(JSON.parse(row.spec_json) as GlobalSpecialist), ...args.patch, name: args.name };
  const v = validateSpecialist(merged);
  if (!v.ok) return v;
  db.prepare(`UPDATE specialist_overrides SET spec_json = ?, updated_at = ? WHERE name = ?`)
    .run(JSON.stringify(merged), Date.now(), args.name);
  return { ok: true };
}

export function removeSpecialist(db: Database, args: { name: string }): Result {
  const info = db.prepare(`DELETE FROM specialist_overrides WHERE name = ?`).run(args.name);
  return info.changes > 0 ? { ok: true } : { ok: false, error: `no such override: ${args.name}` };
}

export function listSpecialistOverrides(db: Database): GlobalSpecialist[] {
  const rows = db.prepare(`SELECT spec_json FROM specialist_overrides ORDER BY name`).all() as Array<{ spec_json: string }>;
  return rows.map(r => JSON.parse(r.spec_json) as GlobalSpecialist);
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/skills/orchestrator/specialist-registry.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/skills/orchestrator/specialist-registry.ts src/skills/orchestrator/specialist-registry.test.ts
git commit -m "feat(specialists): admin-shell IPC tools for specialist overrides"
```

---

## Task 5: Orchestrator reconciler (merge + render + write ConfigMap)

**Files:**
- Create: `src/specialists/reconciler.ts`
- Create: `src/specialists/reconciler.test.ts`

- [ ] **Step 1: Write the failing test**

`src/specialists/reconciler.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { mergeCatalog, renderCatalog, SpecialistReconciler } from './reconciler.js';
import { openTestDb } from '../db.js';
import { registerSpecialist } from '../skills/orchestrator/specialist-registry.js';

describe('mergeCatalog', () => {
  it('override wins on name collision', () => {
    const baseline = [{ name: 'A', prompt: 'baseline' }];
    const overrides = [{ name: 'A', prompt: 'override' }];
    expect(mergeCatalog(baseline, overrides)).toEqual([{ name: 'A', prompt: 'override' }]);
  });

  it('keeps baseline-only and override-only entries', () => {
    const merged = mergeCatalog(
      [{ name: 'A', prompt: 'a' }, { name: 'B', prompt: 'b' }],
      [{ name: 'B', prompt: 'b2' }, { name: 'C', prompt: 'c' }],
    );
    expect(merged.map(s => s.name).sort()).toEqual(['A', 'B', 'C']);
    expect(merged.find(s => s.name === 'B')!.prompt).toBe('b2');
  });
});

describe('renderCatalog', () => {
  it('produces parseable wire format with monotonic generation', () => {
    const r1 = renderCatalog([{ name: 'A', prompt: 'p' }], 5);
    expect(JSON.parse(r1).generation).toBe(5);
    expect(JSON.parse(r1).version).toBe(1);
  });
});

describe('SpecialistReconciler.apply', () => {
  it('writes a merged ConfigMap via the k8s client', async () => {
    const db = openTestDb();
    registerSpecialist(db, { name: 'OnlyOverride', prompt: 'x' });
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new SpecialistReconciler({
      db,
      baselineLoader: () => [{ name: 'Baseline', prompt: 'b' }],
      configMapApply: apply,
    });
    await r.apply();
    expect(apply).toHaveBeenCalledOnce();
    const body = JSON.parse(apply.mock.calls[0][0]);
    expect(body.specialists.map((s: any) => s.name).sort()).toEqual(['Baseline', 'OnlyOverride']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/specialists/reconciler.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/specialists/reconciler.ts`:

```ts
import type { Database } from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { GlobalSpecialist, parseSpecialists } from './types.js';
import { listSpecialistOverrides } from '../skills/orchestrator/specialist-registry.js';
import { logger } from '../logger.js';

const BASELINE_PATH = '/etc/kubeclaw/specialists-baseline/specialists.json';

export function mergeCatalog(baseline: GlobalSpecialist[], overrides: GlobalSpecialist[]): GlobalSpecialist[] {
  const byName = new Map<string, GlobalSpecialist>();
  for (const s of baseline) byName.set(s.name, s);
  for (const s of overrides) byName.set(s.name, s); // override wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function renderCatalog(specialists: GlobalSpecialist[], generation: number): string {
  return JSON.stringify({ version: 1, generation, specialists }, null, 2);
}

export function loadBaselineFromDisk(path = BASELINE_PATH): GlobalSpecialist[] {
  if (!existsSync(path)) return [];
  try {
    const r = parseSpecialists(readFileSync(path, 'utf-8'));
    return r.ok ? r.specialists : [];
  } catch (err) {
    logger.warn({ err, path }, 'baseline catalog read/parse failed; treating as empty');
    return [];
  }
}

export interface ReconcilerDeps {
  db: Database;
  baselineLoader: () => GlobalSpecialist[];
  configMapApply: (rendered: string) => Promise<void>; // server-side apply to kubeclaw-specialists
}

export class SpecialistReconciler {
  private generation = 0;
  constructor(private readonly deps: ReconcilerDeps) {}

  async apply(): Promise<void> {
    const baseline = this.deps.baselineLoader();
    const overrides = listSpecialistOverrides(this.deps.db);
    const merged = mergeCatalog(baseline, overrides);
    this.generation += 1;
    const rendered = renderCatalog(merged, this.generation);
    try {
      await this.deps.configMapApply(rendered);
      logger.info({ generation: this.generation, count: merged.length }, 'specialists ConfigMap applied');
    } catch (err) {
      logger.error({ err }, 'specialists ConfigMap apply failed');
      this.generation -= 1; // do not bump on failure
      throw err;
    }
  }
}
```

- [ ] **Step 4: Wire the K8s client helper**

In `src/k8s/` find the existing ConfigMap apply pattern (used by capabilities reconciler). Reuse or extract a helper:

```ts
// In src/k8s/configmap-apply.ts (create if not present):
import { CoreV1Api, KubeConfig, V1ConfigMap, PatchStrategy, setHeaderOptions } from '@kubernetes/client-node';

export async function applyConfigMap(api: CoreV1Api, namespace: string, name: string, dataKey: string, body: string): Promise<void> {
  const cm: V1ConfigMap = {
    apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { name, namespace, labels: { app: 'kubeclaw', component: 'specialists' } },
    data: { [dataKey]: body },
  };
  await api.patchNamespacedConfigMap(
    { name, namespace, body: cm },
    setHeaderOptions('Content-Type', PatchStrategy.ApplyYaml),
  ).catch(async (err: any) => {
    if (err?.response?.statusCode === 404) {
      await api.createNamespacedConfigMap({ namespace, body: cm });
      return;
    }
    throw err;
  });
}
```

If the codebase already has a server-side-apply helper (likely from the capability reconciler), reuse it instead of creating a duplicate. Grep first: `rg "patchNamespacedConfigMap|ApplyYaml" src/k8s/`.

- [ ] **Step 5: Trigger reconcile from mutations**

In `src/skills/orchestrator/specialist-registry.ts`, take an optional reconcile callback (don't make the registry depend on the reconciler):

```ts
export type ReconcileFn = () => Promise<void>;

export function registerSpecialist(db: Database, s: GlobalSpecialist, reconcile?: ReconcileFn): Result { /* … then `await reconcile?.()` */ }
// same for editSpecialist, removeSpecialist
```

Adjust the test in Task 4 to ignore the new optional param. Callers in the admin-shell IPC handler wire the reconciler in.

- [ ] **Step 6: Run tests**

```bash
npx vitest run src/specialists/reconciler.test.ts src/skills/orchestrator/specialist-registry.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/specialists/reconciler.ts src/specialists/reconciler.test.ts src/k8s/configmap-apply.ts src/skills/orchestrator/specialist-registry.ts
git commit -m "feat(specialists): orchestrator reconciler merges baseline+overrides into ConfigMap"
```

---

## Task 6: `runAgent` accepts `sessionKey`, `llmProvider`, `toolFilter`

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts`
- Modify: `src/runtime/direct-llm-runner.test.ts` (or sibling)

- [ ] **Step 1: Write the failing test**

Add a new test case:

```ts
describe('runAgent overrides', () => {
  it('uses the supplied sessionKey for history lookup', async () => {
    // Arrange: append history under two session keys, then call runAgent with one.
    appendConversationHistory(db, { groupFolder: 'g', sessionKey: 'g', role: 'user', content: 'group-only' });
    appendConversationHistory(db, { groupFolder: 'g', sessionKey: 'g:S', role: 'user', content: 'specialist-only' });
    const runner = new DirectLLMRunner({ /* test wiring with mock LLM client that records the inbound history */ });
    await runner.runAgent(group, 'prompt', chatJid, () => {}, { sessionKey: 'g:S' });
    expect(recordedHistory.find(h => h.content === 'specialist-only')).toBeDefined();
    expect(recordedHistory.find(h => h.content === 'group-only')).toBeUndefined();
  });

  it('uses the supplied llmProvider', async () => {
    const runner = new DirectLLMRunner({ /* … */ });
    await runner.runAgent(group, 'prompt', chatJid, () => {}, { llmProvider: 'openrouter' });
    expect(mockChosenProvider).toBe('openrouter');
  });

  it('filters tools by toolFilter', async () => {
    const runner = new DirectLLMRunner({ /* register tools: bash, propose_skill, mcp:fetch */ });
    await runner.runAgent(group, 'prompt', chatJid, () => {}, { toolFilter: new Set(['mcp:fetch']) });
    expect(toolsAdvertisedToLLM.map(t => t.name).sort()).toEqual(['mcp:fetch']);
  });
});
```

(Adapt to the existing test harness style in the file — recordedHistory / mockChosenProvider / toolsAdvertisedToLLM are conceptual hooks; mirror whatever the file already uses.)

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/runtime/direct-llm-runner.test.ts -t "overrides"
```
Expected: FAIL — `runAgent` doesn't accept the options arg.

- [ ] **Step 3: Implement contract change**

In `src/runtime/direct-llm-runner.ts`, add the options parameter:

```ts
export interface RunAgentOverrides {
  sessionKey?: string;       // defaults to group.folder
  llmProvider?: string;      // defaults to group.llmProvider (or system default)
  toolFilter?: Set<string>;  // when present, registered tools are filtered to this set
}

async runAgent(
  group: Group,
  prompt: string,
  chatJid: string,
  onOutput: OutputCb,
  overrides: RunAgentOverrides = {},
): Promise<RunResult> {
  const sessionKey = overrides.sessionKey ?? group.folder;
  const provider = overrides.llmProvider ?? group.llmProvider ?? DEFAULT_LLM_PROVIDER;
  const tools = overrides.toolFilter
    ? this.tools.filter(t => overrides.toolFilter!.has(t.name))
    : this.tools;
  // …
  const history = getConversationHistory(this.db, { sessionKey });
  // pass `provider` to model client resolution
  // pass `tools` to the LLM call
}
```

Append writes likewise pass `sessionKey`:
```ts
appendConversationHistory(this.db, { groupFolder: group.folder, sessionKey, role: 'user', content: prompt });
```

- [ ] **Step 4: Update every existing `runAgent` call site to pass `{}` (no overrides) for behavioural parity**

```bash
rg "runAgent\(" src/ --files-with-matches
```
For each call site (notably `src/channel-runner.ts`, possibly schedulers), add `{}` as the 5th arg. No semantic change.

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/runtime/direct-llm-runner.test.ts
```
Expected: PASS. Full suite still green.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/runtime/direct-llm-runner.test.ts $(rg -l "runAgent\(" src/)
git commit -m "feat(runtime): runAgent accepts sessionKey/llmProvider/toolFilter overrides"
```

---

## Task 7: Rewrite `channel-runner` dispatch flow

**Files:**
- Modify: `src/channel-runner.ts` (the `processGroupMessages` around line 1113-1193)
- Modify: `src/channel-runner.test.ts`
- Modify: `src/specialists.ts` (remove `loadSpecialists`; keep `detectMentionedSpecialists` typed against `GlobalSpecialist`)

- [ ] **Step 1: Write the failing tests**

Add to `src/channel-runner.test.ts`. The test fixtures (`group`, `chatJid`, fake channel `sentMessages`, `processGroupMessages` arg shape, message-injection pattern) MUST follow the existing tests in this file — do not invent new harness shapes. Read 2-3 existing `processGroupMessages` test cases first and mirror them; the snippets below show only the new assertions specific to dispatch.

```ts
describe('processGroupMessages dispatch', () => {
  it('runs the main agent when no specialist mentioned', async () => {
    catalog.set([{ name: 'CodeReview', prompt: 'p' }]);
    const runCalls: any[] = [];
    fakeRunner.runAgent = async (g, prompt, jid, cb, overrides) => { runCalls.push({ prompt, overrides }); return 'ok'; };
    await processGroupMessages(/* … */);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].overrides.sessionKey).toBeUndefined(); // main agent uses group.folder default
  });

  it('runs mentioned specialists in parallel', async () => {
    catalog.set([{ name: 'A', prompt: 'pa' }, { name: 'B', prompt: 'pb' }]);
    const started: string[] = [];
    const release: Record<string, () => void> = {};
    fakeRunner.runAgent = async (g, prompt, jid, cb, overrides) => {
      const name = /name="([^"]+)"/.exec(prompt)?.[1] ?? 'main';
      started.push(name);
      await new Promise<void>(r => { release[name] = r; });
      return 'ok';
    };
    const p = processGroupMessages(/* message "@A @B do thing" */);
    await new Promise(r => setTimeout(r, 20));
    expect(started.sort()).toEqual(['A', 'B']);  // both started before either resolves
    release.A(); release.B();
    await p;
  });

  it('error in one specialist does not abort the others', async () => {
    catalog.set([{ name: 'A', prompt: 'pa' }, { name: 'B', prompt: 'pb' }]);
    let bRan = false;
    fakeRunner.runAgent = async (g, prompt) => {
      if (prompt.includes('name="A"')) throw new Error('boom');
      bRan = true; return 'ok';
    };
    await processGroupMessages(/* "@A @B" */);
    expect(bRan).toBe(true);
  });

  it('passes per-specialist sessionKey/llmProvider/toolFilter to runAgent', async () => {
    catalog.set([{
      name: 'Iso', prompt: 'p',
      memory: { isolated: true }, llmProvider: 'claude', tools: ['mcp:fetch'],
    }]);
    let captured: any;
    fakeRunner.runAgent = async (g, prompt, jid, cb, overrides) => { captured = overrides; return 'ok'; };
    await processGroupMessages(/* "@Iso q" */);
    expect(captured.sessionKey).toBe(`${group.folder}:Iso`);
    expect(captured.llmProvider).toBe('claude');
    expect([...captured.toolFilter]).toEqual(['mcp:fetch']);
  });

  it('prefixes replies with [@Name] when a specialist is mentioned', async () => {
    catalog.set([{ name: 'A', prompt: 'p' }]);
    fakeRunner.runAgent = async (g, prompt, jid, cb) => {
      cb({ status: 'success', result: 'hello back' });
      return 'ok';
    };
    await processGroupMessages(/* "@A hi" */);
    expect(sentMessages).toEqual(['[@A] hello back']);
  });

  it('does not prefix when no specialist is mentioned', async () => {
    catalog.set([{ name: 'A', prompt: 'p' }]);
    fakeRunner.runAgent = async (g, prompt, jid, cb) => {
      cb({ status: 'success', result: 'hello' }); return 'ok';
    };
    await processGroupMessages(/* "no mention" */);
    expect(sentMessages).toEqual(['hello']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/channel-runner.test.ts -t "dispatch"
```
Expected: FAIL.

- [ ] **Step 3: Refactor `src/specialists.ts`**

```ts
// REMOVE loadSpecialists() entirely.
// KEEP detectMentionedSpecialists, retyped:
import type { GlobalSpecialist } from './specialists/types.js';

export function detectMentionedSpecialists(
  prompt: string,
  available: GlobalSpecialist[],
): GlobalSpecialist[] {
  const matches = new Map<string, GlobalSpecialist>();
  const re = /@(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const mention = m[1].toLowerCase();
    for (const s of available) {
      if (s.name.toLowerCase() === mention || (s.triggers ?? []).some(t => t.toLowerCase() === mention)) {
        if (!matches.has(s.name)) matches.set(s.name, s);
        break;
      }
    }
  }
  return [...matches.values()];
}
```

Delete the old `SpecialistDef` interface; consumers now use `GlobalSpecialist`.

- [ ] **Step 4: Rewrite `processGroupMessages` in `src/channel-runner.ts`**

The current code at lines 1113-1193 is replaced. Pseudocode → real code (preserve the credential-block plumbing already in place earlier in the function):

```ts
const catalog = specialistCatalog.getAll();        // SpecialistCatalogLoader.getAll
const mentioned = detectMentionedSpecialists(prompt, catalog);

interface DispatchRun {
  specialistName?: string;
  prompt: string;
  overrides: RunAgentOverrides;
}

const runs: DispatchRun[] = mentioned.length > 0
  ? mentioned.map(s => ({
      specialistName: s.name,
      prompt: credentialSystemBlock
        ? `${credentialSystemBlock}\n\n<specialist name="${s.name}">\n${s.prompt}${s.claudemd ? `\n\n${s.claudemd}` : ''}\n</specialist>\n\n${prompt}`
        : `<specialist name="${s.name}">\n${s.prompt}${s.claudemd ? `\n\n${s.claudemd}` : ''}\n</specialist>\n\n${prompt}`,
      overrides: {
        sessionKey:  s.memory?.isolated ? `${group.folder}:${s.name}` : group.folder,
        llmProvider: s.llmProvider,
        toolFilter:  s.tools && s.tools.length > 0 ? new Set(s.tools) : undefined,
      },
    }))
  : [{
      prompt: credentialSystemBlock ? `${credentialSystemBlock}\n\n${prompt}` : prompt,
      overrides: {},
    }];

await channel.setTyping?.(chatJid, true);

// Per-run async helper. Task 11 (telemetry) extends the body of `runOne` — keep it
// as a named function rather than an inline lambda so the future hook has a stable place.
async function runOne(run: DispatchRun) {
  return runAgent(
    group, run.prompt, chatJid,
    async (result) => {
      if (result.result) {
        const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (text) {
          const out = run.specialistName ? `[@${run.specialistName}] ${text}` : text;
          await channel.sendMessage(chatJid, out);
          outputSentToUser = true;
        }
      }
      if (result.status === 'success') queue.notifyIdle(chatJid);
      if (result.status === 'error') hadError = true;
    },
    run.overrides,
  );
}

const results = await Promise.allSettled(runs.map(runOne));

await channel.setTyping?.(chatJid, false);

for (const [i, r] of results.entries()) {
  if (r.status === 'rejected') {
    hadError = true;
    logger.error({ err: r.reason, specialist: runs[i].specialistName }, 'specialist run failed');
  }
}
```

Note: `Promise.allSettled` — not `Promise.all` — so one rejection doesn't fail the whole batch and the loop can iterate to log per-run failures.

- [ ] **Step 5: Wire `specialistCatalog`**

In the channel pod startup (`src/channel-runner.ts` main / startup section), construct the loader once:

```ts
const specialistCatalog = new SpecialistCatalogLoader('/etc/kubeclaw/specialists/specialists.json');
specialistCatalog.start();
// pass `specialistCatalog` to processGroupMessages (or close over it in the surrounding scope).
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run src/channel-runner.test.ts src/specialists.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/channel-runner.ts src/channel-runner.test.ts src/specialists.ts src/specialists.test.ts
git commit -m "feat(channels): parallel specialist dispatch with per-specialist overrides"
```

---

## Task 8: Helm baseline ConfigMap template + values default

**Files:**
- Create: `helm/kubeclaw/templates/specialists-baseline-configmap.yaml`
- Modify: `helm/kubeclaw/values.yaml`

- [ ] **Step 1: Add the values default**

In `helm/kubeclaw/values.yaml`, append:

```yaml
# Global specialist catalog. Empty by default — every channel sees no specialists
# until you register some here or via the admin shell. See docs/SPECIALISTS.md.
specialists: []
# Example:
# specialists:
#   - name: CodeReview
#     prompt: |
#       You are a code-review specialist. Focus on security, performance, maintainability.
#     llmProvider: claude
#     tools: [mcp:fetch]
```

- [ ] **Step 2: Create the template**

`helm/kubeclaw/templates/specialists-baseline-configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubeclaw-specialists-baseline
  namespace: {{ .Release.Namespace }}
  labels:
    app: kubeclaw
    component: specialists-baseline
data:
  specialists.json: |-
    {
      "version": 1,
      "generation": 0,
      "specialists": {{ toJson (default (list) .Values.specialists) }}
    }
```

- [ ] **Step 3: Render-test with helm template**

```bash
helm template kubeclaw helm/kubeclaw --set-json='specialists=[{"name":"X","prompt":"p"}]' | grep -A 20 specialists-baseline
```
Expected: ConfigMap rendered with the expected specialist body.

- [ ] **Step 4: Commit**

```bash
git add helm/kubeclaw/templates/specialists-baseline-configmap.yaml helm/kubeclaw/values.yaml
git commit -m "feat(helm): specialists-baseline ConfigMap from values.yaml"
```

---

## Task 9: Mount baseline in orchestrator deployment

**Files:**
- Modify: `helm/kubeclaw/templates/orchestrator-deployment.yaml`

- [ ] **Step 1: Add the volume and mount**

Find the orchestrator container spec in `helm/kubeclaw/templates/orchestrator-deployment.yaml`. Add to `volumes`:

```yaml
- name: specialists-baseline
  configMap:
    name: kubeclaw-specialists-baseline
    optional: true
```

Add to the orchestrator container's `volumeMounts`:

```yaml
- name: specialists-baseline
  mountPath: /etc/kubeclaw/specialists-baseline
  readOnly: true
```

- [ ] **Step 2: Render-test**

```bash
helm template kubeclaw helm/kubeclaw | grep -B 2 -A 4 specialists-baseline
```
Expected: volume + mount present on the orchestrator deployment.

- [ ] **Step 3: Commit**

```bash
git add helm/kubeclaw/templates/orchestrator-deployment.yaml
git commit -m "feat(helm): mount specialists-baseline ConfigMap into orchestrator"
```

---

## Task 10: Mount merged ConfigMap in channel-pod PodSpec

**Files:**
- Modify: `src/k8s/job-runner.ts` (channel-pod spec construction; locate by the existing `HTTPS_PROXY` / credential-broker sidecar wire-up)
- Modify: `src/k8s/job-runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('channel-pod spec mounts kubeclaw-specialists ConfigMap optionally', () => {
  const spec = buildChannelPodSpec(/* … existing test args … */);
  const vol = spec.spec.volumes!.find(v => v.name === 'specialists-catalog');
  expect(vol).toBeDefined();
  expect(vol!.configMap).toEqual({ name: 'kubeclaw-specialists', optional: true });

  const mounts = spec.spec.containers[0].volumeMounts!;
  const mount = mounts.find(m => m.name === 'specialists-catalog');
  expect(mount).toEqual({ name: 'specialists-catalog', mountPath: '/etc/kubeclaw/specialists', readOnly: true });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/k8s/job-runner.test.ts -t "specialists"
```
Expected: FAIL.

- [ ] **Step 3: Implement**

In the channel-pod spec builder in `src/k8s/job-runner.ts`, push:

```ts
volumes.push({ name: 'specialists-catalog', configMap: { name: 'kubeclaw-specialists', optional: true } });
container.volumeMounts!.push({ name: 'specialists-catalog', mountPath: '/etc/kubeclaw/specialists', readOnly: true });
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/k8s/job-runner.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/job-runner.ts src/k8s/job-runner.test.ts
git commit -m "feat(k8s): mount specialists ConfigMap into channel pods"
```

---

## Task 11: `specialist_usage` telemetry table + writes

**Files:**
- Modify: `src/db.ts` (channel-side schema)
- Modify: `src/channel-runner.ts` (write telemetry per dispatch)
- Modify: tests as needed

- [ ] **Step 1: Add schema**

In `src/db.ts` channel-side schema setup:

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS specialist_usage (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    group_folder    TEXT NOT NULL,
    specialist_name TEXT NOT NULL,
    used_at         INTEGER NOT NULL,
    duration_ms     INTEGER,
    status          TEXT CHECK(status IN ('success','error'))
  );
`);

export function recordSpecialistUsage(db: Database, args: {
  groupFolder: string; specialistName: string; durationMs: number; status: 'success' | 'error';
}): void {
  db.prepare(
    `INSERT INTO specialist_usage (group_folder, specialist_name, used_at, duration_ms, status) VALUES (?, ?, ?, ?, ?)`
  ).run(args.groupFolder, args.specialistName, Date.now(), args.durationMs, args.status);
}
```

- [ ] **Step 2: Write the failing test**

```ts
it('records specialist usage on dispatch', async () => {
  catalog.set([{ name: 'A', prompt: 'p' }]);
  fakeRunner.runAgent = async () => 'ok';
  await processGroupMessages(/* "@A hi" */);
  const rows = db.prepare(`SELECT * FROM specialist_usage`).all();
  expect(rows).toHaveLength(1);
  expect((rows[0] as any).specialist_name).toBe('A');
  expect((rows[0] as any).status).toBe('success');
});
```

- [ ] **Step 3: Extend `runOne` in `src/channel-runner.ts` with timing + telemetry**

Task 7 already extracted `runOne` as a named helper. Wrap its body with timing and a `finally` that writes the usage row:

```ts
async function runOne(run: DispatchRun) {
  const start = Date.now();
  let status: 'success' | 'error' = 'success';
  try {
    return await runAgent(
      group, run.prompt, chatJid,
      async (result) => {
        if (result.result) {
          const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
          const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
          if (text) {
            const out = run.specialistName ? `[@${run.specialistName}] ${text}` : text;
            await channel.sendMessage(chatJid, out);
            outputSentToUser = true;
          }
        }
        if (result.status === 'success') queue.notifyIdle(chatJid);
        if (result.status === 'error') { status = 'error'; hadError = true; }
      },
      run.overrides,
    );
  } catch (err) {
    status = 'error';
    throw err;
  } finally {
    if (run.specialistName) {
      recordSpecialistUsage(db, {
        groupFolder: group.folder,
        specialistName: run.specialistName,
        durationMs: Date.now() - start,
        status,
      });
    }
  }
}
```

No other change to the dispatch flow — `Promise.allSettled(runs.map(runOne))` from Task 7 stays.

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/channel-runner.test.ts -t "usage"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/channel-runner.ts src/channel-runner.test.ts
git commit -m "feat(telemetry): record specialist_usage per dispatch"
```

---

## Task 12: Delete dead orchestrator-mode dispatch + `agents.json` loader

**Files:**
- Modify: `src/index.ts` (delete lines 373-559 and `_processGroupMessages` export; delete the `if (KUBECLAW_MODE !== 'orchestrator')` block at 1089-1100)
- Modify: `src/index.test.ts` (delete tests for `_processGroupMessages`)
- Modify: `src/specialists.ts` (delete `loadSpecialists` — already done in Task 7, verify clean)

- [ ] **Step 1: Locate and delete**

```bash
# Verify the spans before deletion:
sed -n '373,559p' src/index.ts | head -5
sed -n '1089,1100p' src/index.ts
```

In `src/index.ts`:
- Delete the entire `processGroupMessages` function spanning ~373-559.
- Delete the `_processGroupMessages` export.
- Delete the entire `if (KUBECLAW_MODE !== 'orchestrator') { … } else { … }` block at ~1089-1100. The orchestrator mode no longer needs to register a message-processing function — that path is dead.
- Remove any now-unused imports surfaced by `tsc`.

- [ ] **Step 2: Delete tests**

In `src/index.test.ts`, delete every `describe`/`it` block that imports or exercises `_processGroupMessages`. Run grep first:

```bash
rg "_processGroupMessages|processGroupMessages" src/index.test.ts
```
Delete each cited block.

- [ ] **Step 3: Verify `loadSpecialists` removal from Task 7**

```bash
rg "loadSpecialists\(" src/
```
Expected: no matches. If any survive, delete them.

- [ ] **Step 4: Type-check and run full suite**

```bash
npm run build && npx vitest run
```
Expected: clean type-check, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts src/specialists.ts
git commit -m "refactor: delete dead orchestrator-mode dispatch and agents.json loader"
```

---

## Task 13: E2E test — global specialist dispatch end-to-end

**Files:**
- Create: `e2e/specialist-catalog.spec.ts` (or alongside the existing e2e suite — match naming)

- [ ] **Step 1: Write the e2e**

```ts
import { describe, it, expect } from 'vitest';
import { installKubeclaw, setSpecialists, registerSpecialistViaAdminShell, sendMessageAndAwaitReply, queryConversationHistory } from './harness.js';

describe('global specialist catalog e2e', () => {
  it('Helm baseline specialist is dispatched on @mention', async () => {
    await installKubeclaw({ specialists: [{ name: 'Echo', prompt: 'Reply with the user message verbatim, no commentary.' }] });
    const replies = await sendMessageAndAwaitReply('http-test-group', '@Echo hello world');
    expect(replies).toEqual(['[@Echo] hello world']);
  });

  it('admin-shell registered specialist appears within 60s', async () => {
    await installKubeclaw({ specialists: [] });
    await registerSpecialistViaAdminShell({ name: 'Sum', prompt: 'Add the two numbers and return only the integer result.' });
    // Allow reconcile + kubelet propagation.
    await new Promise(r => setTimeout(r, 65_000));
    const replies = await sendMessageAndAwaitReply('http-test-group', '@Sum 2 3');
    expect(replies[0]).toMatch(/^\[@Sum\]\s*5\b/);
  }, 120_000);

  it('memory.isolated specialist does not see group history', async () => {
    await installKubeclaw({ specialists: [
      { name: 'Iso', prompt: 'Respond literally with: known=<count>, where count is the number of prior turns you can see.', memory: { isolated: true } },
    ]});
    await sendMessageAndAwaitReply('http-test-group', 'private group message');
    const replies = await sendMessageAndAwaitReply('http-test-group', '@Iso check');
    expect(replies[0]).toMatch(/known=0/);  // isolated => zero history visible
  });

  it('parallel dispatch: two mentions produce two replies in either order', async () => {
    await installKubeclaw({ specialists: [
      { name: 'Quick', prompt: 'Respond with "quick".' },
      { name: 'Slow', prompt: 'Respond with "slow".' },
    ]});
    const replies = await sendMessageAndAwaitReply('http-test-group', '@Quick @Slow run');
    expect(replies.sort()).toEqual(['[@Quick] quick', '[@Slow] slow']);
  });

  it('tool allowlist denies a tool not in the list', async () => {
    await installKubeclaw({ specialists: [
      { name: 'Reader', prompt: 'You may only read files. If asked to do anything else, refuse.', tools: [/* none */] },
    ]});
    const replies = await sendMessageAndAwaitReply('http-test-group', '@Reader run bash command echo hi');
    // The runner should not advertise any tools; the LLM has no tool to call.
    // We assert that the channel pod log shows zero tool invocations for this turn — see harness helper.
    const toolCalls = await queryConversationHistory({ session: 'http-test-group:Reader', kind: 'tool_use' });
    expect(toolCalls).toHaveLength(0);
  });
});
```

(Adapt to the existing e2e harness shape — these helpers are conceptual.)

- [ ] **Step 2: Run the e2e**

```bash
npm run test:e2e -- specialist-catalog
```
Expected: all assertions pass against a real channel pod and orchestrator. Allow generous timeouts; ConfigMap propagation can take up to a minute.

- [ ] **Step 3: Commit**

```bash
git add e2e/specialist-catalog.spec.ts
git commit -m "test(e2e): global specialist catalog end-to-end"
```

---

## Task 14: Documentation

**Files:**
- Create: `docs/legacy-specialists-architecture.md` (preserve old `docs/SPECIALISTS.md` content)
- Modify: `docs/SPECIALISTS.md` (rewrite)
- Modify: `README.md` (Agent Swarms bullet)
- Modify: `CLAUDE.md` (Key Files)
- Modify: `CHANGELOG.md` (breaking change entry)

- [ ] **Step 1: Preserve legacy content**

```bash
cp docs/SPECIALISTS.md docs/legacy-specialists-architecture.md
```

Add this header to the new `docs/legacy-specialists-architecture.md`:

```markdown
# Legacy: Per-Group Specialists (`agents.json`)

> **Deprecated as of 2026-05-16.** Replaced by the cluster-wide global specialist catalog. See `docs/SPECIALISTS.md` for the current model and `docs/superpowers/specs/2026-05-16-global-specialist-catalog-design.md` for the design.

This document is preserved for historical reference. `agents.json` files are no longer read.

---
```
(Then leave the original content unchanged below the header.)

- [ ] **Step 2: Rewrite `docs/SPECIALISTS.md`**

Replace the file entirely with content covering: the global catalog model, the schema (link to spec), `@mention` dispatch, parallel execution, memory isolation, tool allowlist, how to register specialists (Helm + admin shell), the merge precedence, troubleshooting. Cite the spec doc for design rationale.

- [ ] **Step 3: Update README**

In `README.md`, find the "Agent Swarms" bullet (currently mentions `agents.json`). Replace with:

```markdown
- **Agent Swarms** - Spin up teams of specialised agents addressable by `@mention`. Specialists are defined in a cluster-wide catalog — declared in Helm `values.yaml` (`specialists: [...]`) or registered at runtime via the admin shell. Every group sees every specialist. Mentioned specialists run in parallel inside the channel pod, with optional per-specialist model, isolated memory, and tool allowlist. See [docs/SPECIALISTS.md](docs/SPECIALISTS.md). KubeClaw is the first personal AI assistant to support agent swarms.
```

- [ ] **Step 4: Update CLAUDE.md**

Update the Key Files table — change the `src/specialists.ts` description, add new entries:

```markdown
| `src/specialists.ts`                  | @mention parser; resolves mentions against the global catalog       |
| `src/specialists/catalog-loader.ts`   | Channel-side: mounts kubeclaw-specialists ConfigMap, fs.watch reload |
| `src/specialists/reconciler.ts`       | Orchestrator-side: merge(Helm baseline, SQLite overrides) → ConfigMap |
| `src/skills/orchestrator/specialist-registry.ts` | Admin-shell IPC tools: register / edit / remove / list specialists |
```

- [ ] **Step 5: CHANGELOG entry**

In `CHANGELOG.md` under a new `## Unreleased` (or appropriate version) → `### Breaking changes`:

```markdown
- **`agents.json` per-group specialist files are no longer read.** Specialists are now defined in a cluster-wide catalog via Helm `values.yaml` (`specialists: [...]`) or registered at runtime via the admin shell (`register_specialist`). See `docs/SPECIALISTS.md` and `docs/superpowers/specs/2026-05-16-global-specialist-catalog-design.md`.
- **`src/index.ts:373-559` (orchestrator-mode `processGroupMessages`) and the `_processGroupMessages` export have been removed.** They were dead code post-four-tier architecture.
- **`conversation_history` schema:** new `session_key` column. Additive migration with online backfill; no operator action needed.
```

- [ ] **Step 6: Commit**

```bash
git add docs/SPECIALISTS.md docs/legacy-specialists-architecture.md README.md CLAUDE.md CHANGELOG.md
git commit -m "docs: rewrite SPECIALISTS.md and announce agents.json removal"
```

---

## Final integration check

- [ ] Full type-check: `npm run build`
- [ ] Full unit test suite: `npx vitest run`
- [ ] Full e2e: `npm run test:e2e`
- [ ] Manual sanity: install in minikube, register a specialist via admin shell, send a `@Specialist` message, confirm the `[@Name] …` reply and a `specialist_usage` row.

---

## Parallelization notes for the executor

These tasks have the following dependency graph:

```
Task 1 (db.session_key) ─┬─▶ Task 6 (runAgent) ──▶ Task 7 (dispatch) ──▶ Task 11 (telemetry) ──▶ Task 13 (e2e)
                         │                            ▲
Task 2 (types) ──────────┼──▶ Task 3 (loader) ───────┘
                         ├──▶ Task 4 (registry) ─▶ Task 5 (reconciler)
                         └──▶ Task 9 (orchestrator mount)
Task 8 (helm baseline) ─────▶ Task 9
Task 10 (k8s job-runner mount) — independent
Task 12 (dead code deletion) — after Task 7 (which also touches src/specialists.ts)
Task 14 (docs) — last
```

Genuinely parallelizable in independent worktrees (no shared file edits):
- **Stream A:** Tasks 1 → 6 → 7 → 11 (channel-side critical path)
- **Stream B:** Tasks 2 → 3 (channel-loader subgraph)
- **Stream C:** Tasks 4 → 5 (orchestrator-side overrides + reconciler)
- **Stream D:** Tasks 8 → 9 → 10 (K8s plumbing)

After Streams A-D merge to the integration branch, run Task 12 (deletion), Task 13 (e2e), Task 14 (docs) sequentially.
