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
| `auto` | Detect Istio CRDs at install time; fall back to `sidecar` if absent. | Depends on detected mode. |

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

1. Confirm that `kubeclaw-secrets` contains all required keys. The broker reads from this same Secret, so no new Secret is needed — only the keys the mappings reference must exist.
2. Confirm cert-manager is installed in the cluster (`kubectl get crds | grep cert-manager.io`).
3. Set `credentialInjection.mode: "sidecar"` in your values overrides.
4. Run `helm upgrade kubeclaw helm/kubeclaw -n kubeclaw -f your-values.yaml`.
5. The broker Deployment and internal CA resources are created. Existing workload pods restart with the Envoy sidecar attached and without API key env vars.
6. Verify with `kubectl logs deployment/kubeclaw-credential-broker -n kubeclaw` — look for `authz decision` log entries as workloads start making API calls.
7. If something breaks: set `credentialInjection.mode: "off"` and run `helm upgrade` again. The broker Deployment and sidecar containers are removed; env-var injection resumes. This is a full backout.

## Limitations

- The Envoy sidecar runs in the workload's network namespace. NetworkPolicy cannot enforce that outbound connections go through the sidecar — the actual enforcement is that the workload's HTTP client is pointed at `localhost:8443` via `HTTPS_PROXY`, which makes the sidecar the only path for correctly-authenticated calls. A workload that bypasses the proxy env var would receive no `Authorization` header and get a `401` from the upstream API.
- Only `headerScheme: bearer` is currently supported. OAuth token refresh, AWS SigV4, and similar schemes are on the roadmap.
- The sidecar adds 2-5 seconds to pod cold start (Envoy bootstrap, projected token mount, initial broker handshake).
- The orchestrator pod is excluded by design. It is the trusted tier; its credentials remain in environment variables.

## Cross-references

- Implementation plan: `docs/superpowers/plans/2026-05-02-credential-injection.md`
- Security model: `docs/SECURITY.md`
- Sidecar ACL (Redis IPC): `docs/SIDECAR_ACL.md`
