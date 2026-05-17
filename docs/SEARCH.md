# Conversation History Search

KubeClaw stores every conversation message in SQLite. The `/search` command
lets you query that history using full-text search, backed by SQLite FTS4.

## Basic usage

```
/search <query>
```

Returns up to 10 results, most recent first, with a highlighted snippet
showing the matched term in `[brackets]`.

## Flags

| Flag | Description |
|------|-------------|
| `--limit N` | Return at most N results (max 50, default 10) |
| `--since YYYY-MM[-DD]` | Only show messages on or after this date |
| `--before YYYY-MM[-DD]` | Only show messages on or before this date |

Flags can be combined:

```
/search --limit 5 --since 2026-04 kubernetes
/search --before 2026-03 deployment error
```

## Examples

```
/search redis                          # Find any mention of "redis"
/search --limit 3 error               # Top 3 most recent error mentions
/search --since 2026-05 sidecar       # Sidecar mentions from May 2026 onward
/search --since 2026-04 --before 2026-05 helm
```

## Result format

Each result line is formatted as:

```
[N] [YYYY-MM-DD] You|Assistant: ...snippet with [matched term] highlighted...
```

## Limitations

- **Per-group scope only.** Each channel group searches only its own history.
  Cross-group or cross-specialist search is not supported.
- **Exact token matching.** The underlying engine is SQLite FTS4 with the
  default tokeniser. Stemming and fuzzy matching are not available. The query
  `deploy` will not match `deployment` unless you search `deploy*`.
- **No ranking.** Results are ordered by `created_at DESC`, not by relevance
  score. BM25 ranking requires FTS5 which is not compiled into the sql.js
  WASM bundle used by kubeclaw.
- **Content only.** Only the `content` column is indexed. Sender, role, and
  session metadata are not searchable terms.
- **Wipe is permanent.** After `/clear` (or the admin-shell `clear_conversation`
  tool), history rows and their FTS index entries are deleted. Deleted messages
  cannot be recovered.
