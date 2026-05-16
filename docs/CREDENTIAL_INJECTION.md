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

## Per-group user-supplied credentials

### Overview

By default the credential injection system serves only the four operator-provisioned API keys (Anthropic, OpenAI, OpenRouter, Voyage) baked into `kubeclaw-secrets` via Helm values. End users have no way to bring their own credentials into the running system without operator intervention.

The per-group credential feature closes that gap. End users register API credentials for their group via the `/secret` chat slash command. The channel-runner intercepts the command before any LLM call, forwards the credential to the orchestrator over Redis IPC, and the orchestrator writes a high-entropy placeholder to a per-group Kubernetes Secret. Tool-job pods receive the placeholder as an environment variable — never the cleartext value. The credential broker resolves the placeholder to the real value at request time and signals the Envoy Lua filter to perform the byte-level substitution before the request reaches the upstream API. The workload never holds cleartext.

```
End user   /secret add jenkins user=alice password=hunter2
               │  (channel-runner intercepts; LLM never sees this line)
               ▼
          Orchestrator
               ├── validates against catalog
               ├── generates placeholder per field: KC_PH_u_<64 hex chars>, KC_PH_p_<64 hex chars>
               └── writes kubeclaw-group-secrets-<group> K8s Secret
                                  │
                         K8s Secret informer fires
                                  ▼
          Credential broker — substitution-map cache updated:
               (group, jenkins.example.com, KC_PH_u_…) → "alice"
               (group, jenkins.example.com, KC_PH_p_…) → "hunter2"
─────────────────────────────────────────────────────────────────────
Tool-job pod (next request):
  envs:  JENKINS_USER=KC_PH_u_<…>  JENKINS_PASSWORD=KC_PH_p_<…>  (placeholders)
  annotation: kubeclaw.io/owner-group: family
               │
               ▼ workload builds HTTP request using placeholder envs
  Envoy sidecar / Istio egress gateway
               │ ext_authz POST /authz → broker resolves substitution map
               │ Lua filter substitutes placeholders with real values in headers + body
               └──► jenkins.example.com receives Authorization: Basic alice:hunter2
```

The cleartext credential traverses the channel-runner heap for ~milliseconds (while the IPC call is in-flight) and is zeroed in a `finally` block. It is never present in any log, any LLM context, or any tool-job environment.

### Catalog: operator-curated destinations

Operators publish the set of destinations end users may register credentials for via `credentialInjection.catalog` in the Helm values file. Each entry is rendered into the `kubeclaw-credential-broker-config` ConfigMap alongside the existing `mappings:` section, and is hot-reloaded by both the broker and orchestrator via ConfigMap informers — no restart required.

Full catalog reference: `helm/kubeclaw/values.yaml` (the `credentialInjection.catalog` key). The rendered ConfigMap template is at [`helm/kubeclaw/templates/credential-broker-config.yaml`](../helm/kubeclaw/templates/credential-broker-config.yaml).

**Example entries:**

```yaml
credentialInjection:
  catalog:
    # Single-field bearer token (e.g. Replicate)
    - id: replicate
      host: api.replicate.com
      upstreamPort: 443
      credentialFields:
        - { name: token, envVar: REPLICATE_API_TOKEN }
      baseUrlEnvs:
        REPLICATE_API_URL: "http://api.replicate.com"
      allowOperatorFallback: false
      allowedPositions: [header, body]
      apiKeyShape: { prefix: "r8_", minLength: 30 }

    # Multi-field Basic auth (e.g. Jenkins)
    - id: jenkins
      host: jenkins.example.com
      upstreamPort: 8080
      credentialFields:
        - { name: user,     envVar: JENKINS_USER }
        - { name: password, envVar: JENKINS_PASSWORD }
      baseUrlEnvs:
        JENKINS_URL: "http://jenkins.example.com"
      allowOperatorFallback: false
      allowedPositions: [header, body]

    # Cookie/custom-header scheme with operator fallback
    - id: internal-api
      host: api.internal.example.com
      upstreamPort: 443
      credentialFields:
        - { name: token, envVar: INTERNAL_API_TOKEN }
      baseUrlEnvs:
        INTERNAL_API_BASE_URL: "http://api.internal.example.com"
      allowOperatorFallback: true   # must be single-field; kubeclaw-secrets["internal-api"] used when no per-group key
      allowedPositions: [header]    # token goes in a custom header; body substitution not needed
      apiKeyShape: { prefix: "iat_", minLength: 40 }
```

