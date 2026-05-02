# KubeClaw on minikube (Laptop Deployment)

Run KubeClaw locally on a laptop using minikube. A single command provisions the cluster, builds images, and deploys KubeClaw. Cilium CNI is always installed for network policy enforcement. Falco runtime security is installed by default and can be skipped with `--skip-falco`.

## Prerequisites

Install the following before running setup:

| Tool | Install |
|---|---|
| [minikube](https://minikube.sigs.k8s.io/docs/start/) | `brew install minikube` / package manager |
| [kubectl](https://kubernetes.io/docs/tasks/tools/) | usually bundled with minikube |
| [helm](https://helm.sh/docs/intro/install/) | `brew install helm` |
| [docker](https://docs.docker.com/get-docker/) | Docker Desktop or Docker Engine |

**Minimum resources:** 4 CPUs and 6 GB RAM free for the minikube VM (plus host OS overhead).

## Quick Start

```bash
npm run setup:minikube
```

After ~10 minutes (mostly Falco's eBPF probe compilation) you'll have:

- A minikube cluster running Cilium CNI
- Falco monitoring tool job behaviour (unless skipped)
- KubeClaw orchestrator and Redis deployed and ready

Then run `/setup` in Claude Code to configure your API keys and channels.

### Flags

| Flag | Default | Description |
|---|---|---|
| `--reset` | off | Delete and recreate the minikube cluster from scratch |
| `--skip-build` | off | Skip container image build (use existing images in the minikube daemon) |
| `--skip-falco` | off | Skip Falco installation (Cilium network policy enforcement still active) |
| `--cpus N` | `4` | Number of CPUs to allocate to the minikube VM |
| `--memory N` | `6144` | RAM to allocate in MiB (e.g. `--memory 8192` for 8 GB) |
| `--disk SIZE` | `20g` | Disk size for the minikube VM (e.g. `--disk 40g`) |

### Planned flags

These flags are in active development across other PRs and may not be available on `main` yet — see the issue tracker for status.

| Flag | Default | Description |
|---|---|---|
| `--profile <name>` | minikube default | Name the minikube profile/cluster. Useful for running multiple kubeclaw clusters on one machine. |
| `--cni <auto\|bridge\|cilium>` | `auto` | Choose the CNI. `auto` detects the host iptables backend and falls back to `bridge` on iptables-nft hosts. `cilium` enables FQDN egress policies but requires an iptables-legacy compatible host. |
| `--with-cilium` | off | Shortcut for `--cni=cilium`. |

Examples:

```bash
npm run setup:minikube -- --reset               # delete and recreate the cluster
npm run setup:minikube -- --skip-build          # skip image build, use existing
npm run setup:minikube -- --skip-falco          # skip Falco (faster, less security monitoring)
npm run setup:minikube -- --cpus 6 --memory 8192  # give the VM more resources
npm run setup:minikube -- --skip-falco --skip-build  # fastest re-deploy
```

## What It Does

The script runs five phases in order:

### Phase 1 — Start minikube (Cilium CNI)

Starts minikube with `--cni=cilium` and the Docker driver. Cilium replaces kube-proxy with eBPF-based packet processing and enforces Kubernetes `NetworkPolicy` resources with better performance and observability than iptables. _(future: `--cni` flag will make this opt-in; see [Planned flags](#planned-flags) below)_

If minikube is already running with Cilium, this phase is skipped. If it's running without Cilium, you'll be prompted to re-run with `--reset`.

### Phase 2 — Build images

Sets `DOCKER_HOST` to minikube's internal Docker daemon and builds the container images directly inside it. No image registry or `minikube image load` needed — `imagePullPolicy: Never` picks them up instantly.

Skipped with `--skip-build`.

### Phase 3 — Install Falco (opt-in, on by default)

Installs Falco from the [falcosecurity Helm chart](https://github.com/falcosecurity/charts) using the `modern_ebpf` driver — CO-RE eBPF that works without kernel headers or `/sys/kernel/debug` access, compatible with minikube's Docker-based node.

Four custom rules are deployed for KubeClaw agent pods:

| Rule | Priority | What it catches |
|---|---|---|
| Unexpected outbound port | WARNING | Connections to ports other than 53, 443, 6379 |
| Privilege escalation attempt | CRITICAL | su, sudo, newgrp, newuidmap, newgidmap |
| Sensitive file read | ERROR | SSH keys, AWS credentials, /etc/shadow, .kube/config |
| Unexpected shell spawn | WARNING | Shells launched from non-entrypoint parents |

View alerts: `kubectl logs -n falco daemonset/falco --follow`

**Skip with `--skip-falco`** — Cilium network policy enforcement remains active. Use this for faster re-deploys or when you don't need runtime syscall monitoring.

### Phase 4 — Deploy KubeClaw via Helm

Deploys KubeClaw using the Helm chart with `helm/kubeclaw/values-minikube.yaml` (laptop-sized resource requests) and `values-cilium.yaml` (Cilium network policies).

### Phase 5 — Verify

Checks that the orchestrator, Redis, Falco (if installed), and CiliumNetworkPolicy resources are all present and ready.

## Network Security (CiliumNetworkPolicy)

The minikube deployment uses `CiliumNetworkPolicy` with `toFQDNs` rules to restrict external connections to specific hostnames instead of allowing all port-443 traffic.

### Default: Strict Mode

Tool jobs can only reach:
- `api.anthropic.com` — Anthropic API (required)
- `statsig.anthropic.com` — Claude Code feature flags (required by the SDK)

The orchestrator can additionally reach the Kubernetes API server and whatever FQDNs are listed in `ciliumNetworkPolicy.orchestrator.allowedFQDNs`.

**Trade-off:** The agent's browser tool (Chromium) and arbitrary `curl`/`git` in bash will be blocked. This is the right default for a laptop that also holds SSH keys, AWS credentials, etc.

### Tool-Friendly Mode

To allow the browser tool and arbitrary HTTPS from tool jobs, uncomment the `matchPattern: "*"` entry in `helm/kubeclaw/values-cilium.yaml`:

```yaml
ciliumNetworkPolicy:
  agent:
    allowedFQDNs:
      - api.anthropic.com
      - statsig.anthropic.com
      - matchPattern: "*"   # <-- allows arbitrary HTTPS; non-HTTPS ports still blocked
```

Non-HTTPS egress remains blocked. Falco still monitors and alerts on all outbound connections.

### Adding Channel FQDNs

When you enable a channel, add its API hostname to the orchestrator allowlist in `values-cilium.yaml`:

| Channel | Add to orchestrator.allowedFQDNs |
|---|---|
| Telegram | `api.telegram.org` |
| Slack | `slack.com`, `wss-primary.slack.com` |
| Discord | `discord.com`, `gateway.discord.gg` |
| Gmail | `oauth2.googleapis.com`, `www.googleapis.com` |
| WhatsApp | `web.whatsapp.com` (plus dynamic `*.whatsapp.net` — consider tool-friendly mode) |

After editing, apply:
```bash
helm upgrade kubeclaw ./helm/kubeclaw \
  -f ./helm/kubeclaw/values-minikube.yaml \
  -f ./helm/kubeclaw/values-cilium.yaml \
  -n kubeclaw
```

## Resource Usage

Approximate peak on a 6 GB minikube node:

| Component | Memory limit |
|---|---|
| Orchestrator | 256 Mi |
| Redis | 512 Mi |
| Falco | 512 Mi |
| One tool job | 2 Gi |
| **Total peak** | **~3.3 Gi** |

This leaves headroom on a 6 GB node. Increase `--memory` if you run multiple concurrent tool jobs (max 3 by default).

## Troubleshooting

```bash
# Overall pod status
kubectl get pods -n kubeclaw
kubectl get pods -n falco
kubectl get pods -n kube-system -l k8s-app=cilium

# Orchestrator logs
kubectl logs -n kubeclaw deploy/kubeclaw-orchestrator --tail=50

# Falco alerts
kubectl logs -n falco daemonset/falco --tail=50

# Check CiliumNetworkPolicy is applied
kubectl get ciliumnetworkpolicies -n kubeclaw

# Test that agent egress is restricted (should be blocked):
kubectl run test --rm -it --image=alpine --labels='app=kubeclaw-agent' \
  -- wget -qO- --timeout=5 https://example.com

# Verify Cilium is enforcing policies
kubectl exec -n kube-system daemonset/cilium -- cilium policy get
```

### Common Issues

**`cilium_not_ready` after start:** Cilium's eBPF programs take 60–90 seconds to load. Wait a moment and retry. If it persists: `kubectl describe daemonset cilium -n kube-system`.

**`falco_not_ready`:** The `modern_ebpf` probe needs to compile on first boot. Wait up to 3 minutes. Check: `kubectl logs -n falco daemonset/falco`.

**Images not found (`ErrImageNeverPull`):** The build phase failed or was skipped. Run `npm run setup:minikube -- --skip-falco` to rebuild without reinstalling Falco, or check Docker build logs.

**Tool jobs blocked:** If a tool job can't reach the API, check the CiliumNetworkPolicy allowlist in `values-minikube.yaml` and redeploy with `helm upgrade`.

## Stopping and Cleanup

```bash
minikube stop          # suspend the cluster (preserves state)
minikube start         # resume

minikube delete        # permanently destroy the cluster and all data
```

To upgrade KubeClaw after pulling changes:

```bash
npm run build
npm run setup:minikube -- --skip-falco  # skips Falco reinstall (already installed)
```
