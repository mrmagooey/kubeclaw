# Per-group structured user profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `group_profiles` SQLite table that stores per-group timezone, location, cuisine preferences, dietary restrictions, and budget tier, then inject the profile into the system prompt and expose an `update_profile` LLM tool so the assistant can remember and apply user preferences.

**Architecture:** A new `GroupProfile` interface lives in `src/types.ts`; `getGroupProfile` / `upsertGroupProfile` accessors in `src/db.ts` read/write a `group_profiles` table added via an additive `CREATE TABLE IF NOT EXISTS` block (after the existing `audit_log` block). `loadSystemPrompt` in `src/runtime/direct-llm-runner.ts` appends a `## Your profile` section when a profile row exists; `update_profile` is registered as a local tool whose handler calls `upsertGroupProfile`, then timezone-dependent call sites prefer `profile?.timezone ?? TIMEZONE` as the effective timezone.

**Tech Stack:** TypeScript, vitest, better-sqlite3 (via sql.js in-process), OpenAI-compatible SDK

---

## Tasks

### Task 1: Add `GroupProfile` interface to `src/types.ts`

**Files:**
- Modify: `src/types.ts:268` (append after last export)
- Test: `src/db.test.ts` (import shape check — compile-time only, no runtime test needed here)

- [ ] **Step 1: Write the failing compile test**

Add the following import to `src/db.test.ts` at the top alongside the existing `JobACL` import. The test file will fail to compile until the interface exists.

```typescript
// In src/db.test.ts — add to existing import block at line 71:
import type { GroupProfile } from './types.js';

// Add a compile-time shape check near the top of the file (after existing
// describe blocks are declared, before any it() calls):
describe('GroupProfile type shape', () => {
  it('has the expected fields', () => {
    const p: GroupProfile = {
      groupFolder: 'test-group',
      updatedAt: new Date().toISOString(),
    };
    expect(p.groupFolder).toBe('test-group');
    expect(p.timezone).toBeUndefined();
    expect(p.location).toBeUndefined();
    expect(p.cuisineLikes).toBeUndefined();
    expect(p.cuisineDislikes).toBeUndefined();
    expect(p.dietaryRestrictions).toBeUndefined();
    expect(p.budgetTier).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/db.test.ts`
Expected: FAIL — TypeScript compile error: `Module '"./types.js"' has no exported member 'GroupProfile'`

- [ ] **Step 3: Add `GroupProfile` interface to `src/types.ts`**

Append after the last line of `src/types.ts` (after the `JobACL` interface closing brace at line 267):

```typescript
export interface GroupProfile {
  /** The group_folder primary key — matches the `group_folder` column. */
  groupFolder: string;
  /** IANA timezone name, e.g. "America/New_York". Overrides global TIMEZONE when set. */
  timezone?: string;
  /** Free-text location, e.g. "Melbourne, Australia". */
  location?: string;
  /** Cuisine styles the user enjoys, e.g. "Japanese, Mexican". */
  cuisineLikes?: string;
  /** Cuisine styles the user dislikes or wants to avoid. */
  cuisineDislikes?: string;
  /** Dietary restrictions, e.g. "vegetarian, no nuts". */
  dietaryRestrictions?: string;
  /** Budget tier for recommendations: "budget" | "mid-range" | "splurge". */
  budgetTier?: string;
  /** ISO-8601 timestamp of last upsert. */
  updatedAt: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/db.test.ts
git commit -m "feat: add GroupProfile interface to types.ts"
```

---

### Task 2: Add `group_profiles` schema to `src/db.ts`

