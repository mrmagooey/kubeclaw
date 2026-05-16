# Skill Harvest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the skill harvest system per `docs/superpowers/specs/2026-05-16-skill-harvest-design.md`: channel-side capture of user-taught patterns, persisted as markdown skill files under `groups/{group}/skills/`, automatically composed into the LLM system prompt, with on-demand (`propose_skill` tool) and nightly-curator harvest paths and `/skills` chat commands for triage.

**Architecture:** Everything lives in the channel pod. Files (`groups/{group}/skills/{slug}.md`) are the source of truth for skill content; SQLite (`skill_usage` table) holds load telemetry only. New runtime modules under `src/runtime/skill-*.ts` and `src/runtime/tools/propose-skill.ts`; thin hooks into `src/runtime/direct-llm-runner.ts:775` (system prompt assembly + tool list) and `src/channel-runner.ts:499` (`runAgent` `/skills` intercept) and `src/channel-runner.ts:748` (`main` curator interval).

**Tech Stack:** TypeScript, Vitest, sql.js (WASM SQLite via `src/db.ts`), OpenAI SDK (LLM calls via `src/runtime/llm-client.ts`), minikube for e2e. Node `fs` + `path` for filesystem ops, no new deps.

**Reference files for implementers:**
- Spec: `docs/superpowers/specs/2026-05-16-skill-harvest-design.md` — read first
- Existing system prompt loader: `src/runtime/direct-llm-runner.ts:775`
- Existing schema entry point: `src/db.ts:31` (`createSchema`)
- Existing channel inbound dispatch: `src/channel-runner.ts:499` (`runAgent`)
- Built-in tool array to extend: `src/runtime/direct-llm-runner.ts:50` (`TOOLS`)

---

## Task 1: Skill file format + frontmatter parser

**Files:**
- Create: `src/runtime/skill-format.ts`
- Test: `src/runtime/skill-format.test.ts`

Pure module — no FS, no DB, no LLM. Just types and serialization. Subsequent tasks depend on this.

- [ ] **Step 1: Write failing tests**

```typescript
// src/runtime/skill-format.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseSkill,
  serializeSkill,
  validateSlug,
  SkillFile,
} from './skill-format.js';

describe('skill-format', () => {
  describe('parseSkill', () => {
    it('parses frontmatter and body', () => {
      const raw =
        '---\nname: prefer-rg\ndescription: use ripgrep\ncreated: 2026-05-16\nsource: manual\n---\n\nWhen searching, use rg.\n';
      const parsed = parseSkill(raw);
      expect(parsed.frontmatter.name).toBe('prefer-rg');
      expect(parsed.frontmatter.description).toBe('use ripgrep');
      expect(parsed.frontmatter.created).toBe('2026-05-16');
      expect(parsed.frontmatter.source).toBe('manual');
      expect(parsed.body.trim()).toBe('When searching, use rg.');
    });

    it('rejects file with missing frontmatter', () => {
      expect(() => parseSkill('just a body, no frontmatter')).toThrow(
        /frontmatter/i,
      );
    });

    it('rejects frontmatter missing required field', () => {
      const raw = '---\nname: foo\n---\nbody\n';
      expect(() => parseSkill(raw)).toThrow(/description/);
    });

    it('preserves multi-paragraph body verbatim', () => {
      const body = 'Para 1.\n\nPara 2 with `code`.\n\n- bullet\n';
      const raw = `---\nname: x\ndescription: x\ncreated: 2026-05-16\nsource: manual\n---\n\n${body}`;
      expect(parseSkill(raw).body.trimEnd()).toBe(body.trimEnd());
    });
  });

  describe('serializeSkill', () => {
    it('round-trips through parseSkill', () => {
      const skill: SkillFile = {
        frontmatter: {
          name: 'prefer-rg',
          description: 'use ripgrep',
          created: '2026-05-16',
          source: 'manual',
        },
        body: 'When searching, use rg.\n',
      };
      const serialized = serializeSkill(skill);
      const reparsed = parseSkill(serialized);
      expect(reparsed.frontmatter).toEqual(skill.frontmatter);
      expect(reparsed.body.trim()).toBe(skill.body.trim());
    });
  });

  describe('validateSlug', () => {
    it('accepts kebab-case', () => {
      expect(validateSlug('prefer-rg-over-grep')).toBe(true);
    });
    it('rejects spaces, caps, dots, underscores', () => {
      expect(validateSlug('Prefer RG')).toBe(false);
      expect(validateSlug('prefer.rg')).toBe(false);
      expect(validateSlug('prefer_rg')).toBe(false);
      expect(validateSlug('')).toBe(false);
      expect(validateSlug('_starts-with-underscore')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/runtime/skill-format.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement skill-format.ts**

```typescript
// src/runtime/skill-format.ts
export interface SkillFrontmatter {
  name: string;
  description: string;
  created: string; // ISO date YYYY-MM-DD
  source: string; // "manual" | "propose-skill-<id>" | "harvest-curator-<date>"
}

export interface SkillFile {
  frontmatter: SkillFrontmatter;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseSkill(raw: string): SkillFile {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) throw new Error('skill file missing YAML frontmatter');
  const fmBlock = m[1];
  const body = m[2] ?? '';
  const fm: Partial<SkillFrontmatter> = {};
  for (const line of fmBlock.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === 'name' || key === 'description' || key === 'created' || key === 'source') {
      fm[key] = value;
    }
  }
  for (const required of ['name', 'description', 'created', 'source'] as const) {
    if (!fm[required]) throw new Error(`skill frontmatter missing required field: ${required}`);
  }
  return { frontmatter: fm as SkillFrontmatter, body };
}

