# Story 88: Per-group user profile persists across turns and isolates by group

**Date:** 2026-06-01
**Status:** Retrospective (implementation complete, tests passing 4/4)

---

## Goal

Persist a structured user profile scoped to each `group_folder` in SQLite and inject it into every subsequent LLM system prompt so the assistant can personalise responses without the user re-stating preferences.

## Architecture

The LLM calls the `update_profile` LocalTool registered on `DirectLLMRunner`; the handler calls `upsertGroupProfile(groupFolder, json)` which writes (or replaces) a row in the `group_profiles` SQLite table keyed on `group_folder`. On each subsequent `runAgent` call, `_loadSystemPromptForTest` (and the production equivalent) calls `getGroupProfile(groupFolder)` and, if a row exists, appends a `## Your profile` section with the stored JSON inlined before the prompt reaches the LLM. Two groups share the same database but select independently by `group_folder`, so profiles are naturally isolated.

## Tech Stack

- **Runtime:** TypeScript, SQLite (better-sqlite3)
- **Test harness:** Vitest e2e (`vitest.e2e.config.ts`), in-process mock LLM server (`getMockLlmPort()`), real SQLite via `_initTestDatabase()`
- **No Kubernetes required** — all tests run against a local in-process database

---

## File Structure

| File | Role |
|------|------|
| `e2e/group-profile.test.ts` | E2E test suite (4 tests: E2E-1 … E2E-4) |
| `src/db.ts` | `group_profiles` table schema + `getGroupProfile` / `upsertGroupProfile` helpers |
| `src/runtime/direct-llm-runner.ts` | `update_profile` LocalTool registration + `_loadSystemPromptForTest` system-prompt injection |

---

## Tasks (Retrospective)

### AC-1: update_profile tool writes to group_profiles (E2E-1)

`DirectLLMRunner` registers an `update_profile` LocalTool whose handler calls `upsertGroupProfile(groupFolder, json)`. The E2E test drives the tool handler directly, then asserts `getGroupProfile(groupFolder)` returns the exact JSON that was written.

### AC-2: Profile injected into system prompt on next runAgent (E2E-2)

`_loadSystemPromptForTest(groupFolder)` calls `getGroupProfile(groupFolder)`; when a row exists it appends `## Your profile\n<json>` to the base system prompt. E2E-2 writes a profile then calls `_loadSystemPromptForTest` and asserts the section is present.

### AC-3: Group isolation — two groups maintain independent profiles (E2E-3 + E2E-1 cross-group assertion)

Because `group_profiles` is keyed on `group_folder`, a write to group A leaves group B's row untouched. E2E-3 asserts that a group with no stored profile sees no `## Your profile` section, and E2E-1 writes to two distinct groups and verifies the payloads differ.

### AC-4: update_profile registered as LocalTool on DirectLLMRunner (E2E-4)

The tool appears in `DirectLLMRunner`'s local tool list. E2E-4 runs a full `runAgent` call with the mock LLM, exercising the end-to-end path including tool registration and system-prompt injection.

### AC-5: Round-trip persistence — upsert then get returns exact payload

`upsertGroupProfile` uses `INSERT OR REPLACE` so repeated calls for the same `group_folder` overwrite rather than accumulate. `getGroupProfile` deserialises the stored JSON and returns it. E2E-1 covers the round-trip assertion.

### Verification

```bash
npm run test:e2e -- group-profile
```

Expected: **4 / 4 passing** (E2E-1, E2E-2, E2E-3, E2E-4).
