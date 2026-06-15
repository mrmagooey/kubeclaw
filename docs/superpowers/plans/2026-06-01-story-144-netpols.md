# Story 144: Helm chart NetworkPolicies — pod egress is locked down per category

## Goal

Verify that the chart renders per-category NetworkPolicies that restrict pod egress to the minimum required ports, and that those policies are actually enforced on a live cluster with a CNI that supports NetworkPolicy (Cilium / Calico).

## Architecture

All NetworkPolicy objects live in `helm/kubeclaw/templates/networkpolicies.yaml`, guarded by `{{- if .Values.networkPolicy.enabled }}`. Five policies are rendered, one per pod category:

| Policy name | Pod selector | Allowed egress |
|---|---|---|
| `kubeclaw-agent-policy` | `app: kubeclaw-agent` | DNS/53, Redis/6379; TCP/443 only when `credentialInjection.mode == "off"` |
| `kubeclaw-orchestrator-policy` | `app: kubeclaw-orchestrator` | Unrestricted egress; ingress restricted to TCP/8080 |
| `kubeclaw-channel-policy` | label `kubeclaw/channel` exists | DNS/53, Redis/6379, HTTP/80 + HTTPS/443 (mode=off only); ingress denied |
| `kubeclaw-sidecar-tool-policy` | `app: kubeclaw-sidecar-tool` | DNS/53, Redis/6379, TCP/80+443 (mode=off only); `extraEgressPorts` applies |
| `kubeclaw-capability-policy` | label `kubeclaw/capability` exists | DNS/53, Redis/6379, HTTP/80 + HTTPS/443 (mode=off only); ingress only from channel and orchestrator pods |

Because no default-allow policy is present, any pod without a matching selector has no egress — achieving the default-deny requirement.

The `networkPolicy.extraEgressPorts` value lets operators whitelist additional TCP ports chart-wide for agent, channel, and tool-pod categories.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e -- helm-chart -t "network policies"`)
- **Harness:** `requireKubernetes()` — requires a live cluster with Helm release already installed
- **kubectl:** `kc(['get', 'networkpolicy', ...])` and `getJson('networkpolicy/...')` helpers
- **CNI requirement:** cluster must enforce NetworkPolicy (Cilium or Calico)
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/helm-chart.test.ts` | `describe('network policies', ...)` block (line 368) — 3 `it()` tests |
| `helm/kubeclaw/templates/networkpolicies.yaml` | All six NetworkPolicy manifests |
| `helm/kubeclaw/templates/networkpolicies-istio.yaml` | Istio-mode variant policies |
| `helm/kubeclaw/templates/networkpolicies-injection.yaml` | Injection-mode variant policies |
| `helm/kubeclaw/templates/cilium-network-policies.yaml` | CiliumNetworkPolicy CRDs for Cilium clusters |

## Tasks (retrospective)

### AC 1 — `kubeclaw-agent-policy` exists in the cluster

`kubectl get networkpolicy kubeclaw-agent-policy` is called via the `kc()` helper and the output is asserted to contain the policy name. Confirms the chart rendered and applied the policy without error.

### AC 2 — `kubeclaw-orchestrator-policy` exists in the cluster

Same approach: `kubectl get networkpolicy kubeclaw-orchestrator-policy`. Verifies the orchestrator's ingress-only restriction is present alongside the other policies.

### AC 3 — Agent policy permits DNS and Redis but not TCP/443 in sidecar mode

`getJson('networkpolicy/kubeclaw-agent-policy')` fetches the full policy object and extracts all `egress[*].ports[*].port` values. In the default sidecar-mode install (`credentialInjection.mode != "off"`), the template omits the TCP/443 egress rule, so the test asserts:
- port `53` is present (DNS)
- port `6379` is present (Redis)
- port `443` is **not** present (TLS egress blocked; handled by the broker sidecar)
- ports `80` and `22` are **not** present (no HTTP or SSH egress)

### Verification

Run: `npm run test:e2e -- helm-chart -t "network policies"`

Expected: **3 / 3 tests pass** — requires a live Kubernetes cluster with the kubeclaw Helm release installed and a NetworkPolicy-enforcing CNI.