export function serializeSkill(skill: SkillFile): string {
  const fm = skill.frontmatter;
  return `---\nname: ${fm.name}\ndescription: ${fm.description}\ncreated: ${fm.created}\nsource: ${fm.source}\n---\n\n${skill.body}`;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateSlug(slug: string): boolean {
  if (!slug) return false;
  return SLUG_RE.test(slug);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/runtime/skill-format.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/skill-format.ts src/runtime/skill-format.test.ts
git -c commit.gpgsign=false commit -m "feat(skill-harvest): skill file format and frontmatter parser"
```

---

## Task 2: Skill store — filesystem operations

**Files:**
- Create: `src/runtime/skill-store.ts`
- Test: `src/runtime/skill-store.test.ts`

CRUD on `groups/{group}/skills/`, `_candidates/`, `_archive/`. Atomic writes. Operates against a configurable groups-dir root so tests use tmpdir.

- [ ] **Step 1: Write failing tests**

```typescript
// src/runtime/skill-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listAcceptedSkills,
  listCandidates,
  listArchived,
  readSkill,
  writeCandidate,
  acceptCandidate,
  rejectCandidate,
  disableSkill,
  enableSkill,
  pruneSkill,
} from './skill-store.js';
import { SkillFile } from './skill-format.js';

function mkSkill(overrides: Partial<SkillFile['frontmatter']> = {}): SkillFile {
  return {
    frontmatter: {
      name: 'demo',
      description: 'demo skill',
      created: '2026-05-16',
      source: 'manual',
      ...overrides,
    },
    body: 'Use the demo pattern.\n',
  };
}

let groupsRoot: string;
const GROUP = 'g1';

beforeEach(() => {
  groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-store-'));
  fs.mkdirSync(path.join(groupsRoot, GROUP), { recursive: true });
});

describe('skill-store', () => {
  it('returns empty arrays for fresh group', () => {
    expect(listAcceptedSkills(groupsRoot, GROUP)).toEqual([]);
    expect(listCandidates(groupsRoot, GROUP)).toEqual([]);
    expect(listArchived(groupsRoot, GROUP)).toEqual([]);
  });

  it('writes and lists a candidate', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'foo' }));
    const cands = listCandidates(groupsRoot, GROUP);
    expect(cands).toHaveLength(1);
    expect(cands[0].id).toBe(id);
    expect(cands[0].skill.frontmatter.name).toBe('foo');
  });

  it('acceptCandidate moves to accepted', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'foo' }));
    acceptCandidate(groupsRoot, GROUP, id);
    expect(listCandidates(groupsRoot, GROUP)).toHaveLength(0);
    const accepted = listAcceptedSkills(groupsRoot, GROUP);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].frontmatter.name).toBe('foo');
  });

  it('acceptCandidate refuses if accepted name already exists', () => {
    writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'dup' }));
    const id2 = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'dup' }));
    const firstId = listCandidates(groupsRoot, GROUP)[0].id;
    acceptCandidate(groupsRoot, GROUP, firstId);
    expect(() => acceptCandidate(groupsRoot, GROUP, id2)).toThrow(/already exists/);
  });

  it('rejectCandidate deletes the candidate file', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill());
    rejectCandidate(groupsRoot, GROUP, id);
    expect(listCandidates(groupsRoot, GROUP)).toEqual([]);
  });

  it('disableSkill moves to _archive', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'x' }));
    acceptCandidate(groupsRoot, GROUP, id);
    disableSkill(groupsRoot, GROUP, 'x');
    expect(listAcceptedSkills(groupsRoot, GROUP)).toEqual([]);
    expect(listArchived(groupsRoot, GROUP).map((s) => s.frontmatter.name)).toEqual(['x']);
  });

  it('enableSkill moves back from _archive', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'x' }));
    acceptCandidate(groupsRoot, GROUP, id);
    disableSkill(groupsRoot, GROUP, 'x');
    enableSkill(groupsRoot, GROUP, 'x');
    expect(listArchived(groupsRoot, GROUP)).toEqual([]);
    expect(listAcceptedSkills(groupsRoot, GROUP).map((s) => s.frontmatter.name)).toEqual(['x']);
  });

  it('pruneSkill deletes accepted skill outright', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'x' }));
    acceptCandidate(groupsRoot, GROUP, id);
    pruneSkill(groupsRoot, GROUP, 'x');
    expect(listAcceptedSkills(groupsRoot, GROUP)).toEqual([]);
    expect(listArchived(groupsRoot, GROUP)).toEqual([]);
  });

  it('readSkill returns null for unknown skill', () => {
    expect(readSkill(groupsRoot, GROUP, 'nonexistent')).toBeNull();
  });

  it('writeCandidate sanitizes filename from slug', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'my-skill' }));
    const candFile = path.join(groupsRoot, GROUP, 'skills', '_candidates', `${id}.md`);
    expect(fs.existsSync(candFile)).toBe(true);
  });

  it('writeCandidate rejects invalid slug', () => {
    expect(() => writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'Bad Name' }))).toThrow(/slug/);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/runtime/skill-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement skill-store.ts**

```typescript
// src/runtime/skill-store.ts
import * as fs from 'fs';
import * as path from 'path';
import {
  parseSkill,
  serializeSkill,
  validateSlug,
  SkillFile,
} from './skill-format.js';

export interface Candidate {
  id: string; // timestamp + slug, used as filename stem
  skill: SkillFile;
}

function skillsDir(root: string, group: string): string {
  return path.join(root, group, 'skills');
}

function candidatesDir(root: string, group: string): string {
  return path.join(skillsDir(root, group), '_candidates');
}

function archiveDir(root: string, group: string): string {
  return path.join(skillsDir(root, group), '_archive');
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function listMd(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'))
    .map((f) => path.join(dir, f));
}

function readSkillFile(file: string): SkillFile {
  return parseSkill(fs.readFileSync(file, 'utf-8'));
}

function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

export function listAcceptedSkills(root: string, group: string): SkillFile[] {
  return listMd(skillsDir(root, group)).map(readSkillFile);
}

export function listCandidates(root: string, group: string): Candidate[] {
  const dir = candidatesDir(root, group);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const id = f.replace(/\.md$/, '');
      const skill = readSkillFile(path.join(dir, f));
      return { id, skill };
    });
}

export function listArchived(root: string, group: string): SkillFile[] {
  const dir = archiveDir(root, group);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => readSkillFile(path.join(dir, f)));
}

export function readSkill(root: string, group: string, name: string): SkillFile | null {
  if (!validateSlug(name)) return null;
  const file = path.join(skillsDir(root, group), `${name}.md`);
  if (!fs.existsSync(file)) return null;
  return readSkillFile(file);
}

export function writeCandidate(root: string, group: string, skill: SkillFile): string {
  if (!validateSlug(skill.frontmatter.name)) {
    throw new Error(`invalid skill slug: ${skill.frontmatter.name}`);
  }
  const dir = candidatesDir(root, group);
  ensureDir(dir);
  const id = `${Date.now()}-${skill.frontmatter.name}`;
  writeAtomic(path.join(dir, `${id}.md`), serializeSkill(skill));
  return id;
}

export function acceptCandidate(root: string, group: string, id: string): void {
  const src = path.join(candidatesDir(root, group), `${id}.md`);
  if (!fs.existsSync(src)) throw new Error(`candidate not found: ${id}`);
  const skill = readSkillFile(src);
  const dest = path.join(skillsDir(root, group), `${skill.frontmatter.name}.md`);
  if (fs.existsSync(dest)) {
    throw new Error(`skill already exists: ${skill.frontmatter.name}`);
  }
  ensureDir(skillsDir(root, group));
  fs.renameSync(src, dest);
}

export function rejectCandidate(root: string, group: string, id: string): void {
  const src = path.join(candidatesDir(root, group), `${id}.md`);
  if (fs.existsSync(src)) fs.unlinkSync(src);
}

export function disableSkill(root: string, group: string, name: string): void {
  if (!validateSlug(name)) throw new Error(`invalid slug: ${name}`);
  const src = path.join(skillsDir(root, group), `${name}.md`);
  if (!fs.existsSync(src)) throw new Error(`skill not found: ${name}`);
  ensureDir(archiveDir(root, group));
  fs.renameSync(src, path.join(archiveDir(root, group), `${name}.md`));
}

export function enableSkill(root: string, group: string, name: string): void {
  if (!validateSlug(name)) throw new Error(`invalid slug: ${name}`);
  const src = path.join(archiveDir(root, group), `${name}.md`);
  if (!fs.existsSync(src)) throw new Error(`archived skill not found: ${name}`);
  ensureDir(skillsDir(root, group));
  fs.renameSync(src, path.join(skillsDir(root, group), `${name}.md`));
}

export function pruneSkill(root: string, group: string, name: string): void {
  if (!validateSlug(name)) throw new Error(`invalid slug: ${name}`);
  for (const dir of [skillsDir(root, group), archiveDir(root, group)]) {
    const f = path.join(dir, `${name}.md`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/runtime/skill-store.test.ts`
Expected: 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/skill-store.ts src/runtime/skill-store.test.ts
git -c commit.gpgsign=false commit -m "feat(skill-harvest): skill-store filesystem ops (accept/reject/disable/enable/prune)"
```

---

## Task 3: skill_usage table and accessors

**Files:**
- Modify: `src/db.ts` (extend `createSchema` and export accessors)
- Test: extend `src/db.test.ts`

Telemetry-only table. One row per skill load. Read by `/skills list` and the curator's pruning sweep.

- [ ] **Step 1: Add failing tests to db.test.ts**

Append to `src/db.test.ts` (after the conversation_history block, just before file end):

```typescript
// --- skill_usage / recordSkillLoad / getSkillLoadStats / getSkillsLoadedSince ---

