# KubeClaw Requirements

Original requirements and design decisions from the project creator.

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity - 4-5 different processes running different gateways, endless configuration files, endless integrations. It's a security nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole codebase. When you run it you're kind of just yoloing it.

KubeClaw gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in actual Linux containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your Mac.

### Built for One User

This isn't a framework or a platform. It's working software for my specific needs. I use WhatsApp and Email, so it supports WhatsApp and Email. I don't use Telegram, so it doesn't support Telegram. I add the integrations I actually want, not every possible integration.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Very minimal things like the trigger word are in config. Everything else - just change the code to do what you want.

### AI-Native Development

I don't need an installation wizard - Claude Code guides the setup. I don't need a monitoring dashboard - I ask Claude Code what's happening. I don't need elaborate logging UIs - I ask Claude to read the logs. I don't need debugging tools - I describe the problem and Claude fixes it.

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or self-debugging because Claude is always there.

### Skills Over Features

When people contribute, they shouldn't add "Telegram support alongside WhatsApp." They should contribute a skill like `/add-telegram` that transforms the codebase. Users fork the repo, run skills to customize, and end up with clean code that does exactly what they need - not a bloated system trying to support everyone's use case simultaneously.

---

## RFS (Request for Skills)

Skills we'd love contributors to build:

### Communication Channels
Skills to add or switch to different messaging platforms:
- `/add-telegram` - Add Telegram as an input channel
- `/add-slack` - Add Slack as an input channel
- `/add-discord` - Add Discord as an input channel
- `/add-sms` - Add SMS via Twilio or similar
- `/convert-to-telegram` - Replace WhatsApp with Telegram entirely

### Container Runtime
The project uses Docker by default (cross-platform). For macOS users who prefer Apple Container:
- `/convert-to-apple-container` - Switch from Docker to Apple Container (macOS-only)

### Platform Support
- `/setup-linux` - Make the full setup work on Linux (depends on Docker conversion)
- `/setup-windows` - Windows support via WSL2 + Docker

---

## Vision

A personal AI assistant accessible via multiple channels, with isolated pod execution on Kubernetes.

**Core architecture — four-tier pod model:**
- **Orchestrator (High Priv)** — central coordinator, only pod with K8s API access. Manages all pod lifecycles, mediates discovery between tiers. Redis is architecturally part of this tier.
- **Channel (Low Priv)** — user-facing communication pods (HTTP, WhatsApp, Signal, etc.). Each channel owns its LLM conversation directly against provider endpoints. The channel *is* the agent.
- **Capability (Low Priv)** — long-lived feature pods (memory/RAG, MCP servers). Channels talk to them directly after orchestrator-mediated discovery.
- **Tool Job (No Priv)** — short-lived specialist jobs (web search, browser, formatting). Created by the orchestrator on channel request. Can use external container images paired with IPC sidecars.

**Core features:**
- **Multi-channel messaging** via channel pods
- **Persistent memory** per conversation and globally
- **Scheduled tasks** that run and can message back
- **Capabilities** as long-lived feature pods
- **Tool jobs** for specialist output on demand

**Implementation approach:**
- Channel pods talk directly to LLM providers (no Claude Code or Agent SDK dependency at runtime)
- Orchestrator handles all K8s operations — no other tier has cluster access
- Tool jobs can wrap external container images with IPC sidecars
- File-based systems where possible (CLAUDE.md for memory, folders for groups)

---

## Architecture Decisions

### Four-Tier Pod Model
- **Orchestrator (High Priv)**: Only pod with K8s API access. Manages all pod lifecycles. Redis is part of this tier.
- **Channel (Low Priv)**: User-facing pods. Own the LLM conversation directly against provider endpoints. The channel *is* the agent.
- **Capability (Low Priv)**: Long-lived feature pods. Channels talk to them directly after orchestrator-mediated discovery.
- **Tool Job (No Priv)**: Short-lived specialist jobs. Created by orchestrator on channel request. Can use external container images with IPC sidecars.
- The orchestrator never relays data — it handles discovery and authorization, then tiers communicate directly.

### Message Routing
- Channel pods handle their own message routing
- Only messages from registered groups are processed
- Trigger: `@Andy` prefix (case insensitive), configurable via `ASSISTANT_NAME` env var
- Unregistered groups are ignored completely

### Memory System
- **Per-group memory**: Each group has a folder with its own `CLAUDE.md`
- **Global memory**: Root `CLAUDE.md` is read by all groups, but only writable from "main" (self-chat)
- **Files**: Groups can create/read files in their folder and reference them
- Channel pod runs in the group's folder, automatically inherits both CLAUDE.md files

### Session Management
- Each group maintains a conversation session within its channel pod
- Sessions auto-compact when context gets too long, preserving critical information

