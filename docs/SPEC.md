# KubeClaw Specification

A personal AI assistant with multi-channel support, persistent memory per conversation, scheduled tasks, and isolated pod execution on Kubernetes.

---

## Table of Contents

1. [Architecture: Four-Tier Pod Model](#architecture-four-tier-pod-model)
2. [Architecture: Channel System](#architecture-channel-system)
3. [Folder Structure](#folder-structure)
4. [Configuration](#configuration)
5. [Memory System](#memory-system)
6. [Session Management](#session-management)
7. [Message Flow](#message-flow)
8. [Commands](#commands)
9. [Scheduled Tasks](#scheduled-tasks)
10. [MCP Servers](#mcp-servers)
11. [Deployment](#deployment)
12. [Security Considerations](#security-considerations)

---

## Architecture: Four-Tier Pod Model

KubeClaw uses a four-tier pod architecture with clear privilege separation. Each tier has a distinct role and trust level.

### Tiers

| Tier | Privilege | Lifecycle | Role |
|------|-----------|-----------|------|
| **Orchestrator** | High (superuser) | Permanent | Central coordinator. Only pod with K8s API access. Manages all pod lifecycles, mediates discovery and authorization between tiers. Redis is architecturally part of this tier. |
| **Channel** | Low | Permanent | User-facing communication (HTTP, WhatsApp, Signal, Telegram, etc.). Runs its own LLM conversation directly against provider endpoints. The channel *is* the agent. |
| **Capability** | Low | Long-lived | Adds features to the deployment (memory/RAG, MCP servers, etc.). Channels talk to capabilities directly after orchestrator-mediated discovery. |
| **Tool Job** | None | Short-lived | Specialist output on demand (web search, browser, formatting). Created by the orchestrator when a channel requests one. Can use external container images paired with IPC sidecars. |

### Communication Model

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         KUBERNETES CLUSTER                                │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │               ORCHESTRATOR (High Priv)                              │  │
│  │                                                                      │  │
│  │  • Only pod with K8s API access (superuser)                          │  │
│  │  • Manages all pod lifecycles (channels, capabilities, tool jobs)    │  │
│  │  • Mediates discovery: channels ask orchestrator to locate            │  │
│  │    capabilities and spin up tool jobs                                 │  │
│  │  • Authorizes inter-tier communication                               │  │
│  │  • Redis (Pub/Sub + Streams) is part of this tier                    │  │
│  │  • SQLite for message storage, groups, sessions, tasks               │  │
│  │                                                                      │  │
│  └──────────┬──────────────────┬──────────────────┬───────────────────┘  │
│             │ lifecycle +      │ lifecycle +      │ lifecycle +           │
│             │ discovery        │ discovery        │ spin-up on request   │
│             ▼                  ▼                  ▼                       │
│  ┌──────────────────┐  ┌──────────────┐  ┌─────────────────────────┐    │
│  │ CHANNEL (Low)    │  │ CAPABILITY   │  │ TOOL JOB (No Priv)      │    │
│  │                  │  │ (Low)        │  │                          │    │
│  │ Owns LLM convo  │  │ Long-lived   │  │ Short-lived              │    │
│  │ Talks to LLM    │  │ Memory, RAG, │  │ Web search, browser,     │    │
│  │ providers direct │  │ MCP servers  │  │ formatting               │    │
│  │ User I/O        │  │              │  │ External images + IPC    │    │
│  │                  │  │              │  │ sidecars                 │    │
│  └────────┬─────────┘  └──────────────┘  └─────────────────────────┘    │
│           │                    ▲                    ▲                     │
│           │    direct after    │    direct after    │                     │
│           │    discovery       │    discovery       │                     │
│           └────────────────────┴────────────────────┘                     │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

**Key points:**
- The orchestrator never relays data between tiers — it handles discovery and authorization, then channels communicate directly with capabilities and tool jobs.
- Channels run their own LLM conversations directly against provider endpoints (Anthropic, OpenAI, OpenRouter, Ollama, etc.). There is no Claude Code or Agent SDK dependency at runtime.
- Tool jobs can wrap external container images (e.g. a third-party web search container) by pairing them with an IPC sidecar so the KubeClaw communication system can reach them.
- Only the orchestrator can create, destroy, or inspect pods. Channels, capabilities, and tool jobs have no K8s API access.

### Technology Stack

| Component          | Technology                 | Purpose                                             |
| ------------------ | -------------------------- | --------------------------------------------------- |
| Orchestrator       | Node.js 20+               | Central coordinator, pod lifecycle, IPC              |
| IPC                | Redis Pub/Sub + Streams    | Inter-tier communication and discovery               |
| Message Storage    | SQLite (better-sqlite3)    | Messages, groups, sessions, tasks                    |
| Channel Pods       | Per-channel container      | User I/O, LLM conversation against provider APIs     |
| Capability Pods    | Per-capability container   | Long-lived features (RAG, MCP, memory)               |
| Tool Jobs          | K8s Jobs (`batch/v1`)      | Short-lived specialist tasks, external images + IPC  |
| Browser Automation | agent-browser + Chromium   | Web interaction and screenshots (tool job)            |

---

## Architecture: Channel System

Channels are the user-facing tier of KubeClaw. Each channel runs as its own pod, owns its LLM conversation directly against provider endpoints, and communicates with users via a specific platform (WhatsApp, Telegram, HTTP, etc.).

The core ships with no channels built in — each channel is installed as a [Claude Code skill](https://code.claude.com/docs/en/skills) that adds the channel code to your fork.

### System Diagram

```mermaid
graph LR
    subgraph Channels["Channel Pods (Low Priv)"]
        WA[WhatsApp]
        TG[Telegram]
        SL[Slack]
        DC[Discord]
        New["Other (Signal, HTTP...)"]
    end

    subgraph Orchestrator["Orchestrator Pod (High Priv)"]
        LC[Pod Lifecycle]
        DS[Discovery Service]
        IPC[Redis IPC]
        DB[(SQLite)]
        TS[Task Scheduler]
    end

    subgraph Capabilities["Capability Pods (Low Priv)"]
        MEM[Memory/RAG]
        MCP[MCP Servers]
    end

    subgraph Tools["Tool Jobs (No Priv)"]
        WS[Web Search]
        BR[Browser]
        FMT[Formatter]
    end

    %% Channel ↔ Orchestrator (discovery + lifecycle)
    WA & TG & SL & DC & New -->|discovery request| DS
    DS -->|endpoint info| Channels
    LC -->|creates/destroys| Capabilities
    LC -->|spins up on request| Tools

    %% Direct after discovery
    WA & TG & SL & DC & New -.->|direct after discovery| Capabilities
    WA & TG & SL & DC & New -.->|direct after discovery| Tools

    %% Styling
    style New stroke-dasharray: 5 5,stroke-width:2px
    style FMT stroke-dasharray: 5 5,stroke-width:2px
```

### Channel Pod Responsibilities

A channel pod:
- Owns the LLM conversation — talks directly to provider endpoints (Anthropic, OpenAI, OpenRouter, Ollama, etc.)
- Handles user I/O for its platform (receiving and sending messages)
- Requests capabilities and tool jobs through the orchestrator (discovery and authorization)
- Communicates directly with capabilities and tool jobs after the orchestrator mediates discovery

### Channel Registry

The channel system is built on a factory registry in `src/channels/registry.ts`:

```typescript
export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
```

Each factory receives `ChannelOpts` (callbacks for `onMessage`, `onChatMetadata`, and `registeredGroups`) and returns either a `Channel` instance or `null` if that channel's credentials are not configured.

### Channel Interface

Every channel implements this interface (defined in `src/types.ts`):

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

### Self-Registration Pattern

Channels self-register using a barrel-import pattern:

1. Each channel skill adds a file to `src/channels/` (e.g. `whatsapp.ts`, `telegram.ts`) that calls `registerChannel()` at module load time:

   ```typescript
   // src/channels/whatsapp.ts
   import { registerChannel, ChannelOpts } from './registry.js';

   export class WhatsAppChannel implements Channel {
     /* ... */
   }

   registerChannel('whatsapp', (opts: ChannelOpts) => {
     // Return null if credentials are missing
     if (!existsSync(authPath)) return null;
     return new WhatsAppChannel(opts);
   });
   ```

2. The barrel file `src/channels/index.ts` imports all channel modules, triggering registration:

   ```typescript
   import './whatsapp.js';
   import './telegram.js';
   // ... each skill adds its import here
   ```

3. At startup, the orchestrator (`src/index.ts`) loops through registered channels and connects whichever ones return a valid instance:

   ```typescript
   for (const name of getRegisteredChannelNames()) {
     const factory = getChannelFactory(name);
     const channel = factory?.(channelOpts);
     if (channel) {
       await channel.connect();
       channels.push(channel);
     }
   }
   ```

### Key Files

| File                       | Purpose                                                 |
| -------------------------- | ------------------------------------------------------- |
| `src/channels/registry.ts` | Channel factory registry                                |
| `src/channels/index.ts`    | Barrel imports that trigger channel self-registration   |
| `src/types.ts`             | `Channel` interface, `ChannelOpts`, message types       |
| `src/index.ts`             | Orchestrator — instantiates channels, runs message loop |
| `src/router.ts`            | Finds the owning channel for a JID, formats messages    |

### Adding a New Channel

To add a new channel, contribute a skill to `.claude/skills/add-<name>/` that:

1. Adds a `src/channels/<name>.ts` file implementing the `Channel` interface
2. Calls `registerChannel(name, factory)` at module load
3. Returns `null` from the factory if credentials are missing
4. Adds an import line to `src/channels/index.ts`

See existing skills (`/add-whatsapp`, `/add-telegram`, `/add-slack`, `/add-discord`, `/add-gmail`) for the pattern.

---

## Folder Structure

```
kubeclaw/
├── CLAUDE.md                      # Project context for Claude Code
├── docs/
│   ├── SPEC.md                    # This specification document
│   ├── REQUIREMENTS.md            # Architecture decisions
│   └── SECURITY.md                # Security model
├── README.md                      # User documentation
├── package.json                   # Node.js dependencies
├── tsconfig.json                  # TypeScript configuration
├── .mcp.json                      # MCP server configuration (reference)
├── .gitignore
│
├── src/
│   ├── index.ts                   # Orchestrator: state, message loop, agent invocation
│   ├── channels/
│   │   ├── registry.ts            # Channel factory registry
│   │   └── index.ts               # Barrel imports for channel self-registration
│   ├── ipc.ts                     # IPC watcher and task processing
│   ├── router.ts                  # Message formatting and outbound routing
│   ├── config.ts                  # Configuration constants
│   ├── types.ts                   # TypeScript interfaces (includes Channel)
│   ├── logger.ts                  # Pino logger setup
│   ├── db.ts                      # SQLite database initialization and queries
│   ├── group-queue.ts             # Per-group queue with global concurrency limit
│   ├── mount-security.ts          # Mount allowlist validation for containers
│   ├── whatsapp-auth.ts           # Standalone WhatsApp authentication
│   ├── task-scheduler.ts          # Runs scheduled tasks when due
│   └── container-runner.ts        # Spawns agents in containers
│
├── container/
│   ├── Dockerfile                 # Container image (runs as 'node' user, includes Claude Code CLI)
│   ├── build.sh                   # Build script for container image
│   ├── agent-runner/              # Code that runs inside the container
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           # Entry point (query loop, IPC polling, session resume)
│   │       └── ipc-mcp-stdio.ts   # Stdio-based MCP server for host communication
│   └── skills/
│       └── agent-browser.md       # Browser automation skill
│
├── dist/                          # Compiled JavaScript (gitignored)
│
├── .claude/
│   └── skills/
│       ├── setup/SKILL.md              # /setup - First-time installation
│       ├── customize/SKILL.md          # /customize - Add capabilities
│       ├── debug/SKILL.md              # /debug - Container debugging
│       ├── add-telegram/SKILL.md       # /add-telegram - Telegram channel
│       ├── add-gmail/SKILL.md          # /add-gmail - Gmail integration
│       ├── add-voice-transcription/    # /add-voice-transcription - Whisper
│       ├── x-integration/SKILL.md      # /x-integration - X/Twitter
│       ├── convert-to-apple-container/  # /convert-to-apple-container - Apple Container runtime
│       └── add-parallel/SKILL.md       # /add-parallel - Parallel agents
│
├── groups/
│   ├── CLAUDE.md                  # Global memory (all groups read this)
│   ├── {channel}_main/             # Main control channel (e.g., whatsapp_main/)
│   │   ├── CLAUDE.md              # Main channel memory
│   │   └── logs/                  # Task execution logs
│   └── {channel}_{group-name}/    # Per-group folders (created on registration)
│       ├── CLAUDE.md              # Group-specific memory
│       ├── logs/                  # Task logs for this group
│       └── *.md                   # Files created by the agent
│
├── store/                         # Local data (gitignored)
│   ├── auth/                      # WhatsApp authentication state
│   └── messages.db                # SQLite database (messages, chats, scheduled_tasks, task_run_logs, registered_groups, sessions, router_state)
│
├── data/                          # Application state (gitignored)
│   ├── sessions/                  # Per-group session data (.claude/ dirs with JSONL transcripts)
│   ├── env/env                    # Copy of .env for container mounting
│   └── ipc/                       # Container IPC (messages/, tasks/)
│
├── logs/                          # Runtime logs (gitignored)
│   ├── kubeclaw.log               # Host stdout
│   └── kubeclaw.error.log         # Host stderr
│   # Note: Per-container logs are in groups/{folder}/logs/container-*.log
│
└── launchd/
    └── com.kubeclaw.plist         # macOS service configuration
```

---

## Configuration

Configuration constants are in `src/config.ts`:

```typescript
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Paths are absolute (required for container mounts)
const PROJECT_ROOT = process.cwd();
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Container configuration
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'kubeclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
); // 30min default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min — keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

export const TRIGGER_PATTERN = new RegExp(`^@${ASSISTANT_NAME}\\b`, 'i');
```

**Note:** Paths must be absolute for container volume mounts to work correctly.

### Container Configuration

Groups can have additional directories mounted via `containerConfig` in the SQLite `registered_groups` table (stored as JSON in the `container_config` column). Example registration:

```typescript
registerGroup('1234567890@g.us', {
  name: 'Dev Team',
  folder: 'whatsapp_dev-team',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
  containerConfig: {
    additionalMounts: [
      {
        hostPath: '~/projects/webapp',
        containerPath: 'webapp',
        readonly: false,
      },
    ],
    timeout: 600000,
  },
});
```

Folder names follow the convention `{channel}_{group-name}` (e.g., `whatsapp_family-chat`, `telegram_dev-team`). The main group has `isMain: true` set during registration.

Additional mounts appear at `/workspace/extra/{containerPath}` inside the container.

**Mount syntax note:** Read-write mounts use `-v host:container`, but readonly mounts require `--mount "type=bind,source=...,target=...,readonly"` (the `:ro` suffix may not work on all runtimes).

### Claude Authentication

Configure authentication in a `.env` file in the project root. Two options:

**Option 1: Claude Subscription (OAuth token)**

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

The token can be extracted from `~/.claude/.credentials.json` if you're logged in to Claude Code.

**Option 2: Pay-per-use API Key**

```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Only the authentication variables (`CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`) are extracted from `.env` and written to `data/env/env`, then mounted into the container at `/workspace/env-dir/env` and sourced by the entrypoint script. This ensures other environment variables in `.env` are not exposed to the agent. This workaround is needed because some container runtimes lose `-e` environment variables when using `-i` (interactive mode with piped stdin).

### Changing the Assistant Name

Set the `ASSISTANT_NAME` environment variable:

```bash
ASSISTANT_NAME=Bot npm start
```

Or edit the default in `src/config.ts`. This changes:

- The trigger pattern (messages must start with `@YourName`)
- The response prefix (`YourName:` added automatically)

### Placeholder Values in launchd

Files with `{{PLACEHOLDER}}` values need to be configured:

- `{{PROJECT_ROOT}}` - Absolute path to your kubeclaw installation
- `{{NODE_PATH}}` - Path to node binary (detected via `which node`)
- `{{HOME}}` - User's home directory

---

## Memory System

KubeClaw uses a hierarchical memory system based on CLAUDE.md files.

### Memory Hierarchy

| Level      | Location                  | Read By    | Written By | Purpose                                                     |
| ---------- | ------------------------- | ---------- | ---------- | ----------------------------------------------------------- |
| **Global** | `groups/CLAUDE.md`        | All groups | Main only  | Preferences, facts, context shared across all conversations |
| **Group**  | `groups/{name}/CLAUDE.md` | That group | That group | Group-specific context, conversation memory                 |
| **Files**  | `groups/{name}/*.md`      | That group | That group | Notes, research, documents created during conversation      |

### How Memory Works

1. **Agent Context Loading**
   - Agent runs with `cwd` set to `groups/{group-name}/`
   - The LLM provider with `settingSources: ['project']` automatically loads:
     - `../CLAUDE.md` (parent directory = global memory)
     - `./CLAUDE.md` (current directory = group memory)

2. **Writing Memory**
   - When user says "remember this", agent writes to `./CLAUDE.md`
   - When user says "remember this globally" (main channel only), agent writes to `../CLAUDE.md`
   - Agent can create files like `notes.md`, `research.md` in the group folder

3. **Main Channel Privileges**
   - Only the "main" group (self-chat) can write to global memory
   - Main can manage registered groups and schedule tasks for any group
   - Main can configure additional directory mounts for any group
   - All groups have Bash access (safe because it runs inside container)

---

## Session Management

Sessions enable conversation continuity - Claude remembers what you talked about.

### How Sessions Work

1. Each group has a session ID stored in SQLite (`sessions` table, keyed by `group_folder`)
2. Session ID is passed to the LLM provider's `resume` option
3. Claude continues the conversation with full context
4. Session transcripts are stored as JSONL files in `data/sessions/{group}/.claude/`

---

## Message Flow

### Incoming Message Flow

```
1. User sends a message via a platform (WhatsApp, Telegram, HTTP, etc.)
   │
   ▼
2. Channel pod receives the message
   │
   ▼
3. Channel checks trigger pattern and group registration
   ├── Not a registered group? → ignore
   └── No trigger match? → store but don't process
   │
   ▼
4. Channel catches up conversation context:
   ├── Fetch messages since last interaction
   ├── Format with timestamp and sender name
   └── Build prompt with full conversation context
   │
   ▼
5. Channel runs LLM conversation directly against provider endpoint:
   ├── Provider: Anthropic, OpenAI, OpenRouter, Ollama, etc.
   ├── Context: group memory (CLAUDE.md), conversation history
   └── Session continuity via stored session state
   │
   ▼
6. During conversation, channel may request tools/capabilities:
   ├── Asks orchestrator to discover a capability → gets endpoint → talks directly
   └── Asks orchestrator to spin up a tool job → gets endpoint → talks directly
   │
   ▼
7. Channel sends response to user via its platform
   │
   ▼
8. Channel updates conversation state
```

### Trigger Word Matching

Messages must start with the trigger pattern (default: `@Andy`):

- `@Andy what's the weather?` → ✅ Triggers Claude
- `@andy help me` → ✅ Triggers (case insensitive)
- `Hey @Andy` → ❌ Ignored (trigger not at start)
- `What's up?` → ❌ Ignored (no trigger)

### Conversation Catch-Up

When a triggered message arrives, the agent receives all messages since its last interaction in that chat. Each message is formatted with timestamp and sender name:

```
[Jan 31 2:32 PM] John: hey everyone, should we do pizza tonight?
[Jan 31 2:33 PM] Sarah: sounds good to me
[Jan 31 2:35 PM] John: @Andy what toppings do you recommend?
```

This allows the agent to understand the conversation context even if it wasn't mentioned in every message.

---

## Commands

### Commands Available in Any Group

| Command                | Example                     | Effect         |
| ---------------------- | --------------------------- | -------------- |
| `@Assistant [message]` | `@Andy what's the weather?` | Talk to Claude |

### Commands Available in Main Channel Only

| Command                          | Example                             | Effect                 |
| -------------------------------- | ----------------------------------- | ---------------------- |
| `@Assistant add group "Name"`    | `@Andy add group "Family Chat"`     | Register a new group   |
| `@Assistant remove group "Name"` | `@Andy remove group "Work Team"`    | Unregister a group     |
| `@Assistant list groups`         | `@Andy list groups`                 | Show registered groups |
| `@Assistant remember [fact]`     | `@Andy remember I prefer dark mode` | Add to global memory   |

---

## Scheduled Tasks

KubeClaw has a built-in scheduler that runs tasks as full agents in their group's context.

### How Scheduling Works

1. **Group Context**: Tasks created in a group run with that group's working directory and memory
2. **Full Agent Capabilities**: Scheduled tasks have access to all tools (WebSearch, file operations, etc.)
3. **Optional Messaging**: Tasks can send messages to their group using the `send_message` tool, or complete silently
4. **Main Channel Privileges**: The main channel can schedule tasks for any group and view all tasks

### Schedule Types

| Type       | Value Format    | Example                      |
| ---------- | --------------- | ---------------------------- |
| `cron`     | Cron expression | `0 9 * * 1` (Mondays at 9am) |
| `interval` | Milliseconds    | `3600000` (every hour)       |
| `once`     | ISO timestamp   | `2024-12-25T09:00:00Z`       |

### Creating a Task

```
User: @Andy remind me every Monday at 9am to review the weekly metrics

Claude: [calls mcp__kubeclaw__schedule_task]
        {
          "prompt": "Send a reminder to review weekly metrics. Be encouraging!",
          "schedule_type": "cron",
          "schedule_value": "0 9 * * 1"
        }

Claude: Done! I'll remind you every Monday at 9am.
```

### One-Time Tasks

```
User: @Andy at 5pm today, send me a summary of today's emails

Claude: [calls mcp__kubeclaw__schedule_task]
        {
          "prompt": "Search for today's emails, summarize the important ones, and send the summary to the group.",
          "schedule_type": "once",
          "schedule_value": "2024-01-31T17:00:00Z"
        }
```

### Managing Tasks

From any group:

- `@Andy list my scheduled tasks` - View tasks for this group
- `@Andy pause task [id]` - Pause a task
- `@Andy resume task [id]` - Resume a paused task
- `@Andy cancel task [id]` - Delete a task

From main channel:

- `@Andy list all tasks` - View tasks from all groups
- `@Andy schedule task for "Family Chat": [prompt]` - Schedule for another group

---

## MCP Servers

### KubeClaw MCP (built-in)

The `kubeclaw` MCP server is created dynamically per agent call with the current group's context.

**Available Tools:**
| Tool | Purpose |
|------|---------|
| `schedule_task` | Schedule a recurring or one-time task |
| `list_tasks` | Show tasks (group's tasks, or all if main) |
| `get_task` | Get task details and run history |
| `update_task` | Modify task prompt or schedule |
| `pause_task` | Pause a task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Delete a task |
| `send_message` | Send a message to the group via its channel |

---

## Deployment

KubeClaw runs in the `kubeclaw` namespace. The orchestrator is a Kubernetes Deployment; channels and capabilities are long-lived pods managed by the orchestrator; tool jobs are ephemeral K8s Jobs created on demand.

### Startup Sequence

When the orchestrator starts, it:

1. Initializes the SQLite database
2. Loads state from SQLite (registered groups, sessions, router state)
3. **Starts channel pods** — loops through registered channels, creates pods for those with credentials
4. **Starts capability pods** — creates long-lived pods for configured capabilities
5. Once at least one channel is connected:
   - Starts the scheduler loop
   - Starts the Redis IPC watcher (`src/k8s/ipc-redis.ts`)
   - Sets up the per-group queue with `processGroupMessages`
   - Recovers any unprocessed messages from before shutdown
   - Starts the message polling loop

### Managing the Service

```bash
# Check all KubeClaw pods (orchestrator, channels, capabilities, tool jobs)
kubectl get pods -n kubeclaw

# View orchestrator logs
kubectl logs -f deployment/kubeclaw-orchestrator -n kubeclaw

# Restart orchestrator (will restart all managed pods)
kubectl rollout restart deployment/kubeclaw-orchestrator -n kubeclaw

# Scale down / up
kubectl scale deployment kubeclaw-orchestrator --replicas=0 -n kubeclaw
kubectl scale deployment kubeclaw-orchestrator --replicas=1 -n kubeclaw
```

See [INSTALL.md](../INSTALL.md) for full deployment instructions.

---

## Security Considerations

### Pod Isolation by Tier

Security is enforced through the four-tier privilege model:

- **Orchestrator (High Priv)**: Only pod with K8s API access. Controls all pod lifecycles and mediates discovery. Redis is part of this tier.
- **Channel (Low Priv)**: No K8s API access. Handles user I/O and LLM conversations. Can only reach capabilities and tool jobs after orchestrator-mediated discovery.
- **Capability (Low Priv)**: No K8s API access. Provides features to channels. Cannot create or destroy other pods.
- **Tool Job (No Priv)**: No K8s API access. Ephemeral. Can use external container images paired with IPC sidecars. Auto-deleted after completion.

All non-orchestrator pods run as unprivileged users with filesystem isolation — they can only access explicitly mounted directories.

### Prompt Injection Risk

User messages could contain malicious instructions attempting to manipulate the channel's LLM conversation.

**Mitigations:**

- Privilege separation limits blast radius — even a compromised channel cannot access K8s APIs or other groups
- Only registered groups are processed
- Trigger word required (reduces accidental processing)
- Tool jobs are ephemeral and have no persistent privileges
- LLM provider safety training

**Recommendations:**

- Only register trusted groups
- Review capability and tool job configurations
- Review scheduled tasks periodically
- Monitor orchestrator logs for unusual pod activity

### Credential Storage

| Credential       | Storage Location               | Notes                                               |
| ---------------- | ------------------------------ | --------------------------------------------------- |
| Claude CLI Auth  | data/sessions/{group}/.claude/ | Per-group isolation, mounted to /home/node/.claude/ |
| WhatsApp Session | store/auth/                    | Auto-created, persists ~20 days                     |

### File Permissions

The groups/ folder contains personal memory and should be protected:

```bash
chmod 700 groups/
```

---

## Troubleshooting

### Common Issues

| Issue                                    | Cause                             | Solution                                                                                 |
| ---------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- | -------------- |
| No response to messages                  | Service not running               | Check `launchctl list                                                                    | grep kubeclaw` |
| "Claude Code process exited with code 1" | Container runtime failed to start | Check logs; KubeClaw auto-starts container runtime but may fail                          |
| "Claude Code process exited with code 1" | Session mount path wrong          | Ensure mount is to `/home/node/.claude/` not `/root/.claude/`                            |
| Session not continuing                   | Session ID not saved              | Check SQLite: `sqlite3 store/messages.db "SELECT * FROM sessions"`                       |
| Session not continuing                   | Mount path mismatch               | Container user is `node` with HOME=/home/node; sessions must be at `/home/node/.claude/` |
| "QR code expired"                        | WhatsApp session expired          | Delete store/auth/ and restart                                                           |
| "No groups registered"                   | Haven't added groups              | Use `@Andy add group "Name"` in main                                                     |

### Log Location

- `logs/kubeclaw.log` - stdout
- `logs/kubeclaw.error.log` - stderr

### Debug Mode

Run manually for verbose output:

```bash
npm run dev
# or
node dist/index.js
```