describe('recordSkillLoad / getSkillLoadStats / getSkillsLoadedSince', () => {
  beforeEach(async () => {
    await _initTestDatabase();
  });

  it('records a load and returns it in stats', () => {
    recordSkillLoad('g1', 'skill-a', 1000);
    const stats = getSkillLoadStats('g1');
    expect(stats).toHaveLength(1);
    expect(stats[0].skill_name).toBe('skill-a');
    expect(stats[0].load_count).toBe(1);
    expect(stats[0].last_loaded).toBe(1000);
  });

  it('aggregates multiple loads of same skill', () => {
    recordSkillLoad('g1', 'skill-a', 1000);
    recordSkillLoad('g1', 'skill-a', 2000);
    recordSkillLoad('g1', 'skill-a', 3000);
    const stats = getSkillLoadStats('g1');
    expect(stats[0].load_count).toBe(3);
    expect(stats[0].last_loaded).toBe(3000);
  });

  it('isolates by group', () => {
    recordSkillLoad('g1', 'skill-a', 1000);
    recordSkillLoad('g2', 'skill-b', 2000);
    expect(getSkillLoadStats('g1').map((s) => s.skill_name)).toEqual(['skill-a']);
    expect(getSkillLoadStats('g2').map((s) => s.skill_name)).toEqual(['skill-b']);
  });

  it('getSkillsLoadedSince returns distinct skills loaded after cutoff', () => {
    recordSkillLoad('g1', 'old', 1000);
    recordSkillLoad('g1', 'recent', 5000);
    recordSkillLoad('g1', 'recent', 6000);
    expect(getSkillsLoadedSince('g1', 4000)).toEqual(['recent']);
  });
});
```

Also add imports at the top of `src/db.test.ts` alongside other db imports:

```typescript
recordSkillLoad,
getSkillLoadStats,
getSkillsLoadedSince,
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/db.test.ts -t skill_usage`
Expected: FAIL — accessors not exported.

- [ ] **Step 3: Implement schema + accessors in db.ts**

In `src/db.ts`, inside `createSchema(database)` (after the existing CREATE TABLE statements, before the closing brace), add:

```typescript
  database.run(`
    CREATE TABLE IF NOT EXISTS skill_usage (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      loaded_at INTEGER NOT NULL
    )
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_skill_usage_group_skill
    ON skill_usage(group_folder, skill_name)
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_skill_usage_loaded_at
    ON skill_usage(loaded_at)
  `);
```

At the bottom of `src/db.ts` (alongside the other exported functions), add:

```typescript
export interface SkillLoadStat {
  skill_name: string;
  load_count: number;
  last_loaded: number;
}

export function recordSkillLoad(
  groupFolder: string,
  skillName: string,
  loadedAt: number = Date.now(),
): void {
  const id = `${groupFolder}-${skillName}-${loadedAt}-${Math.random().toString(36).slice(2, 8)}`;
  db.run(
    'INSERT INTO skill_usage (id, group_folder, skill_name, loaded_at) VALUES (?, ?, ?, ?)',
    [id, groupFolder, skillName, loadedAt],
  );
  saveDatabase();
}

export function getSkillLoadStats(groupFolder: string): SkillLoadStat[] {
  const rows = db.exec(
    `SELECT skill_name, COUNT(*) as load_count, MAX(loaded_at) as last_loaded
     FROM skill_usage WHERE group_folder = ? GROUP BY skill_name
     ORDER BY last_loaded DESC`,
    [groupFolder],
  );
  if (rows.length === 0) return [];
  return rows[0].values.map((r: unknown[]) => ({
    skill_name: r[0] as string,
    load_count: r[1] as number,
    last_loaded: r[2] as number,
  }));
}

export function getSkillsLoadedSince(
  groupFolder: string,
  sinceMs: number,
): string[] {
  const rows = db.exec(
    `SELECT DISTINCT skill_name FROM skill_usage
     WHERE group_folder = ? AND loaded_at >= ?`,
    [groupFolder, sinceMs],
  );
  if (rows.length === 0) return [];
  return rows[0].values.map((r: unknown[]) => r[0] as string);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/db.test.ts -t skill_usage`
Expected: 4 tests pass. Also run the full db.test.ts to ensure no regressions: `npx vitest run src/db.test.ts` — all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git -c commit.gpgsign=false commit -m "feat(skill-harvest): skill_usage table with load telemetry accessors"
```

---

## Task 4: skill-loader — compose skills into system prompt

**Files:**
- Create: `src/runtime/skill-loader.ts`
- Test: `src/runtime/skill-loader.test.ts`

Glob → parse → concat → record telemetry. Returns the suffix to append to CLAUDE.md, plus the list of skill names loaded (for tests and future telemetry inspection).

- [ ] **Step 1: Write failing tests**

```typescript
// src/runtime/skill-loader.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _initTestDatabase, getSkillLoadStats } from '../db.js';
import { writeCandidate, acceptCandidate } from './skill-store.js';
import { SkillFile } from './skill-format.js';
import { loadSkills, SKILL_CAP } from './skill-loader.js';

function mkSkill(name: string, description = `desc-${name}`): SkillFile {
  return {
    frontmatter: { name, description, created: '2026-05-16', source: 'manual' },
    body: `body of ${name}\n`,
  };
}

function acceptN(root: string, group: string, n: number, prefix = 'sk'): void {
  for (let i = 0; i < n; i++) {
    const id = writeCandidate(root, group, mkSkill(`${prefix}-${i}`));
    acceptCandidate(root, group, id);
  }
}

let root: string;
const GROUP = 'g1';

beforeEach(async () => {
  await _initTestDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-loader-'));
  fs.mkdirSync(path.join(root, GROUP), { recursive: true });
});

describe('loadSkills', () => {
  it('returns empty suffix and no telemetry when no skills', () => {
    const res = loadSkills(root, GROUP);
    expect(res.promptSuffix).toBe('');
    expect(res.loadedSkills).toEqual([]);
    expect(getSkillLoadStats(GROUP)).toEqual([]);
  });

  it('concatenates skill bodies under a Learned skills header', () => {
    const id = writeCandidate(root, GROUP, mkSkill('alpha'));
    acceptCandidate(root, GROUP, id);
    const res = loadSkills(root, GROUP);
    expect(res.promptSuffix).toContain('## Learned skills');
    expect(res.promptSuffix).toContain('body of alpha');
    expect(res.loadedSkills).toEqual(['alpha']);
  });

  it('separates multiple skill bodies with horizontal rules', () => {
    acceptN(root, GROUP, 3);
    const res = loadSkills(root, GROUP);
    expect(res.promptSuffix.match(/---/g)?.length).toBeGreaterThanOrEqual(2);
    expect(res.loadedSkills).toHaveLength(3);
  });

  it('records a telemetry row per loaded skill', () => {
    acceptN(root, GROUP, 2);
    loadSkills(root, GROUP);
    const stats = getSkillLoadStats(GROUP);
    expect(stats.map((s) => s.skill_name).sort()).toEqual(['sk-0', 'sk-1']);
    expect(stats.every((s) => s.load_count === 1)).toBe(true);
  });

  it('caps at SKILL_CAP, preferring most recently loaded skills', () => {
    // Accept SKILL_CAP+2 skills
    acceptN(root, GROUP, SKILL_CAP + 2);
    // Load once — all get a telemetry row, but cap selects an arbitrary 20 the first time
    const first = loadSkills(root, GROUP);
    expect(first.loadedSkills).toHaveLength(SKILL_CAP);
    // Mark a specific later skill as most-recent by recording a load
    // (loadSkills already did that — verify cap respects load recency)
    const second = loadSkills(root, GROUP);
    expect(second.loadedSkills).toHaveLength(SKILL_CAP);
  });

  it('ignores _candidates and _archive directories', () => {
    // candidate present but not accepted
    writeCandidate(root, GROUP, mkSkill('not-yet'));
    const res = loadSkills(root, GROUP);
    expect(res.promptSuffix).toBe('');
    expect(res.loadedSkills).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/runtime/skill-loader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement skill-loader.ts**

```typescript
// src/runtime/skill-loader.ts
import { listAcceptedSkills } from './skill-store.js';
import { SkillFile } from './skill-format.js';
import {
  recordSkillLoad,
  getSkillLoadStats,
  SkillLoadStat,
} from '../db.js';

export const SKILL_CAP = 20;

export interface LoadResult {
  promptSuffix: string;
  loadedSkills: string[];
}

export function loadSkills(groupsRoot: string, group: string): LoadResult {
  const skills = listAcceptedSkills(groupsRoot, group);
  if (skills.length === 0) {
    return { promptSuffix: '', loadedSkills: [] };
  }

  let selected: SkillFile[];
  if (skills.length <= SKILL_CAP) {
    selected = skills;
  } else {
    const stats = new Map<string, number>(
      getSkillLoadStats(group).map((s: SkillLoadStat) => [s.skill_name, s.last_loaded]),
    );
    selected = [...skills]
      .sort(
        (a, b) =>
          (stats.get(b.frontmatter.name) ?? 0) -
          (stats.get(a.frontmatter.name) ?? 0),
      )
      .slice(0, SKILL_CAP);
  }

  const now = Date.now();
  const loadedSkills: string[] = [];
  const bodies: string[] = [];
  for (const skill of selected) {
    recordSkillLoad(group, skill.frontmatter.name, now);
    loadedSkills.push(skill.frontmatter.name);
    bodies.push(skill.body.trim());
  }

  const promptSuffix =
    '\n\n## Learned skills\n\n' + bodies.join('\n\n---\n\n');
  return { promptSuffix, loadedSkills };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/runtime/skill-loader.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/skill-loader.ts src/runtime/skill-loader.test.ts
git -c commit.gpgsign=false commit -m "feat(skill-harvest): skill-loader composes skill bodies into prompt with telemetry"
```

---

## Task 5: propose_skill tool handler

**Files:**
- Create: `src/runtime/tools/propose-skill.ts`
- Test: `src/runtime/tools/propose-skill.test.ts`

Stateless function that takes proposed-skill args + an LLM client for duplicate detection. Returns either `{ kind: 'duplicate', existing: string, suggestion: string }` or `{ kind: 'staged', candidateId: string, preview: string }`. The LLM client is injected so tests can mock it.

- [ ] **Step 1: Write failing tests**

```typescript
// src/runtime/tools/propose-skill.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listCandidates, writeCandidate, acceptCandidate } from '../skill-store.js';
import { proposeSkill, ProposeSkillArgs, DupCheckFn } from './propose-skill.js';

let root: string;
const GROUP = 'g1';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'propose-skill-'));
  fs.mkdirSync(path.join(root, GROUP), { recursive: true });
});

