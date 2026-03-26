# KubeClaw — Kubernetes Installation Guide

> **Running on a laptop?** See [docs/MINIKUBE.md](docs/MINIKUBE.md) for a single-command local setup using minikube with Cilium CNI and Falco runtime security.

## Overview

KubeClaw runs as two persistent services on Kubernetes:

- **Orchestrator** — Node.js process that receives messages from channels (Slack, Telegram, etc.) and manages agent jobs
- **Redis** — Message bus between orchestrator and agent jobs

When a message arrives, the orchestrator creates a short-lived Kubernetes **Job** that runs Claude Agent SDK in a container, communicates back via Redis Pub/Sub, then exits.

```
User message
    │
    ▼
Orchestrator (Deployment)
    │  creates
    ▼
Agent Job (batch/Job)  ◄──── Redis ────► Orchestrator
    │
    ▼
Claude response → back through channel
```

## Prerequisites

- Kubernetes 1.24+ with `batch/v1` Job support
- `kubectl` configured for your cluster
- `helm` 3.x
- Container runtime (Docker or compatible)
- Persistent storage with **ReadWriteMany** (RWX) for multi-node clusters, or ReadWriteOnce (RWO) for single-node

## Quick Start

### 1. Build Images

```bash
# Build the agent container (runs Claude SDK)
./container/build.sh

# Build the orchestrator image
docker build -t kubeclaw-orchestrator:latest .
```

For local clusters (kind, minikube), load the images:

```bash
kind load docker-image kubeclaw-agent:latest
kind load docker-image kubeclaw-orchestrator:latest
# OR
minikube image load kubeclaw-agent:latest
minikube image load kubeclaw-orchestrator:latest
```

For remote clusters, push to a registry and set `image.registry` in your values.

### 2. Install with Helm

```bash
# Single-node / local cluster (default values use ReadWriteOnce)
helm install kubeclaw ./helm/kubeclaw \
  --set secrets.anthropicApiKey=sk-ant-... \
  --namespace kubeclaw --create-namespace

# Multi-node production cluster (RWX storage required)
helm install kubeclaw ./helm/kubeclaw \
  --set secrets.anthropicApiKey=sk-ant-... \
  --set storage.accessMode=ReadWriteMany \
  --set storage.storageClass=efs-csi \
  --namespace kubeclaw --create-namespace
```

### 3. Verify

```bash
kubectl get pods -n kubeclaw
# Expected:
#   kubeclaw-redis-0        Running
#   kubeclaw-orchestrator-* Running

kubectl logs -f deployment/kubeclaw-orchestrator -n kubeclaw
```

### 4. Add a Channel

Open the admin shell inside the orchestrator pod:

```bash
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- node dist/admin-shell.js
```

Tell it in plain English what you want, e.g. `"set up Telegram"`. It will ask for your credentials, create the channel pod, and register your first group.

---

## Configuration Reference

All configuration is via Helm values. Pass overrides with `--set key=value` or a custom values file (`-f myvalues.yaml`). See `helm/kubeclaw/values.yaml` for all available options.

### Core

| Variable                   | Default | Description                                              |
| -------------------------- | ------- | -------------------------------------------------------- |
| `ASSISTANT_NAME`           | `Andy`  | Name used for trigger mentions (e.g. `@Andy`)            |
| `ASSISTANT_HAS_OWN_NUMBER` | `false` | WhatsApp: whether the assistant has its own phone number |
| `LOG_LEVEL`                | `info`  | Log verbosity: `debug`, `info`, `warn`, `error`, `fatal` |
| `TZ`                       | system  | Timezone for scheduled tasks (e.g. `America/New_York`)   |

### LLM Provider

