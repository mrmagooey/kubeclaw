# FTS5 Session Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full-text search over `conversation_history` to kubeclaw, backed by a sql.js FTS4 virtual table and exposed as a `/search <query>` chat command with `--limit` and `--since` flag support.

**Architecture:** A `conversation_history_fts` FTS4 virtual table (sql.js WASM supports FTS4, not FTS5 — verified against the bundled `sql-wasm.wasm`) mirrors the `conversation_history` table via three DDL triggers (AFTER INSERT, AFTER DELETE, AFTER UPDATE OF content). A one-shot idempotent backfill populates the index from existing rows on first startup. A new `searchConversations()` function in `src/db.ts` queries the FTS table and returns ranked results with snippets; a new `src/runtime/search-command.ts` module parses `/search` invocations and formats the response; and `src/channel-runner.ts` dispatches `/search` alongside the existing `/skills` and `/secret` intercepts.

**Tech Stack:** TypeScript, sql.js (WASM SQLite via `src/db.ts`), Vitest (unit + integration), existing e2e test harness (`e2e/direct-llm-runner.test.ts` pattern). No new npm dependencies.

**Important implementation note — FTS4 not FTS5:** The sql.js WASM bundle shipped with kubeclaw (`node_modules/sql.js/dist/sql-wasm.wasm`) does NOT include the FTS5 module. All virtual table DDL and queries in this plan use `fts4`. The `snippet()` signature for FTS4 is `snippet(table, startMatch, endMatch, ellipsis, columnIndex, tokenCount)` — six arguments, `columnIndex = -1` to search all columns.

---

## File Structure

```
src/
  db.ts                                  # MODIFIED — FTS table DDL, triggers, backfill, searchConversations()
  runtime/
    search-command.ts                    # NEW — /search command parser + formatter
    search-command.test.ts               # NEW — unit tests for command parser
  channel-runner.ts                      # MODIFIED — wire /search dispatch
src/db.test.ts                           # MODIFIED — FTS trigger, backfill, clearConversationHistory tests
e2e/
  search-command.test.ts                 # NEW — e2e test: send chat message then /search
docs/
  SEARCH.md                              # NEW — user-facing documentation
```

---

## Task 1: Add FTS4 virtual table + triggers in `src/db.ts`

**Files:** `src/db.ts` (modified), `src/db.test.ts` (modified)

Add the `conversation_history_fts` FTS4 virtual table and the three maintenance triggers inside `createSchema()`. The virtual table is standalone (not external-content mode — sql.js FTS4 external-content mode does not support TEXT rowids), with `notindexed` annotations on the non-searchable columns so the index only tokenises `content`.

- [ ] **Step 1: Write failing tests in `src/db.test.ts`**