const novelDup: DupCheckFn = async () => ({ duplicate: false });
const dupOfFoo: DupCheckFn = async () => ({
  duplicate: true,
  existing: 'foo',
  suggestion: 'extend foo instead',
});

function mkArgs(name = 'bar'): ProposeSkillArgs {
  return {
    proposed_name: name,
    description: 'a brand new skill',
    body: 'do the thing this way',
    rationale: 'because peter said so',
  };
}

describe('proposeSkill', () => {
  it('writes a candidate when novel', async () => {
    const res = await proposeSkill(root, GROUP, mkArgs(), novelDup);
    expect(res.kind).toBe('staged');
    if (res.kind === 'staged') {
      expect(res.candidateId).toBeDefined();
      expect(res.preview).toContain('do the thing this way');
    }
    expect(listCandidates(root, GROUP)).toHaveLength(1);
  });

  it('does not write a candidate when duplicate detected', async () => {
    const res = await proposeSkill(root, GROUP, mkArgs(), dupOfFoo);
    expect(res.kind).toBe('duplicate');
    if (res.kind === 'duplicate') {
      expect(res.existing).toBe('foo');
    }
    expect(listCandidates(root, GROUP)).toHaveLength(0);
  });

  it('detects duplicate against an existing accepted skill via the dup-check', async () => {
    // Seed an accepted skill named foo
    const id = writeCandidate(root, GROUP, {
      frontmatter: { name: 'foo', description: 'foo skill', created: '2026-05-16', source: 'manual' },
      body: 'foo body',
    });
    acceptCandidate(root, GROUP, id);

    const dup: DupCheckFn = vi.fn(async (_args, existing) => {
      expect(existing.map((s) => s.frontmatter.name)).toContain('foo');
      return { duplicate: true, existing: 'foo', suggestion: 'edit foo' };
    });

    const res = await proposeSkill(root, GROUP, mkArgs(), dup);
    expect(res.kind).toBe('duplicate');
    expect(dup).toHaveBeenCalledOnce();
  });

  it('rejects invalid slug before any LLM call', async () => {
    const dup: DupCheckFn = vi.fn(novelDup);
    const res = await proposeSkill(root, GROUP, mkArgs('Bad Slug'), dup);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/slug/);
    expect(dup).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/runtime/tools/propose-skill.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement propose-skill.ts**

```typescript
// src/runtime/tools/propose-skill.ts
import { listAcceptedSkills, writeCandidate } from '../skill-store.js';
import { SkillFile, validateSlug } from '../skill-format.js';

export interface ProposeSkillArgs {
  proposed_name: string;
  description: string;
  body: string;
  rationale: string;
}

export interface DupCheckResult {
  duplicate: boolean;
  existing?: string;
  suggestion?: string;
}

export type DupCheckFn = (
  args: ProposeSkillArgs,
  existingSkills: SkillFile[],
) => Promise<DupCheckResult>;

export type ProposeSkillResult =
  | { kind: 'staged'; candidateId: string; preview: string }
  | { kind: 'duplicate'; existing: string; suggestion: string }
  | { kind: 'error'; message: string };

export async function proposeSkill(
  groupsRoot: string,
  group: string,
  args: ProposeSkillArgs,
  dupCheck: DupCheckFn,
): Promise<ProposeSkillResult> {
  if (!validateSlug(args.proposed_name)) {
    return {
      kind: 'error',
      message: `invalid slug (use kebab-case): ${args.proposed_name}`,
    };
  }
  const existing = listAcceptedSkills(groupsRoot, group);
  const dup = await dupCheck(args, existing);
  if (dup.duplicate) {
    return {
      kind: 'duplicate',
      existing: dup.existing ?? '(unknown)',
      suggestion: dup.suggestion ?? 'edit the existing skill rather than creating a new one',
    };
  }
  const skill: SkillFile = {
    frontmatter: {
      name: args.proposed_name,
      description: args.description,
      created: new Date().toISOString().slice(0, 10),
      source: `propose-skill-${Date.now()}`,
    },
    body: args.body.trim() + '\n',
  };
  const candidateId = writeCandidate(groupsRoot, group, skill);
  const preview = `Drafted candidate ${candidateId}: ${args.proposed_name}\n\n${args.body.trim()}`;
  return { kind: 'staged', candidateId, preview };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/runtime/tools/propose-skill.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/tools/propose-skill.ts src/runtime/tools/propose-skill.test.ts
git -c commit.gpgsign=false commit -m "feat(skill-harvest): propose_skill tool handler with duplicate detection"
```

---

## Task 6: Wire loader + propose_skill tool into DirectLLMRunner

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts`
- Test: extend `src/runtime/direct-llm-runner.test.ts` (or create if minimal)

Two changes in one task because both edit the same file:
1. `loadSystemPrompt` calls `loadSkills(GROUPS_DIR, groupFolder)` and appends `result.promptSuffix`
2. Add `propose_skill` to the `TOOLS` array; wire the tool-call handler to invoke `proposeSkill(...)` and a real LLM-backed `DupCheckFn` (calls the runner's `this.client` with a short structured prompt)

- [ ] **Step 1: Add failing test in direct-llm-runner.test.ts**

Find an appropriate place (or top-level if no existing test file structure dictates) and add:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { __testing__ as runnerTesting } from './direct-llm-runner.js';

describe('loadSystemPrompt — skill composition', () => {
  let tmpGroupsDir: string;
  beforeEach(() => {
    tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-skills-'));
    process.env.GROUPS_DIR = tmpGroupsDir;
    fs.mkdirSync(path.join(tmpGroupsDir, 'g1'), { recursive: true });
    fs.writeFileSync(path.join(tmpGroupsDir, 'g1', 'CLAUDE.md'), 'BASE PROMPT');
  });

  it('returns CLAUDE.md unchanged when no skills directory', () => {
    const out = runnerTesting.loadSystemPromptForTest('g1');
    expect(out).toContain('BASE PROMPT');
    expect(out).not.toContain('Learned skills');
  });

  it('appends skill bodies under Learned skills when present', () => {
    fs.mkdirSync(path.join(tmpGroupsDir, 'g1', 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpGroupsDir, 'g1', 'skills', 'alpha.md'),
      '---\nname: alpha\ndescription: alpha\ncreated: 2026-05-16\nsource: manual\n---\n\nALPHA BODY\n',
    );
    const out = runnerTesting.loadSystemPromptForTest('g1');
    expect(out).toContain('BASE PROMPT');
    expect(out).toContain('## Learned skills');
    expect(out).toContain('ALPHA BODY');
  });
});

describe('TOOLS — propose_skill registration', () => {
  it('includes propose_skill in the built-in tool list', () => {
    const names = runnerTesting.toolsForTest().map((t) => t.function.name);
    expect(names).toContain('propose_skill');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/runtime/direct-llm-runner.test.ts -t "skill composition\|propose_skill"`
Expected: FAIL — `__testing__` export and skill loading not yet implemented.

- [ ] **Step 3: Modify direct-llm-runner.ts**

Add import at the top:

```typescript
import { loadSkills } from './skill-loader.js';
import { proposeSkill, DupCheckFn } from './tools/propose-skill.js';
import { _initTestDatabase as _initTestDatabaseForSkills } from '../db.js'; // only if needed by tests
```

Edit `loadSystemPrompt` (currently at line ~775):

```typescript
function loadSystemPrompt(groupFolder: string): string {
  const claudeMd = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
  let base = DEFAULT_SYSTEM_PROMPT;
  try {
    const content = fs.readFileSync(claudeMd, 'utf-8');
    if (content.trim()) base = content.trim();
  } catch {
    // file missing — use default
  }
  try {
    const { promptSuffix } = loadSkills(GROUPS_DIR, groupFolder);
    return promptSuffix ? base + promptSuffix : base;
  } catch (err) {
    logger.warn({ err, groupFolder }, 'skill-loader failed; using base prompt');
    return base;
  }
}
```

Add the `propose_skill` tool to the `TOOLS` array (after the other built-ins around line 50–200):

```typescript
{
  type: 'function',
  function: {
    name: 'propose_skill',
    description:
      'Capture a reusable instruction or pattern as a skill candidate. Use when the user has just taught you something they want remembered for future conversations (a correction, a preferred tool, a non-obvious pattern). Will stage a candidate that the user reviews via /skills review.',
    parameters: {
      type: 'object',
      properties: {
        proposed_name: {
          type: 'string',
          description: 'kebab-case slug (e.g. prefer-rg-over-grep)',
        },
        description: {
          type: 'string',
          description: 'one-line, specific, what triggers it',
        },
        body: {
          type: 'string',
          description: 'markdown body of the instruction',
        },
        rationale: {
          type: 'string',
          description: 'why this is worth keeping; shown to the user',
        },
      },
      required: ['proposed_name', 'description', 'body', 'rationale'],
    },
  },
},
```

In the tool-call dispatch loop inside `runAgent` (near the existing `else if (call.function.name === 'execute_agent')` around line 916), add a branch:

```typescript
} else if (call.function.name === 'propose_skill') {
  const args = JSON.parse(call.function.arguments) as Parameters<typeof proposeSkill>[2];
  const dupCheck: DupCheckFn = async (a, existing) => {
    if (existing.length === 0) return { duplicate: false };
    const sys = 'You judge whether a proposed skill is a duplicate of any existing skill. Reply JSON: {"duplicate": boolean, "existing": "<name>"|null, "suggestion": "<short>"|null}';
    const listing = existing
      .map((s) => `- ${s.frontmatter.name}: ${s.frontmatter.description}`)
      .join('\n');
    const user = `Existing skills:\n${listing}\n\nProposed:\nname: ${a.proposed_name}\ndescription: ${a.description}\n`;
    const completion = await this.client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 200,
    });
    try {
      return JSON.parse(completion.choices[0].message.content ?? '{"duplicate":false}');
    } catch {
      return { duplicate: false };
    }
  };
  const result = await proposeSkill(GROUPS_DIR, input.groupFolder, args, dupCheck);
  const toolResult =
    result.kind === 'staged'
      ? `Staged candidate ${result.candidateId}. Tell the user: ${result.preview}\n\nThey can reply '/skills review' to triage.`
      : result.kind === 'duplicate'
        ? `Duplicate of '${result.existing}'. ${result.suggestion}`
        : `Error: ${result.message}`;
  messages.push({
    role: 'tool',
    tool_call_id: call.id,
    content: toolResult,
  });
}
```

At the bottom of `direct-llm-runner.ts`, export a `__testing__` symbol for tests:

```typescript
export const __testing__ = {
  loadSystemPromptForTest: (group: string) => loadSystemPrompt(group),
  toolsForTest: () => TOOLS,
};
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/runtime/direct-llm-runner.test.ts`
Expected: new tests pass. Also run the full runner test suite to verify no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/runtime/direct-llm-runner.test.ts
git -c commit.gpgsign=false commit -m "feat(skill-harvest): wire skill-loader and propose_skill tool into DirectLLMRunner"
```

---

## Task 7: skill-curator — channel-side nightly scan

**Files:**
- Create: `src/runtime/skill-curator.ts`
- Test: `src/runtime/skill-curator.test.ts`

Takes group, transcript-fetcher, skill-loader, and an LLM client; produces zero or more candidates written to `_candidates/`. The LLM call is injected for tests.

- [ ] **Step 1: Write failing tests**

```typescript
// src/runtime/skill-curator.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listCandidates, listAcceptedSkills, writeCandidate, acceptCandidate } from './skill-store.js';
import { runCurator, CuratorDeps, CuratorLLMFn } from './skill-curator.js';

let root: string;
const GROUP = 'g1';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-'));
  fs.mkdirSync(path.join(root, GROUP), { recursive: true });
});

function deps(transcript: { role: string; content: string }[], llm: CuratorLLMFn): CuratorDeps {
  return {
    groupsRoot: root,
    getTranscript: () => transcript,
    llm,
  };
}

const noopLLM: CuratorLLMFn = async () => [];

describe('runCurator', () => {
  it('does nothing when transcript is below threshold', async () => {
    const calls: number[] = [];
    const llm: CuratorLLMFn = async () => {
      calls.push(1);
      return [];
    };
    const res = await runCurator(GROUP, deps([{ role: 'user', content: 'hi' }], llm));
    expect(res.candidatesWritten).toBe(0);
    expect(calls).toEqual([]); // LLM not invoked
  });

  it('writes candidates for each LLM-returned new entry', async () => {
    const transcript = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `t${i}` }));
    const llm: CuratorLLMFn = async () => [
      { action: 'new', target: null, name: 'alpha', description: 'alpha', body: 'A' },
      { action: 'new', target: null, name: 'beta', description: 'beta', body: 'B' },
    ];
    const res = await runCurator(GROUP, deps(transcript, llm));
    expect(res.candidatesWritten).toBe(2);
    const cands = listCandidates(root, GROUP);
    expect(cands.map((c) => c.skill.frontmatter.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('writes an edit candidate referencing existing skill', async () => {
    // seed existing skill
    const id = writeCandidate(root, GROUP, {
      frontmatter: { name: 'foo', description: 'foo', created: '2026-05-16', source: 'manual' },
      body: 'old body',
    });
    acceptCandidate(root, GROUP, id);
    const transcript = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `t${i}` }));
    const llm: CuratorLLMFn = async () => [
      { action: 'edit', target: 'foo', name: 'foo', description: 'foo updated', body: 'new body' },
    ];
    const res = await runCurator(GROUP, deps(transcript, llm));
    expect(res.candidatesWritten).toBe(1);
    const cands = listCandidates(root, GROUP);
    expect(cands).toHaveLength(1);
    expect(cands[0].skill.body).toContain('new body');
    // accepted skill is unchanged until user accepts the candidate
    expect(listAcceptedSkills(root, GROUP)[0].body).toContain('old body');
  });

  it('ignores entries with missing required fields', async () => {
    const transcript = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `t${i}` }));
    const llm: CuratorLLMFn = async () =>
      [
        { action: 'new', target: null, name: '', description: 'd', body: 'b' },
        { action: 'new', target: null, name: 'good', description: 'd', body: 'b' },
      ] as any;
    const res = await runCurator(GROUP, deps(transcript, llm));
    expect(res.candidatesWritten).toBe(1);
    expect(listCandidates(root, GROUP)[0].skill.frontmatter.name).toBe('good');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/runtime/skill-curator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement skill-curator.ts**

