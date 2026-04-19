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
| `groups/{name}/CLAUDE.md`           | Per-group memory (isolated)                                |

## Skills

| Skill               | When to Use                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `/customize`        | Adding channels, integrations, changing behavior                  |
| `/debug`            | Container issues, logs, troubleshooting                           |
| `/update-kubeclaw`  | Bring upstream KubeClaw updates into a customized install         |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch     |
| `/get-qodo-rules`   | Load org- and repo-level coding rules from Qodo before code tasks |

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
