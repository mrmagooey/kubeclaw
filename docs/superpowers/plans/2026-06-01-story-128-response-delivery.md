# Story 128: User-interaction Response Delivery — Retrospective Plan

**Date:** 2026-06-01
**Story:** 128 — User-interaction Response Delivery
**Test suite:** `e2e/user-interaction.test.ts` — `describe('User Interaction: Response Delivery', ...)`
**Test command:** `npm run test:e2e -- user-interaction -t "Response Delivery"`
**Result:** 4/4 passing

---

## What the story covers

Story 128 closes the trigger → LLM → channel loop: once the agent produces a
response, that response must be forwarded to the originating chat group, byte-for-
byte, with internal reasoning blocks stripped, and with streaming (multi-part)
support.

---

## Implementation location

`src/channel-runner.ts` — the `runOne` inner function inside `processGroupMessages`.

The key path (lines ~2789–2810):

1. `runAgent` is called with an `onOutput` callback.
2. Inside `onOutput`, `result.result` is coerced to a string.
3. `/<internal>[\s\S]*?<\/internal>/g` is replaced with `''` and the string is
   trimmed.
4. If the trimmed text is non-empty, `channel.sendMessage(chatJid, out)` fires.
5. `outputSentToUser` is set to `true` so downstream cursor logic knows a reply
   was delivered.
6. When `result.status === 'success'` the group queue is notified idle, providing
   idempotence (no duplicate delivery on subsequent queue ticks).

---

## Acceptance criteria mapping

| AC | Description | Verified by |
|----|-------------|-------------|
| 1 | Triggered inbound → LLM response forwarded to channel's outbound queue | `delivers agent response to the channel` |
| 2 | Response text preserved byte-for-byte | same test — `expect(sent[0].content).toBe(...)` |
| 3 | `<internal>` tags stripped before delivery | `strips <internal> reasoning blocks before sending to channel` |
| 4 | Multi-part responses split per character limit | `sends multiple streaming outputs when agent calls onOutput several times` |
| 5 | Delivery is idempotent | `does not send anything when response is only internal blocks` (no spurious send) + `queue.notifyIdle` prevents re-queuing |

---

## Harness design

- Mock channel: module-level `_channelMessages` array written to by a fake
  `channel.sendMessage`; retrieved via `getQueuedMessages()`.
- Mock LLM: `mockRunAgent` / `mockAgentSuccess` helpers inject deterministic
  `ContainerOutput` values, bypassing the real Kubernetes/Ollama path entirely.
- SQLite: in-memory test DB seeded via `storeMessage` / `_setRegisteredGroups`.
- No Kubernetes, no network calls, no Redis required for this describe block
  (Redis is set up once per file but not exercised by these four tests).

---

## Key observations

- The `<internal>` stripping regex is non-greedy and handles multi-line content
  correctly.
- The streaming path (`onOutput` called multiple times) works because `runAgent`
  invokes the callback for each partial result; `runOne` queues each non-empty,
  stripped chunk independently.
- Specialist-prefixed replies (`[@SpecialistName] ...`) are also generated in this
  same callback, but that path is exercised by Story 13, not Story 128.
- The `outputSentToUser` flag prevents cursor roll-back when an error arrives
  after output was already delivered (tested in Story 128's sibling describe
  block, `Error Handling`).
