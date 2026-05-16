# Skill Harvest — Design

## Goal

Let KubeClaw learn from conversations. As a user chats with a channel, the system should capture codifiable patterns — tools the user taught, corrections the user made, hard-won research the agent did — and turn them into reusable **skills** that are automatically composed into future system prompts. The same machinery should also propose **edits to existing skills** when they need tuning, not just spawn new ones.

In v1, everything happens channel-side. The orchestrator is not involved in skill content.

## Background

Today, per-group instruction lives in a single `groups/{group}/CLAUDE.md` file. The user edits it by hand. There is no machinery for capturing "I just told the assistant something it should remember next time" beyond manually editing the file. There is also no way to learn from a corpus of past conversations.

The conversation transcript lives in each channel's own SQLite at `messages-{channel}.db` (per-channel PVC at `/app/store`). The orchestrator's SQLite is a different database and does not contain conversation history — it holds capabilities and scheduled tasks. Any analyzer that wants to read transcripts must run in the channel pod, not in the orchestrator.

Three relevant existing surfaces:

| Surface | Location | Role for this design |
|---|---|---|
| `loadSystemPrompt(groupFolder)` | `src/runtime/direct-llm-runner.ts:775` | Single injection point for channel-side system prompt. Skill loader plugs in here. |
| `conversation_history` table | `src/db.ts:159` (channel DB) | Source of truth for the harvester. Indexed on `(group_folder, created_at)`. |
| `groups/` PVC | mounted at `/app/groups` in every channel pod | Where skill files live; channel has read/write. |

## Design decisions

Five forks resolved during brainstorming:

1. **Channel-side, not orchestrator-side.** The orchestrator has no access to channel SQLite or the channel `groups/` PVC, and giving it access would invert the privacy boundary in the four-tier model. All skill harvesting, storage, loading, and review happens inside the channel pod.

2. **Two harvest triggers, both in v1.** On-demand (`propose_skill` tool the channel LLM can call mid-turn) AND a channel-side nightly curator that scans the previous 24h of `conversation_history`. On-demand captures intentional moments; the curator catches repeated patterns the user did not flag.

3. **Files, not a new table, for skill content.** Skills live as markdown files with YAML frontmatter at `groups/{group}/skills/{slug}.md`. Git-trackable, human-editable, inspectable with `cat`. A separate `skill_usage` SQLite table holds telemetry only.

4. **Per-(channel, group) scope, no global skills in v1.** Each channel pod has its own `groups/` PVC, so skills are naturally scoped to one channel instance and one group within it. Cross-channel promotion is a v2 concern.

5. **Plain markdown bodies, no tool-binding.** A skill is an instruction fragment, not a behavior with attached capability. Tool-binding (a skill that says "prefer MCP tool X for this") couples skills to capability identity and is deferred.

## Architecture

### Skill file format

```markdown
---
name: prefer-rg-over-grep
description: Use ripgrep with --hidden when searching peter's projects
created: 2026-05-16
source: harvest-curator-2026-05-16
                # or "propose-skill-<message-id>"
                # or "manual"
---

When the user asks to search files, prefer `rg --hidden --no-ignore` over
`grep -r`. Reason: peter's projects have important content in dotfiles
and CI configs that default grep skips.
```

The `name` field must match the filename stem. The `description` is what the curator uses to decide "does this signal warrant a new skill, or does an existing skill cover it?" — it must be specific. The body is plain markdown, concatenated verbatim into the system prompt.

### Storage layout

```
groups/{group}/
  CLAUDE.md                         # existing — per-group memory
  skills/
    {slug}.md                       # accepted skills
    _candidates/
      {timestamp}-{slug}.md         # pending review
    _archive/
      {slug}.md                     # disabled skills (still on disk for restore)
```

`_candidates/` and `_archive/` use underscore prefix so the skill loader's glob (`skills/*.md`) excludes them. Disabled skills move to `_archive/`; pruned skills are deleted (with a git commit being the recovery path if the operator commits the `groups/` directory).

### System prompt assembly

Extend `loadSystemPrompt` in `src/runtime/direct-llm-runner.ts:775`:

```
final_prompt = CLAUDE.md
            + "\n\n## Learned skills\n\n"
            + concat(skills/*.md bodies, separated by "\n\n---\n\n")
```

A new module `src/runtime/skill-loader.ts` owns the glob, frontmatter parsing, and body extraction. The loader also records to the `skill_usage` table: which skills were loaded for which group at which timestamp. This is the "loaded-into-context" telemetry the curator uses for pruning.

If `groups/{group}/skills/` is empty or absent, no extra section is appended — behavior is identical to today.

**Hard cap:** if more than 20 skills are present for a group, the loader logs a warning and loads only the 20 with most recent `last_loaded`. The curator surfaces this state as a consolidation prompt.

### On-demand path — `propose_skill` tool

A new built-in tool exposed to the channel LLM:

```typescript
{
  name: "propose_skill",
  description: "Capture a reusable instruction or pattern as a skill. Use when the user has just taught you something they want remembered for future conversations.",
  parameters: {
    proposed_name: "kebab-case slug",
    description: "one-line, specific, what triggers it",
    body: "markdown body of the instruction",
    rationale: "why this is worth keeping (shown to user, not stored)"
  }
}
```

