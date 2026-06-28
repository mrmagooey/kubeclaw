# KubeClaw

Personal AI assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Four-tier pod architecture: **Orchestrator** (high priv, only K8s API access, Redis), **Channel** (low priv, user I/O, owns LLM conversation directly against providers), **Capability** (low priv, long-lived features like memory/MCP), **Tool Job** (no priv, short-lived specialist tasks, external images + IPC sidecars). Orchestrator mediates discovery and authorization; channels then talk directly to capabilities and tool jobs.

## Key Files

| File                                | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `src/index.ts`                      | Orchestrator: state, pod lifecycle, discovery               |
| `src/channels/registry.ts`          | Channel registry (self-registration at startup)            |
| `src/k8s/ipc-redis.ts`              | Redis IPC watcher and task processing                      |
| `src/k8s/job-runner.ts`             | Manages pod lifecycles and tool job creation                |
| `src/runtime/index.ts`              | Agent runner abstraction                                   |
| `src/router.ts`                     | Message formatting and outbound routing                    |
| `src/config.ts`                     | Trigger pattern, paths, intervals                          |
| `src/task-scheduler.ts`             | Runs scheduled tasks                                       |
| `src/db.ts`                         | SQLite operations                                          |
| `src/group-queue.ts`                | Per-group message queue with global concurrency limit       |
| `src/specialists.ts`                | @mention parser; resolves mentions against the global catalog |
| `src/specialists/types.ts`          | GlobalSpecialist interface + validator + wire-format parser  |
| `src/specialists/catalog-loader.ts` | Channel-side: mounts kubeclaw-specialists ConfigMap, fs.watch reload |
| `src/specialists/reconciler.ts`     | Orchestrator-side: merge(Helm baseline, SQLite overrides) → ConfigMap |
| `src/skills/orchestrator/specialist-registry.ts` | Admin-shell IPC tools: register / edit / remove / list specialists |
| `src/credential-broker/`            | Stamps `Authorization` headers via Envoy `ext_authz`; orchestrator-side secret holder |
| `src/credential-injection/`         | Mode flag (`sidecar`/`istio`/`off`) + Envoy sidecar spec for tool-job pods |
| `src/tool-selection/`               | Tool Selection Agent: tiered tool discovery — catalog (tier 1) / library (tier 2) / open discovery (tier 3); `agent.ts` orchestrates tiers; `discovery.ts` runs the registry-search → draft → coherence → probe pipeline; `probe/` runs sandboxed one-shot probe jobs; `provenance.ts` + `sweep.ts` track and prune auto-acquired tools |
| `groups/{name}/CLAUDE.md`           | Per-group memory (isolated)                                |
| `src/runtime/skill-curator.ts`      | 24h auto-harvester: scans `conversation_history`, proposes skill candidates |
| `src/runtime/skill-store.ts`        | Skill filesystem store: accepted / `_candidates/` / `_archive/` |
| `src/runtime/skill-loader.ts`       | Injects accepted skills into system prompt (cap 20/group)  |
| `src/runtime/tools/propose-skill.ts`| On-demand `propose_skill` tool the channel LLM can call mid-turn |
| `src/runtime/skills-commands.ts`    | `/skills review`/`accept`/`reject` chat commands           |
| `groups/{name}/skills/{slug}.md`    | Accepted learned skills (git-trackable markdown)           |

## Skills

| Skill               | When to Use                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `/customize`        | Source-code changes: new channel TYPES, behavior, triggers        |
| `/debug`            | Container issues, logs, troubleshooting                           |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch     |
| `/get-qodo-rules`   | Load org- and repo-level coding rules from Qodo before code tasks |

For installing an existing channel (Telegram, Slack, etc.), use the orchestrator admin shell — see `docs/INSTALLING_A_CHANNEL.md`.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild tool container
```

Service management:

```bash
# Check orchestrator status
kubectl get pods -n kubeclaw

# View logs
kubectl logs -f deployment/kubeclaw-orchestrator -n kubeclaw

# Restart orchestrator
kubectl rollout restart deployment/kubeclaw-orchestrator -n kubeclaw

# Stop orchestrator
kubectl scale deployment kubeclaw-orchestrator --replicas=0 -n kubeclaw

# Start orchestrator
kubectl scale deployment kubeclaw-orchestrator --replicas=1 -n kubeclaw
```

## Troubleshooting

Run `/debug` for guided troubleshooting. For quick checks:

```bash
# Orchestrator status
kubectl get pods -n kubeclaw

# Recent tool jobs
kubectl get jobs -n kubeclaw --sort-by=.metadata.creationTimestamp | tail -10

# Orchestrator errors
kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw --tail=100 | grep -E '"level":5[0-9]|"level":4[0-9]'
```