**Catalog field reference:**

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Unique identifier; lowercase alphanumeric + hyphens. User-visible in `/secret` commands. |
| `host` | Yes | Exact destination hostname matched at the broker. |
| `upstreamPort` | No (default 443) | TLS origination port for mode=sidecar and DestinationRule in mode=istio. |
| `credentialFields` | Yes | One or more `{ name, envVar }` pairs. `name` is the key users supply in `/secret add`; `envVar` is the env variable stamped on tool-job pods. |
| `baseUrlEnvs` | No | Env vars stamped unconditionally on tool-job pods pointing the SDK at the right base URL (always `http://` in mode=istio; Envoy handles TLS). |
| `allowOperatorFallback` | No (default false) | Single-field entries only. When true and no per-group key is registered, the broker substitutes the operator's value from `kubeclaw-secrets.data["<id>"]`. |
| `allowedPositions` | No (default `[header, body]`) | Restricts where the Lua filter may substitute: `header`, `body`, or both. |
| `apiKeyShape` | No | `{ prefix, minLength }` — teaches the channel-runner's backstop regex to redact credential-shaped strings before any LLM call. |

`allowOperatorFallback` requires exactly one `credentialField` (enforced at schema parse time). Multi-field entries cannot use fallback.

### Slash command UX

The `/secret` command is intercepted by the channel-runner strictly upstream of any LLM call. The user's raw line is removed from transcript memory; a system event is inserted describing the registration (catalog ID, host, env var names — never the value). The assistant's reply is a templated string generated by the channel-runner; the LLM is not involved.

| Command | Description |
|---|---|
| `/secret add <id> <value>` | Single-field shorthand. `<value>` is the credential. |
| `/secret add <id> <field>=<value> [<field>=<value> ...]` | Multi-field form. All required fields must be present; missing fields are rejected with a list of expected names. |
| `/secret remove <id>` | Remove the named credential. Pods created after this lose the placeholder envs; in-flight pods using stale placeholders fail closed (upstream rejects the literal placeholder text). |
| `/secret list` | List registered catalog IDs for the current group with `registeredAt` timestamps. Never returns values. |
| `/secret catalog` | List the full operator-curated catalog: destinations, field names, and whether a credential is registered. |
| `/secret help` | Print usage. |

**Backstop:** independent of the parser, every inbound user message is scanned for strings matching known API-key shapes (catalog-driven via `apiKeyShape`, plus built-in patterns for common providers). Matches are replaced with `[possible secret redacted]` before any LLM call. The backstop is intentionally conservative.

**Rejection errors:** unknown catalog ID, missing required field, empty value, value exceeding 4 KB, value containing control characters, or IPC timeout (5 s) — each produces a user-visible error message; cleartext is zeroed on every code path.

### Placeholder and substitution mechanism

At `/secret add` time, the orchestrator generates one high-entropy placeholder per credential field using `crypto.randomBytes(32)` (256-bit entropy, hex-encoded):

```
KC_PH_<short-field-token>_<64 hex chars>
```

The `KC_PH_` prefix makes placeholders greppable in pod env dumps (`kubectl exec <pod> -- env | grep KC_PH_`). The 256-bit body makes accidental collision with any real request content vanishingly unlikely.

Placeholders are stored in a per-group Kubernetes Secret named `kubeclaw-group-secrets-<group>`, labelled `kubeclaw.io/group-secrets=true`. The `data` map key is the catalog ID; the value is a JSON blob:

```json
{
  "fields": {
    "user":     { "value": "alice",   "placeholder": "KC_PH_u_<64 hex chars>" },
    "password": { "value": "hunter2", "placeholder": "KC_PH_p_<64 hex chars>" }
  },
  "registeredAt": "2026-05-16T14:22:11Z"
}
```

Tool-job pods are stamped with the placeholder strings (not the real values) as environment variables, plus `baseUrlEnvs` from the catalog entry. The orchestrator also stamps the annotation `kubeclaw.io/owner-group: <group>` on every tool-job pod; the broker uses this to derive the group at request time.

**At request time**, Envoy calls the broker via `ext_authz POST /authz`. The broker:

