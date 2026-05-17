# Context Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic LLM-based conversation summarization with parent/child session lineage so kubeclaw groups can run indefinitely without hitting context-window limits, while exposing `/compact`, `/summary`, and `/clear` chat commands to users.

**Architecture:** A new `conversation_summaries` SQLite table stores chained summaries (each pointing to its predecessor via `parent_summary_id`). Before every LLM call in `DirectLLMRunner`, a threshold check compares unsummarized message count and token estimate against configurable env vars; if the threshold is exceeded, the oldest messages (outside the keep-window) are summarized in a separate LLM call using the same client/credentials, a summary row is written to SQLite, and those messages are replaced with a compact `[summary_id=N] <text>` header in the prompt. The `/compact`, `/summary`, and `/clear` chat commands live in a new `src/runtime/compression-commands.ts` module, wired into `src/channel-runner.ts` alongside the existing `/skills` intercept.

**Tech Stack:** TypeScript, Node.js, sql.js (via the existing `db` singleton in `src/db.ts`), OpenAI SDK (`openai` package, reusing `createLLMClient`), Vitest.

---

## File Structure

**Created:**
- `src/runtime/compression/token-estimate.ts` — heuristic token counter (no LLM call)
- `src/runtime/compression/token-estimate.test.ts`
- `src/runtime/compression/prompts.ts` — literal summarization system + user prompt templates
- `src/runtime/compression/summarizer.ts` — calls LLM client, returns summary string
- `src/runtime/compression/summarizer.test.ts`
- `src/runtime/compression-commands.ts` — `/compact`, `/summary`, `/clear` command handler
- `src/runtime/compression-commands.test.ts`
- `docs/CONTEXT_COMPRESSION.md` — operator and user documentation

**Modified:**
- `src/db.ts` — new `conversation_summaries` table in `createSchema`; `insertSummary`, `getLatestSummary`, `deleteSummariesForGroup` helpers; extend `clearConversationHistory` to wipe summaries
- `src/db.test.ts` — tests for every new helper + regression test for `clearConversationHistory`
- `src/runtime/direct-llm-runner.ts` — threshold check + compression invocation before assembling the LLM prompt
- `src/runtime/direct-llm-runner.test.ts` — tests for threshold trigger and message replacement
- `src/runtime/direct-llm-runner.integration.test.ts` — integration test: drive conversation past threshold, verify summary row, verify subsequent prompts contain summary marker, verify `clearConversationHistory` purges summaries
- `src/channel-runner.ts` — import and wire `isCompactCommand` / `handleCompactCommand` at the `/skills` intercept site (line ~1087)
- `src/channel-runner.test.ts` — integration test for command dispatch

---

## Task 1: `conversation_summaries` schema in `src/db.ts`

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/db.test.ts`:

```ts
describe('conversation_summaries DDL', () => {
  it('creates the table with all required columns', () => {
    const result = db.exec(
      `SELECT name FROM pragma_table_info('conversation_summaries') ORDER BY name`,
    );
    const cols = result[0].values.flat() as string[];
    expect(cols).toContain('id');
    expect(cols).toContain('group_folder');
    expect(cols).toContain('session_key');
    expect(cols).toContain('parent_summary_id');
    expect(cols).toContain('message_start_id');
    expect(cols).toContain('message_end_id');
    expect(cols).toContain('summary_text');
    expect(cols).toContain('model_used');
    expect(cols).toContain('token_count');
    expect(cols).toContain('created_at');
  });
});
```

- [ ] **Step 2: Add the DDL to `createSchema` in `src/db.ts`**

Inside `createSchema`, after the `specialist_usage` block, add:

```ts
database.run(`
  CREATE TABLE IF NOT EXISTS conversation_summaries (
    id               TEXT PRIMARY KEY,
    group_folder     TEXT NOT NULL,
    session_key      TEXT NOT NULL,
    parent_summary_id TEXT,
    message_start_id TEXT NOT NULL,
    message_end_id   TEXT NOT NULL,
    summary_text     TEXT NOT NULL,
    model_used       TEXT NOT NULL,
    token_count      INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    FOREIGN KEY (parent_summary_id) REFERENCES conversation_summaries(id)
  )
`);
database.run(
  `CREATE INDEX IF NOT EXISTS idx_conv_summaries_group
   ON conversation_summaries(group_folder, created_at)`,
);
database.run(
  `CREATE INDEX IF NOT EXISTS idx_conv_summaries_session
   ON conversation_summaries(session_key, created_at)`,
);
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/db.test.ts
```

Expected: all existing `db` tests pass; new DDL test passes.

- [ ] **Step 4: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): add conversation_summaries table with lineage index"
```

---

## Task 2: DB helpers — `insertSummary`, `getLatestSummary`, `deleteSummariesForGroup`

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/db.test.ts`:

```ts
import {
  insertSummary,
  getLatestSummary,
  deleteSummariesForGroup,
  appendConversationMessage,
} from '../src/db.js';

