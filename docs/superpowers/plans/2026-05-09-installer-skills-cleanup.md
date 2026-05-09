# Installer Skills Cleanup Implementation Plan

> **Historical document.** This describes the installer-skills cleanup work that was completed in May 2026. The skill directories referenced here (e.g. `update-nanoclaw`, the various `add-*` stubs) have been removed from the repo. Preserved for context — do not act on the steps below as if they were still pending. See `docs/INSTALLING_A_CHANNEL.md` for the current installation flow.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove 17 install/sync-shaped Claude Code skills, replace their guidance with operator-facing docs and a refreshed `/customize`, and verify nothing in the codebase still references the deleted slash commands.

**Architecture:** Documentation refresh + directory deletions. No runtime code changes. The runtime install path (admin shell `setup_channel`) is already in place from prior work. The only judgment call: write a NEW `docs/INSTALLING_A_CHANNEL.md` for operator walkthroughs rather than rewriting `docs/ADDING_A_CHANNEL.md` (which is a 354-line developer guide for *writing* new channel types, not for installing existing ones — preserving its content matters).

**Tech Stack:** Markdown only. Bash for deletions and verification grep. No test changes.

**Spec:** `docs/superpowers/specs/2026-05-09-installer-skills-cleanup-design.md`.

---

## Important judgment call (deviation from spec)

The spec said "rewrite `docs/ADDING_A_CHANNEL.md` around the new canonical paths." After reading the file, that turned out to be the wrong file — it is the dev-time guide for writing brand-new channel TYPES (Channel interface contract, JID conventions, capability declarations, plugin loader). Rewriting it as an operator install walkthrough would destroy ~350 lines of useful dev-guide content.

This plan substitutes: **create a new `docs/INSTALLING_A_CHANNEL.md`** for the operator walkthrough (Section A from the spec) and per-capability `values.yaml` examples (Section B). `docs/ADDING_A_CHANNEL.md` gets only surgical edits to remove three references to deleted `/add-*` skills (lines 171, 186, 204). The spec's intent — Sections A/B/C exist somewhere accessible — is honored; the file boundaries are different from what the spec specified.

---

## File structure

### New files

| File | Responsibility |
|---|---|
| `docs/INSTALLING_A_CHANNEL.md` | Operator-facing: how to install an existing channel via admin shell; how to install a capability via Helm values, with concrete per-capability examples |

### Modified files

| File | Edit shape |
|---|---|
| `.claude/skills/customize/SKILL.md` | Modernize (drop launchd refs, fix obsolete file paths); remove `/add-*` routing; point at `docs/INSTALLING_A_CHANNEL.md` for "install existing channel" use case |
| `docs/ADDING_A_CHANNEL.md` | Surgical: remove 3 references to deleted skills (`add-image-vision`, `add-pdf-reader`, `add-voice-transcription`); replace with pointer to `docs/INSTALLING_A_CHANNEL.md` capability section |
| `skills/README.md` | Remove `/update-nanoclaw` reference from bucket-4 description |

### Deleted directories (17)

Channel installers (9): `.claude/skills/add-{discord,gmail,http,irc,signal,slack,telegram,telegram-swarm,whatsapp}/`

Capability installers (5): `.claude/skills/add-{image-vision,ollama-tool,parallel,pdf-reader,voice-transcription}/`

Other installer-shaped (2): `.claude/skills/{x-integration,use-local-whisper}/`

Dev-time fork-sync (1): `.claude/skills/update-nanoclaw/`

---

### Task 1: Write `docs/INSTALLING_A_CHANNEL.md`

**Files:**
- Create: `docs/INSTALLING_A_CHANNEL.md`

This is the operator-facing replacement for the deleted `/add-*` skills. Two sections: install a channel via admin shell, install a capability via Helm values. Comprehensive enough that an operator who used to type `/add-telegram` can find equivalent guidance.

- [ ] **Step 1: Write the new doc**

