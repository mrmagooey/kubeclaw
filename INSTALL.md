# KubeClaw — Kubernetes Installation Guide

> **Running on a laptop?** Use `npm run setup:minikube` — see [docs/MINIKUBE.md](docs/MINIKUBE.md) for what the script does and how to customize it. The rest of this guide covers production / multi-node clusters.

## Overview

KubeClaw runs as two persistent services on Kubernetes:

- **Orchestrator** — manages pod lifecycles, mediates discovery, and coordinates tool jobs
- **Channel pods** — user-facing communication (Telegram, Slack, etc.), each owns its LLM conversation directly
- **Redis** — message bus between all tiers

```
User message
    │
    ▼
Channel Pod (Deployment) ──► LLM Provider API
    │  requests tool via Redis
    ▼
Orchestrator (Deployment) ──► spawns Tool Job (batch/Job)
    │
    ▼
Tool result → back through channel
```

## Before You Start

> **Read this even if you're in a hurry** — several host-level issues regularly bite users during setup and are covered in the Troubleshooting section:
> - **Linux hosts (especially Ubuntu 22.04+)**: `fs.inotify.max_user_instances` must be ≥ 512. The default (128 on Ubuntu) is too low and causes watch failures. See Troubleshooting → "Linux inotify limits".
> - **iptables-nft hosts** (Ubuntu 24.04+ default): if you plan to use Cilium CNI on a remote cluster, it is incompatible with `iptables-nft`. Use the default bridge CNI or reconfigure to `iptables-legacy`. See "CNI and iptables".
> - **Resources**: For local testing, budget ~6 GB RAM and ~4 CPUs for a single-node cluster. For production multi-node clusters, allocate resources proportional to expected concurrent tool jobs (default max 10; each job requests 512 MiB–2 Gi).
> - **Build time**: First-time setup takes ~5 minutes for image builds and Kubernetes initialization. Budget additional time if you enable optional security tools (Falco eBPF probe compilation adds ~3 minutes).
> - **Network**: Tool pods reach the public internet by default to call the Claude API and run tools. Self-hosted LLM endpoints require network policy adjustments (see "Self-hosted endpoint network policy" for egress rules).

## Prerequisites

- Kubernetes 1.24+ with `batch/v1` Job support
- `kubectl` configured for your cluster
- `helm` 3.x
- Container runtime (Docker or compatible)
- Persistent storage with **ReadWriteMany** (RWX) for multi-node clusters, or ReadWriteOnce (RWO) for single-node

## Quick Start

> **Laptop / local install?** Run `npm run setup:minikube` and see [docs/MINIKUBE.md](docs/MINIKUBE.md). The rest of this guide covers production / multi-node clusters.

### 1. Build Images

```bash
# Build the tool container
./container/build.sh

# Build the orchestrator image
docker build -t your-registry/kubeclaw-orchestrator:latest .
docker push your-registry/kubeclaw-orchestrator:latest
```

### 2. Install with Helm

```bash
helm install kubeclaw ./helm/kubeclaw \
  --set image.registry=your-registry \
  --set secrets.anthropicApiKey=sk-ant-... \
  --set storage.accessMode=ReadWriteMany \
  --set storage.storageClass=efs-csi \
  --namespace kubeclaw --create-namespace
```

Then apply the Pod Security labels that allow Redis and the orchestrator to run with the required UIDs:

```bash
kubectl label namespace kubeclaw \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/enforce-version=latest \
  --overwrite
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

#### Self-hosted / OpenAI-compatible endpoint

Any endpoint that implements the OpenAI Chat Completions API can be used as the LLM backend for the channel pods. This includes:

- **llama.cpp** — fast local inference from GGUF models
- **Ollama** — simple local model server (Mac, Linux, Windows)
- **vLLM** — high-throughput serving framework
- **LocalAI** — drop-in replacement for OpenAI API
- **Groq** — fast inference cloud API
- **Mistral** — Mistral's managed API
- Any other compatible endpoint

To use a self-hosted endpoint, set these three values:

```bash
helm install kubeclaw ./helm/kubeclaw \
  --set secrets.openaiApiKey=local \
  --set secrets.openaiBaseUrl=http://192.168.7.100:8080/v1 \
  --set secrets.directLlmModel=mistral-7b-instruct \
  --namespace kubeclaw --create-namespace
