# Credential Injection

## Overview

Tool-job pods previously received API keys as environment variables set at pod creation time. A prompt-injection attack — e.g. a model instructed to run `cat $ANTHROPIC_API_KEY` — could exfiltrate those secrets through any outbound channel available to the pod.

The credential-injection subsystem removes secrets from pod environments entirely. Instead, a credential broker holds the secrets and stamps outbound HTTPS requests with the appropriate `Authorization` header, without the workload ever seeing the key value. The workload's HTTP client points at a local proxy; the proxy asks the broker whether this identity may call this destination; the broker returns the header.

The dataplane proxy is an Envoy sidecar that runs in the workload's pod. Envoy listens on `localhost:8443` and intercepts all outbound HTTPS. For each request it calls the broker via Envoy's `ext_authz` mechanism (`POST /authz`), which performs identity verification (Kubernetes TokenReview) and maps the caller's ServiceAccount and destination hostname to a credential stored in a Kubernetes Secret. The broker returns the `Authorization` header value; Envoy stamps it on the upstream request and re-originates the TLS connection to the public internet using the system CA bundle.

```
Workload process
    │  HTTPS_PROXY=http://localhost:8443
    ▼
Envoy sidecar (localhost:8443)
    │  POST /authz  (ext_authz)
    ▼
Credential broker  (credential-broker.kubeclaw.svc:8080)
    │  TokenReview → identity: sa/kubeclaw-tool-job
    │  mapping lookup → (identity, api.anthropic.com) → Authorization: Bearer <key>
    │  returns 200 + Authorization header
    ▼
Envoy sidecar
    │  stamps Authorization header, re-originates TLS
    ▼
Upstream API  (api.anthropic.com, etc.)
```

Two injection modes are supported. `sidecar` (the default for new installs) attaches an Envoy container to every non-orchestrator pod and works on any Kubernetes cluster. `istio` is a Phase 2 option that leverages an existing Istio mesh instead of per-pod sidecars. `off` preserves legacy env-var behavior for installs that are not ready to migrate.

## Mode flag (`credentialInjection.mode`)

Set in your Helm values file or as a `--set` override:

```yaml
credentialInjection:
  mode: "sidecar"   # default
```

| Mode | Behavior | Requirement |
|---|---|---|
| `off` | No broker. API keys injected as env vars (legacy). | None. |
| `sidecar` | Per-pod Envoy sidecar intercepts outbound HTTPS. Broker stamps credentials. | cert-manager for internal CA. |
| `istio` | Istio egress gateway routes traffic through broker. No per-pod sidecar. | Istio CRDs already installed. |

The orchestrator pod is intentionally excluded from all modes — it is the trusted tier and retains credentials in environment variables.

## Adding a new mapping

The broker's mapping table lives in `helm/kubeclaw/templates/credential-broker-config.yaml` and is rendered into the `kubeclaw-credential-broker-config` ConfigMap. To add support for a new third-party API:

1. Add the API key to the `kubeclaw-secrets` Secret (same Secret that holds the existing LLM keys).
2. Add a mapping entry to the ConfigMap template.
3. Run `helm upgrade` — the broker hot-reloads when the ConfigMap changes.

Mapping schema:

```yaml
mappings:
  - id: <unique-identifier>
    destinations: ["<hostname>"]        # exact hostname(s) to match
    identities: ["*"]                   # "*" = any KubeClaw SA; or list specific SAs
    credentialRef:
      kind: Secret
      name: kubeclaw-secrets            # always this Secret
      key: <secret-key-name>
    headerScheme: bearer                # currently the only supported scheme
```

Example — adding Replicate:

```yaml
- id: replicate
  destinations: ["api.replicate.com"]
  identities: ["sa/kubeclaw-channel-http"]
  credentialRef: { kind: Secret, name: kubeclaw-secrets, key: replicate-api-key }
  headerScheme: bearer
```

The `identities` field accepts `["*"]` to allow any KubeClaw ServiceAccount, or a list of specific values in the form `sa/<name>` (derived from `system:serviceaccount:<namespace>:<name>`). Use specific identities when you want only certain tiers to call a given API.

