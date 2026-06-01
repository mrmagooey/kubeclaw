# Story 87: Recommendation contract — Retrospective Plan

**Goal:** Wire `RECOMMENDATION_CONTRACT` into the system prompt and register `read_user_profile` and `places_search` as local tools on `DirectLLMRunner`, with conversation history threaded across turns within the same `group_folder`.

**Architecture:** A `RECOMMENDATION_CONTRACT` constant is defined in `src/runtime/direct-llm-runner.ts` and appended by `loadSystemPrompt` unless the group CLAUDE.md contains the opt-out marker `<!-- no-recommendation-contract -->`. `read_user_profile` is registered as a local tool on `DirectLLMRunner` via `registerLocalTool`; its handler calls `getGroupProfile` from `src/db.ts`, returning `'{}'` if no profile row exists. `places_search` is added to the static `TOOLS` array in `direct-llm-runner.ts`, making it visible in the tool list advertised to the LLM at construction time. Multi-turn history threading is provided by the existing `loadConversationHistory` path, which loads all prior turns for the `group_folder` before each LLM call.

**Tech Stack:** vitest e2e suite, in-process mock LLM server (`getMockLlmPort()`), real SQLite via `_initTestDatabase()`. No Kubernetes required.

---

## File Structure

### Test file
- `e2e/recommendation-pattern.test.ts` — AC1–AC5 e2e coverage (6 tests including AC1 opt-out variant)

### Implementation surfaces
- `src/runtime/direct-llm-runner.ts`
  - `RECOMMENDATION_CONTRACT` constant — injected by `loadSystemPrompt` (AC1)
  - `read_user_profile` LocalTool definition and handler — registered on runner (AC2, AC3)
  - `places_search` entry in `TOOLS` array (AC5)
  - `loadConversationHistory` called before each LLM request, keyed by `group_folder` (AC4)
- `src/runtime/tools/read-user-profile.ts` — standalone module for `read_user_profile` tool handler
- `src/runtime/places-search.ts` — `places_search` tool implementation (browser-pod backed; stub-safe in tests)
- `src/db.ts` — `getGroupProfile` / `upsertGroupProfile` for profile persistence (AC3 null-safe path)

---

## Tasks

### Task 1: Existing implementation summary

All implementation was delivered in branch `asp/recommendation-pattern` (merged to main as commit `91715a8`) across six commits:

| Commit | Surface |
|--------|---------|
| `791b37a` | `RECOMMENDATION_CONTRACT` injected via `loadSystemPrompt` (AC1) |
| `63bded9` | `places_search` added to `TOOLS`, `TOOL_CATEGORY`, `TOOL_SERVER_NAME` (AC5) |
| `f8b965c` | `read_user_profile` local tool with `{}` fallback (AC2, AC3) |
| `d2275d9` | Integration tests: contract, places_search routing, history threading |
| `dc9906a` | E2E tests AC1–AC5 in `e2e/recommendation-pattern.test.ts` |
| `7f253c3` | Fix: align `GroupProfile` stub shape and distinguish profile errors |

Each acceptance criterion maps directly:
- **AC1** — `RECOMMENDATION_CONTRACT` in `src/runtime/direct-llm-runner.ts`, opt-out via `<!-- no-recommendation-contract -->` marker
- **AC2** — `read_user_profile` registered via `registerLocalTool`; visible via `getLocalToolNames()`
- **AC3** — handler returns `'{}'` when `getGroupProfile` returns null/undefined
- **AC4** — `loadConversationHistory(groupFolder)` called before every LLM request; test fires two sequential turns and asserts second call sees 4 messages
- **AC5** — `places_search` present in `TOOLS` array with a `query` parameter

### Task 2: Verification

**Command:**
```bash
npm run test:e2e -- recommendation-pattern
```

**Expected:** 6 passed (AC1, AC1 opt-out, AC2, AC3, AC4, AC5), 0 failed, 0 skipped.

**Actual result (2026-06-01):** 6 / 6 passed. Exit code 0.
