# Installer Skills Cleanup — Design

## Goal

Remove all Claude Code skills that overlap with runtime install/sync concerns. After this change, `.claude/skills/` contains only dev-time concerns (code customization, K8s debugging, code review). All channel installation flows through the orchestrator's admin shell; capability installation flows through Helm values.

## Background

The `.claude/skills/add-*` slash commands were originally interactive walkthroughs for installing channels and capabilities. A previous round of work converted them to one-line stubs that redirect to runtime paths:
- Channels → admin shell `setup_channel` tool (real, working)
- Capabilities → "the orchestrator" (no runtime path exists; capabilities are Helm-only)

The redirects also promised a chat-command path (`send /add-telegram to the main group`) that was never implemented. The result is 16 stub Claude skills + one orphaned dev-time skill (`update-nanoclaw`) that all sit awkwardly between dev-time and runtime — none of them executes useful logic, but their presence implies an installer surface that doesn't fully exist.

This change removes the stubs entirely. The canonical install paths become explicit:

| To install | Use |
|---|---|
| A channel (Telegram, Slack, etc.) | Orchestrator admin shell `setup_channel` tool (TTY or HTTP UI) |
| A capability (RAG, image-vision, MCP server) | Edit `helm/kubeclaw/values.yaml` `capabilities:` / `mcpServers:` map; `helm upgrade` |
| A brand-new channel TYPE (writing the TS code) | Dev-time `/customize` Claude skill |

## Design decisions

Four design forks resolved during brainstorming:

1. **Installer entry point: admin shell only.** Chat-command path (`@assistant /add-X`) ruled out — credential-in-chat-history threat model and the lack of a good UX for multi-step credential flows (Slack OAuth, IRC server config, OIDC discovery) made it the wrong surface. Admin shell already has the agentic-LLM loop that handles multi-step input well.

2. **Capabilities stay Helm-only.** Capabilities are global, set-once, infrequent. A runtime install path for them would duplicate Helm's reconciliation without a matching usage pattern. Operators who add capabilities are already comfortable with `helm upgrade`.

3. **Stub `.claude/skills/add-*` files: delete entirely.** Not collapsed into a single `/install` skill, not kept as one-liners. Cleanest break with the previous redirect-stub pattern.

4. **No new admin-shell lifecycle tools in this change.** `remove_channel` and `rotate_credentials` are real gaps but explicitly out of scope — they're a separate worthwhile initiative with their own design considerations (PVC retention semantics, audit, etc.).

5. **Drop `/update-kubeclaw`.** Originally retained as a dev-time fork-sync workflow, but per user decision the migration concerns and downstream-fork story are dropped. Forks deal with merges themselves; the CHANGELOG `[BREAKING]` parsing convention is no longer load-bearing.

## Scope

### Deletions — 17 `.claude/skills/` directories

Channel installers (9):
- `add-discord/`
- `add-gmail/`
- `add-http/`
- `add-irc/`
- `add-signal/`
- `add-slack/` (includes `SLACK_SETUP.md`)
- `add-telegram/`
- `add-telegram-swarm/`
- `add-whatsapp/`

Capability installers (5):
- `add-image-vision/`
- `add-ollama-tool/`
- `add-parallel/`
- `add-pdf-reader/`
- `add-voice-transcription/`

Other installer-shaped (2):
- `x-integration/` (X/Twitter — no runtime path ever existed; nothing to migrate to)
- `use-local-whisper/` (capability-shaped; values.yaml path documented in `docs/ADDING_A_CHANNEL.md`)

Dev-time fork-sync (1):
- `update-nanoclaw/` (slash-command name `/update-kubeclaw`; per user decision)

### Edits — 3 files

1. **`.claude/skills/customize/SKILL.md`** — currently the menu/router that branches into the (now-deleted) `/add-*` skills. Refocus to genuine dev-time work only: writing a brand-new channel type (the TypeScript in `src/channels/`), modifying the router or triggers, adding custom orchestrator behavior. Replace the "add channels" branch with a one-line pointer: "To install an existing channel, use the orchestrator admin shell. To install a capability, edit `helm/kubeclaw/values.yaml`."

