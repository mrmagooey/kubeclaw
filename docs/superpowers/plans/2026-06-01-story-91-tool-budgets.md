# Plan: Story 91 — Per-specialist `maxToolRounds` budget caps tool-loop iteration

## Goal

Cap how many tool-call rounds a specialist's LLM may execute per turn via `overrides.maxToolRounds`, preventing runaway tool consumption without throwing on cap-hit.

## Architecture

`MAX_TOOL_ROUNDS = 10` is declared as a module-level constant in `src/runtime/direct-llm-runner.ts`. When `runAgent` / `runSpecialist` is invoked, the effective limit is resolved as `overrides.maxToolRounds ?? MAX_TOOL_ROUNDS` (line 1288). The tool-call loop in `direct-llm-runner.ts` checks this effective limit at the top of each iteration; once reached, it exits the loop and returns the accumulated output marked as `success` rather than throwing. Each `runAgent` invocation gets a fresh counter, so the budget is per-call, not per-process.

## Tech Stack

- Runtime: TypeScript / Node 22
- Test framework: Vitest (default config, `npm test`)
- Mocking: in-process mocked Redis `xadd`/`xread` loop synthesising a constant tool result — no real LLM, no Kubernetes, no SQLite required

## File Structure

| File | Role |
|---|---|
| `src/runtime/direct-llm-runner.ts` | `MAX_TOOL_ROUNDS` constant (line 108); effective limit resolved at line 1288; loop guard enforces the cap |
| `src/runtime/direct-llm-runner.test.ts` | `describe('DirectLLMRunner — tool-round budget', …)` block at line 952; 2 test cases covering AC1–AC5 |

## Tasks (retrospective)

### AC1 — Cap enforced when `maxToolRounds` set below default

`overrides.maxToolRounds` is threaded into `runAgent` and compared against the iteration counter each loop cycle. When the counter reaches the override value the loop exits without issuing another tool-call round.

### AC2 — Default is `MAX_TOOL_ROUNDS = 10` when override absent

`overrides.maxToolRounds ?? MAX_TOOL_ROUNDS` at line 1288 means any call without an explicit override gets the module constant (10).

### AC3 — Fresh budget per `runAgent` invocation

The iteration counter is declared inside `runAgent`'s call frame; it resets to zero on every invocation, so successive calls are independent.

### AC4 — Cap-hit returns `success`, not `error`

After exiting the loop early the runner packages whatever partial output it holds and returns it with a `success` result shape — no exception is raised.

### AC5 — Deterministic offline test via mocked Redis

The test block at line 952 injects a mocked Redis client whose `xadd`/`xread` synthesises a fixed tool result on every round, making the iteration count fully predictable without any network or LLM calls.

### Verification

```
npm test -- src/runtime/direct-llm-runner.test.ts -t "tool-round budget"
```

Expected: **2 passed / 2 total** (`stops after overrides.maxToolRounds rounds when set below default` and its sibling case in the describe block).