```

| Variable                     | Description                                                    |
| ---------------------------- | -------------------------------------------------------------- |
| `secrets.openaiApiKey`       | API key for the endpoint. Use a placeholder (e.g. `local`) if the endpoint has no authentication. |
| `secrets.openaiBaseUrl`      | Full base URL including `/v1` suffix. Examples: `http://192.168.7.100:8080/v1`, `http://ollama:11434/v1`, `https://api.groq.com/openai/v1`. |
| `secrets.directLlmModel`     | Model identifier the endpoint expects (e.g. `mistral-7b-instruct`, `neural-chat`, `gpt-4`). |

**Reachability**: The LLM endpoint must be reachable from inside the cluster. For single-node clusters (minikube, kind), endpoints on your host machine are typically reachable via host IP. To verify reachability:

```bash
kubectl run --rm -i probe --image=curlimages/curl:latest --restart=Never -- \
  curl -sS http://192.168.7.100:8080/v1/models
```

If the endpoint uses a non-standard port (not 80/443), the chart's network policy will block the connection. Use `networkPolicy.extraEgressPorts` to allow specific ports without disabling the policy:

```bash
helm install kubeclaw ./helm/kubeclaw \
  --set 'networkPolicy.extraEgressPorts={8080,11434}' \
  ...
```

The example above allows TCP 8080 (llama.cpp) and 11434 (Ollama) for channel, agent, and tool pods. The orchestrator policy is unrestricted by default and not affected.

If you need a blunt escape hatch (e.g. for debugging), `--set networkPolicy.enabled=false` removes all egress restrictions.

### Kubernetes Runtime

| Variable               | Default                       | Description                                                                                           |
| ---------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `KUBECLAW_RUNTIME`     | `kubernetes`                  | Kubernetes namespace runtime identifier                                                               |
| `KUBECLAW_NAMESPACE`   | `kubeclaw`                    | Kubernetes namespace for tool Jobs                                                                    |
| `KUBECLAW_IPC_BASE`    | `/data/sessions`              | Mount path for the sessions PVC (must match orchestrator volumeMount)                                 |
| `MAX_CONCURRENT_JOBS`  | `10`                          | Maximum parallel tool Jobs                                                                            |
| `REDIS_URL`            | `redis://kubeclaw-redis:6379` | Redis connection URL                                                                                  |
| `REDIS_ADMIN_PASSWORD` | —                             | Redis ACL admin password (from `kubeclaw-redis` secret)                                               |
| `ACL_ENCRYPTION_KEY`   | —                             | 32-byte key to encrypt ACL credentials at rest. If unset, a derived key is used (insecure — dev only) |

### Tool Job Resources

These control the resource requests/limits for each tool Job pod.

| Variable                  | Default | Description                 |
| ------------------------- | ------- | --------------------------- |
| `TOOL_JOB_MEMORY_REQUEST` | `512Mi` | Memory request per tool Job |
| `TOOL_JOB_MEMORY_LIMIT`   | `4Gi`   | Memory limit per tool Job   |
| `TOOL_JOB_CPU_REQUEST`    | `250m`  | CPU request per tool Job    |
| `TOOL_JOB_CPU_LIMIT`      | `2000m` | CPU limit per tool Job      |

### Container Behaviour