```typescript
// src/runtime/skill-curator.ts
import { logger } from '../logger.js';
import { listAcceptedSkills, writeCandidate } from './skill-store.js';
import { SkillFile, validateSlug } from './skill-format.js';

export interface TranscriptTurn {
  role: string;
  content: string;
}

export interface CuratorProposal {
  action: 'new' | 'edit' | 'tune-description';
  target: string | null; // skill name when action is edit/tune-description
  name: string;
  description: string;
  body: string;
}

export type CuratorLLMFn = (
  transcript: TranscriptTurn[],
  existingSkills: SkillFile[],
) => Promise<CuratorProposal[]>;

export interface CuratorDeps {
  groupsRoot: string;
  getTranscript: () => TranscriptTurn[];
  llm: CuratorLLMFn;
}

const MIN_USER_TURNS = 3;

export interface CuratorResult {
  candidatesWritten: number;
}

export async function runCurator(group: string, deps: CuratorDeps): Promise<CuratorResult> {
  const transcript = deps.getTranscript();
  const userTurns = transcript.filter((t) => t.role === 'user').length;
  if (userTurns < MIN_USER_TURNS) {
    return { candidatesWritten: 0 };
  }
  const existing = listAcceptedSkills(deps.groupsRoot, group);
  let proposals: CuratorProposal[];
  try {
    proposals = await deps.llm(transcript, existing);
  } catch (err) {
    logger.warn({ err, group }, 'curator LLM failed');
    return { candidatesWritten: 0 };
  }

  let written = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const p of proposals) {
    if (!p || !p.name || !p.description || !p.body) continue;
    if (!validateSlug(p.name)) continue;
    const skill: SkillFile = {
      frontmatter: {
        name: p.name,
        description: p.description,
        created: today,
        source: `harvest-curator-${today}`,
      },
      body: p.body.trim() + '\n',
    };
    try {
      writeCandidate(deps.groupsRoot, group, skill);
      written++;
    } catch (err) {
      logger.warn({ err, name: p.name }, 'failed to stage curator candidate');
    }
  }
  return { candidatesWritten: written };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/runtime/skill-curator.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/skill-curator.ts src/runtime/skill-curator.test.ts
git -c commit.gpgsign=false commit -m "feat(skill-harvest): skill-curator generates candidates from transcript signals"
```