## Identity model

Each non-orchestrator pod tier has its own Kubernetes ServiceAccount, created by the `serviceaccounts.yaml` template when `credentialInjection.mode` is not `off`:

- `kubeclaw-tool-job` — all tool-job pods
- `kubeclaw-channel-<name>` — one per enabled channel (e.g. `kubeclaw-channel-http`, `kubeclaw-channel-telegram`)
- `kubeclaw-capability-<name>` — one per capability pod

The Envoy sidecar mounts a projected ServiceAccount token via Kubernetes `TokenRequest` with audience `kubeclaw-credential-broker`. This token is short-lived and is automatically rotated by the kubelet.

When the sidecar calls `/authz`, it passes the projected token in the `Authorization` request header. The broker validates it via `TokenReview` (the broker holds the `system:auth-delegator` ClusterRoleBinding to perform this). From a successful review the broker derives the caller's identity as `sa/<serviceaccount-name>` and matches it against the mapping's `identities` list.

## Internal CA

The Envoy sidecar must terminate TLS for the workload's outbound HTTPS (since it acts as a proxy). It presents a certificate signed by an internal CA that the workload trusts, then independently re-originates TLS to the upstream using the public CA bundle.

When `internalCA.autoProvision: true` (the default), the `internal-ca.yaml` template creates:

- A cert-manager self-signed `Issuer` that bootstraps the root
- A cert-manager `Certificate` that produces the `kubeclaw-egress-ca-tls` Secret
- A second `Issuer` backed by that Secret, used to sign workload-facing certs

Workload pods mount the CA cert at `/etc/ssl/certs/kubeclaw-egress-ca.crt`. Two environment variables point runtimes at it:

```
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/kubeclaw-egress-ca.crt
SSL_CERT_FILE=/etc/ssl/certs/kubeclaw-egress-ca.crt
```

The upstream connection re-originates from Envoy using the system bundle (`/etc/ssl/certs/ca-certificates.crt`), so the internal CA never appears in any public trust path.

If you bring your own CA, set `internalCA.autoProvision: false` and create the `kubeclaw-egress-ca-tls` Secret manually before installing the chart. The chart will not create or modify that Secret when `autoProvision` is false.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Sidecar stuck `CrashLoopBackOff` | Envoy config schema error or missing ConfigMap | `kubectl logs <pod> -c credential-sidecar -n kubeclaw` |
| Workload gets `401` from broker | SA token rejected — wrong audience or namespace | Check `BROKER_AUDIENCE` env on broker pod; verify `serviceAccountName` on workload pod |
| Workload gets `403` | No mapping matches `(identity, destination)` | Check broker logs for `authz decision`; add or correct a mapping entry |
| Workload gets `503` | Broker cannot read the underlying Secret | RBAC issue or Secret deleted; check broker pod logs |
| `x509: certificate signed by unknown authority` | CA cert mount missing or env vars not set | Verify volume mount and `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` env vars on the pod |
| Broker pod not created | `credentialInjection.mode` is `"off"` | Confirm values; run `helm upgrade` after changing mode |

Useful commands:

```bash
# Broker logs (authz decisions are logged here)
kubectl logs deployment/kubeclaw-credential-broker -n kubeclaw

# Check that a workload pod has the sidecar container
kubectl get pod <pod-name> -n kubeclaw -o jsonpath='{.spec.containers[*].name}'

# Inspect the projected SA token audience
kubectl get pod <pod-name> -n kubeclaw -o yaml | grep -A5 serviceAccountToken

# Verify CA cert is mounted
kubectl exec <pod-name> -n kubeclaw -- ls -la /etc/ssl/certs/kubeclaw-egress-ca.crt
```

## Migration from `mode: off` to `mode: sidecar`

This guide walks an operator safely from environment-variable credential injection
(`mode: off`) to broker-stamped header injection (`mode: sidecar`) using `auditOnly`
as an observation window before cutting over enforcement.

### Prerequisites