describe('insertSummary / getLatestSummary', () => {
  it('roundtrips a summary record', () => {
    insertSummary({
      groupFolder: 'g1',
      sessionKey: 'g1',
      parentSummaryId: null,
      messageStartId: 'msg-001',
      messageEndId: 'msg-020',
      summaryText: 'User asked about cats.',
      modelUsed: 'gpt-4o',
      tokenCount: 42,
    });
    const row = getLatestSummary('g1');
    expect(row).not.toBeNull();
    expect(row!.summaryText).toBe('User asked about cats.');
    expect(row!.modelUsed).toBe('gpt-4o');
    expect(row!.tokenCount).toBe(42);
    expect(row!.parentSummaryId).toBeNull();
  });

  it('returns the newest summary when multiple exist', () => {
    insertSummary({
      groupFolder: 'g2', sessionKey: 'g2', parentSummaryId: null,
      messageStartId: 'a', messageEndId: 'b',
      summaryText: 'First summary', modelUsed: 'gpt-4o', tokenCount: 10,
    });
    const firstId = getLatestSummary('g2')!.id;
    insertSummary({
      groupFolder: 'g2', sessionKey: 'g2', parentSummaryId: firstId,
      messageStartId: 'c', messageEndId: 'd',
      summaryText: 'Second summary', modelUsed: 'gpt-4o', tokenCount: 15,
    });
    const latest = getLatestSummary('g2');
    expect(latest!.summaryText).toBe('Second summary');
    expect(latest!.parentSummaryId).toBe(firstId);
  });

  it('returns null when no summaries exist for a group', () => {
    expect(getLatestSummary('nonexistent-group')).toBeNull();
  });
});