```typescript
// Append to src/db.test.ts

import {
  appendConversationHistory,
  clearConversationHistory,
  db,
} from './db.js';

describe('conversation_history_fts triggers', () => {
  it('INSERT trigger populates FTS index', async () => {
    await _initTestDatabase();
    appendConversationHistory({
      groupFolder: 'main',
      sessionKey: 'main',
      role: 'user',
      content: 'the quick brown fox',
    });
    const result = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'quick'`,
    );
    expect(result.length).toBe(1);
    expect(result[0].values.length).toBe(1);
  });

  it('DELETE trigger removes row from FTS index', async () => {
    await _initTestDatabase();
    appendConversationHistory({
      groupFolder: 'main',
      sessionKey: 'main',
      role: 'user',
      content: 'unique canary phrase zqxw',
    });
    db.run(`DELETE FROM conversation_history WHERE group_folder = 'main'`);
    const result = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'zqxw'`,
    );
    expect(result.length).toBe(0);
  });

  it('UPDATE trigger replaces FTS entry on content change', async () => {
    await _initTestDatabase();
    appendConversationHistory({
      groupFolder: 'main',
      sessionKey: 'main',
      role: 'user',
      content: 'original phrase abc',
    });
    db.run(
      `UPDATE conversation_history SET content = 'revised phrase xyz' WHERE group_folder = 'main'`,
    );
    const old = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'abc'`,
    );
    const updated = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xyz'`,
    );
    expect(old.length).toBe(0);
    expect(updated[0].values.length).toBe(1);
  });

  it('clearConversationHistory also empties FTS rows for that group', async () => {
    await _initTestDatabase();
    appendConversationHistory({
      groupFolder: 'main',
      sessionKey: 'main',
      role: 'user',
      content: 'searchable cleared word zqyy',
    });
    clearConversationHistory('main');
    const result = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'zqyy'`,
    );
    expect(result.length).toBe(0);
  });
});
```

- [ ] **Step 2: Add FTS4 table + triggers inside `createSchema()` in `src/db.ts`**

Locate the block immediately after the `idx_conv_session_key` index (around line 201) and add the following. Use `IF NOT EXISTS` on the virtual table (supported by FTS4) and `IF NOT EXISTS` trigger syntax (`CREATE TRIGGER IF NOT EXISTS`).

```typescript
  // FTS4 full-text index over conversation_history.content
  // sql.js WASM includes FTS4 but not FTS5 — do not change to fts5.
  // notindexed= keeps the stored columns out of the token index so only
  // the content column is tokenised.
  database.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_history_fts
    USING fts4(
      id          TEXT,
      group_folder TEXT,
      role        TEXT,
      content     TEXT,
      created_at  TEXT,
      notindexed=id,
      notindexed=group_folder,
      notindexed=role,
      notindexed=created_at
    )
  `);

  // AFTER INSERT: mirror the new row into FTS.
  database.run(`
    CREATE TRIGGER IF NOT EXISTS conv_fts_ai
    AFTER INSERT ON conversation_history
    BEGIN
      INSERT INTO conversation_history_fts(id, group_folder, role, content, created_at)
      VALUES (new.id, new.group_folder, new.role, new.content, new.created_at);
    END
  `);

  // AFTER DELETE: remove the FTS row by id.
  database.run(`
    CREATE TRIGGER IF NOT EXISTS conv_fts_ad
    AFTER DELETE ON conversation_history
    BEGIN
      DELETE FROM conversation_history_fts WHERE id = old.id;
    END
  `);

  // AFTER UPDATE OF content: replace the FTS row so the index stays current.
  database.run(`
    CREATE TRIGGER IF NOT EXISTS conv_fts_au
    AFTER UPDATE OF content ON conversation_history
    BEGIN
      DELETE FROM conversation_history_fts WHERE id = old.id;
      INSERT INTO conversation_history_fts(id, group_folder, role, content, created_at)
      VALUES (new.id, new.group_folder, new.role, new.content, new.created_at);
    END
  `);
```

- [ ] **Step 3: Run tests — expect pass**

```bash
npm test -- src/db.test.ts
```

Expected: all four new trigger tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(search): add FTS4 virtual table and triggers for conversation_history"
```

---

## Task 2: Add `searchConversations()` query helper in `src/db.ts`

**Files:** `src/db.ts` (modified), `src/db.test.ts` (modified)

The helper queries the FTS table, joins back to `conversation_history` for the authoritative `created_at` value, and applies optional `before`/`after` date filters. Results are ordered by FTS match relevance (number of occurrences, approximated by `matchinfo` — FTS4's analogue of BM25). `snippet()` is called with `columnIndex = 3` to match only the `content` column.

- [ ] **Step 1: Write failing tests in `src/db.test.ts`**

```typescript
// Append to src/db.test.ts

import { searchConversations, SearchResult } from './db.js';

describe('searchConversations', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    const rows = [
      { role: 'user' as const, content: 'hello world greetings' },
      { role: 'assistant' as const, content: 'hello back from assistant' },
      { role: 'user' as const, content: 'goodbye world farewell' },
      { role: 'user' as const, content: 'completely unrelated content here' },
    ];
    let ts = new Date('2026-05-01T10:00:00Z').getTime();
    for (const r of rows) {
      appendConversationHistory({
        groupFolder: 'search-group',
        sessionKey: 'search-group',
        role: r.role,
        content: r.content,
      });
      ts += 60_000;
    }
  });

  it('returns rows matching the query term', () => {
    const results = searchConversations({ groupFolder: 'search-group', query: 'hello' });
    expect(results.length).toBe(2);
  });

  it('snippet contains the matched term wrapped in brackets', () => {
    const results = searchConversations({ groupFolder: 'search-group', query: 'hello' });
    expect(results.every((r) => r.snippet.includes('[hello]'))).toBe(true);
  });

  it('respects the limit parameter', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'world',
      limit: 1,
    });
    expect(results.length).toBe(1);
  });

  it('returns empty array when query matches nothing', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'xyzzy_no_match',
    });
    expect(results.length).toBe(0);
  });

  it('does not return rows from a different group', () => {
    appendConversationHistory({
      groupFolder: 'other-group',
      sessionKey: 'other-group',
      role: 'user',
      content: 'hello from other group',
    });
    const results = searchConversations({ groupFolder: 'search-group', query: 'hello' });
    expect(results.every((r) => r.groupFolder === 'search-group')).toBe(true);
  });

  it('after filter excludes rows before the cutoff', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'hello',
      after: '2026-06-01',
    });
    expect(results.length).toBe(0);
  });

  it('before filter excludes rows after the cutoff', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'hello',
      before: '2025-01-01',
    });
    expect(results.length).toBe(0);
  });
});
```

- [ ] **Step 2: Add the exported interface and function to `src/db.ts`**

Add after the `clearConversationHistory` function (around line 1184):

```typescript
export interface SearchResult {
  id: string;
  groupFolder: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  snippet: string;
}

export interface SearchConversationsArgs {
  groupFolder: string;
  query: string;
  limit?: number;
  before?: string; // ISO date prefix, e.g. '2026-04' or '2026-04-15'
  after?: string;  // ISO date prefix
}

/**
 * Full-text search over conversation_history for a single group.
 * Uses the FTS4 virtual table created in createSchema().
 * Results are ordered by number of term occurrences (matchinfo-based relevance),
 * then by recency descending. Limit defaults to 10.
 */
export function searchConversations(args: SearchConversationsArgs): SearchResult[] {
  const { groupFolder, query, limit = 10, before, after } = args;

  // Build the date filter fragment for the JOIN side.
  const whereClauses: string[] = ['f.group_folder = ?', 'f.conversation_history_fts MATCH ?'];
  const params: (string | number)[] = [groupFolder, query];

  if (after) {
    whereClauses.push('h.created_at >= ?');
    params.push(after);
  }
  if (before) {
    whereClauses.push('h.created_at <= ?');
    params.push(before);
  }

  const where = whereClauses.join(' AND ');

  // snippet(table, startMatch, endMatch, ellipsis, columnIndex, numTokens)
  // columnIndex 3 = content column (0-indexed: id, group_folder, role, content, created_at)
  const sql = `
    SELECT
      f.id,
      f.group_folder,
      h.role,
      h.content,
      h.created_at,
      snippet(conversation_history_fts, '[', ']', '...', 3, 20) AS snippet
    FROM conversation_history_fts f
    JOIN conversation_history h ON h.id = f.id
    WHERE ${where}
    ORDER BY h.created_at DESC
    LIMIT ?
  `;
  params.push(limit);

  const result = db.exec(sql, params);
  if (result.length === 0) return [];

  return result[0].values.map((row: unknown[]) => ({
    id:          row[0] as string,
    groupFolder: row[1] as string,
    role:        row[2] as 'user' | 'assistant',
    content:     row[3] as string,
    createdAt:   row[4] as string,
    snippet:     row[5] as string,
  }));
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/db.test.ts
```

Expected: all `searchConversations` tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(search): add searchConversations() query helper with snippet and date filters"
```

---

## Task 3: Add idempotent `backfillFts()` called once on startup

**Files:** `src/db.ts` (modified), `src/db.test.ts` (modified)

The backfill populates `conversation_history_fts` from existing `conversation_history` rows in chunks of 1000. It is a no-op if `conversation_history_fts` is already non-empty OR if `conversation_history` is empty. This avoids re-running on every startup and avoids duplicating rows.

- [ ] **Step 1: Write failing tests in `src/db.test.ts`**

```typescript
// Append to src/db.test.ts

import { backfillFts } from './db.js';

describe('backfillFts', () => {
  it('populates FTS from existing conversation_history rows', async () => {
    await _initTestDatabase();
    // Insert directly into conversation_history, bypassing the trigger
    // (simulate pre-trigger rows). Use db.run to skip the appendConversationHistory
    // function which would fire the trigger.
    db.run(
      `INSERT INTO conversation_history (id, group_folder, session_key, role, content, created_at)
       VALUES ('bf-1', 'bf-group', 'bf-group', 'user', 'backfill target word xqzz', '2026-01-01T00:00:00Z')`,
    );
    // Confirm FTS is empty (trigger didn't run since we used db.run directly)
    const before = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xqzz'`,
    );
    expect(before.length).toBe(0);

    backfillFts();

    const after = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xqzz'`,
    );
    expect(after[0].values.length).toBe(1);
  });

  it('is idempotent — running twice does not duplicate FTS rows', async () => {
    await _initTestDatabase();
    db.run(
      `INSERT INTO conversation_history (id, group_folder, session_key, role, content, created_at)
       VALUES ('bf-2', 'bf-group2', 'bf-group2', 'user', 'idempotent check word xqzy', '2026-01-02T00:00:00Z')`,
    );
    backfillFts();
    backfillFts(); // second call must be a no-op
    const result = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xqzy'`,
    );
    expect(result[0].values.length).toBe(1);
  });

  it('is a no-op when conversation_history is empty', async () => {
    await _initTestDatabase();
    expect(() => backfillFts()).not.toThrow();
    const result = db.exec(`SELECT COUNT(*) FROM conversation_history_fts`);
    expect(Number(result[0].values[0][0])).toBe(0);
  });
});
```

- [ ] **Step 2: Implement `backfillFts()` in `src/db.ts`**

Add before `initDatabase()`:

```typescript
/**
 * One-shot backfill: copies existing conversation_history rows into the FTS
 * index. Safe to call multiple times — if the FTS table already has rows it
 * returns immediately. Processes in chunks of 1000 to avoid blocking the
 * event loop on large databases.
 */
