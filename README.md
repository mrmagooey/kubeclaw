

## Quick Start

```bash
git clone https://github.com/qwibitai/kubeclaw.git
cd kubeclaw

# Build images (for local clusters, load instead of push)
./container/build.sh
docker build -t kubeclaw-orchestrator:latest .

# Install with Helm
helm install kubeclaw ./helm/kubeclaw \
  --set secrets.anthropicApiKey=sk-ant-... \
  --namespace kubeclaw --create-namespace
```

Then open the admin shell to add a channel:

```bash
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- node dist/admin-shell.js
```

Tell it in plain English: `"set up Telegram"` — it will ask for your credentials, create the channel pod, and register your first group.

## Philosophy

**Secure by isolation.** Four-tier pod model with clear privilege separation. Only the orchestrator has K8s API access. Channels, capabilities, and tool jobs run in isolated pods and can only see what's explicitly mounted.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** KubeClaw runs on [pi-agent-core](https://github.com/badlogic/pi-mono), giving you access to 20+ LLM providers including Anthropic, OpenAI, Google, Groq, Ollama, and more — route different groups to different models based on cost or capability. Claude Code guides setup, customization, and debugging.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`. Run one or many at the same time.
- **Isolated group context** - Each group has its own memory, isolated filesystem, and runs in its own Kubernetes Job sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content from the Web
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks. KubeClaw is the first personal AI assistant to support agent swarms.
- **Multi-provider LLM support** - Route groups to any of 20+ providers including Anthropic, OpenAI, Google, Groq, Ollama, OpenRouter, and more. Mix and match models per group for cost or capability.
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:

```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

KubeClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram alongside WhatsApp. Instead, contribute a skill file (`.claude/skills/add-telegram/SKILL.md`) that teaches Claude Code how to transform a KubeClaw installation to use Telegram.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**

- `/add-signal` - Add Signal as a channel

**Session Management**

- `/clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session).

## Requirements

- Kubernetes cluster (v1.24+)
- `kubectl` and `helm` configured for your cluster
- Storage class supporting `ReadWriteMany` (e.g., AWS EFS, NFS) for multi-node clusters
- [Claude Code](https://claude.ai/download) (for channel skills and customization)

## Architecture

```
User → Channel Pod (owns LLM conversation) → Orchestrator (discovery) → Capability/Tool Pods
```

Four-tier pod model with clear privilege separation:

| Tier | Privilege | Role |
|------|-----------|------|
| **Orchestrator** | High (superuser) | Only pod with K8s API access. Manages all pod lifecycles, mediates discovery. Redis is part of this tier. |
| **Channel** | Low | User-facing I/O. Owns the LLM conversation directly against provider endpoints. The channel *is* the agent. |
| **Capability** | Low | Long-lived feature pods (memory/RAG, MCP servers). Channels talk directly after orchestrator-mediated discovery. |
| **Tool Job** | None | Short-lived specialist jobs (web search, browser). Can use external container images with IPC sidecars. |

The orchestrator never relays data — it handles discovery and authorization, then channels communicate directly with capabilities and tool jobs. For the full architecture details, see [docs/SPEC.md](docs/SPEC.md).

Key files:

- `src/index.ts` — Orchestrator
- `src/channels/registry.ts` — Channel registry
- `src/k8s/ipc-redis.ts` — Redis IPC watcher
- `src/k8s/job-runner.ts` — Spawns Kubernetes Jobs and manages pod lifecycles
- `src/runtime/index.ts` — Agent runner abstraction
- `src/router.ts` — Message formatting and outbound routing
- `src/group-queue.ts` — Per-group queue with global concurrency limit
- `src/task-scheduler.ts` — Runs scheduled tasks
- `src/db.ts` — SQLite operations
- `groups/*/CLAUDE.md` — Per-group memory

## Quick Deploy

```bash
# Build images
./container/build.sh
docker build -t your-registry/kubeclaw-orchestrator:latest .
docker push your-registry/kubeclaw-agent:latest
docker push your-registry/kubeclaw-orchestrator:latest

# Install with Helm
helm install kubeclaw ./helm/kubeclaw \
  --set image.registry=your-registry \
  --set secrets.anthropicApiKey=$ANTHROPIC_API_KEY \
  --namespace kubeclaw --create-namespace
```

### Monitoring

```bash
# Check running jobs
kubectl get jobs -n kubeclaw

# View agent logs
kubectl logs job/kubeclaw-agent-{folder}-{timestamp} -n kubeclaw

# Check Redis (requires admin password for ACL authentication)
kubectl exec -it kubeclaw-redis-0 -n kubeclaw -- redis-cli -a $(kubectl get secret kubeclaw-redis -n kubeclaw -o jsonpath='{.data.admin-password}' | base64 -d)

# View orchestrator logs
kubectl logs -f deployment/kubeclaw-orchestrator -n kubeclaw
```

See [KUBERNETES_MIGRATION.md](KUBERNETES_MIGRATION.md) for detailed documentation.

## FAQ

**Why Kubernetes?**

Kubernetes provides better isolation, resource limits per agent, scalability across multiple nodes, and cloud-native operation. It's the standard for container orchestration and works well in both local development (minikube, kind) and production cloud environments (EKS, GKE, AKS).

**Is this secure?**

Security is enforced through a four-tier privilege model — Orchestrator (superuser), Channel (low priv), Capability (low priv), Tool Job (no priv). Only the orchestrator has K8s API access. All other pods run isolated with no ability to create, destroy, or inspect other pods. Tool jobs can wrap external container images safely via IPC sidecars. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize KubeClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. KubeClaw uses [pi-agent-core](https://github.com/badlogic/pi-mono) which supports 20+ providers out of the box. Each group can be routed to a different provider and model. Common options:

**Anthropic (default)**
```bash
ANTHROPIC_API_KEY=sk-ant-...
```

**OpenRouter (100+ models)**
```bash
OPENROUTER_API_KEY=your-key-here
OPENROUTER_MODEL=openai/gpt-4o
```

**Local models via Ollama**
```bash
OLLAMA_HOST=http://localhost:11434
```

**Google, Groq, and others** — set the relevant API key and model in the group's provider config. See [docs/OPENROUTER.md](docs/OPENROUTER.md) for full provider configuration.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies KubeClaw.

**Having trouble?**

Run `claude`, then `/debug`. Claude will diagnose and fix the issue. If it's a bug affecting other users, open a PR.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes and migration notes.

## License

MIT
