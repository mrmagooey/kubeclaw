# Story 115: Trigger detection — only matching messages reach the agent

## Goal

Verify that the orchestrator's trigger-match gate inside `src/channel-runner.ts` only forwards inbound group messages to `runAgent` when they contain the configured trigger pattern (e.g. `@Andy`), while storing non-triggering messages in the database untouched, and that DM / non-trigger-required groups bypass the check entirely.

## Architecture

`_processGroupMessages` in `src/channel-runner.ts` reads missed messages from the SQLite store, then — for groups where `isMain` is false and `requiresTrigger !== false` — tests each message body against `TRIGGER_PATTERN` (a case-insensitive regex derived from `ASSISTANT_NAME`). If no message in the batch matches, the function returns early without calling `runAgent`. For groups where `requiresTrigger` is explicitly `false` (DM-style or main groups) the check is skipped and every batch reaches the agent. `src/sender-allowlist.ts` gates which senders' trigger words are honoured, but that path is not the focus of these tests.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Harness:** mocked `runAgent` (no real LLM or Kubernetes) + real `_processGroupMessages` orchestrator logic
- **Database:** in-process SQLite via `storeMessage` / `getQueuedMessages` helpers
- **Redis:** live port-forward to `kubeclaw-redis` (established by global setup)
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/user-interaction.test.ts` | 6-test `describe('User Interaction: Trigger Detection', ...)` suite at line 230 |
| `src/channel-runner.ts` | `_processGroupMessages` — trigger-match gate (line ~2224) |
| `src/sender-allowlist.ts` | Allowlist gating for sender-authorised trigger messages |

## Tasks (retrospective)

### AC 1 — Inbound with trigger → `runAgent` called once

`makeMessage` creates a message body containing `@${ASSISTANT}`. `storeMessage` writes it. `_processGroupMessages` finds the trigger, calls `mockRunAgent` exactly once.

### AC 2 — Inbound without trigger → stored, no `runAgent`

Two messages with generic text are stored. `_processGroupMessages` finds no trigger match and returns `true` early; `mockRunAgent` is never invoked and `getQueuedMessages()` is empty.

### AC 3 — Multiple trigger patterns match independently

A batch with a non-trigger preamble followed by a trigger message is processed. The trigger match fires on the third message and `mockRunAgent` is called once, confirming any batch member can satisfy the predicate.

### AC 4 — Case-insensitive trigger matching

A message containing `@${ASSISTANT.toLowerCase()}` (all-lowercase) matches `TRIGGER_PATTERN`, confirming the regex is case-insensitive.

### AC 5 — DM / main groups auto-trigger every message

Two cases: `makeGroup({ isMain: true, requiresTrigger: false })` and `makeGroup({ requiresTrigger: false })`. In both, a message with no trigger word still causes `mockRunAgent` to be called, confirming the gate is bypassed.

### Verification

Run: `npm run test:e2e -- user-interaction -t "Trigger Detection"`

Expected: **6 / 6 tests pass**.

Runtime: under 5 seconds (mocked agent; no helm install).