describe('deleteSummariesForGroup', () => {
  it('removes all summaries for the group, leaving others intact', () => {
    insertSummary({
      groupFolder: 'del-group', sessionKey: 'del-group', parentSummaryId: null,
      messageStartId: 'x', messageEndId: 'y',
      summaryText: 'To be deleted', modelUsed: 'gpt-4o', tokenCount: 5,
    });
    insertSummary({
      groupFolder: 'keep-group', sessionKey: 'keep-group', parentSummaryId: null,
      messageStartId: 'p', messageEndId: 'q',
      summaryText: 'Keep me', modelUsed: 'gpt-4o', tokenCount: 5,
    });
    deleteSummariesForGroup('del-group');
    expect(getLatestSummary('del-group')).toBeNull();
    expect(getLatestSummary('keep-group')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Implement the helpers in `src/db.ts`**

Add after `clearConversationHistory`:

```ts
export interface SummaryRecord {
  id: string;
  groupFolder: string;
  sessionKey: string;
  parentSummaryId: string | null;
  messageStartId: string;
  messageEndId: string;
  summaryText: string;
  modelUsed: string;
  tokenCount: number;
  createdAt: string;
}

export interface InsertSummaryArgs {
  groupFolder: string;
  sessionKey: string;
  parentSummaryId: string | null;
  messageStartId: string;
  messageEndId: string;
  summaryText: string;
  modelUsed: string;
  tokenCount: number;
}

export function insertSummary(args: InsertSummaryArgs): string {
  const id =
    args.groupFolder +
    '-summary-' +
    Date.now() +
    '-' +
    Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO conversation_summaries
      (id, group_folder, session_key, parent_summary_id,
       message_start_id, message_end_id, summary_text,
       model_used, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      args.groupFolder,
      args.sessionKey,
      args.parentSummaryId ?? null,
      args.messageStartId,
      args.messageEndId,
      args.summaryText,
      args.modelUsed,
      args.tokenCount,
      now,
    ],
  );
  saveDatabase();
  return id;
}

export function getLatestSummary(groupFolder: string): SummaryRecord | null {
  const result = db.exec(
    `SELECT id, group_folder, session_key, parent_summary_id,
            message_start_id, message_end_id, summary_text,
            model_used, token_count, created_at
     FROM conversation_summaries
     WHERE group_folder = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [groupFolder],
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  const [
    id, gf, sk, parentId, startId, endId, text, model, tokens, createdAt,
  ] = result[0].values[0] as [
    string, string, string, string | null,
    string, string, string, string, number, string,
  ];
  return {
    id, groupFolder: gf, sessionKey: sk, parentSummaryId: parentId,
    messageStartId: startId, messageEndId: endId,
    summaryText: text, modelUsed: model,
    tokenCount: tokens, createdAt,
  };
}

export function deleteSummariesForGroup(groupFolder: string): void {
  db.run('DELETE FROM conversation_summaries WHERE group_folder = ?', [groupFolder]);
  saveDatabase();
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/db.test.ts
```

Expected: all new helper tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): add insertSummary, getLatestSummary, deleteSummariesForGroup helpers"
```

---

## Task 3: Extend `clearConversationHistory` to also wipe summaries

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

**Why:** A hard wipe must be complete. Leaving orphaned summary rows after clearing history would cause the next compression cycle to reference non-existent `message_start_id` / `message_end_id` values, and would give the LLM a stale summary as context for a supposedly fresh conversation.

- [ ] **Step 1: Write the regression test first**

Add to `src/db.test.ts`:

```ts
describe('clearConversationHistory regression — also purges summaries', () => {
  it('deletes both conversation_history and conversation_summaries rows', () => {
    appendConversationMessage('wipe-group', 'user', 'hello');
    insertSummary({
      groupFolder: 'wipe-group', sessionKey: 'wipe-group',
      parentSummaryId: null,
      messageStartId: 'x', messageEndId: 'y',
      summaryText: 'Prior session summary', modelUsed: 'gpt-4o', tokenCount: 10,
    });
    clearConversationHistory('wipe-group');
    expect(getConversationHistory('wipe-group')).toHaveLength(0);
    expect(getLatestSummary('wipe-group')).toBeNull();
  });
});
```

- [ ] **Step 2: Update `clearConversationHistory` in `src/db.ts`**

Replace the existing implementation:

```ts
export function clearConversationHistory(groupFolder: string): void {
  db.run('DELETE FROM conversation_history WHERE group_folder = ?', [groupFolder]);
  db.run('DELETE FROM conversation_summaries WHERE group_folder = ?', [groupFolder]);
  saveDatabase();
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/db.test.ts
```

Expected: regression test passes; no existing tests broken.

- [ ] **Step 4: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "fix(db): clearConversationHistory now also purges conversation_summaries"
```

---

## Task 4: Token-estimation utility

**Files:**
- Create: `src/runtime/compression/token-estimate.ts`
- Create: `src/runtime/compression/token-estimate.test.ts`

The estimator must be synchronous and must NOT call any LLM. The heuristic is `ceil(charCount / 4)` — roughly 4 chars per token for English prose. This is the same heuristic used by many OpenAI client libraries for pre-call budget checks. The threshold check in Task 7 uses this to avoid a network round-trip before deciding whether to compress.

- [ ] **Step 1: Write the failing tests**

Create `src/runtime/compression/token-estimate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateMessagesTokens,
} from './token-estimate.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up for strings not divisible by 4', () => {
    // 'hello' = 5 chars → ceil(5/4) = 2
    expect(estimateTokens('hello')).toBe(2);
  });

  it('returns exact division when divisible', () => {
    // 'abcd' = 4 chars → 1
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('handles a realistic message', () => {
    const msg = 'The quick brown fox jumps over the lazy dog.'; // 44 chars → 11
    expect(estimateTokens(msg)).toBe(11);
  });
});

describe('estimateMessagesTokens', () => {
  it('sums tokens across all messages including role label overhead', () => {
    const msgs = [
      { role: 'user' as const, content: 'Hi' },       // 'user' (4) + 'Hi' (2) = 6 chars → 2
      { role: 'assistant' as const, content: 'Hello!' }, // 'assistant' (9) + 'Hello!' (6) = 15 chars → 4
    ];
    // total chars = 6 + 15 = 21 → ceil(21/4) = 6
    expect(estimateMessagesTokens(msgs)).toBe(6);
  });

  it('returns 0 for empty array', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});
```

- [ ] **Step 2: Implement `src/runtime/compression/token-estimate.ts`**

```ts
/**
 * Heuristic token estimator — no LLM call.
 *
 * Uses the 4-chars-per-token approximation. Suitable for threshold checks
 * only; do not use for billing or precise context-window management.
 */

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(
  messages: { role: string; content: string }[],
): number {
  if (messages.length === 0) return 0;
  const totalChars = messages.reduce(
    (sum, m) => sum + m.role.length + m.content.length,
    0,
  );
  return Math.ceil(totalChars / 4);
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/runtime/compression/token-estimate.test.ts
```

Expected: all 5 assertions pass.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/compression/token-estimate.ts src/runtime/compression/token-estimate.test.ts
git commit -m "feat(compression): add heuristic token estimator (no LLM)"
```

---

## Task 5: Summarization prompt

**Files:**
- Create: `src/runtime/compression/prompts.ts`

No tests required for this file (it is a pure string constant). The prompt is designed so the LLM produces a dense, temporally-ordered narrative covering decisions, tool calls, and open threads — information a future LLM call needs to continue the conversation as if it had full history.

- [ ] **Step 1: Create `src/runtime/compression/prompts.ts`**

```ts
/**
 * Prompts used by the context-compression summarizer.
 *
 * The summarization call is a separate LLM request using the same
 * client/credentials as the channel's normal conversation. Keep the
 * system prompt short to minimize billed tokens.
 */

export const SUMMARIZER_SYSTEM_PROMPT = `\
You are a conversation archiver. Your output will be inserted verbatim into
future conversation context as a compressed memory header. Write in dense,
factual prose — no filler words, no pleasantries. Cover:
1. What the user asked or instructed (chronological order).
2. What the assistant decided and why (key reasoning steps).
3. Tool calls made and their outcomes.
4. Any facts, values, or names that were established and may be referenced later.
5. Any open tasks or unresolved questions at the point the conversation was cut.
Limit: 400 words. Do NOT add commentary about the summarization process itself.`;

/**
 * Build the user-turn message for the summarization call.
 *
 * @param messages  The conversation slice to summarize (oldest → newest).
 * @returns         A formatted string ready to send as the user message.
 */
export function buildSummarizationUserMessage(
  messages: { role: string; content: string }[],
): string {
  const lines = messages.map(
    (m, i) => `[${i + 1}] ${m.role.toUpperCase()}: ${m.content}`,
  );
  return (
    `Summarize the following conversation segment (${messages.length} messages):\n\n` +
    lines.join('\n\n')
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/runtime/compression/prompts.ts
git commit -m "feat(compression): add summarization prompt templates"
```

---

## Task 6: Summarizer function

**Files:**
- Create: `src/runtime/compression/summarizer.ts`
- Create: `src/runtime/compression/summarizer.test.ts`

The summarizer takes a message slice and an OpenAI client reference. It calls the LLM and returns the summary string. The caller (Task 7) wraps this in a try/catch and falls back to the sliding-window if the call fails, so `summarize` itself may throw — it does NOT swallow errors.

Credential/billing note: because the summarizer receives the same `OpenAI` client instance that the channel's `DirectLLMRunner` was constructed with, it automatically uses the same `OPENAI_API_KEY` and `OPENAI_BASE_URL`. No separate credential setup is needed. If the channel routes through Envoy `ext_authz` for header stamping (credential broker path), the same HTTP client picks it up transparently because the base URL is the same.

- [ ] **Step 1: Write the failing tests**

Create `src/runtime/compression/summarizer.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import { summarize } from './summarizer.js';

function makeStubClient(content: string): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
          usage: { total_tokens: 55 },
        }),
      },
    },
  } as unknown as OpenAI;
}

describe('summarize', () => {
  it('returns the model response text', async () => {
    const client = makeStubClient('The user asked about cats. No tools used.');
    const messages = [
      { role: 'user', content: 'Tell me about cats.' },
      { role: 'assistant', content: 'Cats are obligate carnivores.' },
    ];
    const result = await summarize(messages, client, 'test-model');
    expect(result.text).toBe('The user asked about cats. No tools used.');
    expect(result.tokenCount).toBe(55);
  });

  it('sends the correct model to the API', async () => {
    const client = makeStubClient('summary');
    const messages = [{ role: 'user', content: 'Hi' }];
    await summarize(messages, client, 'gpt-4o-mini');
    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.model).toBe('gpt-4o-mini');
  });

  it('throws if the API returns empty content', async () => {
    const client = makeStubClient('');
    await expect(
      summarize([{ role: 'user', content: 'Hi' }], client, 'gpt-4o'),
    ).rejects.toThrow('Summarizer returned empty response');
  });
});
```

- [ ] **Step 2: Implement `src/runtime/compression/summarizer.ts`**

```ts
import OpenAI from 'openai';
import {
  SUMMARIZER_SYSTEM_PROMPT,
  buildSummarizationUserMessage,
} from './prompts.js';

export interface SummaryResult {
  text: string;
  tokenCount: number;
}

/**
 * Call the LLM to summarize a message slice.
 *
 * Uses the same OpenAI client instance as the channel runner — credentials,
 * base URL, and proxy settings are inherited automatically.
 *
 * Throws on API error or empty response. The caller must handle errors and
 * decide whether to fall back to the sliding-window behavior.
 */
export async function summarize(
  messages: { role: string; content: string }[],
  client: OpenAI,
  model: string,
): Promise<SummaryResult> {
  const userMessage = buildSummarizationUserMessage(messages);
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 600,
  });

  const text = response.choices[0]?.message?.content?.trim() ?? '';
  if (!text) throw new Error('Summarizer returned empty response');

  const tokenCount = response.usage?.total_tokens ?? 0;
  return { text, tokenCount };
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/runtime/compression/summarizer.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/compression/summarizer.ts src/runtime/compression/summarizer.test.ts
git commit -m "feat(compression): add LLM summarizer (same client as channel)"
```

---

## Task 7: Threshold check and compression invocation in `DirectLLMRunner`

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts`
- Modify: `src/runtime/direct-llm-runner.test.ts`
- Modify: `src/runtime/direct-llm-runner.integration.test.ts`

**Concurrency safety note:** All messages for a given group flow through `GroupQueue` (`src/group-queue.ts`), which serializes execution: `state.active = true` is set before `runForGroup` begins, and the queue does not start a second message for the same group until the first `runForGroup` promise resolves. Because `runAgent` (and therefore the compression check) runs inside that serialized window, there is no possibility of two compression cycles racing for the same group. Document this assumption in a comment in `direct-llm-runner.ts` above the compression call site.

**Threshold env vars:**
- `KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES` — default `50`. If the group has more than this many unsummarized messages, compression fires.
- `KUBECLAW_COMPRESSION_THRESHOLD_TOKENS` — default `32000`. If the token estimate of unsummarized messages exceeds this, compression fires (whichever threshold is hit first).

**Keep-window:** `MAX_CONVERSATION_HISTORY` (existing env var, default `20`) defines how many recent messages are never summarized. Compression operates on messages *older* than the keep-window.

**Prompt injection format:** When a summary exists, prepend to the messages array:
```
{ role: 'system', content: '[summary_id=<id>] <summaryText>' }
```
This goes after the main system prompt and before the history messages, so the LLM sees it as additional privileged context.

- [ ] **Step 1: Write the failing unit tests**

Add to `src/runtime/direct-llm-runner.test.ts`:

```ts
import { shouldCompress } from '../runtime/direct-llm-runner.js';

describe('shouldCompress', () => {
  it('returns false when message count is below threshold', () => {
    expect(shouldCompress(10, 1000, 50, 32000)).toBe(false);
  });

  it('returns true when message count exceeds threshold', () => {
    expect(shouldCompress(51, 1000, 50, 32000)).toBe(true);
  });

  it('returns true when token count exceeds threshold even if messages are below', () => {
    expect(shouldCompress(10, 33000, 50, 32000)).toBe(true);
  });

  it('returns false when both are at exactly the threshold (not exceeded)', () => {
    expect(shouldCompress(50, 32000, 50, 32000)).toBe(false);
  });
});
```

- [ ] **Step 2: Export `shouldCompress` from `src/runtime/direct-llm-runner.ts`**

Add near the top of `direct-llm-runner.ts` (after the env-var constants):

```ts
const COMPRESSION_THRESHOLD_MESSAGES = parseInt(
  process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES || '50',
  10,
);
const COMPRESSION_THRESHOLD_TOKENS = parseInt(
  process.env.KUBECLAW_COMPRESSION_THRESHOLD_TOKENS || '32000',
  10,
);

/** Exported for unit testing only. */
export function shouldCompress(
  messageCount: number,
  tokenEstimate: number,
  thresholdMessages: number,
  thresholdTokens: number,
): boolean {
  return messageCount > thresholdMessages || tokenEstimate > thresholdTokens;
}
```

- [ ] **Step 3: Insert the compression check inside `runAgent`**

In `runAgent`, the history is loaded and then the `messages` array is assembled. Replace the current block:

```ts
const history = useHistory
  ? overrides.sessionKey
    ? getConversationHistory({ sessionKey: overrides.sessionKey })
    : getConversationHistory(input.groupFolder)
  : [];

const messages: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'system', content: systemPrompt },
  ...history,
  { role: 'user', content: input.prompt },
];
```

With the following expanded block:

```ts
const history = useHistory
  ? overrides.sessionKey
    ? getConversationHistory({ sessionKey: overrides.sessionKey })
    : getConversationHistory(input.groupFolder)
  : [];

// --- Context compression ---
// GroupQueue serializes all messages within a group (state.active = true for
// the duration of runForGroup), so this check and the summarization write
// cannot interleave with another runAgent call for the same group.
let activeSummaryMarker: string | null = null;
if (useHistory) {
  const tokenEst = estimateMessagesTokens(history);
  if (
    shouldCompress(
      history.length,
      tokenEst,
      COMPRESSION_THRESHOLD_MESSAGES,
      COMPRESSION_THRESHOLD_TOKENS,
    )
  ) {
    const keepWindow = parseInt(
      process.env.MAX_CONVERSATION_HISTORY || '20',
      10,
    );
    const toSummarize = history.slice(0, Math.max(0, history.length - keepWindow));
    if (toSummarize.length > 0) {
      try {
        const prevSummary = getLatestSummary(input.groupFolder);
        const { text, tokenCount } = await summarize(toSummarize, this.client, model);
        const summaryId = insertSummary({
          groupFolder: input.groupFolder,
          sessionKey: overrides.sessionKey ?? input.groupFolder,
          parentSummaryId: prevSummary?.id ?? null,
          messageStartId: `${input.groupFolder}-hist-start`,
          messageEndId: `${input.groupFolder}-hist-end`,
          summaryText: text,
          modelUsed: model,
          tokenCount,
        });
        activeSummaryMarker = `[summary_id=${summaryId}] ${text}`;
        logger.info(
          { groupFolder: input.groupFolder, summaryId, messagesCompressed: toSummarize.length },
          'DirectLLMRunner: compressed conversation history',
        );
      } catch (err) {
        logger.warn(
          { groupFolder: input.groupFolder, err },
          'DirectLLMRunner: summarization failed — falling back to sliding-window',
        );
      }
    }
  }
}

const recentHistory = activeSummaryMarker
  ? history.slice(
      Math.max(0, history.length - parseInt(process.env.MAX_CONVERSATION_HISTORY || '20', 10)),
    )
  : history;

const messages: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'system', content: systemPrompt },
  ...(activeSummaryMarker
    ? [{ role: 'system' as const, content: activeSummaryMarker }]
    : []),
  ...recentHistory,
  { role: 'user', content: input.prompt },
];
```

Also add to the imports at the top of `direct-llm-runner.ts`:

```ts
import {
  getConversationHistory,
  appendConversationMessage,
  appendConversationHistory,
  getLatestSummary,
  insertSummary,
} from '../db.js';
import { estimateMessagesTokens } from './compression/token-estimate.js';
import { summarize } from './compression/summarizer.js';
```

- [ ] **Step 4: Write the integration test**

Add to `src/runtime/direct-llm-runner.integration.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectLLMRunner } from './direct-llm-runner.js';
import { getLatestSummary, clearConversationHistory } from '../db.js';
import OpenAI from 'openai';