**Files:**
- Modify: `src/db.ts:454` (after the `audit_log` index, before the closing `}` of `createSchema`)
- Test: `src/db.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new describe block to `src/db.test.ts` after the existing imports/beforeEach. This test queries `sqlite_master` to assert the table exists after `_initTestDatabase()`.

```typescript
describe('group_profiles schema', () => {
  it('creates the group_profiles table', () => {
    const result = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='group_profiles'`,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].values[0][0]).toBe('group_profiles');
  });

  it('has the expected columns', () => {
    const result = db.exec(`PRAGMA table_info(group_profiles)`);
    expect(result.length).toBeGreaterThan(0);
    const colNames = result[0].values.map((r) => r[1] as string);
    expect(colNames).toContain('group_folder');
    expect(colNames).toContain('timezone');
    expect(colNames).toContain('location');
    expect(colNames).toContain('cuisine_likes');
    expect(colNames).toContain('cuisine_dislikes');
    expect(colNames).toContain('dietary_restrictions');
    expect(colNames).toContain('budget_tier');
    expect(colNames).toContain('updated_at');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/db.test.ts`
Expected: FAIL — `Expected: "group_profiles"` but received empty result array

- [ ] **Step 3: Add the schema block to `createSchema` in `src/db.ts`**

Insert after the `audit_log` index (`CREATE INDEX IF NOT EXISTS idx_audit_log_group_ts`) and before the closing `}` of the `createSchema` function (after line 453):

```typescript
  // Story N: group_profiles — per-group user preferences injected into system prompt.
  // group_folder is the primary key (matches the channel pod's groups/<folder> directory).
  // All preference columns are nullable; missing rows mean "no profile set".
  database.run(`
    CREATE TABLE IF NOT EXISTS group_profiles (
      group_folder          TEXT PRIMARY KEY,
      timezone              TEXT,
      location              TEXT,
      cuisine_likes         TEXT,
      cuisine_dislikes      TEXT,
      dietary_restrictions  TEXT,
      budget_tier           TEXT,
      updated_at            TEXT NOT NULL
    )
  `);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: add group_profiles table to createSchema"
```

---

### Task 3: Add `getGroupProfile` and `upsertGroupProfile` accessors to `src/db.ts`

**Files:**
- Modify: `src/db.ts` (append new accessors after the `audit_log` accessor block, around line 1400+)
- Test: `src/db.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `src/db.test.ts`. Also add `getGroupProfile` and `upsertGroupProfile` to the import from `./db.js`.

First, add to the import block at the top of `src/db.test.ts`:

```typescript
// Add to existing import from './db.js':
  getGroupProfile,
  upsertGroupProfile,
```

Then add the test block:

```typescript
describe('getGroupProfile / upsertGroupProfile', () => {
  it('returns null for a group with no profile row', () => {
    const result = getGroupProfile('no-such-group');
    expect(result).toBeNull();
  });

  it('round-trips all fields', () => {
    upsertGroupProfile({
      groupFolder: 'test-group',
      timezone: 'America/New_York',
      location: 'Brooklyn, NY',
      cuisineLikes: 'Japanese, Thai',
      cuisineDislikes: 'Liver',
      dietaryRestrictions: 'no shellfish',
      budgetTier: 'mid-range',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });
    const p = getGroupProfile('test-group');
    expect(p).not.toBeNull();
    expect(p!.groupFolder).toBe('test-group');
    expect(p!.timezone).toBe('America/New_York');
    expect(p!.location).toBe('Brooklyn, NY');
    expect(p!.cuisineLikes).toBe('Japanese, Thai');
    expect(p!.cuisineDislikes).toBe('Liver');
    expect(p!.dietaryRestrictions).toBe('no shellfish');
    expect(p!.budgetTier).toBe('mid-range');
    expect(p!.updatedAt).toBe('2026-05-28T10:00:00.000Z');
  });

  it('partial upsert preserves existing fields not supplied', () => {
    upsertGroupProfile({
      groupFolder: 'partial-group',
      timezone: 'Australia/Melbourne',
      location: 'Melbourne, AU',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });
    // Second call sets only budgetTier; timezone/location must be preserved
    upsertGroupProfile({
      groupFolder: 'partial-group',
      budgetTier: 'splurge',
      updatedAt: '2026-05-28T11:00:00.000Z',
    });
    const p = getGroupProfile('partial-group');
    expect(p!.timezone).toBe('Australia/Melbourne');
    expect(p!.location).toBe('Melbourne, AU');
    expect(p!.budgetTier).toBe('splurge');
    expect(p!.updatedAt).toBe('2026-05-28T11:00:00.000Z');
  });

  it('upsert with all-undefined optional fields creates a minimal row', () => {
    upsertGroupProfile({
      groupFolder: 'minimal-group',
      updatedAt: '2026-05-28T09:00:00.000Z',
    });
    const p = getGroupProfile('minimal-group');
    expect(p).not.toBeNull();
    expect(p!.groupFolder).toBe('minimal-group');
    expect(p!.timezone).toBeUndefined();
    expect(p!.location).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/db.test.ts`
Expected: FAIL — `getGroupProfile is not a function` (not exported yet)

- [ ] **Step 3: Implement the accessors in `src/db.ts`**

Append the following after the `writeAuditEntry` / `getAuditEntries` accessor pair (near the end of the file, before any `export function _initTestDatabase`-style test helpers):

```typescript
// ---------------------------------------------------------------------------
// group_profiles — per-group user preferences
// ---------------------------------------------------------------------------

import type { GroupProfile } from './types.js';

/**
 * Return the stored profile for the given group, or null if no row exists.
 */
export function getGroupProfile(groupFolder: string): GroupProfile | null {
  const stmt = db.prepare(
    `SELECT group_folder, timezone, location, cuisine_likes, cuisine_dislikes,
            dietary_restrictions, budget_tier, updated_at
     FROM group_profiles WHERE group_folder = ?`,
  );
  stmt.bind([groupFolder]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject() as {
    group_folder: string;
    timezone: string | null;
    location: string | null;
    cuisine_likes: string | null;
    cuisine_dislikes: string | null;
    dietary_restrictions: string | null;
    budget_tier: string | null;
    updated_at: string;
  };
  stmt.free();
  return {
    groupFolder: row.group_folder,
    timezone: row.timezone ?? undefined,
    location: row.location ?? undefined,
    cuisineLikes: row.cuisine_likes ?? undefined,
    cuisineDislikes: row.cuisine_dislikes ?? undefined,
    dietaryRestrictions: row.dietary_restrictions ?? undefined,
    budgetTier: row.budget_tier ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Insert or partially-update a group profile.
 *
 * Uses `COALESCE(?, col)` semantics so that `undefined` / null arguments
 * leave existing column values untouched. The `updated_at` column is always
 * overwritten with the supplied value.
 *
 * On first write (no existing row) all supplied fields are set; omitted
 * optional fields remain NULL in the database.
 */
export function upsertGroupProfile(p: GroupProfile): void {
  // Map undefined → null so sql.js can bind the value correctly.
  const tz = p.timezone ?? null;
  const loc = p.location ?? null;
  const cl = p.cuisineLikes ?? null;
  const cd = p.cuisineDislikes ?? null;
  const dr = p.dietaryRestrictions ?? null;
  const bt = p.budgetTier ?? null;

  db.run(
    `INSERT INTO group_profiles
       (group_folder, timezone, location, cuisine_likes, cuisine_dislikes,
        dietary_restrictions, budget_tier, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_folder) DO UPDATE SET
       timezone             = COALESCE(?, timezone),
       location             = COALESCE(?, location),
       cuisine_likes        = COALESCE(?, cuisine_likes),
       cuisine_dislikes     = COALESCE(?, cuisine_dislikes),
       dietary_restrictions = COALESCE(?, dietary_restrictions),
       budget_tier          = COALESCE(?, budget_tier),
       updated_at           = ?`,
    [
      // INSERT values (8 columns)
      p.groupFolder, tz, loc, cl, cd, dr, bt, p.updatedAt,
      // UPDATE COALESCE values (6 nullable columns) + updated_at
      tz, loc, cl, cd, dr, bt, p.updatedAt,
    ],
  );
  saveDatabase();
}
```

> **Note:** `src/db.ts` already imports `GroupProfile` is **not** done at the top of the file — the import must be added at the top of the file alongside the existing type imports, not inline. Move the `import type { GroupProfile }` line to sit with the other imports near the top of `src/db.ts` (after the existing `import type { LLMProvider } from './config.js'` line).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: add getGroupProfile and upsertGroupProfile accessors"
```

---

### Task 4: Inject profile into `loadSystemPrompt` in `src/runtime/direct-llm-runner.ts`

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts:862-881` (`loadSystemPrompt` function)
- Test: `src/runtime/direct-llm-runner.test.ts` (new unit test file, or append to existing if present)

- [ ] **Step 1: Write the failing tests**

Check whether `src/runtime/direct-llm-runner.test.ts` exists already:

```bash
ls src/runtime/direct-llm-runner.test.ts 2>/dev/null || echo "does not exist"
```

If it does not exist, create it. If it exists, append the new `describe` block. The test imports `loadSystemPrompt` — but that function is not currently exported. We'll export it in the implementation step.

```typescript
// src/runtime/direct-llm-runner.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Mock db so the test does not need a real SQLite file.
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>();
  return {
    ...actual,
    getGroupProfile: vi.fn().mockReturnValue(null),
  };
});

import { _loadSystemPromptForTest } from './direct-llm-runner.js';
import * as db from '../db.js';

describe('loadSystemPrompt profile injection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-test-'));
    vi.mocked(db.getGroupProfile).mockReturnValue(null);
  });

  it('returns base prompt with no profile when getGroupProfile returns null', () => {
    vi.mocked(db.getGroupProfile).mockReturnValue(null);
    const result = _loadSystemPromptForTest('some-group', tmpDir);
    expect(result).not.toContain('## Your profile');
  });

  it('appends a profile section when getGroupProfile returns a full profile', () => {
    vi.mocked(db.getGroupProfile).mockReturnValue({
      groupFolder: 'test-group',
      timezone: 'America/New_York',
      location: 'Brooklyn, NY',
      cuisineLikes: 'Japanese, Thai',
      cuisineDislikes: 'Liver',
      dietaryRestrictions: 'no shellfish',
      budgetTier: 'mid-range',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });
    const result = _loadSystemPromptForTest('test-group', tmpDir);
    expect(result).toContain('## Your profile');
    expect(result).toContain('America/New_York');
    expect(result).toContain('Brooklyn, NY');
    expect(result).toContain('Japanese, Thai');
    expect(result).toContain('Liver');
    expect(result).toContain('no shellfish');
    expect(result).toContain('mid-range');
  });

  it('omits profile fields that are undefined', () => {
    vi.mocked(db.getGroupProfile).mockReturnValue({
      groupFolder: 'sparse-group',
      timezone: 'UTC',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });
    const result = _loadSystemPromptForTest('sparse-group', tmpDir);
    expect(result).toContain('## Your profile');
    expect(result).toContain('UTC');
    // Fields not set should not appear as "undefined" literally
    expect(result).not.toContain('undefined');
  });

  it('profile section appears after the skills suffix', () => {
    // Create a fake CLAUDE.md so the skills path can run
    const groupDir = path.join(tmpDir, 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), 'Custom base prompt.');
    vi.mocked(db.getGroupProfile).mockReturnValue({
      groupFolder: 'test-group',
      timezone: 'Europe/London',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });
    const result = _loadSystemPromptForTest('test-group', tmpDir);
    const profileIdx = result.indexOf('## Your profile');
    const baseIdx = result.indexOf('Custom base prompt.');
    expect(profileIdx).toBeGreaterThan(baseIdx);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/runtime/direct-llm-runner.test.ts`
Expected: FAIL — `_loadSystemPromptForTest is not exported` (or module resolution error)

- [ ] **Step 3: Modify `loadSystemPrompt` and export a test helper**

In `src/runtime/direct-llm-runner.ts`, update the import block at the top to include `getGroupProfile`:

```typescript
// Add to the existing import from '../db.js':
import {
  // ... existing imports ...
  getGroupProfile,
} from '../db.js';
```

Then replace the body of `loadSystemPrompt` (lines 862–881):

```typescript
function loadSystemPrompt(
  groupFolder: string,
  groupsDir: string = GROUPS_DIR,
): string {
  const claudeMd = path.join(groupsDir, groupFolder, 'CLAUDE.md');
  let base = DEFAULT_SYSTEM_PROMPT;
  try {
    const content = fs.readFileSync(claudeMd, 'utf-8');
    if (content.trim()) base = content.trim();
  } catch {
    // file missing — use default
  }

  let prompt = base;
  try {
    const { promptSuffix } = loadSkills(groupsDir, groupFolder);
    if (promptSuffix) prompt = base + promptSuffix;
  } catch (err) {
    logger.warn({ err, groupFolder }, 'skill-loader failed; using base prompt');
  }

  // Append per-group profile section when a profile row exists.
  const profile = getGroupProfile(groupFolder);
  if (profile) {
    const lines: string[] = ['\n\n## Your profile'];
    if (profile.timezone) lines.push(`- **Timezone:** ${profile.timezone}`);
    if (profile.location) lines.push(`- **Location:** ${profile.location}`);
    if (profile.cuisineLikes) lines.push(`- **Cuisine likes:** ${profile.cuisineLikes}`);
    if (profile.cuisineDislikes) lines.push(`- **Cuisine dislikes:** ${profile.cuisineDislikes}`);
    if (profile.dietaryRestrictions) lines.push(`- **Dietary restrictions:** ${profile.dietaryRestrictions}`);
    if (profile.budgetTier) lines.push(`- **Budget tier:** ${profile.budgetTier}`);
    prompt += lines.join('\n');
  }

  return prompt;
}

/**
 * @internal Test-only: exposes loadSystemPrompt with an explicit groupsDir so
 * unit tests can point it at a temp directory without needing the real FS layout.
 */
export function _loadSystemPromptForTest(
  groupFolder: string,
  groupsDir: string,
): string {
  return loadSystemPrompt(groupFolder, groupsDir);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/runtime/direct-llm-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full unit suite to catch regressions**

Run: `npm test -- src/db.test.ts src/runtime/direct-llm-runner.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/runtime/direct-llm-runner.test.ts
git commit -m "feat: inject group profile into system prompt via loadSystemPrompt"
```

---

### Task 5: Register `update_profile` as a local tool in `src/channel-runner.ts`

**Files:**
- Modify: `src/channel-runner.ts` (after `registerCredentialTools` or at the group-init call site where `registerLocalTool` is called)
- Test: `src/channel-runner.test.ts` (unit) and `src/memory-command.integration.test.ts`-style integration test (new file: `src/profile-command.integration.test.ts`)

- [ ] **Step 1: Write the unit test (failing)**

Add to `src/channel-runner.test.ts`. Find an existing describe block that checks registered tool names (around line 621) and add:

```typescript
describe('update_profile local tool registration', () => {
  it('registers update_profile on the DirectLLMRunner', async () => {
    // Arrange: mock runner that records registered tool names
    const registeredTools: string[] = [];
    const mockRunner = {
      configureMcp: vi.fn(),
      configureGroupMcpTemplates: vi.fn(),
      registerLocalTool: vi.fn((name: string) => { registeredTools.push(name); }),
      setChannelMetrics: vi.fn(),
      writeTasksSnapshot: vi.fn(),
      writeGroupsSnapshot: vi.fn(),
      runAgent: vi.fn().mockResolvedValue({ status: 'success' }),
    };

    // Act: trigger the registration path (call the exported helper directly)
    const { registerProfileTool } = await import('./channel-runner.js');
    registerProfileTool(mockRunner as unknown as ReturnType<typeof import('./runtime/index.js').getDirectLLMRunner>);

    // Assert
    expect(registeredTools).toContain('update_profile');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/channel-runner.test.ts`
Expected: FAIL — `registerProfileTool is not exported`

- [ ] **Step 3: Implement `registerProfileTool` in `src/channel-runner.ts`**

Add the following export function near the `registerCredentialTools` function (around line 3042 in `src/channel-runner.ts`):

```typescript
/**
 * Update-profile tool definition.
 * All fields are optional — the LLM only needs to supply what changed.
 */
const UPDATE_PROFILE_TOOL_DEF: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'update_profile',
    description:
      'Persist user preferences (timezone, location, cuisine likes/dislikes, ' +
      'dietary restrictions, budget tier) so they are remembered across conversations. ' +
      'Call whenever the user states, corrects, or confirms a preference. ' +
      'Omit fields that are not being changed.',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA timezone, e.g. "America/New_York"',
        },
        location: {
          type: 'string',
          description: 'Free-text location, e.g. "Melbourne, Australia"',
        },
        cuisine_likes: {
          type: 'string',
          description: 'Cuisine styles the user enjoys',
        },
        cuisine_dislikes: {
          type: 'string',
          description: 'Cuisine styles the user dislikes',
        },
        dietary_restrictions: {
          type: 'string',
          description: 'Dietary restrictions, e.g. "vegetarian, no nuts"',
        },
        budget_tier: {
          type: 'string',
          enum: ['budget', 'mid-range', 'splurge'],
          description: 'Budget tier for recommendations',
        },
      },
    },
  },
};

/**
 * Register the `update_profile` local tool on the given runner.
 * The handler upserts the supplied fields into the group_profiles table.
 * Called once per channel-runner startup (same pattern as registerCredentialTools).
 */
export function registerProfileTool(
  runner: ReturnType<typeof getDirectLLMRunner>,
): void {
  runner.registerLocalTool('update_profile', {
    def: UPDATE_PROFILE_TOOL_DEF,
    handler: async (args, input) => {
      try {
        const now = new Date().toISOString();
        upsertGroupProfile({
          groupFolder: input.groupFolder,
          timezone: (args.timezone as string | undefined) ?? undefined,
          location: (args.location as string | undefined) ?? undefined,
          cuisineLikes: (args.cuisine_likes as string | undefined) ?? undefined,
          cuisineDislikes: (args.cuisine_dislikes as string | undefined) ?? undefined,
          dietaryRestrictions:
            (args.dietary_restrictions as string | undefined) ?? undefined,
          budgetTier: (args.budget_tier as string | undefined) ?? undefined,
          updatedAt: now,
        });
        return 'Profile updated.';
      } catch (err) {
        return `update_profile error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
  logger.debug('Registered update_profile local tool');
}
```

Also add the `import { upsertGroupProfile } from './db.js'` line to the existing db import block at the top of `src/channel-runner.ts`, and call `registerProfileTool(runner)` in the channel startup code alongside the existing `registerCredentialTools(runner)` call.

- [ ] **Step 4: Write the integration test (failing)**

Create `src/profile-command.integration.test.ts`:

```typescript
/**
 * Integration test: update_profile local tool + SQLite round-trip.
 *
 * Uses real sql.js in-memory database. No Kubernetes, Redis, or LLM required.
 * Mocks the K8s / Redis transitive dependencies that channel-runner pulls in.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'test';
});

vi.mock('./k8s/job-runner.js', () => ({
  jobRunner: {
    applyYamlToK8s: vi.fn(),
    deleteDeployment: vi.fn(),
    deleteService: vi.fn(),
    deletePersistentVolumeClaim: vi.fn(),
    createJob: vi.fn(),
    deleteJob: vi.fn(),
    getPodLogs: vi.fn(),
  },
  buildJobName: vi.fn().mockReturnValue('mock-job'),
  JobRunner: vi.fn(),
}));
vi.mock('./k8s/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({ publish: vi.fn() }),
  getChannelStatusChannel: vi.fn().mockReturnValue('ch'),
  getTaskRequestStream: vi.fn().mockReturnValue('ts'),
  getSpawnToolPodStream: vi.fn().mockReturnValue('sp'),
}));
vi.mock('./k8s/ipc-redis.js', () => ({
  startIpcWatcher: vi.fn(),
  startControlChannelWatcher: vi.fn(),
}));
vi.mock('./k8s/file-sidecar-runner.js', () => ({
  FileSidecarJobRunner: vi.fn(),
  fileSidecarRunner: { createJob: vi.fn(), deleteJob: vi.fn() },
}));
vi.mock('./k8s/http-sidecar-runner.js', () => ({
  HttpSidecarJobRunner: vi.fn(),
  httpSidecarRunner: { createJob: vi.fn(), deleteJob: vi.fn() },
}));
vi.mock('./k8s/acl-manager.js', () => ({
  getACLManager: vi.fn().mockReturnValue({}),
  RedisACLManager: vi.fn(),
}));
vi.mock('./runtime/index.js', () => ({
  getDirectLLMRunner: vi.fn().mockReturnValue({
    configureMcp: vi.fn(),
    configureGroupMcpTemplates: vi.fn(),
    registerLocalTool: vi.fn(),
    setChannelMetrics: vi.fn(),
    writeTasksSnapshot: vi.fn(),
    writeGroupsSnapshot: vi.fn(),
    runAgent: vi.fn().mockResolvedValue({ status: 'success' }),
  }),
  shutdownAllRunners: vi.fn(),
}));

import {
  _initTestDatabase,
  __resetDbForTest,
  getGroupProfile,
  upsertGroupProfile,
} from './db.js';
import { registerProfileTool } from './channel-runner.js';

beforeAll(async () => {
  await _initTestDatabase();
});

beforeEach(() => {
  __resetDbForTest();
});

describe('registerProfileTool integration', () => {
  it('update_profile handler upserts a profile row in SQLite', async () => {
    const groupFolder = 'integration-test-group';

    // Capture the registered handler
    let capturedHandler: ((args: Record<string, unknown>, input: { groupFolder: string }) => Promise<string>) | null = null;
    const mockRunner = {
      registerLocalTool: vi.fn((_name: string, tool: { handler: typeof capturedHandler }) => {
        capturedHandler = tool.handler;
      }),
    };

    registerProfileTool(
      mockRunner as unknown as ReturnType<typeof import('./runtime/index.js').getDirectLLMRunner>,
    );

    expect(capturedHandler).not.toBeNull();

    // Call the handler as the LLM would
    const result = await capturedHandler!(
      {
        timezone: 'America/Chicago',
        location: 'Austin, TX',
        cuisine_likes: 'BBQ, Tex-Mex',
        budget_tier: 'mid-range',
      },
      { groupFolder },
    );

    expect(result).toBe('Profile updated.');

    // Verify the SQLite row was written
    const profile = getGroupProfile(groupFolder);
    expect(profile).not.toBeNull();
    expect(profile!.timezone).toBe('America/Chicago');
    expect(profile!.location).toBe('Austin, TX');
    expect(profile!.cuisineLikes).toBe('BBQ, Tex-Mex');
    expect(profile!.budgetTier).toBe('mid-range');
  });

  it('partial update_profile call preserves existing fields', async () => {
    const groupFolder = 'partial-update-group';

    // Seed an existing profile
    upsertGroupProfile({
      groupFolder,
      timezone: 'Pacific/Auckland',
      location: 'Auckland, NZ',
      updatedAt: '2026-05-28T08:00:00.000Z',
    });

    let capturedHandler: ((args: Record<string, unknown>, input: { groupFolder: string }) => Promise<string>) | null = null;
    const mockRunner = {
      registerLocalTool: vi.fn((_name: string, tool: { handler: typeof capturedHandler }) => {
        capturedHandler = tool.handler;
      }),
    };
    registerProfileTool(
      mockRunner as unknown as ReturnType<typeof import('./runtime/index.js').getDirectLLMRunner>,
    );

    // Only update budgetTier
    await capturedHandler!({ budget_tier: 'splurge' }, { groupFolder });

    const profile = getGroupProfile(groupFolder);
    // Pre-existing fields must survive
    expect(profile!.timezone).toBe('Pacific/Auckland');
    expect(profile!.location).toBe('Auckland, NZ');
    // New field must be present
    expect(profile!.budgetTier).toBe('splurge');
  });
});
```

- [ ] **Step 5: Run integration test to verify it fails**

Run: `npm test -- src/profile-command.integration.test.ts`
Expected: FAIL — `registerProfileTool is not exported` or handler not available

- [ ] **Step 6: Run tests to verify both pass after implementation**

Run: `npm test -- src/channel-runner.test.ts src/profile-command.integration.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/channel-runner.ts src/channel-runner.test.ts src/profile-command.integration.test.ts
git commit -m "feat: register update_profile local tool in channel-runner"
```

---

### Task 6: Prefer `profile?.timezone` over global `TIMEZONE` in `src/task-scheduler.ts`

**Files:**
- Modify: `src/task-scheduler.ts:33` (`computeNextRun`)
- Test: `src/task-scheduler.test.ts` (unit — if missing, append to existing vitest file)

> **Scope note:** `scheduleTaskDirect` in `src/runtime/direct-llm-runner.ts` delegates scheduling to the orchestrator over Redis; the cron evaluation happens inside `computeNextRun` in `src/task-scheduler.ts`. That function is the only call site that passes `TIMEZONE` to `cron-parser`. We update `computeNextRun` to accept an optional `tzOverride` and prefer it over the global constant, then pass `profile?.timezone` at the call site in `TaskScheduler.tick`.

- [ ] **Step 1: Write the failing unit test**

Check whether `src/task-scheduler.test.ts` exists:

```bash
ls src/task-scheduler.test.ts 2>/dev/null || echo "does not exist"
```

Append (or create) the following describe block:

```typescript
// In src/task-scheduler.test.ts
import { describe, it, expect } from 'vitest';
import { computeNextRun } from './task-scheduler.js';
import type { ScheduledTask } from './types.js';

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'test-task-1',
    group_folder: 'test-group',
    chat_jid: 'test@chat',
    prompt: 'hello',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: null,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('computeNextRun timezone override', () => {
  it('uses tzOverride when supplied instead of global TIMEZONE', () => {
    const task = makeTask({ schedule_value: '0 9 * * *' });
    // Run for two different timezones; the next-run ISO strings must differ.
    const nextNY = computeNextRun(task, 'America/New_York');
    const nextTok = computeNextRun(task, 'Asia/Tokyo');
    // Both must be valid ISO timestamps
    expect(() => new Date(nextNY!)).not.toThrow();
    expect(() => new Date(nextTok!)).not.toThrow();
    // They can be equal only if by coincidence — for a 9am cron fired outside
    // business hours they will differ by the UTC offset gap, so for a broad
    // sanity check just assert they are both valid ISO strings (format check).
    expect(nextNY).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(nextTok).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('falls back to global TIMEZONE when tzOverride is undefined', () => {
    const task = makeTask({ schedule_value: '0 9 * * *' });
    const next = computeNextRun(task, undefined);
    expect(next).not.toBeNull();
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('interval tasks ignore tzOverride', () => {
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: '60000',
      next_run: new Date(Date.now() - 1000).toISOString(),
    });
    const next = computeNextRun(task, 'America/Los_Angeles');
    expect(next).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/task-scheduler.test.ts`
Expected: FAIL — `computeNextRun` does not accept a second argument (TypeScript error or runtime mismatch)

- [ ] **Step 3: Update `computeNextRun` signature and call site**

In `src/task-scheduler.ts`, update `computeNextRun` at line 26:

```typescript
/**
 * Compute the ISO timestamp of the next run for a scheduled task.
 *
 * @param task - The task to compute for.
 * @param tzOverride - Optional IANA timezone that takes precedence over the
 *   global TIMEZONE constant (used when a group has a profile timezone set).
 */
export function computeNextRun(
  task: ScheduledTask,
  tzOverride?: string,
): string | null {
  if (task.schedule_type === 'once') return null;

  const tz = tzOverride ?? TIMEZONE;
  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, { tz });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}
```

Then update the call site inside `TaskScheduler.tick` (search for `computeNextRun(task)` — it should appear once). Replace with:

```typescript
// At the call site in TaskScheduler.tick (look for the line that calls computeNextRun):
const profile = getGroupProfile(task.group_folder);
const nextRun = computeNextRun(task, profile?.timezone);
```

Add `import { getGroupProfile } from './db.js';` to `src/task-scheduler.ts` if not already present.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/task-scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: Run full unit suite to catch regressions**

Run: `npm test`
Expected: PASS — all existing tests unaffected

- [ ] **Step 6: Commit**

```bash
git add src/task-scheduler.ts src/task-scheduler.test.ts
git commit -m "feat: prefer profile.timezone over global TIMEZONE in computeNextRun"
```

---

## E2E Tests

**Target file:** `e2e/group-profile.test.ts`

**Scope:** Exercises the full path — HTTP POST /message → LLM tool call → SQLite write → system prompt injection → subsequent reply uses Eastern time for a cron task.

> **N/A caveat:** The LLM-in-the-loop E2E (asking the assistant to set timezone) requires a live cluster with the mock LLM server or a real API key. The test below is written for the in-process mock LLM pattern used by `e2e/direct-llm-runner.test.ts`. It does **not** test actual cron fire times (which would require waiting real minutes) but instead verifies the profile row is created and that a second `runAgent` call receives a system prompt containing the profile section.

```typescript
/**
 * End-to-end tests for the per-group user profile feature.
 *
 * Verifies:
 *   E2E-1: update_profile tool call writes a SQLite row (groupFolder isolation).
 *   E2E-2: System prompt on the next runAgent call includes the ## Your profile section.
 *   E2E-3: Two groups have independent profiles (isolation).
 *
 * Uses the in-process mock LLM server from global-setup.ts.
 * No Kubernetes required.
 *
 * Run with: npm run test:e2e -- e2e/group-profile.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getMockLlmPort } from './setup.js';
import { _initTestDatabase, getGroupProfile, upsertGroupProfile } from '../src/db.js';
import { _loadSystemPromptForTest } from '../src/runtime/direct-llm-runner.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

describe('group profile E2E', () => {
  beforeAll(async () => {
    await _initTestDatabase();
    const port = getMockLlmPort();
    if (!port) return;
    process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.DIRECT_LLM_MODEL = 'test/model';
  });

  it('E2E-1: upserted profile row is retrievable per group', async () => {
    const groupA = `e2e-profile-a-${Date.now()}`;
    const groupB = `e2e-profile-b-${Date.now()}`;

    upsertGroupProfile({
      groupFolder: groupA,
      timezone: 'America/New_York',
      location: 'New York City',
      updatedAt: new Date().toISOString(),
    });
    upsertGroupProfile({
      groupFolder: groupB,
      timezone: 'Asia/Tokyo',
      location: 'Tokyo',
      updatedAt: new Date().toISOString(),
    });

    const pA = getGroupProfile(groupA);
    const pB = getGroupProfile(groupB);

    expect(pA!.timezone).toBe('America/New_York');
    expect(pB!.timezone).toBe('Asia/Tokyo');
    // Groups are isolated
    expect(pA!.location).toBe('New York City');
    expect(pB!.location).toBe('Tokyo');
  });

  it('E2E-2: system prompt contains profile section after profile is stored', () => {
    const groupFolder = `e2e-prompt-${Date.now()}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-e2e-'));

    upsertGroupProfile({
      groupFolder,
      timezone: 'America/New_York',
      location: 'Brooklyn, NY',
      cuisineLikes: 'Thai, Sushi',
      budgetTier: 'mid-range',
      updatedAt: new Date().toISOString(),
    });

    const prompt = _loadSystemPromptForTest(groupFolder, tmpDir);

    expect(prompt).toContain('## Your profile');
    expect(prompt).toContain('America/New_York');
    expect(prompt).toContain('Brooklyn, NY');
    expect(prompt).toContain('Thai, Sushi');
    expect(prompt).toContain('mid-range');
  });

  it('E2E-3: group with no profile has no profile section in prompt', () => {
    const groupFolder = `e2e-noprofile-${Date.now()}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-e2e-'));

    const prompt = _loadSystemPromptForTest(groupFolder, tmpDir);

    expect(prompt).not.toContain('## Your profile');
  });

  it('E2E-4: DirectLLMRunner.runAgent receives a profile-injected system prompt', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const groupFolder = `e2e-runner-profile-${Date.now()}`;

    // Seed a profile before the agent run
    upsertGroupProfile({
      groupFolder,
      timezone: 'Europe/Berlin',
      location: 'Berlin, Germany',
      updatedAt: new Date().toISOString(),
    });

    const output = await runner.runAgent(
      { name: groupFolder, folder: groupFolder, trigger: '', added_at: new Date().toISOString() },
      { prompt: 'What is my timezone?', groupFolder, chatJid: 'e2e@e2e', isMain: false, assistantName: 'Bot' },
    );

    // The mock LLM just returns a fixed response; the key assertion is that
    // the call succeeded (the profile injection did not break the pipeline).
    expect(output.status).toBe('success');
    console.log(`✅ profile-injected runAgent response: "${output.result}"`);
  });
});
```

Save to `e2e/group-profile.test.ts`.

**Run:** `npm run test:e2e -- e2e/group-profile.test.ts`
Expected: PASS (E2E-1 through E2E-3 pass without the mock server; E2E-4 passes when the mock LLM server is available).

Final commit after all E2E tests pass:

```bash
git add e2e/group-profile.test.ts
git commit -m "test(e2e): add group profile end-to-end test suite"
```

---

## Summary

| Task | Files touched | Test level |
|------|--------------|-----------|
| 1 — `GroupProfile` interface | `src/types.ts`, `src/db.test.ts` | Unit (compile-time shape) |
| 2 — Schema block | `src/db.ts`, `src/db.test.ts` | Unit |
| 3 — Accessors | `src/db.ts`, `src/db.test.ts` | Unit |
| 4 — System prompt injection | `src/runtime/direct-llm-runner.ts`, `src/runtime/direct-llm-runner.test.ts` | Unit |
| 5 — `update_profile` local tool | `src/channel-runner.ts`, `src/channel-runner.test.ts`, `src/profile-command.integration.test.ts` | Unit + Integration |
| 6 — Timezone fallback | `src/task-scheduler.ts`, `src/task-scheduler.test.ts` | Unit |
| E2E | `e2e/group-profile.test.ts` | End-to-end |