| Variable                  | Default                        | Description                                       |
| ------------------------- | ------------------------------ | ------------------------------------------------- |
| `DEFAULT_LLM_PROVIDER`    | `claude`                       | `claude` or `openrouter`                          |
| `ANTHROPIC_API_KEY`       | —                              | Anthropic API key (required if using Claude)      |
| `CLAUDE_CODE_OAUTH_TOKEN` | —                              | Claude Code OAuth token (alternative to API key)  |
| `ANTHROPIC_BASE_URL`      | —                              | Custom Claude API endpoint (optional)             |
| `OPENROUTER_API_KEY`      | —                              | OpenRouter API key (required if using OpenRouter) |
| `OPENROUTER_MODEL`        | `openai/gpt-4o`                | Model identifier for OpenRouter                   |
| `OPENROUTER_BASE_URL`     | `https://openrouter.ai/api/v1` | OpenRouter API base URL                           |
| `OPENROUTER_HTTP_REFERER` | —                              | Your domain, for OpenRouter rankings (optional)   |
| `OPENROUTER_X_TITLE`      | `KubeClaw`                     | App name for OpenRouter rankings (optional)       |

### Kubernetes Runtime

| Variable               | Default                       | Description                                                                                           |
| ---------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `KUBECLAW_RUNTIME`     | `kubernetes`                  | Kubernetes namespace runtime identifier                                                               |
| `KUBECLAW_NAMESPACE`   | `kubeclaw`                    | Kubernetes namespace for agent Jobs                                                                   |
| `KUBECLAW_IPC_BASE`    | `/data/sessions`              | Mount path for the sessions PVC (must match orchestrator volumeMount)                                 |
| `MAX_CONCURRENT_JOBS`  | `10`                          | Maximum parallel agent Jobs                                                                           |
| `REDIS_URL`            | `redis://kubeclaw-redis:6379` | Redis connection URL                                                                                  |
| `REDIS_ADMIN_PASSWORD` | —                             | Redis ACL admin password (from `kubeclaw-redis` secret)                                               |
| `ACL_ENCRYPTION_KEY`   | —                             | 32-byte key to encrypt ACL credentials at rest. If unset, a derived key is used (insecure — dev only) |

### Agent Job Resources

These control the resource requests/limits for each agent Job pod.

| Variable                   | Default | Description                  |
| -------------------------- | ------- | ---------------------------- |
| `AGENT_JOB_MEMORY_REQUEST` | `512Mi` | Memory request per agent Job |
| `AGENT_JOB_MEMORY_LIMIT`   | `4Gi`   | Memory limit per agent Job   |
| `AGENT_JOB_CPU_REQUEST`    | `250m`  | CPU request per agent Job    |
| `AGENT_JOB_CPU_LIMIT`      | `2000m` | CPU limit per agent Job      |

### Container Behaviour

| Variable                     | Default                     | Description                                   |
| ---------------------------- | --------------------------- | --------------------------------------------- |
| `CONTAINER_TIMEOUT`          | `1800000`                   | Max agent runtime in ms (30 min)              |
| `CONTAINER_MAX_OUTPUT_SIZE`  | `10485760`                  | Max agent output in bytes (10 MB)             |
| `IDLE_TIMEOUT`               | `1800000`                   | Idle timeout after last result in ms (30 min) |
| `CLAUDE_CONTAINER_IMAGE`     | `kubeclaw-agent:claude`     | Image for Claude-backed agents                |
| `OPENROUTER_CONTAINER_IMAGE` | `kubeclaw-agent:openrouter` | Image for OpenRouter-backed agents            |

### Channel Integrations

Add secrets for any channels you use. See the `/add-telegram`, `/add-slack`, `/add-discord`, `/add-whatsapp` skills for guided setup.

| Variable                | Channel  | Description                           |
| ----------------------- | -------- | ------------------------------------- |
| `TELEGRAM_BOT_TOKEN`    | Telegram | Bot token from @BotFather             |
| `SLACK_BOT_TOKEN`       | Slack    | `xoxb-...` bot token                  |
| `SLACK_SIGNING_SECRET`  | Slack    | Webhook signature verification secret |
| `SLACK_APP_TOKEN`       | Slack    | `xapp-...` token for Socket Mode      |
| `WHATSAPP_SESSION_PATH` | WhatsApp | Path to WhatsApp session directory    |
| `IRC_SERVER`            | IRC      | IRC server hostname                   |
| `IRC_PORT`              | IRC      | IRC server port                       |
| `IRC_NICK`              | IRC      | Bot nickname                          |
| `IRC_CHANNELS`          | IRC      | Comma-separated channels to join      |