| Variable                     | Default                     | Description                                   |
| ---------------------------- | --------------------------- | --------------------------------------------- |
| `CONTAINER_TIMEOUT`          | `1800000`                   | Max agent runtime in ms (30 min)              |
| `CONTAINER_MAX_OUTPUT_SIZE`  | `10485760`                  | Max agent output in bytes (10 MB)             |
| `IDLE_TIMEOUT`               | `1800000`                   | Idle timeout after last result in ms (30 min) |
| `CLAUDE_CONTAINER_IMAGE`     | `kubeclaw-agent:claude`     | Image for Claude-backed agents                |
| `OPENROUTER_CONTAINER_IMAGE` | `kubeclaw-agent:openrouter` | Image for OpenRouter-backed agents            |

### Channel Integrations

Add secrets for any channels you use. For guided setup, use the orchestrator admin shell — see [docs/INSTALLING_A_CHANNEL.md](docs/INSTALLING_A_CHANNEL.md). The variables below are reference-only; the admin shell collects them interactively.

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

\*`kubeclaw-groups` and `kubeclaw-sessions` need RWX on multi-node clusters because the orchestrator, channel pods, and tool Jobs mount them simultaneously. RWO works on single-node clusters where all pods schedule on the same node.

**Recommended storage classes by provider:**

| Provider    | Storage Class                              |
| ----------- | ------------------------------------------ |
| AWS         | EFS CSI driver (`efs.csi.aws.com`)         |
| Azure       | Azure Files (`azurefile-csi`)              |
| GCP         | Filestore (`filestore.csi.storage.gke.io`) |
| On-prem     | NFS provisioner or Longhorn                |
| Single-node | `standard` (minikube), `local-path` (kind) |

### Multi-replica channels

By default, each channel Deployment runs as a single pod (`replicas: 1`). The per-channel runtime PVC (`kubeclaw-channel-<instance>-runtime`) uses `ReadWriteOnce` — only one pod may mount it at a time. Scaling beyond 1 replica on a RWO PVC causes a `Multi-Attach error` on the second pod.

To enable multi-replica steady-state channel pods, provision an RWX-capable storage class and configure the chart:

```bash
helm upgrade kubeclaw ./helm/kubeclaw \
  --set bootstrap.runtimePvc.accessModes[0]=ReadWriteMany \
  --set bootstrap.steadyState.defaultReplicas=2 \
  -n kubeclaw
```

**Common RWX storage classes by provider:**

| Provider | Storage Class | Notes |
|----------|--------------|-------|
| AWS | EFS CSI (`efs.csi.aws.com`) | Provision an AccessPoint per PVC for isolation |
| GCP | Filestore (`filestore.csi.storage.gke.io`) | Requires a Filestore instance; supports RWX |
| Azure | Azure Files (`azurefile-csi`) | SMB/NFS backed; supports RWX in AKS |
| On-prem | NFS provisioner / Longhorn | Use `nfs.csi.k8s.io` or Longhorn with RWX mode |
| minikube | NFS via `storage-provisioner-rancher` | Enable: `minikube addons enable storage-provisioner-rancher` |
| kind | csi-driver-nfs | Install: `helm install csi-driver-nfs csi-driver-nfs/csi-driver-nfs` |

**minikube NFS setup:**

```bash
minikube addons enable storage-provisioner-rancher
kubectl apply -f - <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-sc
provisioner: rancher.io/local-path
volumeBindingMode: WaitForFirstConsumer
EOF
```

Then upgrade the chart with `--set bootstrap.runtimePvc.accessModes[0]=ReadWriteMany`.

**kind / csi-driver-nfs setup:**

```bash
helm repo add csi-driver-nfs https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/master/charts
helm install csi-driver-nfs csi-driver-nfs/csi-driver-nfs --namespace kube-system
```

Create a StorageClass pointing at your NFS server, then set the chart values as above.

> **Note:** The runtime PVC mounts **read-only** on all steady-state replicas and **read-write** on the bootstrap Job only. This is an invariant enforced by KubeClaw — it holds regardless of the PVC's accessModes.

