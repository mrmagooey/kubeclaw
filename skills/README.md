# KubeClaw Skills

Skills are split into four categories based on who consumes them:

## `orchestrator/` — Orchestrator Skills

TypeScript modules that run inside the orchestrator pod. They create and manage K8s resources (Secrets, PVCs, Deployments) for channels and capabilities. These have high privilege — only the orchestrator can execute them.

## `channel/` — Channel Self-Configuration Skills

Markdown documents describing how a blank channel pod configures itself. The orchestrator sends these to newly created channel pods via the Redis control channel. The channel pod installs dependencies, writes configuration, and starts the messaging protocol.

## `capability/` — Capability Skills

Markdown documents describing long-lived capability pods (RAG, MCP servers, memory). These are deployed by the orchestrator and consumed by channels directly after discovery. Not enabled by default — enable via Helm values or the admin shell.

## `.claude/skills/` — Claude Code Skills

Developer-facing workflows consumed by Claude Code CLI during development. These never run at runtime. Examples: `/customize`, `/debug`, `/update-nanoclaw`.