### Pod Isolation
- Channels, capabilities, and tool jobs run in isolated pods with no K8s API access
- Only the orchestrator can create, destroy, or inspect pods
- Pods provide filesystem isolation — only explicitly mounted paths are visible
- Tool jobs can wrap external container images with IPC sidecars, keeping untrusted images sandboxed
- Non-root execution in all non-orchestrator pods

### Scheduled Tasks
- Users can ask to schedule recurring or one-time tasks from any group
- Tasks run in the context of the group that created them
- Tasks can optionally send messages to their group via `send_message` tool, or complete silently
- Task runs are logged to the database with duration and result
- Schedule types: cron expressions, intervals (ms), or one-time (ISO timestamp)
- From main: can schedule tasks for any group, view/manage all tasks
- From other groups: can only manage that group's tasks

### Group Management
- New groups are added explicitly via the main channel
- Groups are registered in SQLite (via the main channel or IPC `register_group` command)
- Each group gets a dedicated folder under `groups/`

### Main Channel Privileges
- Main channel is the admin/control group (typically self-chat)
- Can write to global memory (`groups/CLAUDE.md`)
- Can schedule tasks for any group
- Can view and manage tasks from all groups

---

## Integration Points

### WhatsApp
- Using baileys library for WhatsApp Web connection
- Messages stored in SQLite, polled by router
- QR code authentication during setup

### Scheduler
- Built-in scheduler runs on the host, spawns containers for task execution
- Custom `kubeclaw` MCP server (inside container) provides scheduling tools
- Tools: `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `send_message`
- Tasks stored in SQLite with run history
- Scheduler loop checks for due tasks every minute
- Tasks execute in containerized group context via tool jobs

### Web Access
- Built-in WebSearch and WebFetch tools
- Standard LLM provider capabilities

### Browser Automation
- agent-browser CLI with Chromium in container
- Snapshot-based interaction with element references (@e1, @e2, etc.)
- Screenshots, PDFs, video recording
- Authentication state persistence

---

## Setup & Customization

### Philosophy
- Minimal configuration files
- Setup and customization done via Claude Code
- Users clone the repo and run Claude Code to configure
- Each user gets a custom setup matching their exact needs

### Skills
- `/setup` - Install dependencies, authenticate WhatsApp, configure scheduler, start services
- `/customize` - General-purpose skill for adding capabilities (new channels like Telegram, new integrations, behavior changes)
- `/update` - Pull upstream changes, merge with customizations, run migrations

### Deployment
- Runs on local Mac via launchd
- Single Node.js process handles everything

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference:

- **Trigger**: `@Andy` (case insensitive)
- **Response prefix**: `Andy:`
- **Persona**: Default Claude (no custom personality)
- **Main channel**: Self-chat (messaging yourself in WhatsApp)

---

## Project Name

**KubeClaw** - A reference to Clawdbot (now OpenClaw).

---

## Agent Output Conventions

These conventions govern what agents write and how the orchestrator interprets it before delivery to users. Skill authors and group `CLAUDE.md` authors should be aware of them.

### `<internal>` tag — hide reasoning from users

Agents can wrap any content in `<internal>...</internal>` tags. The orchestrator strips these blocks (via `stripInternalTags` in `src/router.ts`) before sending output to the user.

Use this for chain-of-thought, scratchpad reasoning, or planning steps that should inform the response but must not appear in the final message.

Example:
```
<internal>
The user asked about X. I should first check Y before answering.
</internal>
Here is the answer to your question about X...
```

### Prompt XML format — what agents receive

The orchestrator formats inbound conversation history as XML before passing it to the agent:

```xml
<context timezone="America/New_York" />
<messages>
<message sender="Alice" time="10:30 AM">@Andy hello</message>
<message sender="Bob" time="10:31 AM">@Andy what time is it?</message>
</messages>
```

- `<context>` carries metadata (currently timezone).
- `<messages>` contains one `<message>` per stored message, with `sender` and `time` attributes.
- Special content markers (see below) may appear inside `<message>` bodies after preprocessing.

### Input markers — preprocessed before the agent sees them

These markers appear inside `<message>` content after the orchestrator preprocesses attachments. The agent sees them as part of the conversation history.

| Marker | Meaning |
|---|---|
| `[Image: path/to/image.jpg]` | An image attachment, converted from the raw upload. |
| `[Voice: transcript text]` | A voice message transcribed to text. |

### `[SendFile: path caption="..."]` marker — deliver files to users

Agents can embed this marker in their output to send a file or media item to the user. The orchestrator's `handleSendFileMarkers` (in `src/outbound-media.ts`) intercepts it, delivers the file via the appropriate channel, and strips the marker from the text reply.

```
[SendFile: groups/my-group/report.pdf caption="Your monthly report"]
```

- `path` is relative to the groups directory or an absolute path accessible to the orchestrator.
- `caption` is optional.
- Multiple `[SendFile: ...]` markers can appear in a single response.
