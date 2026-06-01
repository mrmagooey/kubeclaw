# Story 109: Skill-harvest pipeline — propose → review → accept → load into next prompt

## Goal / Architecture

The skill-harvest pipeline gives KubeClaw a self-improving prompt library: `skill-store.ts` manages the filesystem layout (`skills/` for active, `skill-candidates/` for staged) and the SQLite candidate table; `skill-curator.ts` scans conversation transcripts via an LLM call and writes candidates with `writeCandidate`; `direct-llm-runner.ts` reads every `.md` file from the active `skills/` directory and prepends their bodies to the system prompt before calling the LLM.

## Tech Stack

- TypeScript / Node.js
- Vitest (e2e suite, `vitest.e2e.config.ts`)
- better-sqlite3 (in-memory database via `_initTestDatabase`)
- Node `fs` / `os.tmpdir()` for real filesystem harness
- Stubbed LLM (no Ollama / no Kubernetes required)

## File Structure

### Test files
- `e2e/skill-harvest.test.ts` — 4 e2e scenarios covering all ACs

### Source files
- `src/runtime/skill-store.ts` — `writeCandidate`, `acceptCandidate`, `listCandidates`, filesystem helpers
- `src/runtime/skill-curator.ts` — `runCurator` scans transcript, calls `writeCandidate` for each surfaced skill
- `src/runtime/skills-commands.ts` — `handleSkillsCommand` (`/skills review`, `/skills accept <id>`)
- `src/runtime/tools/propose-skill.ts` — `proposeSkill` tool handler stages a candidate
- `src/runtime/direct-llm-runner.ts` — `buildSystemPrompt` reads `skills/*.md` and injects into prompt
- `src/db.ts` — `_initTestDatabase`, `__resetDbForTest`

## Tasks per AC

| AC | Test | Implementation |
|----|------|----------------|
| 1. Pre-existing skill loads into system prompt | `loads pre-existing skill into system prompt` | `direct-llm-runner.ts` reads `skills/` dir on `buildSystemPrompt` |
| 2. Full lifecycle via `/skills` commands | `full lifecycle: candidate -> /skills review -> /skills accept -> appears in prompt` | `skill-store.ts` + `skills-commands.ts` |
| 3. `propose_skill` stages candidate | `propose_skill stages candidate, accept moves it, prompt includes it` | `propose-skill.ts` → `writeCandidate` → `acceptCandidate` |
| 4. Curator stages from transcript | `curator stages candidates from transcript, user accepts, skill appears` | `skill-curator.ts` → `writeCandidate` → `handleSkillsCommand accept` |
| 5. Real fs + in-memory SQLite + stubbed LLM | all tests | `_initTestDatabase()` + `fs.mkdtempSync` harness; no LLM calls |

## Verification

```
npm run test:e2e -- skill-harvest
```

Expected: 4/4 passing. No Kubernetes cluster required.

## Retrospective

Implementation matched the story spec exactly. All four acceptance criteria map 1:1 to the four `it()` blocks in the test file. The harness (real fs tmpdir + in-memory SQLite + no live LLM) makes the suite fast (~200 ms for tests) and fully deterministic. No scope creep observed.
