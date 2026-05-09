---
name: customize
description: Add new channel types (TypeScript), modify orchestrator behavior, change triggers, or make any other source-code customization. Use when the change requires writing or modifying TypeScript. For installing an existing channel (Telegram, Slack, etc.) or a capability, point the user at docs/INSTALLING_A_CHANNEL.md instead.
---

# KubeClaw Customization

Use AskUserQuestion to understand what the user wants before making changes. **Before doing anything, check whether the request is actually a code customization or just an installation.**

## First, check whether this is the right skill

| User intent | Use this skill? | Where to send them |
|---|---|---|
| "Install Telegram / Slack / Discord / WhatsApp / IRC / Signal / Gmail / HTTP / oauth-webchat" | No | `docs/INSTALLING_A_CHANNEL.md` (admin shell) |
| "Install a model server / MCP server / Whisper / Ollama" | No | `docs/INSTALLING_A_CHANNEL.md` (Helm values) |
| "Add a brand-new channel type that doesn't exist yet" | Yes | This skill |
| "Add an inline preprocessing capability (image vision, pdf-reader, voice transcription)" | Yes | This skill |
| "Change the trigger word / persona / response style" | Yes | This skill |
| "Add a custom command / router rule" | Yes | This skill |
| "Modify deployment / K8s manifests" | Yes | This skill (or direct Helm edits) |

If the request is in the No row, tell the user to read `docs/INSTALLING_A_CHANNEL.md` and stop.

## Workflow

1. **Understand the request** — Ask clarifying questions
2. **Plan the changes** — Identify files to modify
3. **Implement** — Make changes directly to the code
4. **Test guidance** — Tell the user how to verify

## Key files

| File | Purpose |
|---|---|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/channels/index.ts` | Barrel file — import each channel here so it self-registers |
| `src/channels/{name}.ts` | A channel implementation (see `src/channels/telegram.ts` for reference) |
| `src/k8s/ipc-redis.ts` | Redis IPC watcher and task processing |
| `src/k8s/job-runner.ts` | Manages pod lifecycles and tool job creation |
| `src/router.ts` | Message formatting and outbound routing |
| `src/types.ts` | TypeScript interfaces (includes `Channel`) |
| `src/config.ts` | Assistant name, trigger pattern, paths |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

See `docs/ADDING_A_CHANNEL.md` for the `Channel` interface contract, JID conventions, capability declarations, and the plugin contract before writing a new channel type.

## Common customization patterns

### Adding a brand-new channel type

For installing an EXISTING channel, send the user to `docs/INSTALLING_A_CHANNEL.md`. Only continue here if they want a channel type that does not exist yet (e.g., a custom messaging platform).

Questions to ask:
- What platform? (SDK / API to use)
- What does a JID look like for that platform? (must follow `<channel>:<id>` format)
- Same trigger word or different?

Implementation pattern (full contract in `docs/ADDING_A_CHANNEL.md`):
1. Create `src/channels/{name}.ts` implementing the `Channel` interface from `src/types.ts` (use `src/channels/telegram.ts` as reference)
2. Add `import './{name}.js'` to `src/channels/index.ts` so it self-registers
3. Add the channel's env-var-driven credential check (return `null` if missing)
4. Write a unit test at `src/channels/{name}.test.ts`
5. Run `npm test && npm run typecheck && npm run build`

For installation by an operator after the type exists, the new channel needs to be plumbed into `src/skills/orchestrator/channel-setup.ts` so the admin shell can install it. That requires:
- Adding the type string to the validated enum in `src/skills/orchestrator/types.ts`
- Adding a case in `buildSecretData()` in `src/skills/orchestrator/channel-setup.ts`
- Adding a credential-validation block (e.g., the `validateTelegramToken` pattern) if applicable

### Adding an inline preprocessing capability

Examples: image-vision, pdf-reader, voice-transcription. These run inside the channel or orchestrator pod's existing process — they cannot be deployed as separate Helm `capabilities:` entries.

Questions to ask:
- What does the capability transform? (e.g., `[ImageAttachment: ...]` → `[Image: ...]`)
- Does it need an external service (model API)? If yes, that service should be a separate `capabilities:` Helm entry that this preprocessing module calls.

Implementation pattern:
1. Create `src/preprocessing/{name}.ts`
2. Wire it into the orchestrator's preprocessing job (search for existing preprocessing pipeline integration; the markers contract is in `docs/ADDING_A_CHANNEL.md`)
3. If it needs new credentials, add them to `kubeclaw-secrets` via Helm `secrets:` values

### Changing assistant behavior

Questions to ask:
- What aspect? (name, trigger, persona, response style)
- Apply to all groups or specific ones?

- Simple changes → edit `src/config.ts`
- Persona changes → edit `groups/global/CLAUDE.md`
- Per-group behavior → edit specific group's `CLAUDE.md`

### Adding new commands

Questions to ask:
- What should the command do?
- Available in all groups or one specific group?
- Does it need new MCP tools?

Implementation:
1. Commands are handled by the agent naturally — add instructions to `groups/global/CLAUDE.md` or the group's `CLAUDE.md`
2. For trigger-level routing changes, modify the router logic in `src/router.ts` and `src/index.ts`

### Changing deployment

Questions to ask:
- Target K8s context? (minikube, GKE, EKS, on-prem)
- Helm values overrides needed?

Implementation:
1. Edit `helm/kubeclaw/values.yaml` or create a values overlay file
2. Apply with `helm upgrade --install kubeclaw ./helm/kubeclaw -n kubeclaw -f your-values.yaml`

## After changes

Always tell the user:

```bash
# Build TypeScript
npm run build

# Rebuild and reload the container image (if you changed src/)
./container/build.sh

# Restart the orchestrator deployment
kubectl rollout restart deployment/kubeclaw-orchestrator -n kubeclaw
```

For channel pods specifically:

```bash
kubectl rollout restart deployment/kubeclaw-channel-<name> -n kubeclaw
```
