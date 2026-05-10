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

- cert-manager is installed in the cluster:

  ```bash
  kubectl get crds | grep cert-manager.io
  # Expected: cert-manager.io CRDs listed
  ```

  If not installed: `helm install cert-manager jetstack/cert-manager --namespace cert-manager --create-namespace --set installCRDs=true`

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

## Cross-references

- Implementation plan: `docs/superpowers/plans/2026-05-02-credential-injection.md`
- Security model: `docs/SECURITY.md`
- Sidecar ACL (Redis IPC): `docs/SIDECAR_ACL.md`