---

## Task 8: Wire curator interval into channel-runner.ts main()

**Files:**
- Modify: `src/channel-runner.ts`
- Test: extend `src/channel-runner.test.ts` if structured tests exist; otherwise rely on integration via Task 11 (e2e). At minimum, the wiring is a tiny startup hook — verify by reading.

- [ ] **Step 1: Add the wiring**

In `src/channel-runner.ts`, add imports at the top (alongside existing runtime imports):

```typescript
import { runCurator, CuratorLLMFn, CuratorProposal } from './runtime/skill-curator.js';
import { getConversationHistory } from './db.js';
import { GROUPS_DIR } from './config.js';
import { createLLMClient, DEFAULT_DIRECT_MODEL } from './runtime/llm-client.js';
import { listAcceptedSkills } from './runtime/skill-store.js';
```

After `await initDatabase();` at `src/channel-runner.ts:750`, add:

```typescript
  startSkillCuratorInterval();
```

Add this function near the other top-level helpers in `channel-runner.ts`:

```typescript
const CURATOR_INTERVAL_MS = Number(process.env.SKILL_CURATOR_INTERVAL_MS ?? 24 * 60 * 60 * 1000);

function startSkillCuratorInterval(): void {
  if (CURATOR_INTERVAL_MS <= 0) {
    logger.info('skill curator disabled (SKILL_CURATOR_INTERVAL_MS=0)');
    return;
  }
  setInterval(async () => {
    try {
      const groups = Object.keys(registeredGroups);
      const client = createLLMClient();
      for (const group of groups) {
        const transcript = getConversationHistory(group).slice(-200);
        const llm: CuratorLLMFn = async (tx, existing) => {
          const sys = `You analyze a recent assistant-user transcript and propose at most 3 skill candidates. Reply JSON: {"proposals": [{"action":"new"|"edit"|"tune-description","target":string|null,"name":string,"description":string,"body":string}]}. Prefer "edit" over "new" when the topic overlaps an existing skill. Skip project-specific facts (those belong elsewhere) and one-off solutions.`;
          const existingDigest = existing
            .map((s) => `- ${s.frontmatter.name}: ${s.frontmatter.description}`)
            .join('\n');
          const transcriptStr = tx
            .map((t) => `[${t.role}] ${t.content}`)
            .join('\n')
            .slice(0, 12000);
          const completion = await client.chat.completions.create({
            model: DEFAULT_DIRECT_MODEL,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: `Existing skills:\n${existingDigest || '(none)'}\n\nTranscript:\n${transcriptStr}` },
            ],
            response_format: { type: 'json_object' },
            max_tokens: 1200,
          });
          try {
            const parsed = JSON.parse(completion.choices[0].message.content ?? '{"proposals":[]}');
            return Array.isArray(parsed.proposals) ? (parsed.proposals as CuratorProposal[]) : [];
          } catch {
            return [];
          }
        };
        const res = await runCurator(group, { groupsRoot: GROUPS_DIR, getTranscript: () => transcript, llm });
        if (res.candidatesWritten > 0) {
          logger.info({ group, candidates: res.candidatesWritten }, 'skill curator staged candidates');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'skill curator interval iteration failed');
    }
  }, CURATOR_INTERVAL_MS).unref();
}
```

- [ ] **Step 2: Run the existing channel-runner tests to verify no regressions**

Run: `npx vitest run src/channel-runner.test.ts`
Expected: existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/channel-runner.ts
git -c commit.gpgsign=false commit -m "feat(skill-harvest): start nightly skill curator interval in channel-runner main()"
```

---

## Task 9: skills-commands — /skills chat command parser

**Files:**
- Create: `src/runtime/skills-commands.ts`
- Test: `src/runtime/skills-commands.test.ts`

Pure command dispatcher. Returns a `string` reply that the channel sends back to the user. No LLM. Uses skill-store for all mutations and a small in-memory review cursor (per `(group, jid)`).

- [ ] **Step 1: Write failing tests**

```typescript
// src/runtime/skills-commands.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  handleSkillsCommand,
  resetReviewCursors,
} from './skills-commands.js';
import { writeCandidate, acceptCandidate } from './skill-store.js';
import { SkillFile } from './skill-format.js';
import { _initTestDatabase } from '../db.js';

