# Story 149: User-interaction Error Handling — agent errors deliver a user-visible reply

## Goal

Verify that `processGroupMessages` in `src/channel-runner.ts` handles agent runner errors safely: rolling back the message cursor when no output has reached the user, and NOT rolling back when partial output was already sent (to prevent duplicate replies on retry).

## Architecture

The key state machine lives in `processGroupMessages` (around line 2768 of `src/channel-runner.ts`):

1. **Cursor snapshot** — `previousCursor` captures `lastAgentTimestamp[chatJid]` before the agent runs. The cursor is optimistically advanced to the last message timestamp.
2. **`outputSentToUser` flag** — set to `true` inside the `onOutput` callback the first time a non-empty result is forwarded to the channel's `sendMessage`.
3. **`hadError` flag** — set when `runAgent` returns `'error'` or the `onOutput` callback receives `{ status: 'error' }`.
4. **Post-loop error dispatch:**
   - `hadError && outputSentToUser` → cursor stays advanced, returns `true` (partial output was sent; do not re-process to avoid duplicates).
   - `hadError && !outputSentToUser && failedSpecialists.length === 0` → cursor rolled back to `previousCursor`, returns `false` (message will be re-tried on next tick).
   - `hadError && !outputSentToUser && failedSpecialists.length > 0` → per-specialist error messages sent to channel, cursor stays advanced, returns `true`.

The mock injected in tests (`mockRunAgent`) controls whether `onOutput` is called with `{ status: 'error', result: null }` (no output) or `{ status: 'success', result: '...' }` followed by an error return.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** none required — `requireKubernetes()` is NOT called; harness uses mock channel + mock LLM + in-process SQLite
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/user-interaction.test.ts` (line 502) | `describe('User Interaction: Error Handling', ...)` — 3-test suite |
| `src/channel-runner.ts` (line ~2768) | `processGroupMessages` — cursor rollback + `outputSentToUser` logic |

## Tasks (retrospective)

### AC 1 — Exception in agent runner → cursor rolled back, returns false

`mockRunAgent` fires `onOutput` with `{ status: 'error', result: null }` and returns `{ status: 'error' }`. Because `result` is null, `outputSentToUser` remains false. Post-loop: `hadError && !outputSentToUser && failedSpecialists.length === 0` → cursor is restored to `previousCursor` and `processGroupMessages` returns `false`. The test then calls again with a success mock and confirms the same message is re-processed (cursor rollback was effective).

### AC 2 — Error after partial output does not roll back cursor, returns true

`mockRunAgent` calls `onOutput` with a success result (setting `outputSentToUser = true`), then returns `{ status: 'error' }`. Post-loop: `hadError && outputSentToUser` → cursor stays advanced, returns `true`. The partial message is in the queue; a second call to `processGroupMessages` finds no new messages and does not invoke `runAgent` again.

### AC 3 — No channel owns the JID → skips silently, returns true

A group is registered for a JID but the mock channel does not claim that JID (`findChannel` returns null). `processGroupMessages` logs a warning and returns `true` immediately; `mockRunAgent` is never called.

### Verification

Run: `npm run test:e2e -- user-interaction -t "Error Handling"`

Expected: **3 / 3 tests pass**. No cluster required.

Runtime: ~200 ms (pure in-process SQLite + mock channel; no network).
