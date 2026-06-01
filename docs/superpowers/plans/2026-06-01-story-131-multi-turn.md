# Story 131 — User-interaction Multi-turn Conversation: Retrospective Plan

**Date:** 2026-06-01
**Story:** 131 — User-interaction Multi-turn Conversation — context carries across turns
**Test suite:** `e2e/user-interaction.test.ts` › `describe('User Interaction: Multi-turn Conversation', …)` at line 423
**Run command:** `npm run test:e2e -- user-interaction -t "Multi-turn"`
**Result:** 3/3 passing (mock channel + mock LLM, no cluster)

---

## What was implemented

Story 131 verifies that `processGroupMessages` in `src/channel-runner.ts` correctly
threads conversation state across successive invocations for the same group, using a
cursor (timestamp), a per-group session-id registry, and the group's SQLite message
store — without requiring a live Kubernetes cluster.

### History loading (cursor-based windowing)

`processGroupMessages` calls `getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME)`
where `sinceTimestamp` is drawn from the module-level `lastAgentTimestamp` map (keyed by
JID). After each successful turn the cursor is advanced to the triggering message's
timestamp. On a retry (error path) the cursor is rolled back so the same messages are
re-processed next time.

Key facts:
- `lastAgentTimestamp[chatJid]` defaults to `''` (empty string) on first call, which
  returns all stored messages.
- After a turn completes, the cursor is set to `msg.timestamp` of the last processed
  message before the LLM call, ensuring subsequent calls only see new messages.
- `clearMessageQueue()` in tests simulates the queue being drained between turns; the
  cursor tracks position independently of queue state.

### Session-ID threading

`runAgent` reads `sessions[group.folder]` (another module-level map) and passes it as
`sessionId` to `agentRunner.runAgent(...)`. The `wrappedOnOutput` callback captures
`output.newSessionId` from each `ContainerOutput` and writes it back to
`sessions[group.folder]` (and persists via `setSession`). This means:

- Turn 1: `sessionId` is `undefined` (no prior session).
- Turn 2: `sessionId` is whatever `newSessionId` the first turn's output emitted.
- The session propagates across turns within one group but not across groups (separate
  `sessions[folder]` keys).

### Per-group isolation

Both maps (`lastAgentTimestamp` and `sessions`) are keyed by group identifier
(`chatJid` and `group.folder` respectively). Groups never share state.

### `/clear` resets context

The `/clear` intercept in `processGroupMessages` calls `clearConversationHistory(group.folder)`
and advances the cursor. The next LLM call therefore starts with `sessionId = undefined`
(no carry-over) and an empty history, satisfying AC4.

---

## Test structure

Three tests in the describe block, all using the mock harness (no cluster):

| Test | What it verifies |
|---|---|
| does not re-process messages from a previous turn | Cursor advances after turn 1; turn 2 with no new messages calls `mockRunAgent` 0 times |
| processes new messages in second turn with context cursor | Prompt for turn 2 contains the new message but NOT the turn-1 message (cursor excluded it) |
| preserves session ID across turns | `sessionId` is `undefined` in turn 1; equals `newSessionId` from turn 1 response in turn 2 |

---

## Files touched

- `src/channel-runner.ts` — `processGroupMessages`, `runAgent`, `lastAgentTimestamp`,
  `sessions`, `_testResetState`, `_setRegisteredGroups`
- `e2e/user-interaction.test.ts` — line 423, `describe('User Interaction: Multi-turn Conversation', …)`

No new implementation was required for this story; the behaviour was already present.
The retrospective confirms tests pass against the existing code.
