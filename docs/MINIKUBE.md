# KubeClaw on minikube (Laptop Deployment)

Run KubeClaw locally on a laptop using minikube and **Falco** for runtime security. A single command provisions the cluster, builds images, installs security tooling, and deploys KubeClaw.

By default the setup uses minikube's built-in **bridge** CNI (or auto-detects the best CNI for your host). Cilium is opt-in via `--cni=cilium` or `--with-cilium`.

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

That's it. After ~10 minutes (mostly Falco's eBPF probe compilation) you'll have:

- A minikube cluster (bridge CNI by default, or Cilium if requested)
- Falco monitoring tool job behaviour
- KubeClaw orchestrator and Redis deployed and ready

Then run `/setup` in Claude Code to configure your API keys and channels.

### Options

```bash
npm run setup:minikube -- --reset             # delete and recreate the minikube cluster
npm run setup:minikube -- --skip-build        # skip container image build (use existing)
npm run setup:minikube -- --skip-falco        # skip Falco install
npm run setup:minikube -- --cpus 6            # use 6 CPUs (default: 4)
npm run setup:minikube -- --memory 8192       # use 8 GB RAM (default: 6144 MiB)
npm run setup:minikube -- --profile kubeclaw  # use a named minikube profile (default: minikube)
npm run setup:minikube -- --with-cilium       # opt-in to Cilium CNI
npm run setup:minikube -- --cni=cilium        # same as --with-cilium
npm run setup:minikube -- --cni=bridge        # force bridge CNI (minikube default)
npm run setup:minikube -- --cni=auto          # auto-detect based on host iptables backend (default)
```

`--profile` lets you run KubeClaw alongside other minikube clusters without collision. The profile name is passed as `-p <name>` to every `minikube` command. `minikube start -p <name>` automatically sets the matching kubectl context, so all subsequent `kubectl` calls follow the correct cluster.

## What It Does

### Phase 1 — Cluster

Starts minikube with the Docker driver and the resolved CNI. The default CNI mode is `auto`:

- **auto (default):** Detects the host iptables backend by running `iptables --version`. If the output contains `nf_tables` (Ubuntu 24.04 default), the setup falls back to `bridge` and logs a warning. Otherwise it uses Cilium.
- **bridge:** Uses minikube's built-in bridge CNI. Works on all hosts. No FQDN egress policies.
- **cilium:** Uses Cilium CNI. Requires iptables-legacy-compatible hosts. Enables FQDN egress policies.

If minikube is already running with Cilium and `--cni=cilium` is active, this phase is skipped. If it's running without Cilium and Cilium was requested, re-run with `--reset`.

## CNI Selection

The CNI controls network policy enforcement and eBPF-based packet filtering.

| CNI | FQDN egress policies | Requires | Notes |
|---|---|---|---|
| bridge | No | nothing | Works everywhere; standard K8s NetworkPolicy only |
| cilium | Yes | iptables-legacy | Blocks non-allowlisted FQDNs; better observability |

**Default:** `auto` — bridge is selected automatically on hosts using iptables-nft (Ubuntu 24.04+). Cilium is selected on hosts with iptables-legacy.

**When to choose Cilium:** You want strict FQDN egress policies (blocking agent internet access to non-allowlisted hostnames). Your host uses iptables-legacy (`iptables --version` shows `legacy`, not `nf_tables`).

**When to stick with bridge:** You're on Ubuntu 24.04 or any host where `iptables --version` reports `nf_tables`. Cilium will crashloop on these hosts due to kernel iptables incompatibility.

### Phase 2 — Image Build

Sets `DOCKER_HOST` to minikube's internal Docker daemon and builds the container images directly inside it. No image registry or `minikube image load` needed — `imagePullPolicy: Never` (the default when no registry is set) picks them up instantly.

### Phase 3 — Falco

Installs Falco from the [falcosecurity Helm chart](https://github.com/falcosecurity/charts) using the `modern_ebpf` driver — CO-RE eBPF that works without kernel headers or `/sys/kernel/debug` access, making it compatible with minikube's Docker-based node.

Four custom rules are deployed for KubeClaw agent pods:

| Rule | Priority | What it catches |
|---|---|---|
| Unexpected outbound port | WARNING | Connections to ports other than 53, 443, 6379 |
| Privilege escalation attempt | CRITICAL | su, sudo, newgrp, newuidmap, newgidmap |
| Sensitive file read | ERROR | SSH keys, AWS credentials, /etc/shadow, .kube/config |
| Unexpected shell spawn | WARNING | Shells launched from non-entrypoint parents |

View alerts: `kubectl logs -n falco daemonset/falco --follow`

### Phase 4 — KubeClaw Helm Deploy

Deploys KubeClaw using the Helm chart with `helm/kubeclaw/values-minikube.yaml` — laptop-sized resource requests and Cilium network policies enabled. Immediately after the Helm install, the script applies `pod-security.kubernetes.io/enforce=privileged` labels to the `kubeclaw` namespace so the admission controller permits privileged pods (Redis, orchestrator).

### Phase 5 — Verify

Checks that the orchestrator, Redis, Falco, and CiliumNetworkPolicy resources are all present and ready.

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

**Cilium fails to start on Ubuntu 24.04 / iptables-nft hosts:** Symptoms include `cilium-operator` crashlooping, `kube-proxy` errors (`failed complete: too many open files`), and cilium init containers failing with `dial tcp 10.96.0.1:443: connect: no route to host`. This happens because Cilium requires iptables-legacy but Ubuntu 24.04 defaults to `iptables-nft`. Workaround: use bridge CNI instead.

```bash
# Reset and use bridge CNI
npm run setup:minikube -- --reset --cni=bridge

# Or verify what your host uses:
iptables --version   # shows "(nf_tables)" or "(legacy)"
```

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