Handler (`src/runtime/tools/propose-skill.ts`):

1. Loads existing skills in this group; runs a cheap LLM check ("does this duplicate or extend an existing skill?")
2. If duplicate or near-duplicate → returns suggestion to **edit** the existing skill instead; no candidate written
3. If novel → writes `groups/{group}/skills/_candidates/{timestamp}-{slug}.md` and returns a draft preview to the LLM, which then surfaces it conversationally ("Drafted skill `prefer-rg-over-grep` — reply `/skills accept <id>` or `/skills reject <id>`.")

The tool does **not** auto-accept. User confirmation through the chat-side `/skills` commands is required.

### Curator path — channel-side nightly job

A new module `src/runtime/skill-curator.ts` runs on a `setInterval` started in `src/channel-runner.ts` startup. Default cadence: every 24h, anchored to the channel pod's start time (no cron parsing needed; if you want clock-aligned cadence later, use the orchestrator's existing scheduler via Redis trigger — flagged as v2).

Per run, per group with any activity in the last 24h:

1. Query `conversation_history` for the last 24h
2. Cheap pre-filter (drop pure tool-call noise, keep user turns + assistant turns that contain corrections or research summaries)
3. If filtered size is non-trivial (≥3 user turns), invoke the curator LLM call with:
   - Existing skills (full bodies) for this group
   - Filtered transcript
   - The signal taxonomy as a system prompt
   - Output schema: array of `{action: "new"|"edit"|"tune-description", target: skill-name-or-null, body: string, rationale: string}`
4. For each output entry, write to `_candidates/` with timestamped filename
5. Update channel's "pending candidates" counter; on next user message in that group, the channel surfaces: *"Found N skill candidates from yesterday. Reply `/skills review` to triage."*

The curator does **not** modify or delete existing skills directly. Every action is staged as a candidate for user approval.

Curator transcript size is bounded by pre-filtering. If filtered transcript still exceeds a tunable token limit (default: 30k tokens), the curator windows by 6h chunks within the 24h window and merges proposals across windows (dedup by `(action, target)` then re-rank). No new IPC surface.

### Signal taxonomy

The curator LLM's system prompt enumerates:

**Capture as candidate:**
- User correction: "no, do X instead" where X is non-obvious
- Taught incantation: "use `cmd --weird-flag …`"
- Hard-won research: agent did long exploration, found non-obvious answer
- Cross-session repetition: same correction observed ≥2 times in window
- Existing-skill miss: skill *should have* applied per its description but didn't trigger → propose `tune-description`
- Existing-skill drift: skill triggered but agent diverged from it → propose `edit` (strengthen body)

**Do not capture:**
- Project-specific facts → those belong in CLAUDE.md, suggest user move there
- One-off solutions with no reuse signal
- Things already obvious from surrounding code

**Edit-over-new bias** is structural: the curator prompt requires retrieving existing skills first, then for each signal explicitly answering "does this strengthen skill X, tune the description of skill Y, or warrant a new skill?" — `new` is the last resort.

### Chat commands — `/skills ...`

**Intercept point:** `runAgent` in `src/channel-runner.ts:499`. This is the single function that every channel's inbound message flows through before reaching the LLM, so wiring `/skills` here makes it work universally with no per-channel changes. Handler logic lives in `skills-commands.ts` and is channel-agnostic.

Channel-side message handler recognizes these and routes to local handlers (not LLM):

| Command | Effect |
|---|---|
| `/skills list` | List accepted skills with trigger count, last-loaded date |
| `/skills review` | Interactive triage of `_candidates/` — one at a time |
| `/skills show <name>` | Print body of a skill |
| `/skills accept <candidate-id>` | Move candidate to accepted (`skills/{slug}.md`) |
| `/skills reject <candidate-id>` | Delete candidate |
| `/skills edit <name>` | Print body for user to copy, edit, repost; or open in admin shell (deferred — v1 prints only) |
| `/skills disable <name>` | Move skill to `_archive/` |
| `/skills enable <name>` | Move skill back from `_archive/` |
| `/skills prune` | Run curator's pruning sweep: surface skills with zero loads in 60 days |

`/skills review` is a stateful conversation — channel writes a per-(group, user) "in-review" cursor to track which candidate is being shown. User replies `a`/`r`/`s` (accept/reject/skip) advance the cursor.

### Telemetry — `skill_usage` table

New table in channel SQLite (added to `createSchema` in `src/db.ts`):

```sql
CREATE TABLE IF NOT EXISTS skill_usage (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  loaded_at INTEGER NOT NULL
);
CREATE INDEX idx_skill_usage_group_skill ON skill_usage(group_folder, skill_name);
CREATE INDEX idx_skill_usage_loaded_at ON skill_usage(loaded_at);
```

Written by `skill-loader.ts` every time `loadSystemPrompt` is called: one row per skill loaded. Read by `/skills list`, `/skills prune`, and the curator's pruning sweep.