---

## Persistent Storage

| PVC                 | Size  | Access | Purpose                                    |
| ------------------- | ----- | ------ | ------------------------------------------ |
| `kubeclaw-redis`    | 10 Gi | RWO    | Redis AOF persistence                      |
| `kubeclaw-groups`   | 50 Gi | RWX\*  | Group folders and `CLAUDE.md` memory files |
| `kubeclaw-sessions` | 20 Gi | RWX\*  | Claude SDK session state                   |

\*`kubeclaw-groups` and `kubeclaw-sessions` need RWX on multi-node clusters because both the orchestrator and agent Jobs mount them simultaneously. RWO works on single-node clusters where all pods schedule on the same node.

**Recommended storage classes by provider:**

| Provider    | Storage Class                              |
| ----------- | ------------------------------------------ |
| AWS         | EFS CSI driver (`efs.csi.aws.com`)         |
| Azure       | Azure Files (`azurefile-csi`)              |
| GCP         | Filestore (`filestore.csi.storage.gke.io`) |
| On-prem     | NFS provisioner or Longhorn                |
| Single-node | `standard` (minikube), `local-path` (kind) |

---

## Secrets Reference

### Required

| Secret             | Key                       | Description              |
| ------------------ | ------------------------- | ------------------------ |
| `kubeclaw-redis`   | `admin-password`          | Redis ACL admin password |
| `kubeclaw-secrets` | `anthropic-api-key`       | Anthropic API key        |
| `kubeclaw-secrets` | `claude-code-oauth-token` | Claude Code OAuth token  |

You need at least one of `anthropic-api-key` or `claude-code-oauth-token`.

### Optional (add to `kubeclaw-secrets`)

| Key                  | Description        |
| -------------------- | ------------------ |
| `openrouter-api-key` | OpenRouter API key |
| `slack-bot-token`    | Slack bot token    |
| `telegram-bot-token` | Telegram bot token |

---

## RBAC

The orchestrator runs with a minimal service account (`kubeclaw-orchestrator`) that has permission only to:

- Create, get, list, watch, delete **Jobs** (`batch/v1`)
- Get, list, watch **Pods** (to monitor job pods)
- Get **Pod logs**

No cluster-level permissions are required.

---

## Network Policy

`k8s/01-network-policy.yaml` restricts agent Job pods to egress-only traffic on:

- UDP/53 — DNS
- TCP/6379 — Redis (within namespace)
- TCP/443 — HTTPS (for Claude API and tool calls)

The orchestrator has no NetworkPolicy restrictions by default.

---

## Upgrading

1. Build new images
2. Load/push to your registry
3. Roll the orchestrator: `kubectl rollout restart deployment/kubeclaw-orchestrator -n kubeclaw`

In-progress agent Jobs will complete before the pod terminates (graceful shutdown). New jobs start on the new image automatically.

---

## Debugging

```bash
# Orchestrator logs
kubectl logs -f deployment/kubeclaw-orchestrator -n kubeclaw

# List recent agent jobs
kubectl get jobs -n kubeclaw --sort-by=.metadata.creationTimestamp

# Logs for a specific agent job
kubectl logs job/<job-name> -n kubeclaw

# Check Redis connectivity
kubectl exec -it statefulset/kubeclaw-redis -n kubeclaw -- \
  redis-cli -a $(kubectl get secret kubeclaw-redis -n kubeclaw \
    -o jsonpath='{.data.admin-password}' | base64 -d) ping

# Check PVC usage
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- \
  du -sh /workspace/groups/* /data/sessions/*
```

See also the `/debug` skill for guided troubleshooting.

---

## Uninstalling

```bash
kubectl delete namespace kubeclaw
```

This removes all resources. **PersistentVolumes are retained by default** — delete them manually if you want to remove all data:

```bash
kubectl delete pv $(kubectl get pv | grep kubeclaw | awk '{print $1}')
```