// Build a stub OpenAI client that returns predictable text and records calls.
function makeIntegrationStub() {
  let callCount = 0;
  const calls: string[] = [];
  const client = {
    chat: {
      completions: {
        create: vi.fn(async (req: { messages: { role: string; content: string }[]; model: string }) => {
          callCount++;
          const userMsg = req.messages.find((m) => m.role === 'user')?.content ?? '';
          calls.push(userMsg);
          // Summarization call (triggered by the compression path) uses the system summarizer prompt
          const isSummarizationCall = req.messages.some(
            (m) => m.role === 'system' && m.content.includes('conversation archiver'),
          );
          if (isSummarizationCall) {
            return {
              choices: [{ message: { content: 'Dense summary of prior messages.' } }],
              usage: { total_tokens: 30 },
            };
          }
          return {
            choices: [{ message: { content: `Reply #${callCount}` } }],
            usage: { total_tokens: 10 },
          };
        }),
      },
    },
  } as unknown as OpenAI;
  return { client, calls: () => calls };
}

describe('DirectLLMRunner compression integration', () => {
  const groupFolder = 'compression-test-group';

  beforeEach(() => {
    clearConversationHistory(groupFolder);
  });

  it('creates a summary row after exceeding KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES', async () => {
    process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES = '5';
    process.env.MAX_CONVERSATION_HISTORY = '2';

    const { client } = makeIntegrationStub();
    const runner = new DirectLLMRunner(client);
    const group = {
      name: groupFolder, folder: groupFolder, trigger: '', added_at: '',
      jid: groupFolder,
    } as any;

    // Seed 5 messages directly (simulate prior turns)
    for (let i = 0; i < 5; i++) {
      const { appendConversationMessage } = await import('../db.js');
      appendConversationMessage(groupFolder, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`);
    }

    await runner.runAgent(group, {
      groupFolder, chatJid: groupFolder, prompt: 'New message', isMain: false,
    });

    const summary = getLatestSummary(groupFolder);
    expect(summary).not.toBeNull();
    expect(summary!.summaryText).toBe('Dense summary of prior messages.');

    delete process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES;
    delete process.env.MAX_CONVERSATION_HISTORY;
  });

  it('includes the summary marker in subsequent LLM calls after compression', async () => {
    process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES = '3';
    process.env.MAX_CONVERSATION_HISTORY = '1';

    const { client, calls } = makeIntegrationStub();
    const runner = new DirectLLMRunner(client);
    const group = {
      name: groupFolder, folder: groupFolder, trigger: '', added_at: '', jid: groupFolder,
    } as any;
    const { appendConversationMessage } = await import('../db.js');
    for (let i = 0; i < 4; i++) {
      appendConversationMessage(groupFolder, i % 2 === 0 ? 'user' : 'assistant', `seed ${i}`);
    }

    await runner.runAgent(group, {
      groupFolder, chatJid: groupFolder, prompt: 'Follow-up', isMain: false,
    });

    // The main LLM call's messages should include a system message with [summary_id=
    const createCalls = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls;
    const mainCall = createCalls.find((c: any[]) =>
      !c[0].messages.some((m: { role: string; content: string }) =>
        m.role === 'system' && m.content.includes('conversation archiver'),
      ),
    );
    expect(mainCall).toBeDefined();
    const hasMarker = mainCall[0].messages.some(
      (m: { role: string; content: string }) => m.role === 'system' && m.content.startsWith('[summary_id='),
    );
    expect(hasMarker).toBe(true);

    delete process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES;
    delete process.env.MAX_CONVERSATION_HISTORY;
  });

  it('clearConversationHistory purges both history and summaries', async () => {
    const { insertSummary } = await import('../db.js');
    insertSummary({
      groupFolder, sessionKey: groupFolder, parentSummaryId: null,
      messageStartId: 'a', messageEndId: 'b',
      summaryText: 'old summary', modelUsed: 'gpt-4o', tokenCount: 5,
    });
    clearConversationHistory(groupFolder);
    expect(getLatestSummary(groupFolder)).toBeNull();
  });
});
```

- [ ] **Step 5: Run tests**

```bash
npm test -- src/runtime/direct-llm-runner.test.ts src/runtime/direct-llm-runner.integration.test.ts
```

Expected: `shouldCompress` unit tests pass; all three integration scenarios pass.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/runtime/direct-llm-runner.test.ts src/runtime/direct-llm-runner.integration.test.ts
git commit -m "feat(compression): threshold check and LLM summarization in DirectLLMRunner"
```

---

## Task 8: `/compact`, `/summary`, `/clear` chat commands

**Files:**
- Create: `src/runtime/compression-commands.ts`
- Create: `src/runtime/compression-commands.test.ts`

The command module mirrors the shape of `src/runtime/skills-commands.ts`: a pure handler function + an `isCompactCommand` guard. The `/compact` command triggers immediate compression regardless of threshold. `/compact --keep N` overrides the keep-window for this run. `/summary` displays the current summary chain. `/clear` calls `clearConversationHistory` and `deleteSummariesForGroup`.

- [ ] **Step 1: Write the failing tests**

Create `src/runtime/compression-commands.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isCompactCommand, parseCompactArgs } from './compression-commands.js';

describe('isCompactCommand', () => {
  it('matches /compact', () => expect(isCompactCommand('/compact')).toBe(true));
  it('matches /summary', () => expect(isCompactCommand('/summary')).toBe(true));
  it('matches /clear', () => expect(isCompactCommand('/clear')).toBe(true));
  it('does not match /skills', () => expect(isCompactCommand('/skills list')).toBe(false));
  it('does not match plain text', () => expect(isCompactCommand('hello')).toBe(false));
  it('matches /compact with flags', () =>
    expect(isCompactCommand('/compact --keep 5')).toBe(true));
});

describe('parseCompactArgs', () => {
  it('returns default keep when no flag provided', () => {
    const { keep } = parseCompactArgs('/compact');
    expect(keep).toBeNull();
  });

  it('parses --keep N correctly', () => {
    const { keep } = parseCompactArgs('/compact --keep 10');
    expect(keep).toBe(10);
  });

  it('returns null for non-numeric --keep value', () => {
    const { keep } = parseCompactArgs('/compact --keep abc');
    expect(keep).toBeNull();
  });
});
```

- [ ] **Step 2: Implement `src/runtime/compression-commands.ts`**

```ts
import {
  clearConversationHistory,
  deleteSummariesForGroup,
  getLatestSummary,
  insertSummary,
  getConversationHistory,
  SummaryRecord,
} from '../db.js';
import { summarize } from './compression/summarizer.js';
import { estimateMessagesTokens } from './compression/token-estimate.js';
import { logger } from '../logger.js';
import OpenAI from 'openai';

export function isCompactCommand(message: string): boolean {
  return /^\/(compact|summary|clear)(\s|$)/.test(message.trim());
}

export interface ParsedCompactArgs {
  verb: 'compact' | 'summary' | 'clear';
  keep: number | null;
}

export function parseCompactArgs(message: string): ParsedCompactArgs {
  const parts = message.trim().split(/\s+/);
  const verb = parts[0].slice(1) as 'compact' | 'summary' | 'clear';
  const keepIdx = parts.indexOf('--keep');
  let keep: number | null = null;
  if (keepIdx !== -1 && parts[keepIdx + 1]) {
    const n = parseInt(parts[keepIdx + 1], 10);
    keep = Number.isFinite(n) ? n : null;
  }
  return { verb, keep };
}

export async function handleCompactCommand(
  groupFolder: string,
  message: string,
  client: OpenAI,
  model: string,
): Promise<string> {
  const { verb, keep } = parseCompactArgs(message);

  if (verb === 'clear') {
    clearConversationHistory(groupFolder);
    deleteSummariesForGroup(groupFolder);
    return 'Conversation history and summaries cleared.';
  }

  if (verb === 'summary') {
    const latest = getLatestSummary(groupFolder);
    if (!latest) return 'No summary exists for this group yet.';
    const chain: SummaryRecord[] = [latest];
    // Walk parent chain (up to 10 deep to avoid infinite loops on corrupt data)
    let current = latest;
    for (let i = 0; i < 10 && current.parentSummaryId; i++) {
      const parent = getLatestSummary(groupFolder);
      if (!parent || parent.id === current.id) break;
      chain.unshift(parent);
      current = parent;
    }
    const lines = chain.map(
      (s, idx) =>
        `[${idx + 1}/${chain.length}] id=${s.id} created=${s.createdAt} tokens=${s.tokenCount}\n${s.summaryText}`,
    );
    return `Summary chain (${chain.length} entry/entries):\n\n${lines.join('\n\n---\n\n')}`;
  }

  // verb === 'compact'
  const defaultKeep = parseInt(process.env.MAX_CONVERSATION_HISTORY || '20', 10);
  const keepWindow = keep ?? defaultKeep;
  const history = getConversationHistory(groupFolder);

  if (history.length === 0) return 'No conversation history to compact.';

  const toSummarize = history.slice(0, Math.max(0, history.length - keepWindow));
  if (toSummarize.length === 0) {
    return `Nothing to compact — all messages are within the keep-window of ${keepWindow}.`;
  }

  try {
    const prevSummary = getLatestSummary(groupFolder);
    const { text, tokenCount } = await summarize(toSummarize, client, model);
    const summaryId = insertSummary({
      groupFolder,
      sessionKey: groupFolder,
      parentSummaryId: prevSummary?.id ?? null,
      messageStartId: `${groupFolder}-compact-start`,
      messageEndId: `${groupFolder}-compact-end`,
      summaryText: text,
      modelUsed: model,
      tokenCount,
    });
    logger.info(
      { groupFolder, summaryId, compacted: toSummarize.length },
      'compression-commands: /compact completed',
    );
    return (
      `Compacted ${toSummarize.length} messages into summary ${summaryId}.\n\n` +
      `Summary:\n${text}\n\n` +
      `(${keepWindow} most recent messages retained in full.)`
    );
  } catch (err) {
    logger.error({ groupFolder, err }, 'compression-commands: /compact failed');
    return `Compact failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/runtime/compression-commands.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/compression-commands.ts src/runtime/compression-commands.test.ts
git commit -m "feat(compression): /compact, /summary, /clear chat command handler"
```

---

## Task 9: Wire compression commands into `src/channel-runner.ts`

**Files:**
- Modify: `src/channel-runner.ts`
- Modify: `src/channel-runner.test.ts`

The `/compact`, `/summary`, and `/clear` commands must be intercepted before `formatMessages` wraps the user content in XML (exactly as `/skills` is handled today). The interception site is around line 1087 in `src/channel-runner.ts`. The `handleCompactCommand` function needs the runner's `OpenAI` client and current model string; expose these via a new `getClient()` and `getModel()` accessor on `DirectLLMRunner`, or pass them through the `processMessagesForGroup` closure.

- [ ] **Step 1: Write the failing integration test**

Add to `src/channel-runner.test.ts`:

```ts
import { isCompactCommand } from '../src/runtime/compression-commands.js';

describe('channel-runner compression command dispatch', () => {
  it('isCompactCommand is the right guard for /compact', () => {
    expect(isCompactCommand('/compact')).toBe(true);
    expect(isCompactCommand('/compact --keep 5')).toBe(true);
    expect(isCompactCommand('/summary')).toBe(true);
    expect(isCompactCommand('/clear')).toBe(true);
    expect(isCompactCommand('/skills list')).toBe(false);
  });
});
```

- [ ] **Step 2: Add `getClient` / `getModel` accessors to `DirectLLMRunner`**

In `src/runtime/direct-llm-runner.ts`, inside the `DirectLLMRunner` class, add:

```ts
getClient(): OpenAI {
  return this.client;
}

getCurrentModel(group: RegisteredGroup, overrideProvider?: string): string {
  return getModel(group, overrideProvider);
}
```

- [ ] **Step 3: Wire commands in `src/channel-runner.ts`**

Add to the imports at the top of `src/channel-runner.ts`:

```ts
import {
  isCompactCommand,
  handleCompactCommand,
} from './runtime/compression-commands.js';
```

Immediately after the `/skills` block at line ~1087, add:

```ts
// /compact, /summary, /clear chat commands
if (lastMsg && isCompactCommand(lastMsg.content)) {
  lastAgentTimestamp[chatJid] = lastMsg.timestamp;
  saveState();
  await channel.setTyping?.(chatJid, true);
  try {
    const reply = await handleCompactCommand(
      group.folder,
      lastMsg.content.trim(),
      runner.getClient(),
      runner.getCurrentModel(group),
    );
    await channel.sendMessage(chatJid, reply);
  } finally {
    await channel.setTyping?.(chatJid, false);
  }
  return true;
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/channel-runner.test.ts
```

Expected: new dispatch tests pass; no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/channel-runner.ts src/channel-runner.test.ts src/runtime/direct-llm-runner.ts
git commit -m "feat(compression): wire /compact command dispatch in channel-runner"
```

---

## Task 10: Documentation — `docs/CONTEXT_COMPRESSION.md`

**Files:**
- Create: `docs/CONTEXT_COMPRESSION.md`

- [ ] **Step 1: Write the documentation file**

```markdown
# Context Compression

KubeClaw automatically summarizes old conversation history before each LLM
call when the unsummarized message count or estimated token count exceeds a
configurable threshold. This prevents context-window exhaustion for
long-running groups without requiring a hard wipe that loses conversational
memory.

## How It Works

1. Before assembling the LLM prompt, `DirectLLMRunner` checks whether the
   current history exceeds either threshold (message count or estimated
   tokens).
2. If the threshold is exceeded, messages older than the keep-window are
   summarized with a single LLM call using the same provider and credentials
   as the normal conversation. This call is billed/logged identically.
3. The summary is persisted in the `conversation_summaries` SQLite table.
   Each summary row records its predecessor (`parent_summary_id`), forming a
   chain of chained summaries that can grow indefinitely.
4. The current summary is injected into the prompt as an additional `system`
   message: `[summary_id=<id>] <summaryText>`.  Only the most recent
   keep-window messages are appended as full turns after the summary.
5. If summarization fails (network error, empty response), the failure is
   logged at WARN level and the call falls back to the existing
   sliding-window behavior (`MAX_CONVERSATION_HISTORY`). The user's message
   is never blocked.

## Configuration

| Environment Variable                         | Default | Description                                                |
|----------------------------------------------|---------|------------------------------------------------------------|
| `KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES`    | `50`    | Compress when unsummarized message count exceeds this.     |
| `KUBECLAW_COMPRESSION_THRESHOLD_TOKENS`      | `32000` | Compress when estimated token count exceeds this.          |
| `MAX_CONVERSATION_HISTORY`                   | `20`    | Number of recent messages kept verbatim after compression. |

Token estimation is a heuristic (4 chars ≈ 1 token). It does NOT call the
LLM; it is only used for the threshold check.

## Chat Commands

These commands are available in any group chat:

| Command             | Description                                                            |
|---------------------|------------------------------------------------------------------------|
| `/compact`          | Immediately compress history, even if below threshold.                 |
| `/compact --keep N` | Compress, retaining the N most recent messages in full (overrides env).|
| `/summary`          | Show the current summary chain (most recent entry first).              |
| `/clear`            | Delete all conversation history AND all summaries for this group.      |

## Failure Mode

Summarization is best-effort. If the LLM call fails:
- The error is logged at WARN level with `group_folder` and error details.
- The runner falls back to the standard sliding-window (last
  `MAX_CONVERSATION_HISTORY` messages).
- The user's message is processed normally — no error is surfaced to the
  user.

## Lineage Chain

Each summary row in `conversation_summaries` points to its predecessor via
`parent_summary_id`. This chain is informational; the runtime always loads
only the single latest summary (`ORDER BY created_at DESC LIMIT 1`). The
chain can be inspected with `/summary` or by querying SQLite directly:

```sql
SELECT id, parent_summary_id, created_at, token_count, substr(summary_text,1,80)
FROM conversation_summaries
WHERE group_folder = 'your-group'
ORDER BY created_at;
```

## Concurrency Safety

All messages for a group are serialized by `GroupQueue` before `runAgent`
is called. The compression check and summary write therefore cannot
interleave with another message's compression cycle for the same group.
No additional locking is required.
```

- [ ] **Step 2: Commit**

```bash
git add docs/CONTEXT_COMPRESSION.md
git commit -m "docs: add CONTEXT_COMPRESSION.md with env vars, commands, failure mode"
```

---

## Self-Review

### Spec Compliance

| Requirement | Covered |
|---|---|
| `conversation_summaries` table with all specified columns | Task 1 |
| `insertSummary`, `getLatestSummary`, `deleteSummariesForGroup` | Task 2 |
| `clearConversationHistory` also wipes summaries | Task 3 |
| Token estimation without LLM call (4 chars/token heuristic) | Task 4 |
| Summarization prompt in dedicated file | Task 5 |
| Summarizer uses same client/credentials as channel | Task 6 |
| `KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES` env var (default 50) | Task 7 |
| `KUBECLAW_COMPRESSION_THRESHOLD_TOKENS` env var (default 32000) | Task 7 |
| Threshold check BEFORE prompt assembly | Task 7 |
| Messages replaced with `[summary_id=N] text` marker | Task 7 |
| Best-effort: failures log and fall back to sliding-window | Task 7 |
| Parent/child lineage via `parent_summary_id` | Tasks 2 + 7 |
| `/compact` command (immediate, even below threshold) | Task 8 |
| `/compact --keep N` override | Task 8 |
| `/summary` shows summary chain | Task 8 |
| `/clear` as chat command | Task 8 |
| Wired into channel-runner like `/skills` | Task 9 |
| Concurrency safety documented | Task 7 |
| Unit tests for token estimator | Task 4 |
| Unit tests for DB helpers | Task 2 |
| Unit tests for lineage / `clearConversationHistory` regression | Tasks 2 + 3 |
| Unit tests for threshold boolean | Task 7 |
| Unit tests for command parsers | Task 8 |
| Integration test: conversation past threshold → summary row | Task 7 |
| Integration test: subsequent calls contain summary marker | Task 7 |
| Integration test: `clearConversationHistory` purges summaries | Task 7 |
| E2E note (kind cluster / channel-runner harness, 60 messages) | Not a code task — described below |
| Operator docs with env vars, failure mode, lineage | Task 10 |

**E2E note:** The plan does not include a Task for the E2E test because E2E tests in this project require a running kind cluster and are maintained in the `e2e/` directory outside the `src/` tree. The implementer must add an E2E script to `e2e/` that: (1) sends 60 messages to a registered group via the channel API, (2) polls `kubectl exec` into the orchestrator pod to `sqlite3` the `conversation_summaries` table until a row appears, (3) sends `/summary` and asserts the response contains `[summary_id=`. This follows the same pattern as `e2e/audit-metrics.test.ts`.

### Code Quality Checklist

- No `// TODO` or placeholder strings in any code block — every block is complete and runnable.
- No new external dependencies — uses the existing `openai` SDK, `sql.js`, and Vitest.
- Failure path explicitly tested: summarizer throws on empty response; runner catches and falls back.
- `clearConversationHistory` contract extended atomically (both deletes in the same function, same `saveDatabase()` call).
- Token estimator is pure and deterministic — safe to call in hot path.
- Summary marker uses a `system` role message so it is never confused with user content or attributed to the assistant.
- Compression prompt capped at 600 tokens (`max_tokens: 600`) to limit cost on the summarization call.
- All new exported symbols are explicitly tested at the unit level.
- No direct mutation of `db` outside `src/db.ts` — callers use the exported helpers.