- cert-manager is installed in the cluster. The standard KubeClaw setup
  (`npm run setup:minikube`) installs cert-manager v1.16.x automatically in
  Phase 3.5; production clusters typically already have cert-manager
  managed at the cluster level, in which case the setup step is a no-op.

  Verify:

  ```bash
  kubectl get crds | grep cert-manager.io
  # Expected: cert-manager.io CRDs listed
  ```

  To bypass cert-manager entirely (env-var injection of API keys instead
  of broker/sidecar TLS interception), run:

  ```bash
  helm upgrade kubeclaw helm/kubeclaw -n kubeclaw \
    --set credentialInjection.mode=off
  ```

  If you prefer to manage cert-manager yourself, v1.15+ is the chart minimum
  (the `crds.enabled` install value landed in v1.15; earlier releases used the
  legacy `installCRDs` key). KubeClaw's auto-managed Phase 3.5 pins v1.16.2
  for parity with what's exercised in CI — pin to the same when you can.

  ```bash
  helm install cert-manager jetstack/cert-manager \
    --namespace cert-manager --create-namespace \
    --version v1.16.2 \
    --set crds.enabled=true
  ```

  Then run KubeClaw's setup with `--skip-cert-manager`.

- `kubeclaw-secrets` contains all keys referenced by your broker mappings. The broker
  reads from the same Secret the orchestrator uses, so no new Secret is needed.

---

### Step A — Enable audit-only mode

Set `mode: sidecar` and `auditOnly: true` together. This deploys the broker and
Envoy sidecar but does **not** strip workload env vars and does **not** stamp the
`Authorization` header. Workloads continue to use their env-var API keys. The broker
logs every routing decision it **would** have made.

In your values override file:

```yaml
credentialInjection:
  mode: sidecar
  auditOnly: true
```

Then upgrade:

```bash
helm upgrade kubeclaw helm/kubeclaw -n kubeclaw -f your-values.yaml --wait
```