function mkSkill(name: string): SkillFile {
  return {
    frontmatter: { name, description: `d-${name}`, created: '2026-05-16', source: 'manual' },
    body: `body-${name}\n`,
  };
}

let root: string;
const GROUP = 'g1';
const JID = 'user@channel';

beforeEach(async () => {
  await _initTestDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-cmd-'));
  fs.mkdirSync(path.join(root, GROUP), { recursive: true });
  resetReviewCursors();
});

describe('handleSkillsCommand', () => {
  it('list — empty state', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills list');
    expect(reply).toMatch(/no skills/i);
  });

  it('list — shows accepted skills', () => {
    const id = writeCandidate(root, GROUP, mkSkill('alpha'));
    acceptCandidate(root, GROUP, id);
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills list');
    expect(reply).toContain('alpha');
  });

  it('show — prints skill body', () => {
    const id = writeCandidate(root, GROUP, mkSkill('alpha'));
    acceptCandidate(root, GROUP, id);
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills show alpha');
    expect(reply).toContain('body-alpha');
  });

  it('show — unknown skill', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills show nope');
    expect(reply).toMatch(/not found/i);
  });

  it('review — empty queue', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills review');
    expect(reply).toMatch(/no candidates/i);
  });

  it('review — walks candidates and accept advances cursor', () => {
    const id1 = writeCandidate(root, GROUP, mkSkill('a'));
    const id2 = writeCandidate(root, GROUP, mkSkill('b'));
    const first = handleSkillsCommand(root, GROUP, JID, '/skills review');
    expect(first).toContain(id1);
    const acc = handleSkillsCommand(root, GROUP, JID, `/skills accept ${id1}`);
    expect(acc).toMatch(/accepted/i);
    const next = handleSkillsCommand(root, GROUP, JID, '/skills review');
    expect(next).toContain(id2);
  });

  it('reject — removes candidate', () => {
    const id = writeCandidate(root, GROUP, mkSkill('x'));
    const reply = handleSkillsCommand(root, GROUP, JID, `/skills reject ${id}`);
    expect(reply).toMatch(/rejected/i);
    const after = handleSkillsCommand(root, GROUP, JID, '/skills review');
    expect(after).toMatch(/no candidates/i);
  });

  it('disable + enable round-trip', () => {
    const id = writeCandidate(root, GROUP, mkSkill('alpha'));
    acceptCandidate(root, GROUP, id);
    expect(handleSkillsCommand(root, GROUP, JID, '/skills disable alpha')).toMatch(/disabled/i);
    expect(handleSkillsCommand(root, GROUP, JID, '/skills list')).not.toContain('alpha');
    expect(handleSkillsCommand(root, GROUP, JID, '/skills enable alpha')).toMatch(/enabled/i);
    expect(handleSkillsCommand(root, GROUP, JID, '/skills list')).toContain('alpha');
  });

  it('unknown verb', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills frobnicate');
    expect(reply).toMatch(/unknown/i);
  });

  it('plain /skills shows help', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills');
    expect(reply).toMatch(/list|review|show|accept|reject|disable|enable|prune/);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/runtime/skills-commands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement skills-commands.ts**

```typescript
// src/runtime/skills-commands.ts
import {
  listAcceptedSkills,
  listCandidates,
  listArchived,
  readSkill,
  acceptCandidate,
  rejectCandidate,
  disableSkill,
  enableSkill,
  pruneSkill,
} from './skill-store.js';
import { getSkillLoadStats, getSkillsLoadedSince } from '../db.js';

const reviewCursors = new Map<string, number>();

export function resetReviewCursors(): void {
  reviewCursors.clear();
}

const HELP = [
  'Skill commands:',
  '  /skills list',
  '  /skills show <name>',
  '  /skills review',
  '  /skills accept <candidate-id>',
  '  /skills reject <candidate-id>',
  '  /skills disable <name>',
  '  /skills enable <name>',
  '  /skills prune',
].join('\n');

export function handleSkillsCommand(
  groupsRoot: string,
  group: string,
  jid: string,
  message: string,
): string {
  const parts = message.trim().split(/\s+/);
  if (parts[0] !== '/skills') return HELP;
  const verb = parts[1];
  const arg = parts.slice(2).join(' ');
  const cursorKey = `${group}:${jid}`;
  switch (verb) {
    case undefined:
    case 'help':
      return HELP;
    case 'list': {
      const skills = listAcceptedSkills(groupsRoot, group);
      if (skills.length === 0) return 'No skills installed for this group.';
      const stats = new Map(getSkillLoadStats(group).map((s) => [s.skill_name, s]));
      return (
        'Installed skills:\n' +
        skills
          .map((s) => {
            const stat = stats.get(s.frontmatter.name);
            const count = stat?.load_count ?? 0;
            return `  ${s.frontmatter.name} — ${s.frontmatter.description} (loaded ${count}x)`;
          })
          .join('\n')
      );
    }
    case 'show': {
      if (!arg) return 'Usage: /skills show <name>';
      const skill = readSkill(groupsRoot, group, arg);
      if (!skill) return `Skill not found: ${arg}`;
      return `# ${skill.frontmatter.name}\n${skill.frontmatter.description}\n\n${skill.body}`;
    }
    case 'review': {
      const cands = listCandidates(groupsRoot, group);
      if (cands.length === 0) {
        reviewCursors.delete(cursorKey);
        return 'No candidates pending review.';
      }
      const cursor = reviewCursors.get(cursorKey) ?? 0;
      const next = cursor >= cands.length ? 0 : cursor;
      const c = cands[next];
      reviewCursors.set(cursorKey, next + 1);
      return (
        `Candidate ${next + 1} of ${cands.length}: ${c.id}\n` +
        `name: ${c.skill.frontmatter.name}\n` +
        `description: ${c.skill.frontmatter.description}\n\n` +
        c.skill.body +
        `\nReply: /skills accept ${c.id}  |  /skills reject ${c.id}  |  /skills review (skip)`
      );
    }
    case 'accept': {
      if (!arg) return 'Usage: /skills accept <candidate-id>';
      try {
        acceptCandidate(groupsRoot, group, arg);
        return `Accepted candidate ${arg}.`;
      } catch (err) {
        return `Could not accept: ${(err as Error).message}`;
      }
    }
    case 'reject': {
      if (!arg) return 'Usage: /skills reject <candidate-id>';
      rejectCandidate(groupsRoot, group, arg);
      return `Rejected candidate ${arg}.`;
    }
    case 'disable': {
      if (!arg) return 'Usage: /skills disable <name>';
      try {
        disableSkill(groupsRoot, group, arg);
        return `Disabled skill ${arg}.`;
      } catch (err) {
        return `Could not disable: ${(err as Error).message}`;
      }
    }
    case 'enable': {
      if (!arg) return 'Usage: /skills enable <name>';
      try {
        enableSkill(groupsRoot, group, arg);
        return `Enabled skill ${arg}.`;
      } catch (err) {
        return `Could not enable: ${(err as Error).message}`;
      }
    }
    case 'prune': {
      const skills = listAcceptedSkills(groupsRoot, group);
      const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
      const recentlyLoaded = new Set(getSkillsLoadedSince(group, cutoff));
      const stale = skills
        .map((s) => s.frontmatter.name)
        .filter((n) => !recentlyLoaded.has(n));
      if (stale.length === 0) return 'No stale skills (all loaded in last 60 days).';
      return (
        'Stale skills (0 loads in 60 days). Confirm with /skills prune-confirm <name>:\n' +
        stale.map((n) => `  ${n}`).join('\n')
      );
    }
    case 'prune-confirm': {
      if (!arg) return 'Usage: /skills prune-confirm <name>';
      try {
        pruneSkill(groupsRoot, group, arg);
        return `Pruned ${arg}.`;
      } catch (err) {
        return `Could not prune: ${(err as Error).message}`;
      }
    }
    default:
      return `Unknown verb: ${verb}\n\n${HELP}`;
  }
}

