<p align="center">
  <img src="assets/kubeclaw-logo.png" alt="KubeClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://kubeclaw.dev">kubeclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>
Using Claude Code, KubeClaw can dynamically rewrite its code to customize its feature set for your needs.

**New:** First AI assistant to support [Agent Swarms](https://code.claude.com/docs/en/agent-teams). Spin up teams of agents that collaborate in your chat.

## Why I Built KubeClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

KubeClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Claude agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

```bash
git clone https://github.com/qwibitai/kubeclaw.git
cd kubeclaw
claude
```

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup and service configuration.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal.

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full KubeClaw codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** KubeClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, KubeClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**

- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** KubeClaw runs on the Claude Agent SDK, which means you're running Claude Code directly. Claude Code is highly capable and its coding and problem-solving capabilities allow it to modify and expand KubeClaw and tailor it to each user.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`. Run one or many at the same time.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Apple Container (macOS) or Docker (macOS/Linux)
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks. KubeClaw is the first personal AI assistant to support agent swarms.
- **Dual LLM provider support** - Use Claude (via Claude Code) or OpenRouter (access to 100+ models including GPT-4o, Llama, and more)
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

- `/clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session). Requires figuring out how to trigger compaction programmatically via the Claude Agent SDK.

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see [docs/SPEC.md](docs/SPEC.md).

Key files:

- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory

## Kubernetes Runtime

KubeClaw supports running agents as Kubernetes Jobs instead of Docker containers. This enables better scalability, resource management, and cloud-native operation.

### When to Use Kubernetes

- You want to run KubeClaw on a Kubernetes cluster
- You need better resource limits and isolation per agent
- You want horizontal scaling across multiple nodes
- You're deploying to a cloud environment (EKS, GKE, AKS)

### Prerequisites

- Kubernetes cluster (v1.24+)
- `kubectl` configured with cluster access
- Storage class supporting `ReadWriteMany` (e.g., AWS EFS, NFS)
- Redis (deployed as part of the manifests)

### Quick Deploy

```bash
# Deploy infrastructure
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/01-network-policy.yaml
kubectl apply -f k8s/10-redis.yaml
kubectl apply -f k8s/20-storage.yaml

# Create secrets (Redis 7+ required for ACL support)
kubectl create secret generic kubeclaw-redis \
  --from-literal=admin-password=$(openssl rand -base64 32) \
  -n kubeclaw

kubectl create secret generic kubeclaw-secrets \
  --from-literal=anthropic-api-key=$ANTHROPIC_API_KEY \
  --from-literal=claude-code-oauth-token=$CLAUDE_CODE_OAUTH_TOKEN \
  -n kubeclaw

# Build and push images
docker build -t your-registry/kubeclaw-agent:latest -f container/Dockerfile .
docker build -t your-registry/kubeclaw-orchestrator:latest .
docker push your-registry/kubeclaw-agent:latest
docker push your-registry/kubeclaw-orchestrator:latest

# Update image references in orchestrator manifest, then deploy
kubectl apply -f k8s/30-orchestrator.yaml
```

### Configuration

Set these environment variables in the orchestrator deployment:

```yaml
env:
  - name: KUBECLAW_RUNTIME
    value: kubernetes
  - name: REDIS_URL
    value: redis://kubeclaw-redis:6379
  - name: KUBECLAW_NAMESPACE
    value: kubeclaw
  - name: MAX_CONCURRENT_JOBS
    value: '10'
```

Or use Docker mode (default) for local development:

```bash
KUBECLAW_RUNTIME=docker  # or omit (docker is default)
```

### Architecture Differences

| Feature             | Docker              | Kubernetes                     |
| ------------------- | ------------------- | ------------------------------ |
| **Agent execution** | Docker containers   | Kubernetes Jobs                |
| **Communication**   | Filesystem IPC      | Redis Pub/Sub + Streams        |
| **Concurrency**     | Local process limit | Distributed via Redis          |
| **Storage**         | Bind mounts         | PersistentVolumeClaims         |
| **Networking**      | Docker bridge       | Kubernetes CNI + NetworkPolicy |
| **Secrets**         | Stdin injection     | Kubernetes Secrets             |

### Security

The Kubernetes runtime includes additional security features:

- **Network isolation**: Agents can only reach DNS, Redis, and HTTPS endpoints
- **RBAC**: Minimal permissions for job management
- **Resource limits**: CPU/memory limits per agent job
- **TTL cleanup**: Jobs auto-delete after 1 hour

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

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime.

**Can I run this on Linux?**

Yes. Docker is the default runtime and works on both macOS and Linux. Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize KubeClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. KubeClaw supports multiple LLM providers:

**Option 1: OpenRouter (Recommended for multi-model access)**

Set up OpenRouter to access 100+ models including GPT-4o, Llama, and more:

```bash
OPENROUTER_API_KEY=your-key-here
OPENROUTER_MODEL=openai/gpt-4o
```

See [docs/OPENROUTER.md](docs/OPENROUTER.md) for detailed configuration.

**Option 2: Claude API-compatible endpoints**

For endpoints that support the Anthropic API format:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

This allows you to use:

- Local models via [Ollama](https://ollama.ai) with an API proxy
- Open-source models hosted on [Together AI](https://together.ai), [Fireworks](https://fireworks.ai), etc.
- Custom model deployments with Anthropic-compatible APIs

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies KubeClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Claude will try to dynamically fix them. If that doesn't work, run `claude`, then run `/debug`. If Claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

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