2. **`docs/ADDING_A_CHANNEL.md`** — rewrite around the new canonical paths:
   - Section A: "Install an existing channel" — admin shell `setup_channel` walkthrough (TTY mode and HTTP UI, what credentials each channel type needs, how `instanceName` enables multi-instance setups including the Telegram-swarm pattern)
   - Section B: "Install a capability" — `helm/kubeclaw/values.yaml` examples for each previously-supported capability (`image-vision`, `pdf-reader`, `ollama-tool`, `voice-transcription`, `parallel`, `use-local-whisper`) under `capabilities:` or `mcpServers:` as appropriate
   - Section C: "Add a brand-new channel type" — pointer to `/customize`

3. **`skills/README.md`** — verify the bucket descriptions don't reference Claude-skill installers as a runtime path; tighten if needed.

### No code changes

- `src/skills/orchestrator/channel-setup.ts` already exposes `setupChannel()` with the right shape.
- `src/admin-shell.ts` already exposes `setup_channel` as an LLM tool that calls `setupChannel()`.
- No new admin-shell tools (per scope decision 4).

### Special-case notes for the implementer

- **`add-telegram-swarm`**: existing functionality (multiple Telegram bots) is preserved by calling `setup_channel` N times with distinct `instanceName` values. `docs/ADDING_A_CHANNEL.md` Section A must call this out so the swarm use case isn't lost in the deletion.
- **`x-integration`**: no functionality is being removed (the redirect pointed to nothing functional). No replacement guidance is needed; if a user wants X support they go through `/customize` to add a brand-new channel type.
- **`use-local-whisper`**: capability path. Document the values.yaml shape (likely a `capabilities:` entry pointing at a Whisper model server image) in `docs/ADDING_A_CHANNEL.md` Section B.
- The Helm values examples in Section B should be COMPLETE enough to copy-paste — image, port, env vars, resource sizing — not just `# add a capability here`. The deleted skills used to walk operators through these decisions; the docs need to absorb that responsibility.

## Testing

No new code, no new tests. Verification is documentation review:

1. After deletions, `ls .claude/skills/` returns exactly 4 directories: `customize`, `debug`, `qodo-pr-resolver`, `get-qodo-rules`.
2. `git grep "/add-telegram\|/add-discord\|/add-slack\|/add-whatsapp\|/add-irc\|/add-signal\|/add-gmail\|/add-http\|/add-telegram-swarm\|/add-image-vision\|/add-pdf-reader\|/add-ollama-tool\|/add-voice-transcription\|/add-parallel\|/x-integration\|/use-local-whisper\|/update-kubeclaw\|/update-nanoclaw"` returns no matches outside the deleted directories themselves and possibly historical CHANGELOG entries.
3. `helm template helm/kubeclaw` still renders cleanly (defensive — no template should reference these skills, but confirm).
4. Existing admin-shell tests at `src/admin-shell.test.ts` still pass — no changes to install path under test.
5. Manual smoke: open admin shell HTTP UI (`http://localhost:$ADMIN_HTTP_PORT`), confirm `setup_channel` is still listed in the LLM tool list and a dry walk-through reaches the credential-collection step.

## Out of scope (explicit non-goals)

- Building chat-command handlers (`@assistant /add-X`).
- Building runtime install paths for capabilities.
- Adding `remove_channel`, `rotate_credentials`, or any other channel-lifecycle tools to admin shell.
- CHANGELOG `[BREAKING]` entry / downstream-fork migration story.
- Any change to `customize`, `debug`, `qodo-pr-resolver`, `get-qodo-rules` beyond removing `/add-*` references in `customize`.
- Adding the missing `oauth-webchat` Claude installer skill (the runtime channel skill exists; per this design, no Claude installer should be added).

## Risk

The change is mechanical: 17 directory deletions and 3 doc edits. No runtime code changes. Lowest-risk failure modes:
- A doc somewhere references a deleted slash command and is missed in the grep sweep — surfaces as broken instructions for a user, fixable with a follow-up edit.
- An operator with muscle memory types `/add-telegram` and gets "command not found" — solvable by reading `docs/ADDING_A_CHANNEL.md`.

No data loss, no behavior change in the running orchestrator, no Helm template regression possible.
