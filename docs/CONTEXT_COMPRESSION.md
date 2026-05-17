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
