# KubeClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running as Kubernetes Jobs. Each group has isolated filesystem and memory.

## Key Files

| File                                | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `src/index.ts`                      | Orchestrator: state, message loop, agent invocation        |
| `src/channels/registry.ts`          | Channel registry (self-registration at startup)            |
| `src/k8s/ipc-redis.ts`              | Redis IPC watcher and task processing                      |
| `src/k8s/job-runner.ts`             | Spawns Kubernetes Jobs for agent execution                 |
| `src/runtime/index.ts`              | Agent runner abstraction                                   |
| `src/router.ts`                     | Message formatting and outbound routing                    |
| `src/config.ts`                     | Trigger pattern, paths, intervals                          |
| `src/task-scheduler.ts`             | Runs scheduled tasks                                       |
| `src/db.ts`                         | SQLite operations                                          |
| `groups/{name}/CLAUDE.md`           | Per-group memory (isolated)                                |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

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
./container/build.sh # Rebuild agent container
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

# Recent agent jobs
kubectl get jobs -n kubeclaw --sort-by=.metadata.creationTimestamp | tail -10

# Orchestrator errors
kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw --tail=100 | grep -E '"level":5[0-9]|"level":4[0-9]'
```