Create `docs/INSTALLING_A_CHANNEL.md` with this exact content:

````markdown
# Installing a Channel or Capability

This guide is for **operators** who want to install an existing channel (Telegram, Slack, etc.) or capability (RAG, image-vision, MCP server) into a running KubeClaw deployment.

For developers who want to *write a brand-new channel TYPE* (the TypeScript code), see [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md). For other dev-time customization (modifying behavior, triggers, router), use the `/customize` Claude Code skill.

---

## Installing a channel

Channels are installed via the orchestrator's **admin shell**. The admin shell is an LLM-powered tool runner that walks you through credential collection and provisions the K8s resources (Secret, PVCs, Deployment, NetworkPolicy) for the new channel pod.

### Two access modes

**TTY mode** (interactive shell inside the orchestrator pod):

```bash
kubectl -n kubeclaw exec -it deploy/kubeclaw-orchestrator -- node dist/admin-shell.js
```

**HTTP UI** (browser-based, requires `ADMIN_HTTP_PORT` and `ADMIN_HTTP_PASSWORD` set in your Helm values):

```bash
kubectl -n kubeclaw port-forward deploy/kubeclaw-orchestrator 8080:8080
# Open http://localhost:8080 in browser; auth with ADMIN_HTTP_USERNAME/PASSWORD
```

### What the admin shell does

The admin shell exposes a `setup_channel` tool to its underlying LLM. You describe what you want ("install Telegram"), the LLM asks for credentials, calls `setup_channel`, and the orchestrator:

1. Validates credentials online (e.g. fetches `api.telegram.org` for Telegram)
2. Creates a K8s Secret with the credentials
3. Creates 3 PVCs for the channel pod (groups, store, sessions)
4. Creates a Deployment running the orchestrator image in `KUBECLAW_MODE=channel`
5. Optionally registers a default group with `direct: true`

### Per-channel credentials