1. Resolves the caller's owner-group from the pod annotation (sidecar: via `TokenReview` extras → pod UID → annotation lookup; istio: via source IP → pod-informer → annotation, with A1 mitigations — see [SECURITY.md](SECURITY.md#per-group-credential-injection-threats)).
2. Looks up the host in the catalog; rejects unknown destinations.
3. Loads the per-group Secret from its informer cache and builds a substitution map.
4. Returns HTTP 200 with two response headers:
   - `x-kubeclaw-substitutions: <placeholder>=<base64-value>;<placeholder>=<base64-value>;...`
   - `x-kubeclaw-policy: positions=header,body;per=10;total=50`

The Lua filter colocated with Envoy reads these two headers, decodes each base64 value, performs byte-level string substitution in request headers and body (within the position and counter limits declared by the policy header), and strips both headers before forwarding to the upstream. The upstream receives the real credential in whatever position the workload's SDK chose.

The `per=10` limit means any single placeholder may appear at most 10 times in one request; `total=50` is the ceiling across all placeholders. Requests exceeding these limits are rejected with `503 substitution_limit_exceeded`. The limits guard against flood-write exfil patterns; legitimate requests rarely need more than a handful of substitutions.

### Lifecycle

- **Add:** `/secret add <id> ...` generates new placeholders and writes (or overwrites) the per-group Secret entry. The broker's informer fires within ~100–500 ms; subsequent tool-job requests use the new credential. In-flight tool-jobs already spawned retain the old placeholder envs; if the old credential was removed first, their requests fail closed.
- **Remove:** `/secret remove <id>` patches the Secret to delete the catalog entry key. If it was the last key, the Secret is deleted. In-flight pods carry stale placeholder envs; the broker no longer holds the matching substitution — requests pass the literal placeholder to the upstream, which rejects it (fail-closed). The error is surfaced to the LLM as a tool failure with a `no_credential` hint.
- **Rotate:** There is no `/secret rotate`. Rotation is `/secret remove` followed by `/secret add`. Any in-flight tool-job using the old credential fails closed for the interstitial period.
- **Group deletion:** the orchestrator's group-deletion path deletes `kubeclaw-group-secrets-<group>`; the broker informer evicts the entries.

### Operator fallback

For catalog entries with `allowOperatorFallback: true` (single-field entries only), the operator may place a default credential in `kubeclaw-secrets.data["<catalogId>"]` (the same Secret that holds the built-in LLM keys). Tool-job pods belonging to groups that have *not* registered their own credential are stamped with the stable sentinel `KC_PH_FALLBACK_<catalogId>` as the env value. The broker maps this sentinel to the operator's value at request time. The source is recorded in the audit log as `keySource: operatorFallback`.

Groups that have registered their own credential always use it in preference to the operator fallback; the operator value is not visible to them.

For entries with `allowOperatorFallback: false`, unregistered groups receive the literal string `injected-by-broker` as the env value. The broker does not substitute this literal; the upstream rejects the request. The LLM sees a `no_credential` error and can prompt the user to run `/secret add`.

### `list_credentials` tool

A `list_credentials` tool is registered in the channel LLM's tool list at startup. It takes no arguments and returns metadata only:

```json
[
  {
    "catalogId": "replicate",
    "host": "api.replicate.com",
    "fields": ["token"],
    "hasCredential": true,
    "registeredAt": "2026-05-16T14:22:11Z"
  },
  {
    "catalogId": "jenkins",
    "host": "jenkins.example.com",
    "fields": ["user", "password"],
    "hasCredential": false,
    "registeredAt": null
  }
]
```

No values, hashes, previews, or last-4 digits are ever present in the return shape. The tool description guides the LLM: "Use when user asks what's available, when a tool call fails with `no_credential`, or when you're unsure whether a destination is configured."

### Per-turn system block

On every conversation turn, the channel-runner prepends a system message summarising the operator-curated catalog and which entries have credentials registered for the current group. The block is rebuilt fresh each turn so that credentials added within the same conversation are reflected immediately. This gives the LLM up-front context without requiring a `list_credentials` call.

## Cross-references

- Implementation plan: `docs/superpowers/plans/2026-05-02-credential-injection.md`
- Security model: `docs/SECURITY.md`
- Sidecar ACL (Redis IPC): `docs/SIDECAR_ACL.md`