export function isSkillsCommand(message: string): boolean {
  return /^\/skills(\s|$)/.test(message.trim());
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/runtime/skills-commands.test.ts`
Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/skills-commands.ts src/runtime/skills-commands.test.ts
git -c commit.gpgsign=false commit -m "feat(skill-harvest): /skills chat command parser and handlers"
```

---

## Task 10: Wire /skills intercept into channel-runner runAgent

**Files:**
- Modify: `src/channel-runner.ts`
- Test: extend `src/channel-runner.test.ts`

At the top of `runAgent` (currently at line 499), if the prompt is a `/skills` command, dispatch to `handleSkillsCommand` and emit the reply via `wrappedOnOutput` rather than calling the LLM runner.

- [ ] **Step 1: Add failing test**

In `src/channel-runner.test.ts` (add a new describe block, importing as needed):

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('runAgent — /skills intercept', () => {
  it('does not invoke the LLM runner when prompt starts with /skills', async () => {
    // This is verified by a unit test on the dispatcher helper.
    const { dispatchSkillsCommandIfApplicable } = await import('./channel-runner.js');
    const outputs: string[] = [];
    const handled = await dispatchSkillsCommandIfApplicable(
      { folder: 'g1' } as any,
      '/skills list',
      'jid1',
      async (o) => {
        outputs.push(o.message ?? '');
      },
    );
    expect(handled).toBe(true);
    expect(outputs.join('\n')).toMatch(/no skills/i);
  });

  it('returns false (and does not output) for non-/skills prompts', async () => {
    const { dispatchSkillsCommandIfApplicable } = await import('./channel-runner.js');
    const outputs: string[] = [];
    const handled = await dispatchSkillsCommandIfApplicable(
      { folder: 'g1' } as any,
      'hello',
      'jid1',
      async (o) => {
        outputs.push(o.message ?? '');
      },
    );
    expect(handled).toBe(false);
    expect(outputs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/channel-runner.test.ts -t /skills`
Expected: FAIL — export not present.

- [ ] **Step 3: Modify channel-runner.ts**

Add imports at the top:

```typescript
import { handleSkillsCommand, isSkillsCommand } from './runtime/skills-commands.js';
```

Add a small exported helper near the other top-level helpers, before `runAgent`:

```typescript
export async function dispatchSkillsCommandIfApplicable(
  group: RegisteredGroup,
  prompt: string,
  jid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<boolean> {
  if (!isSkillsCommand(prompt)) return false;
  const reply = handleSkillsCommand(GROUPS_DIR, group.folder, jid, prompt);
  if (onOutput) {
    await onOutput({
      message: reply,
      raw: reply,
    } as ContainerOutput);
  }
  return true;
}
```

In `runAgent` (line 499), at the very top before any `agentRunner` work, add:

```typescript
  if (await dispatchSkillsCommandIfApplicable(group, prompt, chatJid, onOutput)) {
    return 'success';
  }
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/channel-runner.test.ts`
Expected: new /skills tests pass, existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/channel-runner.ts src/channel-runner.test.ts
git -c commit.gpgsign=false commit -m "feat(skill-harvest): intercept /skills commands in channel-runner runAgent"
```

---

## Task 11: e2e — skill harvest happy path

**Files:**
- Create: `e2e/skill-harvest.test.ts`

End-to-end happy path: stand up the system, propose a skill via the `propose_skill` tool path, accept it via `/skills accept`, and verify the next system prompt contains the new skill body. Curator path is exercised by overriding `SKILL_CURATOR_INTERVAL_MS` to a small value and seeding `conversation_history`.

The e2e suite follows the patterns in `e2e/http-channel.test.ts`. Use a faked LLM in the channel pod (existing pattern: there's `e2e/lib` helpers; if not, use a stubbed `LLM_BASE_URL`).

- [ ] **Step 1: Write the e2e test**

```typescript
// e2e/skill-harvest.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureMinikube, deployFreshOrchestrator } from './lib/minikube.js';
import { httpClient, sendMessage, waitForReply } from './lib/http-channel.js';
import { execSync } from 'child_process';

// This suite relies on the http channel and uses a faked LLM that:
// - On user message "TEACH: rg-over-grep" returns a tool_call to propose_skill
//   with name=prefer-rg, description=use ripgrep, body="use rg --hidden"
// - On any /skills message: the channel-runner intercept handles it (no LLM call)
// - On subsequent user message "FOLLOWUP: search" returns the system prompt
//   it received (for assertion).

describe('skill harvest e2e', () => {
  beforeAll(async () => {
    await ensureMinikube();
    await deployFreshOrchestrator({ env: { SKILL_CURATOR_INTERVAL_MS: '5000' } });
  });

  afterAll(async () => {
    // Standard teardown per existing e2e suite conventions.
  });

  it('propose -> accept -> skill appears in subsequent system prompt', async () => {
    const c = httpClient();
    await sendMessage(c, 'TEACH: rg-over-grep');
    const teachReply = await waitForReply(c);
    expect(teachReply).toMatch(/staged candidate/i);

    const reviewReply = await waitForReply(c, async () =>
      sendMessage(c, '/skills review'),
    );
    const candidateId = reviewReply.match(/Candidate 1 of 1: (\S+)/)?.[1];
    expect(candidateId).toBeDefined();

    const acceptReply = await waitForReply(c, async () =>
      sendMessage(c, `/skills accept ${candidateId}`),
    );
    expect(acceptReply).toMatch(/accepted/i);

    await sendMessage(c, 'FOLLOWUP: search');
    const followupReply = await waitForReply(c);
    // Faked LLM echoes the system prompt it received.
    expect(followupReply).toContain('## Learned skills');
    expect(followupReply).toContain('use rg --hidden');
  });

  it('curator stages a candidate after seeded transcript', async () => {
    // Seed conversation_history directly via kubectl exec or via a few user
    // messages, then wait for the curator interval to fire.
    const c = httpClient();
    for (let i = 0; i < 5; i++) await sendMessage(c, `seed-${i}`);
    // Wait ~6s for the curator to fire (interval was set to 5000ms)
    await new Promise((r) => setTimeout(r, 6500));
    const reviewReply = await waitForReply(c, async () =>
      sendMessage(c, '/skills review'),
    );
    expect(reviewReply).toMatch(/Candidate \d+ of \d+/);
  });
});
```

> **Note for implementer:** The actual e2e helpers (`ensureMinikube`, `deployFreshOrchestrator`, `httpClient`, `sendMessage`, `waitForReply`) follow the same pattern as `e2e/http-channel.test.ts`. If those helpers don't already export the exact API used above, adapt the test to the available helpers — the assertions (staged candidate, accept, skill in followup prompt, curator stages candidate) are what matter. Faked LLM behavior may live in `e2e/fixtures/` or be provided by an existing fake-LLM container; if neither exists, gate this test on `LIVE_LLM=1` and run it against a real LLM endpoint with assertions relaxed accordingly.

- [ ] **Step 2: Run the test**

Run: `npx vitest run e2e/skill-harvest.test.ts`
Expected: passes against the live minikube setup. If the LIVE_LLM gate is in effect, document why and ensure local subset still runs.

- [ ] **Step 3: Commit**

```bash
git add e2e/skill-harvest.test.ts
git -c commit.gpgsign=false commit -m "test(e2e): skill harvest happy path (propose -> accept -> appears in prompt) + curator"
```

---

## Final verification

Before marking the plan complete:

- [ ] Run the full suite: `npm test`
- [ ] Sanity-check no regressions: `npm run build`
- [ ] Verify the spec is satisfied: re-read `docs/superpowers/specs/2026-05-16-skill-harvest-design.md` "Concrete file changes" section against the diff.