> **Note:** A `HorizontalPodAutoscaler` named `kubeclaw-channel-rwo-guardrail` is deployed when `bootstrap.runtimePvc.accessModes` does not include `ReadWriteMany`. It caps channel Deployments at `maxReplicas: 1`. When you switch to RWX, the HPA is not rendered and channel Deployments may scale freely. The HPA exists solely as a guardrail — operators who want true auto-scaling should disable it and install their own.

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

`k8s/01-network-policy.yaml` restricts tool Job pods to egress-only traffic on:

- UDP/53 — DNS
- TCP/6379 — Redis (within namespace)
- TCP/443 — HTTPS (for Claude API and tool calls)

The orchestrator has no NetworkPolicy restrictions by default.

---

## Upgrading

1. Build new images
2. Load/push to your registry
3. Roll the orchestrator: `kubectl rollout restart deployment/kubeclaw-orchestrator -n kubeclaw`

In-progress tool Jobs will complete before the pod terminates (graceful shutdown). New jobs start on the new image automatically.

---

## Debugging

```bash
# Orchestrator logs
kubectl logs -f deployment/kubeclaw-orchestrator -n kubeclaw

# List recent tool jobs
kubectl get jobs -n kubeclaw --sort-by=.metadata.creationTimestamp

# Logs for a specific tool job
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

## Troubleshooting

### Linux inotify limits

On Linux hosts, the kernel parameter `fs.inotify.max_user_instances` limits how many inotify watches a single user can create. The default on Ubuntu is 128, which is too low for KubeClaw's persistent file watching in agent jobs.

**Symptom:** Agent jobs timeout or fail with `ENOSPC` ("No space left on device") when attempting file operations.

**Fix:** Increase the limit to at least 512:

```bash
sudo sysctl -w fs.inotify.max_user_instances=512
```

To make it permanent, edit `/etc/sysctl.conf`:

```
fs.inotify.max_user_instances=512
```

Then apply:

```bash
sudo sysctl -p
```

### CNI and iptables

Modern Linux distributions (Ubuntu 24.04+, Debian 13+) default to `iptables-nft` instead of `iptables-legacy`. The Cilium CNI does not support `iptables-nft` and will fail to install on such systems.

**Symptom:** When deploying on a non-minikube cluster with Cilium, pods fail to schedule or show `NetworkPolicy` enforcement errors.

**Fix:** Use the default Kubernetes bridge CNI instead of Cilium, or reconfigure your host to use `iptables-legacy`:

**Option 1 (recommended):** Use the default bridge CNI by omitting the Cilium chart from your Helm values. The default `NetworkPolicy` controller will provide basic network isolation.

**Option 2:** Reconfigure iptables to use legacy mode:

```bash
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy
```

Then restart your Kubernetes cluster. After the cluster is ready, deploy Cilium via Helm.

### Self-hosted endpoint network policy

Tool pods run with a `NetworkPolicy` that restricts egress to specific ports and (optionally) FQDNs. If you use a self-hosted LLM endpoint on a non-standard port, you must allow it explicitly.

**Symptom:** Tool jobs timeout when calling `--set secrets.openaiBaseUrl=http://...`.

**Fix:** Add the endpoint's port to `networkPolicy.egressPorts` in your Helm values:

```bash
helm install kubeclaw ./helm/kubeclaw \
  --set networkPolicy.egressPorts[0]=53 \
  --set networkPolicy.egressPorts[1]=443 \
  --set networkPolicy.egressPorts[2]=6379 \
  --set networkPolicy.egressPorts[3]=8080 \
  --namespace kubeclaw --create-namespace
```

Or add it to a custom `values.yaml` file under the `networkPolicy` section.

---

## Uninstalling

```bash
kubectl delete namespace kubeclaw
```

This removes all resources. **PersistentVolumes are retained by default** — delete them manually if you want to remove all data:

```bash
kubectl delete pv $(kubectl get pv | grep kubeclaw | awk '{print $1}')
```