**Why "loaded" not "used":** the LLM never tells us which skill it relied on. Counting loads is a cheap proxy: a skill that was never loaded in 60 days is certainly unused; a skill loaded daily *might* be useful. Pruning is therefore opt-in (curator suggests, user accepts).

### Quality control summary

- **Edit-over-new bias** in the curator prompt (structural, not optional)
- **Per-group hard cap of 20 skills** enforced by the loader (warns and selects most-recent-loaded subset)
- **User-gated acceptance** for every new or edited skill — nothing is written to `skills/*.md` without `/skills accept`
- **Pruning sweep** via `/skills prune` proposes deletion candidates for skills with zero loads in 60 days; user accepts/rejects per skill

## Concrete file changes

### New files

```
src/runtime/skill-loader.ts             # glob, parse, concat, telemetry write
src/runtime/skill-curator.ts            # nightly scan + candidate generation
src/runtime/skill-store.ts              # filesystem ops on groups/{g}/skills/
src/runtime/tools/propose-skill.ts      # propose_skill tool handler
src/runtime/skills-commands.ts          # /skills chat command parser + handlers
src/runtime/skill-loader.test.ts
src/runtime/skill-curator.test.ts
src/runtime/skill-store.test.ts
src/runtime/tools/propose-skill.test.ts
src/runtime/skills-commands.test.ts
e2e/skill-harvest.test.ts               # full end-to-end happy path
```

### Modified files

- `src/runtime/direct-llm-runner.ts:775` — `loadSystemPrompt` calls `skill-loader.loadSkills(groupFolder)` and appends to prompt; adds `propose_skill` to the channel-side tool list
- `src/db.ts` — add `skill_usage` table to `createSchema`; add typed accessors (`recordSkillLoad`, `getSkillLoadStats`, `getSkillsLoadedSince`)
- `src/channel-runner.ts` — start the curator interval after `initDatabase()`
- `src/channel-runner.ts:499` (`runAgent`) — at the top of the function, if the incoming prompt starts with `/skills` (or equals `/skills`), dispatch to `skills-commands.ts` instead of calling the LLM runner. This works for all channels because every inbound message flows through this function.

## Testing strategy

Three levels, per project policy.

**Unit (Vitest, `src/runtime/*.test.ts`):**
- `skill-loader`: glob filters `_candidates/`, `_archive/`, and dotfiles; frontmatter parse; body concatenation; 20-skill cap selects by most-recent-loaded; empty `skills/` returns unchanged prompt; telemetry rows written.
- `skill-store`: write candidate, list candidates, accept (move to `skills/`), reject (delete), disable (move to `_archive/`), enable (move back), prune (delete). Atomic rename semantics (no torn files on crash).
- `skill-curator`: pre-filter behavior; cap-then-window when transcript exceeds token limit; edit-over-new bias respected when fed a duplicate signal; produces well-formed candidate files.
- `propose-skill` tool: duplicate detection short-circuits; novel signal writes candidate.
- `skills-commands`: parses each `/skills <verb> [args]`; rejects unknown verbs; stateful review cursor.

**Integration (Vitest, runs against real SQLite in tmp dir):**
- `loadSystemPrompt` returns prompt with skills appended when `groups/{g}/skills/` populated; returns unchanged prompt when empty.
- `skill_usage` table written on each `loadSystemPrompt` call; rows queryable by group and time window.
- End-to-end candidate lifecycle: `propose_skill` tool writes candidate → `/skills accept <id>` moves it to accepted → next `loadSystemPrompt` includes the new skill body.
- Curator run against a seeded `conversation_history` produces candidates in `_candidates/`.

**End-to-end (`e2e/skill-harvest.test.ts`, runs against minikube):**
- Stand up a channel; send a chat message that teaches a pattern; send `/skills review`; accept the proposed skill; send a follow-up message; verify the LLM's system prompt assembled for the follow-up call includes the new skill body (asserted via channel log or runtime debug hook).
- Verify the nightly curator triggers when its interval is overridden to a few seconds in test; verify candidates appear; verify acceptance flow.

## Out of scope (deferred)

- **Global / cross-channel skills.** Each channel has its own `groups/` PVC; sharing requires either an orchestrator-mediated promotion path or a shared PVC strategy. Punt to v2 once usage patterns inform whether it matters.
- **Tool-binding in skill bodies.** A skill is text. If a skill needs to direct the LLM toward a specific MCP tool or capability, that goes in the skill body as a textual instruction — not as a structured binding.
- **Orchestrator-coordinated curator schedule.** v1 uses a channel-side `setInterval`. If clock-alignment or cross-channel coordination matters later, the orchestrator publishes a "run-curator" message on a per-channel Redis stream; channel subscribes. Not built in v1.
- **LLM self-report telemetry** ("which skills did you actually use this turn?"). Adds per-turn cost. Proxy via load-counting is good enough for pruning decisions in v1.
- **Skill editing via chat.** `/skills edit <name>` v1 just prints the body; full conversational editing is a v2 nicety.
- **Per-skill A/B or staged rollout.** Not needed at this scale.