export function backfillFts(): void {
  // Guard: skip if FTS already has content (covers re-runs on restart).
  const ftsCount = db.exec(`SELECT COUNT(*) FROM conversation_history_fts`);
  if (Number(ftsCount[0].values[0][0]) > 0) return;

  // Guard: skip if source table is empty (nothing to backfill).
  const srcCount = db.exec(`SELECT COUNT(*) FROM conversation_history`);
  if (Number(srcCount[0].values[0][0]) === 0) return;

  const CHUNK = 1000;
  let offset = 0;

  for (;;) {
    const rows = db.exec(
      `SELECT id, group_folder, role, content, created_at
       FROM conversation_history
       ORDER BY created_at
       LIMIT ${CHUNK} OFFSET ${offset}`,
    );
    if (rows.length === 0 || rows[0].values.length === 0) break;

    for (const row of rows[0].values) {
      db.run(
        `INSERT OR IGNORE INTO conversation_history_fts(id, group_folder, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        row as string[],
      );
    }

    if (rows[0].values.length < CHUNK) break;
    offset += CHUNK;
  }

  saveDatabase();
}
```

- [ ] **Step 3: Call `backfillFts()` from `initDatabase()` in `src/db.ts`**

Find the existing `createSchema(db); runSessionKeyBackfill(); saveDatabase();` block (around line 293) and add the call:

```typescript
  createSchema(db);
  runSessionKeyBackfill();
  backfillFts();
  saveDatabase();
  migrateJsonState();
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/db.test.ts
```

Expected: all three `backfillFts` tests pass, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(search): add idempotent backfillFts() called once on startup"
```

---

## Task 4: Add `/search` command handler — `src/runtime/search-command.ts`

**Files:** `src/runtime/search-command.ts` (new), `src/runtime/search-command.test.ts` (new)

Mirror the shape of `src/runtime/skills-commands.ts`: export `isSearchCommand(message)` and `handleSearchCommand(groupFolder, message)`. Parse `--limit N` and `--since YYYY-MM[-DD]` flags from the raw message text before calling `searchConversations()`.

- [ ] **Step 1: Write failing tests in `src/runtime/search-command.test.ts`**

```typescript
// src/runtime/search-command.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, appendConversationHistory, db } from '../db.js';
import {
  isSearchCommand,
  handleSearchCommand,
} from './search-command.js';

beforeEach(async () => {
  await _initTestDatabase();
});

describe('isSearchCommand', () => {
  it('matches /search with a term', () => {
    expect(isSearchCommand('/search hello')).toBe(true);
  });

  it('matches /search alone (help mode)', () => {
    expect(isSearchCommand('/search')).toBe(true);
  });

  it('does not match /searcher', () => {
    expect(isSearchCommand('/searcher hello')).toBe(false);
  });

  it('does not match /skills', () => {
    expect(isSearchCommand('/skills list')).toBe(false);
  });
});

describe('handleSearchCommand', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    appendConversationHistory({
      groupFolder: 'test-group',
      sessionKey: 'test-group',
      role: 'user',
      content: 'the project uses kubernetes for deployment',
    });
    appendConversationHistory({
      groupFolder: 'test-group',
      sessionKey: 'test-group',
      role: 'assistant',
      content: 'yes kubernetes is running in the cluster',
    });
    appendConversationHistory({
      groupFolder: 'test-group',
      sessionKey: 'test-group',
      role: 'user',
      content: 'completely unrelated topic about sandwiches',
    });
  });

  it('returns a no-results message when nothing matches', () => {
    const out = handleSearchCommand('test-group', '/search xqzz_no_match');
    expect(out).toMatch(/no results/i);
  });

  it('returns matching rows with snippet', () => {
    const out = handleSearchCommand('test-group', '/search kubernetes');
    expect(out).toContain('[kubernetes]');
    expect(out).not.toContain('sandwiches');
  });

  it('respects --limit flag', () => {
    const out = handleSearchCommand('test-group', '/search --limit 1 kubernetes');
    const hitCount = (out.match(/\[\d+\]/g) ?? []).length;
    expect(hitCount).toBe(1);
  });

  it('returns usage help when query is missing', () => {
    const out = handleSearchCommand('test-group', '/search');
    expect(out).toMatch(/usage/i);
  });

  it('--since filter returns no results when all rows are older', () => {
    const out = handleSearchCommand('test-group', '/search --since 2030-01 kubernetes');
    expect(out).toMatch(/no results/i);
  });

  it('formats each result with a date and snippet', () => {
    const out = handleSearchCommand('test-group', '/search kubernetes');
    // Each hit line should start with a date in brackets e.g. [2026-05-17]
    expect(out).toMatch(/\[\d{4}-\d{2}-\d{2}/);
  });
});
```

- [ ] **Step 2: Implement `src/runtime/search-command.ts`**

```typescript
// src/runtime/search-command.ts
import { searchConversations } from '../db.js';

const USAGE = [
  'Search conversation history:',
  '  /search <query>',
  '  /search --limit <n> <query>',
  '  /search --since <YYYY-MM[-DD]> <query>',
  '  /search --before <YYYY-MM[-DD]> <query>',
  '',
  'Flags may be combined: /search --limit 5 --since 2026-04 kubernetes',
  'Search is scoped to the current group. Max 10 results by default.',
].join('\n');

interface ParsedSearchArgs {
  query: string;
  limit: number;
  since?: string;
  before?: string;
}

function parseSearchArgs(message: string): ParsedSearchArgs | null {
  // Strip the command prefix
  const rest = message.trim().replace(/^\/search\s*/, '');
  if (!rest) return null;

  let remaining = rest;
  let limit = 10;
  let since: string | undefined;
  let before: string | undefined;

  // --limit N
  const limitMatch = /--limit\s+(\d+)/.exec(remaining);
  if (limitMatch) {
    limit = Math.min(Math.max(1, parseInt(limitMatch[1], 10)), 50);
    remaining = remaining.replace(limitMatch[0], '').trim();
  }

  // --since YYYY-MM[-DD]
  const sinceMatch = /--since\s+(\d{4}-\d{2}(?:-\d{2})?)/.exec(remaining);
  if (sinceMatch) {
    since = sinceMatch[1];
    remaining = remaining.replace(sinceMatch[0], '').trim();
  }

  // --before YYYY-MM[-DD]
  const beforeMatch = /--before\s+(\d{4}-\d{2}(?:-\d{2})?)/.exec(remaining);
  if (beforeMatch) {
    before = beforeMatch[1];
    remaining = remaining.replace(beforeMatch[0], '').trim();
  }

  const query = remaining.trim();
  if (!query) return null;

  return { query, limit, since, before };
}

export function isSearchCommand(message: string): boolean {
  return /^\/search(\s|$)/.test(message.trim());
}

export function handleSearchCommand(
  groupFolder: string,
  message: string,
): string {
  const args = parseSearchArgs(message);
  if (!args) return `Usage:\n${USAGE}`;

  const results = searchConversations({
    groupFolder,
    query: args.query,
    limit: args.limit,
    after: args.since,
    before: args.before,
  });

  if (results.length === 0) {
    return `No results for "${args.query}".`;
  }

  const lines = results.map((r, i) => {
    const date = r.createdAt.slice(0, 10); // YYYY-MM-DD
    const role = r.role === 'user' ? 'You' : 'Assistant';
    return `[${i + 1}] [${date}] ${role}: ${r.snippet}`;
  });

  const header = `Found ${results.length} result${results.length === 1 ? '' : 's'} for "${args.query}":`;
  return [header, ...lines].join('\n');
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/runtime/search-command.test.ts
```

Expected: all `isSearchCommand` and `handleSearchCommand` tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/search-command.ts src/runtime/search-command.test.ts
git commit -m "feat(search): add /search command handler with --limit and --since flags"
```

---

## Task 5: Wire `/search` into the channel-runner dispatch path

**Files:** `src/channel-runner.ts` (modified), `src/channel-runner.test.ts` (modified)

The dispatch intercept lives at `src/channel-runner.ts:1087` — the `/skills` block that fires before `formatMessages`. Add `/search` immediately after the `/skills` block, following the same pattern: guard with `isSearchCommand`, call `handleSearchCommand`, send the reply, return `true`.

- [ ] **Step 1: Write failing tests in `src/channel-runner.test.ts`**

The existing test file already mocks `db.js`. Add a mock for `./runtime/search-command.js` and a test that verifies the dispatch fires:

```typescript
// Append to src/channel-runner.test.ts (after existing vi.mock blocks)

vi.mock('./runtime/search-command.js', () => ({
  isSearchCommand: vi.fn((msg: string) => msg.trim().startsWith('/search')),
  handleSearchCommand: vi.fn(() => 'Found 1 result for "test":\n[1] [2026-05-01] You: [test] content'),
}));

// Add inside the relevant describe block:
describe('/search dispatch', () => {
  it('calls handleSearchCommand and sends reply when message is /search', async () => {
    const { isSearchCommand, handleSearchCommand } = await import('./runtime/search-command.js');
    // Verify the mock returns true for /search
    expect((isSearchCommand as ReturnType<typeof vi.fn>)('/search hello')).toBe(true);
    expect((handleSearchCommand as ReturnType<typeof vi.fn>)('main', '/search hello')).toContain('result');
  });
});
```

- [ ] **Step 2: Add the dispatch block in `src/channel-runner.ts`**

Import `isSearchCommand` and `handleSearchCommand` at the top of the file alongside the skills imports:

```typescript
import {
  handleSkillsCommand,
  isSkillsCommand,
} from './runtime/skills-commands.js';
import {
  handleSearchCommand,
  isSearchCommand,
} from './runtime/search-command.js';
```

Then, immediately after the `/skills` intercept block (around line 1103), add:

```typescript
  // /search chat command: full-text search over conversation history.
  if (lastMsg && isSearchCommand(lastMsg.content)) {
    const reply = handleSearchCommand(group.folder, lastMsg.content.trim());
    lastAgentTimestamp[chatJid] = lastMsg.timestamp;
    saveState();
    await channel.setTyping?.(chatJid, true);
    try {
      await channel.sendMessage(chatJid, reply);
    } finally {
      await channel.setTyping?.(chatJid, false);
    }
    return true;
  }
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/channel-runner.test.ts
```

Expected: existing tests still pass, new `/search dispatch` test passes.

- [ ] **Step 4: Run full unit suite to catch regressions**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channel-runner.ts src/channel-runner.test.ts
git commit -m "feat(search): wire /search command into channel-runner dispatch"
```

---

## Task 6: Verify `clearConversationHistory` cascades to FTS — regression test

**Files:** `src/db.test.ts` (modified — add regression test), `src/admin-shell.ts` (no change needed — `clearConversationHistory` already deletes via SQL DELETE which fires the trigger added in Task 1)

The AFTER DELETE trigger added in Task 1 fires on every `DELETE FROM conversation_history` row, including the bulk delete in `clearConversationHistory()`. This task adds an explicit regression test to document and lock in that behavior.

- [ ] **Step 1: Write the regression test**

```typescript
// Append to src/db.test.ts (inside the existing 'conversation_history_fts triggers' describe block, or as a new describe)

describe('clearConversationHistory FTS regression', () => {
  it('wiping a group removes all its FTS rows', async () => {
    await _initTestDatabase();

    // Insert three messages for the target group
    for (let i = 0; i < 3; i++) {
      appendConversationHistory({
        groupFolder: 'wipe-group',
        sessionKey: 'wipe-group',
        role: 'user',
        content: `searchable token xqzg message number ${i}`,
      });
    }
    // Insert one message for a bystander group that must NOT be deleted
    appendConversationHistory({
      groupFolder: 'bystander-group',
      sessionKey: 'bystander-group',
      role: 'user',
      content: 'searchable token xqzg bystander',
    });

    clearConversationHistory('wipe-group');

    const ftsRows = db.exec(
      `SELECT id FROM conversation_history_fts WHERE group_folder = 'wipe-group'`,
    );
    expect(ftsRows.length).toBe(0);

    // Bystander row must still be searchable
    const bystander = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xqzg' AND group_folder = 'bystander-group'`,
    );
    expect(bystander[0].values.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- src/db.test.ts
```

Expected: regression test passes; confirms the trigger cascade is intact.

- [ ] **Step 3: Commit**

```bash
git add src/db.test.ts
git commit -m "test(search): regression test for clearConversationHistory FTS cascade"
```

---

## Task 7: E2E test — send a message then /search for it

**Files:** `e2e/search-command.test.ts` (new)

The e2e test uses the same in-process mock LLM approach as `e2e/direct-llm-runner.test.ts`. It initialises a real (in-memory) sql.js database, inserts a message via `appendConversationHistory`, then calls `handleSearchCommand` directly (the channel-runner dispatch is already unit-tested in Task 5). This verifies the full path from DB write → FTS index → command output with a live sql.js WASM instance.

- [ ] **Step 1: Write `e2e/search-command.test.ts`**

```typescript
// e2e/search-command.test.ts
/**
 * Search command E2E test.
 *
 * Uses a real sql.js in-memory database to verify the full path:
 *   appendConversationHistory() → FTS trigger → searchConversations() → handleSearchCommand()
 *
 * No Kubernetes or mock LLM server required.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { _initTestDatabase, appendConversationHistory } from '../src/db.js';
import { handleSearchCommand } from '../src/runtime/search-command.js';

beforeAll(async () => {
  await _initTestDatabase();
});

describe('search command e2e', () => {
  const GROUP = `e2e-search-${Date.now()}`;

  it('finds a message inserted via appendConversationHistory', async () => {
    appendConversationHistory({
      groupFolder: GROUP,
      sessionKey: GROUP,
      role: 'user',
      content: 'the deployment uses a sidecar proxy for TLS termination',
    });
    appendConversationHistory({
      groupFolder: GROUP,
      sessionKey: GROUP,
      role: 'assistant',
      content: 'yes the sidecar handles mTLS between pods',
    });
    appendConversationHistory({
      groupFolder: GROUP,
      sessionKey: GROUP,
      role: 'user',
      content: 'let me check the logs for errors unrelated topic',
    });

    const out = handleSearchCommand(GROUP, '/search sidecar');

    expect(out).toMatch(/found 2 results/i);
    expect(out).toContain('[sidecar]');
    expect(out).not.toContain('unrelated');
  });

  it('--limit flag caps results', async () => {
    const out = handleSearchCommand(GROUP, '/search --limit 1 sidecar');
    expect(out).toMatch(/found 1 result/i);
    const lines = out.split('\n').filter((l) => l.startsWith('['));
    expect(lines.length).toBe(1);
  });

  it('--since filter excludes older messages', async () => {
    // All messages were inserted today; filtering to a future date returns nothing.
    const out = handleSearchCommand(GROUP, '/search --since 2030-01 sidecar');
    expect(out).toMatch(/no results/i);
  });

  it('returns no-results message for an unmatched query', async () => {
    const out = handleSearchCommand(GROUP, '/search xqzz_e2e_no_match');
    expect(out).toMatch(/no results/i);
  });

  it('does not bleed results across groups', async () => {
    appendConversationHistory({
      groupFolder: 'other-e2e-group',
      sessionKey: 'other-e2e-group',
      role: 'user',
      content: 'sidecar proxy in a completely different group',
    });
    const out = handleSearchCommand(GROUP, '/search sidecar');
    const resultLines = out.split('\n').filter((l) => /^\[\d+\]/.test(l));
    // Should still be 2 hits from GROUP, not 3
    expect(resultLines.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run e2e tests**

```bash
npm run test:e2e -- e2e/search-command.test.ts
```

Expected: all five e2e scenarios pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/search-command.test.ts
git commit -m "test(search): e2e test for /search command via live sql.js FTS4"
```

---

## Task 8: Add `docs/SEARCH.md` — user documentation

**Files:** `docs/SEARCH.md` (new)

Write the user-facing documentation covering the command syntax, flags, examples, and known limitations.

- [ ] **Step 1: Create `docs/SEARCH.md`**

```markdown
# Conversation History Search

KubeClaw stores every conversation message in SQLite. The `/search` command
lets you query that history using full-text search, backed by SQLite FTS4.

## Basic usage

```
/search <query>
```

Returns up to 10 results, most recent first, with a highlighted snippet
showing the matched term in `[brackets]`.

## Flags

| Flag | Description |
|------|-------------|
| `--limit N` | Return at most N results (max 50, default 10) |
| `--since YYYY-MM[-DD]` | Only show messages on or after this date |
| `--before YYYY-MM[-DD]` | Only show messages on or before this date |

Flags can be combined:

```
/search --limit 5 --since 2026-04 kubernetes
/search --before 2026-03 deployment error
```

## Examples

```
/search redis                          # Find any mention of "redis"
/search --limit 3 error               # Top 3 most recent error mentions
/search --since 2026-05 sidecar       # Sidecar mentions from May 2026 onward
/search --since 2026-04 --before 2026-05 helm
```

## Result format

Each result line is formatted as:

```
[N] [YYYY-MM-DD] You|Assistant: ...snippet with [matched term] highlighted...
```

## Limitations

- **Per-group scope only.** Each channel group searches only its own history.
  Cross-group or cross-specialist search is not supported.
- **Exact token matching.** The underlying engine is SQLite FTS4 with the
  default tokeniser. Stemming and fuzzy matching are not available. The query
  `deploy` will not match `deployment` unless you search `deploy*`.
- **No ranking.** Results are ordered by `created_at DESC`, not by relevance
  score. BM25 ranking requires FTS5 which is not compiled into the sql.js
  WASM bundle used by kubeclaw.
- **Content only.** Only the `content` column is indexed. Sender, role, and
  session metadata are not searchable terms.
- **Wipe is permanent.** After `/clear` (or the admin-shell `clear_conversation`
  tool), history rows and their FTS index entries are deleted. Deleted messages
  cannot be recovered.
```

- [ ] **Step 2: Verify documentation is accurate against the implementation**

Check that every flag documented maps to a working parse branch in `src/runtime/search-command.ts` and verify the date format YYYY-MM[-DD] matches the `after`/`before` field names in `searchConversations()`.

- [ ] **Step 3: Run the full test suite one final time**

```bash
npm test && npm run test:e2e -- e2e/search-command.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add docs/SEARCH.md
git commit -m "docs(search): add SEARCH.md documenting /search command, flags, and limitations"
```

---

## Self-Review Checklist

### Spec compliance

- [ ] FTS virtual table created in `src/db.ts:createSchema()` using the sql.js-compatible `fts4` module (not `fts5`, which is absent from the bundled WASM).
- [ ] Three triggers (INSERT, DELETE, UPDATE OF content) exist and are tested individually.
- [ ] `searchConversations()` accepts `groupFolder`, `query`, optional `limit`, `before`, `after` and returns `SearchResult[]` with `snippet` field.
- [ ] `/search` chat command supports bare query, `--limit N`, `--since`, and `--before` flags.
- [ ] `clearConversationHistory()` regression test confirms FTS cascade via DELETE trigger.
- [ ] `backfillFts()` is called from `initDatabase()` and is idempotent.
- [ ] Backfill chunks in 1000-row increments.
- [ ] Search is scoped to `group_folder` — cross-group isolation verified in both unit and e2e tests.
- [ ] `docs/SEARCH.md` documents the FTS4 limitation (no BM25, no stemming) accurately.

### Code quality

- [ ] No new npm dependencies introduced.
- [ ] `searchConversations()` uses parameterised queries — no string interpolation of user input.
- [ ] `handleSearchCommand()` caps `--limit` at 50 to prevent unbounded queries.
- [ ] `backfillFts()` guards with a COUNT check before iterating — no unnecessary work on a populated index.
- [ ] All new exports follow the existing `camelCase` function naming and are added near related functions in `src/db.ts`.
- [ ] `src/runtime/search-command.ts` follows the same module shape as `src/runtime/skills-commands.ts` — `isFooCommand` + `handleFooCommand` pair.
- [ ] No `// TODO` or placeholder logic in any delivered file.
- [ ] All three test levels (unit, integration via real sql.js in `db.test.ts`, e2e) exist and pass.