| Channel | Credentials needed | Where to obtain |
|---|---|---|
| `telegram` | Bot token | Talk to [@BotFather](https://t.me/BotFather) |
| `discord` | Bot token | https://discord.com/developers/applications → Bot → Token |
| `slack` | Bot token + App token | https://api.slack.com/apps → OAuth & Permissions / Socket Mode |
| `whatsapp` | Phone number | WhatsApp Business API setup |
| `signal` | Phone number | signal-cli registration |
| `irc` | Server, nick, optional channels list | None (just the IRC server you want to join) |
| `gmail` | OAuth flow handled by setup_channel | Google Cloud project with Gmail API enabled |
| `http` | Username:password pairs | None (you choose them) |
| `oauth-webchat` | OIDC issuer, client ID, client secret, allowed emails | Your OIDC provider (Google Workspace, Okta, etc.) |

### Multi-instance setups (e.g., Telegram swarm)

`setup_channel` accepts an `instanceName` field. To run multiple Telegram bots side by side, call it once per bot with distinct names:

```
setup_channel(type="telegram", instanceName="telegram-personal", token="...")
setup_channel(type="telegram", instanceName="telegram-work", token="...")
```

Each gets its own Deployment (`kubeclaw-channel-telegram-personal`, `kubeclaw-channel-telegram-work`) and Secret. The default `instanceName` equals the channel `type` for the single-bot common case.

### Removing a channel

The admin shell does not currently expose a removal tool. To remove a channel, manually:

```bash
kubectl -n kubeclaw delete deploy kubeclaw-channel-<instanceName>
kubectl -n kubeclaw delete secret kubeclaw-channel-<instanceName>-secret
kubectl -n kubeclaw delete pvc -l kubeclaw/channel=<instanceName>  # ⚠ deletes message history
```

---

## Installing a capability

Capabilities are configured via Helm values and applied with `helm upgrade`. There are two shapes depending on whether the capability is a **separate model server / MCP server** (deploy as its own pod) or an **inline preprocessing pipeline** (modifies orchestrator/channel source code).

### Capability shape decision tree

| If the capability is... | Install via... |
|---|---|
| A separate model server you'd run anyway (Whisper STT, Ollama LLM, image vision API) | Helm values `capabilities:` map |
| An MCP server exposing tools (calendar, weather, your own service) | Helm values `mcpServers:` map |
| An inline preprocessing pipeline (image resize, PDF text extraction, voice transcription) that runs inside channel/orchestrator pods | Source code change via `/customize` (see ADDING_A_CHANNEL.md for the markers contract) |

### `capabilities:` example — `use-local-whisper`

Run a local Whisper STT server as a capability pod that channel pods can call for voice transcription:

```yaml
# In your values overrides:
capabilities:
  whisper:
    image: onerahmet/openai-whisper-asr-webservice:v1.7.1
    port: 9000
    env:
      ASR_MODEL: base.en
    resources:
      requests:
        memory: 2Gi
        cpu: 500m
      limits:
        memory: 4Gi
        cpu: "2"
```

Apply with:

```bash
helm upgrade --install kubeclaw ./helm/kubeclaw -n kubeclaw -f your-values.yaml
```

Channel pods discover this via the orchestrator's discovery registry and call `http://kubeclaw-capability-whisper:9000/asr`.

### `mcpServers:` example — `ollama-tool`

Expose Ollama via MCP for channels that opt in:

```yaml
mcpServers:
  ollama:
    image: your-org/ollama-mcp-server:1.0.0
    port: 3000
    path: /mcp
    channels: [telegram]   # only telegram channel sees this; empty list = all
    env:
      OLLAMA_HOST: http://ollama-server:11434
    resources:
      memoryRequest: 256Mi
      memoryLimit: 512Mi
```

### Inline-preprocessing capabilities — `/customize`

These previously had `/add-*` Claude skills that modified source files directly. They cannot be installed via Helm because they need to run *inside* the channel or orchestrator pod's existing process:

| Capability | What it does | Where to add it |
|---|---|---|
| `image-vision` | Reads `[ImageAttachment: ...]` markers, resizes images, rewrites to `[Image: ...]` | New module `src/preprocessing/image-vision.ts` called from the orchestrator's preprocessing job |
| `pdf-reader` | Extracts text from PDF attachments before the agent sees them | New module `src/preprocessing/pdf-reader.ts` |
| `voice-transcription` | Transcribes audio attachments to text inline | `src/transcription.ts` exporting `transcribeBuffer()`; called from channel implementations that set `inboundVoice: true` (see ADDING_A_CHANNEL.md) |
| `parallel` | Parallel skill execution support | Orchestrator router/runtime change |

Use the `/customize` Claude Code skill to add these; it'll ask the right questions and write the code following the existing patterns.

### RAG (special case)

RAG isn't a capability under `capabilities:` — it's a top-level Helm values block:

```yaml
rag:
  enabled: true
  provider: openai          # or "voyage"
  storage: 20Gi
  topK: 5
  scoreThreshold: "0.5"
```

This deploys a Qdrant StatefulSet and wires the orchestrator to embed + retrieve before each agent invocation. See `helm/kubeclaw/values.yaml` for the full schema.

---

## See also

- [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md) — for developers writing a brand-new channel TYPE in TypeScript
- `helm/kubeclaw/values.yaml` — full Helm value reference with inline comments
- `/customize` Claude Code skill — for source-code customization (channel types, behavior, triggers)
````

- [ ] **Step 2: Verify the file renders cleanly**

Run: `head -1 docs/INSTALLING_A_CHANNEL.md && wc -l docs/INSTALLING_A_CHANNEL.md`
Expected: first line `# Installing a Channel or Capability`; line count ~150-180.

- [ ] **Step 3: Commit**

```bash
git add docs/INSTALLING_A_CHANNEL.md
git commit -m "docs: add INSTALLING_A_CHANNEL operator guide for admin-shell + Helm flows"
```

---

### Task 2: Modernize `.claude/skills/customize/SKILL.md`

**Files:**
- Modify: `.claude/skills/customize/SKILL.md` (full file rewrite — current content is significantly out of date)

The current file references files that no longer exist (`src/ipc.ts`, `src/whatsapp-auth.ts`, `src/container-runner.ts`), uses macOS launchd commands (KubeClaw is K8s-native now), and has an "Adding a New Input Channel" section that overlaps the now-deleted `/add-*` skills. Replace with content scoped to genuine dev-time work.

- [ ] **Step 1: Replace `.claude/skills/customize/SKILL.md` with this content**

````markdown
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
````

- [ ] **Step 2: Verify file is well-formed**

Run: `head -4 .claude/skills/customize/SKILL.md`
Expected: starts with `---` frontmatter; `name: customize` and `description:` present.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/customize/SKILL.md
git commit -m "refactor(customize): modernize for K8s; route channel installs to admin shell"
```

---

### Task 3: Surgical edit of `docs/ADDING_A_CHANNEL.md`

**Files:**
- Modify: `docs/ADDING_A_CHANNEL.md` (3 lines reference deleted skills)

The file references three deleted Claude skills in the inline-preprocessing sections. Update those references to point at `/customize` and `docs/INSTALLING_A_CHANNEL.md` instead.

- [ ] **Step 1: Replace the `add-image-vision` reference**

Find the block (around line 171):
```
The preprocessing pipeline (added by the `add-image-vision` skill) reads these markers, resizes the image, and rewrites them to `[Image: attachments/processed/...]` before the agent sees them.
```

Replace with:
```
A preprocessing pipeline (image-vision) is expected to read these markers, resize the image, and rewrite them to `[Image: attachments/processed/...]` before the agent sees them. See `docs/INSTALLING_A_CHANNEL.md` (capability section) for how to add the pipeline via `/customize`.
```

- [ ] **Step 2: Replace the `add-pdf-reader` reference**

Find the block (around line 186):
```
The `add-pdf-reader` skill must also be applied for the agent to receive extracted PDF text.
```

Replace with:
```
A pdf-reader preprocessing module must also be present for the agent to receive extracted PDF text. See `docs/INSTALLING_A_CHANNEL.md` for how to add it via `/customize`.
```

- [ ] **Step 3: Replace the `add-voice-transcription` reference**

Find the block (around line 204):
```
Requires the `add-voice-transcription` skill to be applied (which adds `src/transcription.ts` and the `openai` npm dependency).
```

Replace with:
```
Requires `src/transcription.ts` (which depends on the `openai` npm package) to be present in the build. See `docs/INSTALLING_A_CHANNEL.md` for how to add voice transcription via `/customize`.
```

- [ ] **Step 4: Verify no stale references remain in this file**

Run: `grep -nE "add-image-vision|add-pdf-reader|add-voice-transcription|add-ollama|add-parallel|/add-" docs/ADDING_A_CHANNEL.md`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add docs/ADDING_A_CHANNEL.md
git commit -m "docs(adding-a-channel): replace deleted-skill references with /customize pointer"
```

---

### Task 4: Update `skills/README.md`

**Files:**
- Modify: `skills/README.md` (line 19 references `/update-nanoclaw` which is being deleted)

- [ ] **Step 1: Read the current file**

Run: `cat skills/README.md`

- [ ] **Step 2: Replace the bucket-4 description**

Find:
```
## `.claude/skills/` — Claude Code Skills

Developer-facing workflows consumed by Claude Code CLI during development. These never run at runtime. Examples: `/customize`, `/debug`, `/update-nanoclaw`.
```

Replace with:
```
## `.claude/skills/` — Claude Code Skills

Developer-facing workflows consumed by Claude Code CLI during development. These never run at runtime. Examples: `/customize`, `/debug`, `/qodo-pr-resolver`, `/get-qodo-rules`. Channel installation is NOT a Claude skill — see [docs/INSTALLING_A_CHANNEL.md](../docs/INSTALLING_A_CHANNEL.md).
```

- [ ] **Step 3: Verify the change**

Run: `grep -E "update-nanoclaw|update-kubeclaw" skills/README.md`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add skills/README.md
git commit -m "docs(skills/README): drop /update-nanoclaw reference; point at INSTALLING_A_CHANNEL"
```

---

### Task 5: Delete the 17 `.claude/skills/` directories

**Files:**
- Delete: 17 directories under `.claude/skills/`

This is the destructive step. The replacement docs (Tasks 1-4) MUST land first so any user reading the deleted-skill descriptions can find the new location.

- [ ] **Step 1: Confirm prior tasks landed**

Run:
```bash
test -f docs/INSTALLING_A_CHANNEL.md && echo "INSTALLING_A_CHANNEL.md exists" || echo "MISSING — STOP"
git log --oneline -4
```
Expected: `INSTALLING_A_CHANNEL.md exists`; the four most recent commits are Tasks 1-4 commits in order.

If `MISSING — STOP` is printed, do not proceed. Go back and complete Tasks 1-4.

- [ ] **Step 2: Verify no other code references the directories about to be deleted**

Run:
```bash
git grep -lE "\.claude/skills/(add-(discord|gmail|http|irc|signal|slack|telegram|telegram-swarm|whatsapp|image-vision|ollama-tool|parallel|pdf-reader|voice-transcription)|x-integration|use-local-whisper|update-nanoclaw)" -- ':!docs/superpowers/' ':!CHANGELOG.md'
```
Expected: no matches outside `docs/superpowers/` (which is plans/specs that may legitimately reference them) and `CHANGELOG.md` (historical entries are fine).

If matches appear in unexpected files, investigate before proceeding.

- [ ] **Step 3: Delete the 17 directories**

```bash
rm -rf \
  .claude/skills/add-discord \
  .claude/skills/add-gmail \
  .claude/skills/add-http \
  .claude/skills/add-irc \
  .claude/skills/add-signal \
  .claude/skills/add-slack \
  .claude/skills/add-telegram \
  .claude/skills/add-telegram-swarm \
  .claude/skills/add-whatsapp \
  .claude/skills/add-image-vision \
  .claude/skills/add-ollama-tool \
  .claude/skills/add-parallel \
  .claude/skills/add-pdf-reader \
  .claude/skills/add-voice-transcription \
  .claude/skills/x-integration \
  .claude/skills/use-local-whisper \
  .claude/skills/update-nanoclaw
```

- [ ] **Step 4: Verify final state**

Run:
```bash
ls .claude/skills/
```
Expected output exactly:
```
customize
debug
get-qodo-rules
qodo-pr-resolver
```

If anything else is listed, investigate (some directory wasn't deleted, or a skill was added since this plan was written).

- [ ] **Step 5: Stage the deletions and commit**

```bash
git add -A .claude/skills/
git status --short | head -10
git commit -m "chore(skills): remove 17 install/sync Claude skills (channels via admin shell, capabilities via Helm)"
```

The commit message body could optionally list the deleted skills; since the plan/spec is committed separately, the short message is sufficient.

---

### Task 6: Whole-repo verification grep

**Files:** none modified — verification only.

Confirm no doc, code, or test references the deleted slash commands. If anything is found, fix it inline.

- [ ] **Step 1: Run the full verification grep**

```bash
git grep -nE "(/add-(discord|gmail|http|irc|signal|slack|telegram(-swarm)?|whatsapp|image-vision|ollama-tool|parallel|pdf-reader|voice-transcription)|/x-integration|/use-local-whisper|/update-(kube|nano)claw)" \
  -- ':!docs/superpowers/' ':!CHANGELOG.md'
```
Expected: no matches.

If matches appear, they're stragglers — for each one, edit the file to remove the reference (use `/customize` or `docs/INSTALLING_A_CHANNEL.md` as the replacement pointer per the surrounding context) and commit each fix as `docs: remove stale /<skill> reference in <filename>`.

- [ ] **Step 2: Confirm final `.claude/skills/` directory count**

```bash
ls .claude/skills/ | wc -l
```
Expected: `4`.

- [ ] **Step 3: Confirm Helm chart still renders cleanly** (defensive — no template should reference these skills, but let's be sure)

```bash
helm template helm/kubeclaw > /tmp/render-after.yaml && echo OK
helm template helm/kubeclaw -f helm/kubeclaw/values-minikube.yaml > /tmp/render-minikube-after.yaml && echo OK
```
Expected: `OK` printed twice; no template errors.

- [ ] **Step 4: Confirm tests still pass** (defensive — no source code changed, but verify nothing broke)

```bash
npm run typecheck 2>&1 | tail -3
npx vitest run 2>&1 | tail -3
```
Expected: typecheck clean; same test count as before this plan started (1233 in the post-credential-injection-merge baseline). If the count changed, it shouldn't have — investigate.

- [ ] **Step 5: Confirm `/customize` slash command still works as a Claude skill**

Run: `head -4 .claude/skills/customize/SKILL.md`
Expected: valid frontmatter starting with `---`, `name: customize`, `description:` present and not empty.

- [ ] **Step 6: Mark plan complete**

If all steps above pass, this plan is fully executed. No commit needed for verification — the verification is purely read-only.

---

## Self-review

**Spec coverage:**
- Spec deletion list (17 directories) → Task 5 deletes all 17 ✓
- Spec edits (3 files: customize/SKILL.md, ADDING_A_CHANNEL.md, skills/README.md) → Tasks 2, 3, 4 ✓
- Spec capability documentation requirement (per-capability values.yaml examples) → Task 1's INSTALLING_A_CHANNEL.md covers `use-local-whisper` (capability), `ollama-tool` (mcpServers) and the inline-preprocessing trio (image-vision, pdf-reader, voice-transcription) routed through `/customize` ✓
- Spec verification (grep, helm template) → Task 6 ✓
- Out-of-scope items (chat-command handler, capability runtime install, lifecycle tools, CHANGELOG entry) → not in plan ✓

**Spec deviation noted:** The spec said rewrite `docs/ADDING_A_CHANNEL.md` to contain Sections A/B/C; the plan creates a new `docs/INSTALLING_A_CHANNEL.md` instead and gives ADDING_A_CHANNEL.md only surgical edits. Reasoning is documented in the plan header — this preserves ~350 lines of valuable dev-guide content that the spec inadvertently called for deletion.

**Placeholder scan:** None. Each task contains exact file content, exact commands, exact expected outputs.

**Type consistency:** No types are defined or modified by this plan; not applicable.

**Outstanding risks:**
- Task 5's destructive `rm -rf` is gated by Task 5 Step 1 (verify prior tasks landed) and Step 2 (verify no other references). If the implementer skips Step 2, they could delete a directory that another file still references — but the verification grep in Step 2 surfaces this before deletion.
- Task 1's INSTALLING_A_CHANNEL.md content is large but copyable verbatim from this plan; no judgment required from the implementer.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-installer-skills-cleanup.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task with two-stage review (spec-compliance then code-quality) per CLAUDE.md. Tasks are independent enough that each gets a clean implementer + reviewer pass.

2. **Inline Execution** — Run tasks in this session with checkpoints. Lower overhead since the work is mostly mechanical (one file write, three small edits, one bash deletion).

Given the scope (6 tasks, 4 of them very mechanical), inline might actually be faster than subagent-driven for this plan — the per-task review overhead would be larger than the work itself. Subagent-driven is still defensible for the rigor.

**Which approach?**
