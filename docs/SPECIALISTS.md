# Specialist Agents

KubeClaw supports **specialist sub-agents** addressable by `@mention`. Unlike the old per-group `agents.json` model, specialists are now defined in a **cluster-wide global catalog** — declare a specialist once and every group can invoke it.

Specialists run in-process inside the channel pod (Path A), not as separate tool jobs. Mentioned specialists execute in parallel via `Promise.allSettled`, so one specialist's failure does not abort the others. Each reply is prefixed with `[@Name]`.

> **Migration note:** existing `groups/{group}/agents.json` files are silently ignored as of this release. See `docs/legacy-specialists-architecture.md` for the old model.

---

## Registering Specialists

### Option 1: Helm `values.yaml` (baseline)

Add a `specialists` array to your `values.yaml` before deploying or upgrading:

```yaml
specialists:
  - name: Research
    prompt: >
      You are a research specialist. Find and analyse information from
      authoritative sources. Cite every claim.
    triggers:
      - "@Researcher"
      - "@Analysis"
    llmProvider: claude
    memory:
      isolated: false

  - name: Helper
    prompt: Answer questions concisely and accurately.
    llmProvider: openrouter
    memory:
      isolated: true
    tools:
      - web_search
      - fetch_url
```

The Helm chart renders these into the `kubeclaw-specialists-baseline` ConfigMap, which the orchestrator reconciler picks up and merges into `kubeclaw-specialists`.

### Option 2: Admin shell at runtime

Connect to the admin shell and call `register_specialist`:

```
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- node dist/admin-shell.js
```

Then in the shell:

```
register_specialist({
  name: "Editor",
  prompt: "You are a writing editor. Improve clarity and concision without changing meaning.",
  memory: { isolated: true }
})
```

> **Caveat:** The `register_specialist` IPC tool is wired end-to-end through the `specialist_overrides` SQLite table and the reconciler, but the underlying K8s ConfigMap apply helper is currently deferred. Until that is shipped, `register_specialist` persists the override in SQLite and the reconciler will include it on the next reconcile cycle (triggered by orchestrator restart or the next Helm upgrade). Admin-shell overrides **always win** over the Helm baseline (see _Merge precedence_ below).

---

## Schema

Full field reference: `docs/superpowers/specs/2026-05-16-global-specialist-catalog-design.md`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Display name; used for `@mentions`. E.g. `"Research"`. |
| `prompt` | string | yes | System prompt for this specialist. |
| `triggers` | string[] | no | Additional `@-mention` aliases, case-insensitive. |
| `llmProvider` | string | no | Override the LLM provider for this specialist (e.g. `"claude"`, `"openrouter"`). Omit to inherit the group's default. |
| `memory.isolated` | boolean | no | If `true`, specialist gets its own `session_key` (`groupfolder:SpecialistName`) and does not see group conversation history. Defaults to `false`. |
| `claudemd` | string | no | Extra content appended to the system prompt. |
| `tools` | string[] | no | Allowlist of tool names. When set, the specialist can only call listed tools. |

---

## Dispatch

### Triggering specialists

Mention one or more specialists in any message:

```
@Research find recent AI safety papers
@Helper format this JSON for me
@Research summarise @Helper clean up the output
```

The `@mention` parser scans the message for names that match the `name` or `triggers` fields (case-insensitive, leading `@` stripped). All matched specialists run in parallel.

### Parallel execution

Dispatch uses `Promise.allSettled`, so:

- All mentioned specialists run concurrently.
- A failure in one specialist does not prevent others from responding.
- Each specialist's reply is sent to the group with a `[@Name]` prefix so the user can tell them apart.

### Fallback

If no specialists are mentioned, the main group agent runs as normal.

---

## Per-Specialist Features

### `llmProvider` — cost optimisation

Route expensive specialists to capable models and cheap specialists to fast, low-cost ones:

```yaml
specialists:
  - name: Expert
    prompt: Solve complex problems with deep analysis.
    llmProvider: claude          # Claude Opus — capable but expensive

  - name: Helper
    prompt: Answer simple questions quickly.
    llmProvider: openrouter      # Cheap/fast model for simple tasks
```

When `llmProvider` is omitted, the group's configured provider is used.

### `memory.isolated` — stateless specialists

By default, specialists share the group's conversation history. Set `memory.isolated: true` for specialists that should start each invocation with a clean slate:

```yaml
- name: FAQ
  prompt: Answer questions concisely. Be friendly.
  memory:
    isolated: true
```

Isolation is real: `conversation_history` rows are scoped by `session_key`. An isolated specialist's `session_key` is `groupfolder:SpecialistName`, completely separate from the group's `session_key`. No history leaks between them.

Use isolation for:
- Stateless helpers (formatters, validators, Q&A bots)
- Preventing context-window bloat from long group histories
- Specialists that must not see previous group turns

### `tools` — hardening via allowlist

Restrict which tools a specialist can call:

```yaml
- name: Summariser
  prompt: Summarise the provided text.
  tools:
    - fetch_url
```

A specialist with a `tools` allowlist cannot call anything outside that list, even if the channel pod has broader tool permissions. Omit `tools` to apply no restriction.

---

## Merge Precedence

The orchestrator reconciler merges two sources into the `kubeclaw-specialists` ConfigMap:

1. **Helm baseline** — from `kubeclaw-specialists-baseline` ConfigMap (rendered from `values.yaml`)
2. **Admin-shell overrides** — from the `specialist_overrides` SQLite table on the orchestrator

**Admin-shell overrides win on conflict.** If both sources define a specialist with the same `name`, the admin-shell version is used in full. This lets operators patch individual specialists at runtime without redeploying Helm.

---

## Troubleshooting

### Inspect the merged ConfigMap

```bash
kubectl get cm kubeclaw-specialists -n kubeclaw \
  -o jsonpath='{.data.specialists\.json}' | jq .
```

This shows the exact list of specialists currently visible to all channel pods.

### Check specialist_usage telemetry

Each channel pod records every specialist dispatch in its local SQLite database:

```bash
# Get the channel pod name
kubectl get pods -n kubeclaw -l component=channel

# Open the SQLite shell
kubectl exec -it <channel-pod> -n kubeclaw -- \
  sqlite3 /data/kubeclaw.db "SELECT * FROM specialist_usage ORDER BY created_at DESC LIMIT 20;"
```

Columns: `id`, `group_folder`, `specialist_name`, `session_key`, `duration_ms`, `status` (`success` or `error`), `error_message`, `created_at`.

### Specialist not responding

1. Check the merged ConfigMap (above) to confirm the specialist is registered.
2. Verify the `@mention` matches the `name` or a `triggers` entry (case-insensitive).
3. Check channel pod logs for dispatch errors:
   ```bash
   kubectl logs -l component=channel -n kubeclaw --tail=100 | grep -i specialist
   ```
4. Check `specialist_usage` — if `status = 'error'`, `error_message` has the reason.

### ConfigMap not updating after `register_specialist`

The K8s ConfigMap apply step is deferred (see caveat in _Option 2_ above). Restart the orchestrator to trigger an immediate reconcile:

```bash
kubectl rollout restart deployment/kubeclaw-orchestrator -n kubeclaw
```

---

## See Also

- `docs/legacy-specialists-architecture.md` — old `agents.json`-based model (preserved for reference)
- `docs/superpowers/specs/2026-05-16-global-specialist-catalog-design.md` — full design and field reference
- `src/specialists/types.ts` — `GlobalSpecialist` interface
- `src/specialists/catalog-loader.ts` — channel-side ConfigMap loader
- `src/specialists/reconciler.ts` — orchestrator-side reconciler