Pods restart with the Envoy sidecar injected and `HTTPS_PROXY` set. Upstream API calls
continue to work (the workload env-var key is still present and the broker returns `200`
with no `Authorization` header, so the workload's own header wins).

---

### Step B — Observe broker logs and metrics for ≥24 hours

Tail the broker logs and watch for `auditOnly: true` entries:

```bash
kubectl logs -f deployment/kubeclaw-credential-broker -n kubeclaw | grep auditOnly
```

Each line represents a request that flowed through the sidecar. Compare the count to
your expected upstream call volume. If the counts diverge, investigate missing or
extra routes.

Watch for `403` decisions (mapping not found for a destination):

```bash
kubectl logs deployment/kubeclaw-credential-broker -n kubeclaw | \
  python3 -c "import sys,json; [print(l) for l in sys.stdin if json.loads(l).get('status')==403]"
```

A `403` in audit-only mode means the broker would have blocked that request when
enforcement is on. Add a mapping in `credentialInjection.broker.config.mappings` for
any legitimate destination that appears.

If you have Prometheus Operator installed, enable the ServiceMonitor:

```yaml
credentialInjection:
  metrics:
    serviceMonitor:
      enabled: true
```

Then watch `credential_broker_authz_total` in Grafana. Once the counter is stable and
all `403`s are resolved, proceed to Step C.

---

### Step C — Flip to enforcement

Set `auditOnly: false`. Pods restart with API key env vars stripped. The broker now
stamps the `Authorization` header on every matched request.

```yaml
credentialInjection:
  mode: sidecar
  auditOnly: false
```

```bash
helm upgrade kubeclaw helm/kubeclaw -n kubeclaw -f your-values.yaml --wait
```

---

### Step D — Verify enforcement

Confirm upstream calls still succeed (broker stamps the header):

```bash
kubectl logs deployment/kubeclaw-credential-broker -n kubeclaw --tail=20
# Look for: "status":200, "auditOnly":false, "wouldStamp":true
```

Confirm API key env vars are absent from workload pods:

```bash
kubectl exec -n kubeclaw <tool-job-pod> -- env | grep -E 'ANTHROPIC|OPENAI|OPENROUTER'
# Expected: no output
```

---

### Rollback options

**Partial rollback (return to audit-only):** set `auditOnly: true` and upgrade. The
broker stays deployed, env vars return to workload pods, and upstream calls continue
to work via env-var keys. No service disruption.

**Full rollback (return to mode=off):** set `mode: off` and upgrade. The broker
Deployment and Envoy sidecars are removed. Env-var credential injection resumes.
This is a clean backout with no data loss.

```yaml
# Full backout
credentialInjection:
  mode: off
```

```bash
helm upgrade kubeclaw helm/kubeclaw -n kubeclaw -f your-values.yaml --wait
```

## Limitations

- The Envoy sidecar runs in the workload's network namespace. NetworkPolicy cannot enforce that outbound connections go through the sidecar — the actual enforcement is that the workload's HTTP client is pointed at `localhost:8443` via `HTTPS_PROXY`, which makes the sidecar the only path for correctly-authenticated calls. A workload that bypasses the proxy env var would receive no `Authorization` header and get a `401` from the upstream API.
- Only `headerScheme: bearer` is currently supported. OAuth token refresh, AWS SigV4, and similar schemes are on the roadmap.
- The sidecar adds 2-5 seconds to pod cold start (Envoy bootstrap, projected token mount, initial broker handshake).
- The orchestrator pod is excluded by design. It is the trusted tier; its credentials remain in environment variables.

## mode=istio (Istio egress gateway)

### When to use

Choose `mode=istio` if your cluster already runs **Istio 1.24 LTS or later**.
This mode replaces the per-pod Envoy sidecar from `mode=sidecar` with a single
namespace-level egress gateway, which gives:

- **Genuine iptables-enforced egress.** In `mode=sidecar`, the workload and the
  Envoy sidecar share a network namespace. NetworkPolicy cannot distinguish
  their traffic, so a workload process can theoretically open raw sockets.
  In `mode=istio`, the Istio init container installs iptables rules inside the
  workload's netns that force all egress through the mesh proxy. A workload
  cannot bypass the proxy without root access to the netns.
- **Fewer per-pod resources.** One gateway for the namespace instead of one
  sidecar per pod.
- **Istio observability integration.** Egress traffic shows up in Kiali,
  Jaeger, and Prometheus dashboards automatically.

### Prerequisites

1. Istio installed: `istioctl install --set profile=minimal -y`
2. Minimum Istio version: **1.24 LTS** (1.24.x recommended).
3. `kubectl get crd virtualservices.networking.istio.io` must return a result.

### Enabling

```yaml
credentialInjection:
  mode: "istio"
  istio:
    gateway:
      replicas: 2  # Set to 1 for dev, 2+ for production HA
      resources:
        requests: { cpu: 100m, memory: 128Mi }
        limits:   { cpu: 500m, memory: 256Mi }
    ambientMode: false   # Must remain false — see below
    additionalDestinations: []  # Add extra hostnames if needed
```

After `helm upgrade`, verify:
```bash
kubectl -n kubeclaw get sidecar
kubectl -n kubeclaw get serviceentry
kubectl -n kubeclaw get gateway
kubectl -n kubeclaw get virtualservice
kubectl -n kubeclaw get envoyfilter
```

### How it works

1. The kubeclaw namespace is labeled `istio-injection: enabled`.
2. All workload pods receive an `istio-proxy` sidecar. The orchestrator is
   excluded via `sidecar.istio.io/inject: "false"`.
3. The `Sidecar` resource restricts namespace egress to in-namespace services
   and ServiceEntry-declared upstreams.
4. One `ServiceEntry` per external API (Anthropic, OpenAI, etc.) declares the
   upstream to the Istio registry.
5. The `VirtualService` routes matching traffic from mesh sidecars through the
   `kubeclaw-istio-egressgateway` Deployment.
6. The `EnvoyFilter` on the gateway calls the credential-broker via `ext_authz`
   before forwarding. The broker reads the workload's SPIFFE identity from the
   `x-forwarded-client-cert` header populated by Istio's mTLS.
7. The broker returns an `Authorization` header; the gateway stamps it on the
   upstream request.

### How requests flow in `mode=istio`

Workloads in pods with the Istio sidecar (anything in the `kubeclaw`
namespace except the orchestrator) make outbound requests as plain HTTP
to the destination hostname:

```bash
curl http://api.openai.com/v1/chat/completions
```

The chart injects `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, and
`OPENROUTER_BASE_URL` with `http://` values into channel, capability,
and tool-job pods automatically — most SDKs pick these up.

The Istio sidecar intercepts the request, wraps it in mesh mTLS, and
forwards to `kubeclaw-istio-egressgateway`. The gateway terminates the
mTLS, runs ext_authz against `kubeclaw-credential-broker`, and the
broker returns an `Authorization: Bearer <secret>` header. Envoy
stamps it onto the request and originates TLS to the real upstream
(`api.openai.com:443`) per the `DestinationRule` for that host.

Workload-supplied `Authorization` headers (e.g. from a hard-coded
`OPENAI_API_KEY`) are overwritten by the gateway. In `mode=istio` the
chart sets the API-key envs to the literal string
`injected-by-broker` so SDKs that enforce client-side key presence
(OpenAI's official SDK, for example) construct successfully; the
placeholder is never used as a credential.

Voyage is not auto-injected because its SDK doesn't standardise on a
`VOYAGE_BASE_URL` env. Operators using voyage should set the
appropriate base-URL env on their workload pod themselves.

### `additionalDestinations` schema

Each entry is `"host[:upstreamPort]"`. The workload-facing listener is
always HTTP on port 80; `upstreamPort` (default 443) is what the
gateway originates TLS to. Examples:

| Value | Meaning |
|---|---|
| `"my-mcp.internal"` | HTTP on port 80 (workload), HTTPS on port 443 (upstream) |
| `"my-mcp.internal:8443"` | HTTP on port 80 (workload), HTTPS on port 8443 (upstream) |

Workloads targeting a custom destination must use `http://my-mcp.internal/`
(not `https://`). Set the matching `*_BASE_URL` env on your workload
spec if the SDK doesn't already read one of the auto-injected envs.

### Ambient mode

**Ambient mode (ztunnel + waypoint proxy) is out of scope for this release.**
Ambient's waypoint proxy supports header mutation via `EnvoyFilter`, but the
API stabilised only in Istio 1.26+. A follow-up plan will cover ambient mode.
Do not set `ambientMode: true` — it is accepted by the chart but has no effect.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `helm upgrade` fails: "credentialInjection.mode=istio requires Istio CRDs" | Istio not installed in cluster | Run `istioctl install --set profile=minimal -y` first |
| Egress gateway pod in `CrashLoopBackOff` | istiod not available or CRDs not ready | Check `kubectl get pods -n istio-system`; wait for istiod |
| Gateway 5xx responses | `EnvoyFilter` misconfigured or broker unreachable | Check `kubectl logs -n kubeclaw -l istio=kubeclaw-egressgateway`; verify `credential-broker` Service resolves |
| Broker returns 401 for XFCC requests | XFCC header not forwarded by Istio | Verify Istio version >= 1.24; check `EnvoyFilter` `allowed_headers` includes `x-forwarded-client-cert` |
| `Sidecar` resource hosts mismatch | ServiceEntry missing for a destination | Add host to `credentialInjection.istio.additionalDestinations` |
| Missing `VirtualService` after upgrade | Helm render error (Istio CRDs absent at template time) | Run `helm template` and check for errors; ensure CRDs present |
| Workload pod missing `istio-proxy` container | Namespace label not applied | Check `kubectl get namespace kubeclaw -o yaml`; re-run `helm upgrade` |
| Broker shows `no credentials: both authorization and xfcc are absent` | Traffic not going through Istio proxy | Verify iptables redirection: `kubectl exec <pod> -c istio-proxy -- pilot-agent request GET /config_dump` |

## Cross-references

- Implementation plan: `docs/superpowers/plans/2026-05-02-credential-injection.md`
- Security model: `docs/SECURITY.md`
- Sidecar ACL (Redis IPC): `docs/SIDECAR_ACL.md`
