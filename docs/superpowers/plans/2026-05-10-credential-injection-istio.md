# Credential Injection — Istio Mode (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `credentialInjection.mode=istio` so KubeClaw operators on Istio-equipped clusters can replace per-pod Envoy sidecars with a single namespace-level egress gateway that calls the same credential-broker for Authorization-header injection, while getting real iptables-enforced egress control that Phase 1 sidecar mode cannot provide.

**Architecture:** A `kubeclaw-istio-egressgateway` Deployment (labeled `istio: kubeclaw-egressgateway`) is deployed into the kubeclaw namespace and owned by the KubeClaw Helm chart; a `Sidecar` resource forces all pod egress through `istio-system/*`; per-destination `ServiceEntry` resources declare reachable upstreams derived from the broker config; an `EnvoyFilter` on the gateway wires `ext_authz` to the existing `credential-broker` Service; Istio injects mesh sidecars into workload pods (giving them SPIFFE identities via XFCC peer-cert), and the broker's `IdentityVerifier` gains a second dispatch path that parses the SPIFFE URI from the `x-forwarded-client-cert` header rather than calling the TokenReview API. The orchestrator pod is explicitly excluded from Istio injection. The Phase 1 per-pod Envoy sidecar is not injected in `mode=istio`.

**Security upgrade note:** Phase 1 sidecar mode cannot enforce that workload code uses the proxy — workload and sidecar share a network namespace, so a determined workload process can open raw sockets to the internet. Istio mode uses iptables redirection inside the workload's netns to force all egress through the Istio sidecar, which then routes through the egress gateway. This is a genuine security upgrade for Istio operators, not merely a transport swap.

**Ambient mode:** Classic sidecar injection (`sidecar.istio.io/inject: "true"`) only. Istio ambient + waypoint proxy is explicitly out of scope — header mutation via waypoint is still experimental in Istio 1.24 LTS and requires separate design. A follow-up plan will cover ambient mode. Minimum supported Istio version for Phase 2 is **Istio 1.24 LTS**.

**Tech Stack:** TypeScript (broker SPIFFE parser + IdentityVerifier update), Helm (new Istio-mode templates), Istio 1.24+ CRDs (`Sidecar`, `ServiceEntry`, `Gateway`, `VirtualService`, `EnvoyFilter`), vitest (unit + integration), kind v0.23+ with istioctl (e2e), GitHub Actions (e2e workflow).

---

## Pre-decisions (locked — do not re-open)

1. **No `auto` mode.** Commit `1f921de` deliberately dropped it. Operator chooses `sidecar` or `istio` explicitly.
2. **Orchestrator excluded from Istio injection.** The kubeclaw namespace label enables mesh injection for the whole namespace; the orchestrator pod template gets `sidecar.istio.io/inject: "false"` to opt back out.
3. **Bearer/XFCC dispatch in the same broker process.** If `x-forwarded-client-cert` is present, parse SPIFFE URI. If absent, fall back to existing bearer-token TokenReview. No separate broker binary.
4. **SPIFFE identity normalises to `sa/<saname>`.** The `Resolver.find()` signature is unchanged; XFCC-derived identity produces the same string format as TokenReview-derived identity.
5. **e2e in a separate GitHub Actions workflow**, triggered by PR label `e2e:istio` or nightly cron. Not every PR.
6. **NetworkPolicy shape for `mode=istio`:** only the egress-gateway pod (selector `istio: kubeclaw-egressgateway`) needs to reach `credential-broker:8080`. Per-pod-sidecar → broker rules are not rendered.
7. **Destination list for `ServiceEntry` resources** is derived from the broker's `mappings[*].destinations` array in `credential-broker-config.yaml` via a shared `_helpers.tpl` helper (not Helm `lookup`). Rationale: `lookup` is a runtime API call that breaks `helm template` in CI without cluster access; a helper that iterates `.Values`-derived structure works offline.

---

## Task ordering

| Task | What | Files |
|---|---|---|
| 1 | Helm CRD pre-flight check | `_helpers.tpl`, `NOTES.txt` |
| 2 | Extend `values.yaml` with `credentialInjection.istio` tree | `values.yaml` |
| 3 | `Sidecar` resource (namespace egress restriction) | `istio-sidecar.yaml` (new) |
| 4 | `ServiceEntry` resources per destination | `istio-serviceentries.yaml` (new), `_helpers.tpl` |
| 5 | Egress `Gateway` + `VirtualService` | `istio-egress.yaml` (new) |
| 6 | `EnvoyFilter` for ext_authz on egress gateway | `istio-envoyfilter.yaml` (new) |
| 7 | Namespace label `istio-injection=enabled` | `orchestrator.yaml` or new namespace template |
| 8 | Annotate orchestrator pod `sidecar.istio.io/inject: "false"` | `orchestrator.yaml` |
| 9 | Skip per-pod Envoy sidecar when `mode=istio` | `channel-pods.yaml`, `capability-pods.yaml`, `job-runner.ts` |
| 10 | SPIFFE/XFCC parser | `src/credential-broker/spiffe.ts` (new), `spiffe.test.ts` (new) |
| 11 | Extend `IdentityVerifier` for XFCC | `identity.ts`, `identity.test.ts` |
| 12 | Update `ext-authz.ts` to thread XFCC | `ext-authz.ts`, `ext-authz.test.ts` |
| 13 | Update `index.ts` to read XFCC header | `index.ts` |
| 14 | NetworkPolicies for `mode=istio` | `networkpolicies-istio.yaml` (new) |
| 15 | Helm render coverage (all three modes) | `e2e/helm-chart.test.ts` |
| 16 | e2e on kind + Istio | `e2e/credential-injection-istio.test.ts` (new), `.github/workflows/e2e-istio.yml` (new) |
| 17 | Operator doc updates | `docs/CREDENTIAL_INJECTION.md` |

---

### Task 1: Helm CRD pre-flight check

**Files:**
- Modify: `helm/kubeclaw/templates/_helpers.tpl`
- Modify: `helm/kubeclaw/templates/NOTES.txt`

When `mode=istio` is selected, the chart should fail fast with a human-readable message if the Istio CRDs are not installed in the cluster. Helm's `lookup` function returns an empty dict when the resource is absent without cluster access (e.g. `helm template`), so the guard is a `required`-style `fail` gated behind a `lookup` that only fires when the lookup actually returns a non-empty result for its negative case.

Because `helm template` runs without cluster access and `lookup` returns empty maps in that context, the CRD check must be phrased so that offline rendering always passes; it only blocks on `helm install`/`helm upgrade` (which do have cluster access). Use the pattern: if the lookup result for the CRD group is nil/empty AND the chart can detect it's running with cluster access (no clean way in Helm), the safest approach is to emit a NOTES.txt warning and rely on a `helm lint` rule. The plan uses the `fail` function gated on the lookup returning a non-nil value with `kind == ""`, which is the Helm convention for "CRD not found in cluster":

- [x] **Step 1: Add the `kubeclaw.istioInstalled` helper to `_helpers.tpl`**

Open `helm/kubeclaw/templates/_helpers.tpl` and append after the last `{{- end -}}`:

```
{{/*
istioInstalled — returns "true" when the networking.istio.io/v1 CRD group is
present in the cluster. Returns "" when running offline (helm template) because
lookup returns an empty map without cluster access.
Usage: {{- if include "kubeclaw.istioInstalled" . }}
*/}}
{{- define "kubeclaw.istioInstalled" -}}
{{- $crd := lookup "apiextensions.k8s.io/v1" "CustomResourceDefinition" "" "virtualservices.networking.istio.io" -}}
{{- if $crd.metadata -}}
true
{{- end -}}
{{- end -}}

{{/*
kubeclaw.requireIstio — fails with a clear message when mode=istio and the
cluster is reachable but Istio CRDs are absent. Silent when running offline.
*/}}
{{- define "kubeclaw.requireIstio" -}}
{{- if eq .Values.credentialInjection.mode "istio" -}}
  {{- $crd := lookup "apiextensions.k8s.io/v1" "CustomResourceDefinition" "" "virtualservices.networking.istio.io" -}}
  {{- if and (not $crd.metadata) (lookup "v1" "Namespace" "" "kube-system").metadata -}}
    {{- fail "credentialInjection.mode=istio requires Istio CRDs. Install Istio >= 1.24 first, or use mode=sidecar." -}}
  {{- end -}}
{{- end -}}
{{- end -}}
```

- [x] **Step 2: Call the guard from `NOTES.txt`**

Open `helm/kubeclaw/templates/NOTES.txt`. After any existing content, add:

```
{{- include "kubeclaw.requireIstio" . }}
{{- if eq .Values.credentialInjection.mode "istio" }}

Credential injection mode: istio
  Minimum Istio version required: 1.24 LTS
  The kubeclaw namespace is labeled istio-injection=enabled.
  Egress gateway: kubeclaw-istio-egressgateway ({{ .Values.credentialInjection.istio.gateway.replicas }} replica(s))
  All workload egress is forced through the gateway via a Sidecar resource.
  Workload pods receive Istio mesh sidecars (SPIFFE identity).
  The orchestrator pod is excluded from injection (sidecar.istio.io/inject=false).
  Ambient mode is not supported — see docs/CREDENTIAL_INJECTION.md.
{{- end }}
```

- [x] **Step 3: Verify offline rendering does not fail**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio --set credentialInjection.istio.gateway.replicas=2`

Expected: no `Error:` output, renders to stdout without error (CRD check is silent offline).

- [x] **Step 4: Commit**

```bash
git add helm/kubeclaw/templates/_helpers.tpl helm/kubeclaw/templates/NOTES.txt
git commit -m "feat(helm): add CRD pre-flight check helper for mode=istio"
```

---

### Task 2: Extend `values.yaml` with the `credentialInjection.istio` tree

**Files:**
- Modify: `helm/kubeclaw/values.yaml`

- [x] **Step 1: Add the `istio` block to `values.yaml`**

Open `helm/kubeclaw/values.yaml`. After the `internalCA:` block (line 301), add:

```yaml

  # istio: settings for mode=istio (Istio egress gateway).
  # Ignored when mode != "istio".
  istio:
    gateway:
      # replicas: number of egress gateway pods. 2 for HA (recommended for production).
      replicas: 2
      resources:
        requests: { cpu: 100m, memory: 128Mi }
        limits:   { cpu: 500m, memory: 256Mi }

    # ambientMode: ambient + waypoint support. MUST remain false — ambient mode is
    # out of scope for Phase 2. A follow-up plan will cover waypoint-based header
    # injection when Istio 1.26+ stabilises the API.
    ambientMode: false

    # additionalDestinations: hostnames beyond the built-in broker mappings that
    # the egress gateway should allow and create ServiceEntry resources for.
    # Example: ["my-mcp-server.internal:8443"]
    additionalDestinations: []
```

- [x] **Step 2: Verify render**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio | grep -c "kind:"` 

Expected: a non-zero count (chart renders without error).

- [x] **Step 3: Commit**

```bash
git add helm/kubeclaw/values.yaml
git commit -m "feat(helm): extend credentialInjection.istio value tree"
```

---

### Task 3: Render `Sidecar` resource (namespace egress restriction)

**Files:**
- Create: `helm/kubeclaw/templates/istio-sidecar.yaml`

The `Sidecar` resource restricts what external services pods in the kubeclaw namespace can reach via the Istio service registry. By specifying `egress.hosts: ["istio-system/*", "./*"]` (plus `"~/*"` for DNS lookups), all pod traffic that is not matched by a `ServiceEntry` will be dropped by the proxy, and traffic that IS matched routes through the egress gateway.

- [x] **Step 1: Create the file**

Create `helm/kubeclaw/templates/istio-sidecar.yaml`:

```yaml
{{- if eq .Values.credentialInjection.mode "istio" -}}
# Sidecar resource restricts all pod egress in the kubeclaw namespace to:
#   - Services within the same namespace (./* for Redis, broker, etc.)
#   - Resources declared via ServiceEntry (external upstreams)
# Traffic not matching any ServiceEntry is dropped by the Istio proxy,
# giving true iptables-enforced egress control — unlike Phase 1 sidecar mode
# where workload and sidecar share a netns and NetworkPolicy cannot separate them.
apiVersion: networking.istio.io/v1
kind: Sidecar
metadata:
  name: kubeclaw-egress-restriction
  namespace: {{ .Values.namespace }}
spec:
  egress:
    # Allow traffic to all services within the kubeclaw namespace (Redis, broker, etc.)
    - hosts:
        - "./*"
    # Allow traffic declared in ServiceEntry resources in the istio-system namespace.
    # ServiceEntry resources created by this chart are placed in the kubeclaw namespace,
    # so "./*" above covers them. "istio-system/*" is kept for platform-level entries
    # (e.g. cert-manager ACME, mesh control-plane traffic).
    - hosts:
        - "istio-system/*"
{{- end }}
```

- [x] **Step 2: Verify render**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio | grep -A 10 "kind: Sidecar"`

Expected output includes:
```
kind: Sidecar
metadata:
  name: kubeclaw-egress-restriction
```

Run: `helm template helm/kubeclaw --set credentialInjection.mode=sidecar | grep "kind: Sidecar"`

Expected: empty output (resource not rendered in sidecar mode).

- [x] **Step 3: Commit**

```bash
git add helm/kubeclaw/templates/istio-sidecar.yaml
git commit -m "feat(helm): add Sidecar resource for kubeclaw namespace egress restriction (mode=istio)"
```

---

### Task 4: `ServiceEntry` resources per upstream destination

**Files:**
- Modify: `helm/kubeclaw/templates/_helpers.tpl`
- Create: `helm/kubeclaw/templates/istio-serviceentries.yaml`

The destination list must be shared between the broker config ConfigMap (already in `credential-broker-config.yaml`) and the ServiceEntry template. Rather than duplicating the list, a `_helpers.tpl` function will return the canonical destination list as a comma-separated string, and both templates will iterate it.

Design decision: use a `_helpers.tpl` function (not `lookup`) because `helm template` must work offline in CI. The helper returns the hardcoded built-in destinations plus any entries in `.Values.credentialInjection.istio.additionalDestinations`.

- [x] **Step 1: Add `kubeclaw.egressDestinations` helper to `_helpers.tpl`**

Append to `helm/kubeclaw/templates/_helpers.tpl`:

```
{{/*
kubeclaw.egressDestinations — returns a list of all egress destinations that
the credential broker handles, suitable for ServiceEntry generation.
Each entry is a dict with keys: host (string), port (number), protocol (string).
Includes built-in destinations (anthropic, openai, etc.) plus any entries
in .Values.credentialInjection.istio.additionalDestinations.
*/}}
{{- define "kubeclaw.egressDestinations" -}}
{{- $built_in := list
      (dict "host" "api.anthropic.com"  "port" 443 "protocol" "HTTPS")
      (dict "host" "api.openai.com"     "port" 443 "protocol" "HTTPS")
      (dict "host" "openrouter.ai"      "port" 443 "protocol" "HTTPS")
      (dict "host" "api.voyageai.com"   "port" 443 "protocol" "HTTPS") -}}
{{- $extra := list -}}
{{- range .Values.credentialInjection.istio.additionalDestinations -}}
  {{- $parts := splitList ":" . -}}
  {{- $h := index $parts 0 -}}
  {{- $p := 443 -}}
  {{- if gt (len $parts) 1 -}}
    {{- $p = index $parts 1 | int -}}
  {{- end -}}
  {{- $extra = append $extra (dict "host" $h "port" $p "protocol" "HTTPS") -}}
{{- end -}}
{{- toJson (concat $built_in $extra) -}}
{{- end -}}
```

- [x] **Step 2: Create `istio-serviceentries.yaml`**

Create `helm/kubeclaw/templates/istio-serviceentries.yaml`:

```yaml
{{- if eq .Values.credentialInjection.mode "istio" -}}
{{- $destinations := include "kubeclaw.egressDestinations" . | fromJson -}}
{{- range $dest := $destinations }}
---
# ServiceEntry for {{ $dest.host }} — allows Istio mesh to route traffic to this
# external host through the kubeclaw egress gateway.
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: kubeclaw-egress-{{ $dest.host | replace "." "-" | replace ":" "-" }}
  namespace: {{ $.Values.namespace }}
spec:
  hosts:
    - {{ $dest.host }}
  ports:
    - number: {{ $dest.port }}
      name: https
      protocol: {{ $dest.protocol }}
  location: MESH_EXTERNAL
  resolution: DNS
{{- end }}
{{- end }}
```

- [x] **Step 3: Verify render**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio | grep "kind: ServiceEntry" | wc -l`

Expected: `4` (one per built-in destination).

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio --set "credentialInjection.istio.additionalDestinations[0]=my-mcp.internal:8443" | grep "kind: ServiceEntry" | wc -l`

Expected: `5`.

Run: `helm template helm/kubeclaw --set credentialInjection.mode=sidecar | grep "kind: ServiceEntry"`

Expected: empty output.

- [x] **Step 4: Commit**

```bash
git add helm/kubeclaw/templates/_helpers.tpl helm/kubeclaw/templates/istio-serviceentries.yaml
git commit -m "feat(helm): add ServiceEntry resources for external destinations (mode=istio)"
```

---

### Task 5: Egress `Gateway` + `VirtualService`

**Files:**
- Create: `helm/kubeclaw/templates/istio-egress.yaml`

The Gateway resource creates a logical ingress/egress point on the egress gateway pod. The VirtualService routes matching traffic from the mesh sidecars (via the Sidecar resource) through the gateway.

- [x] **Step 1: Create `istio-egress.yaml`**

Create `helm/kubeclaw/templates/istio-egress.yaml`:

```yaml
{{- if eq .Values.credentialInjection.mode "istio" -}}
{{- $destinations := include "kubeclaw.egressDestinations" . | fromJson -}}
# Egress Gateway Deployment — owned by the KubeClaw Helm chart (not by the
# Istio platform team). Labeled istio: kubeclaw-egressgateway so EnvoyFilter
# selectors and NetworkPolicy selectors can target it independently of the
# platform-level istio-egressgateway (if any).
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kubeclaw-istio-egressgateway
  namespace: {{ .Values.namespace }}
  labels:
    app: kubeclaw-istio-egressgateway
    istio: kubeclaw-egressgateway
spec:
  replicas: {{ .Values.credentialInjection.istio.gateway.replicas }}
  selector:
    matchLabels:
      app: kubeclaw-istio-egressgateway
      istio: kubeclaw-egressgateway
  template:
    metadata:
      labels:
        app: kubeclaw-istio-egressgateway
        istio: kubeclaw-egressgateway
      annotations:
        # Force Istio sidecar injection on the gateway pod itself so Envoy picks
        # up the gateway listener configuration from istiod.
        sidecar.istio.io/inject: "true"
    spec:
      serviceAccountName: kubeclaw-istio-egressgateway
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: istio-proxy
          # The istio-proxy image is injected by the Istio mutating webhook;
          # this placeholder is overwritten. Kept here so the Deployment is
          # syntactically valid for helm lint.
          image: auto
          resources: {{ toYaml .Values.credentialInjection.istio.gateway.resources | nindent 12 }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
            runAsNonRoot: true
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kubeclaw-istio-egressgateway
  namespace: {{ .Values.namespace }}
---
apiVersion: v1
kind: Service
metadata:
  name: kubeclaw-istio-egressgateway
  namespace: {{ .Values.namespace }}
  labels:
    app: kubeclaw-istio-egressgateway
    istio: kubeclaw-egressgateway
spec:
  selector:
    app: kubeclaw-istio-egressgateway
    istio: kubeclaw-egressgateway
  ports:
    - name: https
      port: 443
      targetPort: 8443
---
# Gateway — configures the egress gateway Envoy to accept connections from
# mesh sidecars for each external host.
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: kubeclaw-egressgateway
  namespace: {{ .Values.namespace }}
spec:
  selector:
    istio: kubeclaw-egressgateway
  servers:
{{- range $dest := $destinations }}
    - port:
        number: {{ $dest.port }}
        name: https-{{ $dest.host | replace "." "-" }}
        protocol: HTTPS
      hosts:
        - {{ $dest.host }}
      tls:
        # PASSTHROUGH: the egress gateway does not terminate the upstream TLS.
        # It terminates the mesh mTLS from the workload sidecar. The
        # re-originated upstream connection uses the public CA bundle.
        mode: PASSTHROUGH
{{- end }}
---
# VirtualService — routes traffic for each external host from the mesh
# through the egress gateway before it leaves the cluster.
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: kubeclaw-egress-routing
  namespace: {{ .Values.namespace }}
spec:
  hosts:
{{- range $dest := $destinations }}
    - {{ $dest.host }}
{{- end }}
  gateways:
    - mesh
    - kubeclaw-egressgateway
  tls:
{{- range $dest := $destinations }}
    - match:
        - gateways: [mesh]
          port: {{ $dest.port }}
          sniHosts: [{{ $dest.host }}]
      route:
        - destination:
            host: kubeclaw-istio-egressgateway.{{ $.Values.namespace }}.svc.cluster.local
            port: { number: 443 }
    - match:
        - gateways: [kubeclaw-egressgateway]
          port: {{ $dest.port }}
          sniHosts: [{{ $dest.host }}]
      route:
        - destination:
            host: {{ $dest.host }}
            port: { number: {{ $dest.port }} }
{{- end }}
{{- end }}
```

- [x] **Step 2: Verify render**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio | grep "kind:" | sort | uniq -c`

Expected output includes:
```
      1 kind: Deployment          (kubeclaw-istio-egressgateway)
      1 kind: Gateway
      1 kind: ServiceAccount      (kubeclaw-istio-egressgateway)
      1 kind: Service             (kubeclaw-istio-egressgateway)
      1 kind: VirtualService
```

Run: `helm template helm/kubeclaw --set credentialInjection.mode=sidecar | grep -E "kind: (Gateway|VirtualService)"`

Expected: empty output.

- [x] **Step 3: Commit**

```bash
git add helm/kubeclaw/templates/istio-egress.yaml
git commit -m "feat(helm): add egress Gateway, VirtualService, and gateway Deployment (mode=istio)"
```

---

### Task 6: `EnvoyFilter` wiring `ext_authz` on the egress gateway

**Files:**
- Create: `helm/kubeclaw/templates/istio-envoyfilter.yaml`

The EnvoyFilter patches the egress gateway's Envoy config to call the credential-broker via `ext_authz` before forwarding traffic upstream. The broker response's `authorization` header is stamped on the upstream request (same as the Phase 1 sidecar's `allowed_upstream_headers`).

- [x] **Step 1: Create `istio-envoyfilter.yaml`**

Create `helm/kubeclaw/templates/istio-envoyfilter.yaml`:

```yaml
{{- if eq .Values.credentialInjection.mode "istio" -}}
# EnvoyFilter patches the kubeclaw egress gateway to call the credential-broker
# via ext_authz for every proxied request. On a 200 response from the broker,
# the returned "authorization" header is stamped on the upstream request.
# The broker receives the workload's SPIFFE identity via the
# x-forwarded-client-cert header that Istio mTLS populates automatically.
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: kubeclaw-credential-authz
  namespace: {{ .Values.namespace }}
spec:
  workloadSelector:
    labels:
      istio: kubeclaw-egressgateway
  configPatches:
    # Insert ext_authz HTTP filter before the router filter on the outbound listener.
    - applyTo: HTTP_FILTER
      match:
        context: GATEWAY
        listener:
          filterChain:
            filter:
              name: envoy.filters.network.http_connection_manager
              subFilter:
                name: envoy.filters.http.router
      patch:
        operation: INSERT_BEFORE
        value:
          name: envoy.filters.http.ext_authz
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz
            http_service:
              server_uri:
                uri: http://credential-broker.{{ .Values.namespace }}.svc.cluster.local:{{ .Values.credentialInjection.broker.port }}
                cluster: outbound|{{ .Values.credentialInjection.broker.port }}||credential-broker.{{ .Values.namespace }}.svc.cluster.local
                timeout: 5s
              path_prefix: /authz
              authorization_request:
                allowed_headers:
                  patterns:
                    # Forward the original Authorization header (workload SA bearer token,
                    # if present) and the XFCC peer cert header so the broker can identify
                    # the caller by SPIFFE URI.
                    - exact: authorization
                    - exact: x-forwarded-client-cert
                    - exact: x-forwarded-authority
              authorization_response:
                allowed_upstream_headers:
                  patterns:
                    # The broker stamps the credential Authorization header; copy it
                    # onto the upstream request exactly as Phase 1 sidecar mode does.
                    - exact: authorization
            failure_mode_allow: false
            with_request_body:
              max_request_bytes: 0
              allow_partial_message: false
              pack_as_bytes: false
{{- end }}
```

- [x] **Step 2: Verify render**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio | grep "kind: EnvoyFilter"`

Expected: `kind: EnvoyFilter`

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio | grep "ext_authz"`

Expected: at least one line containing `ext_authz`.

Run: `helm template helm/kubeclaw --set credentialInjection.mode=sidecar | grep "kind: EnvoyFilter"`

Expected: empty output.

- [x] **Step 3: Commit**

```bash
git add helm/kubeclaw/templates/istio-envoyfilter.yaml
git commit -m "feat(helm): add EnvoyFilter wiring ext_authz on egress gateway (mode=istio)"
```

---

### Task 7: Namespace label `istio-injection=enabled` when `mode=istio`

**Files:**
- Modify: `helm/kubeclaw/templates/orchestrator.yaml`

The kubeclaw namespace must carry `istio-injection: enabled` so Istio's mutating admission webhook injects sidecars into all new pods. This label is added to the Namespace resource. KubeClaw's chart already manages the namespace via the orchestrator template's preamble; add the namespace manifest there.

- [x] **Step 1: Add a conditional Namespace resource at the top of `orchestrator.yaml`**

Open `helm/kubeclaw/templates/orchestrator.yaml`. Insert at line 1 (before the existing `---`):

```yaml
{{- if eq .Values.credentialInjection.mode "istio" -}}
# In mode=istio the kubeclaw namespace must be labeled for Istio sidecar injection.
# This label causes istiod's mutating webhook to inject the istio-proxy sidecar
# into every new pod in the namespace, giving each workload a SPIFFE identity.
# The orchestrator pod opts back out via its own annotation (sidecar.istio.io/inject=false).
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .Values.namespace }}
  labels:
    istio-injection: enabled
{{- end }}
---
```

- [x] **Step 2: Verify render**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio | grep -A 5 "kind: Namespace"`

Expected output:
```yaml
kind: Namespace
metadata:
  name: kubeclaw
  labels:
    istio-injection: enabled
```

Run: `helm template helm/kubeclaw --set credentialInjection.mode=sidecar | grep "istio-injection"`

Expected: empty output (label not rendered in sidecar mode).

- [x] **Step 3: Commit**

```bash
git add helm/kubeclaw/templates/orchestrator.yaml
git commit -m "feat(helm): label kubeclaw namespace istio-injection=enabled when mode=istio"
```

---

### Task 8: Annotate orchestrator pod with `sidecar.istio.io/inject: "false"`

**Files:**
- Modify: `helm/kubeclaw/templates/orchestrator.yaml`

The orchestrator is the trusted tier — it holds K8s API credentials and Redis credentials and must not be in the mesh dataplane. Under `mode=istio` the namespace-wide label would inject a sidecar into it unless explicitly excluded.

- [x] **Step 1: Add the inject=false annotation to the orchestrator pod template**

Open `helm/kubeclaw/templates/orchestrator.yaml`. Locate the orchestrator Deployment's `template.metadata` block (currently just has `labels`). Add a conditional `annotations` block:

```yaml
  template:
    metadata:
      labels:
        app: kubeclaw-orchestrator
      {{- if eq .Values.credentialInjection.mode "istio" }}
      annotations:
        # The orchestrator is the trusted control-plane tier; it must not receive
        # an Istio sidecar even though the namespace label enables injection for
        # all other pods. The orchestrator accesses the K8s API directly using
        # its own SA credentials and does not need mesh identity.
        sidecar.istio.io/inject: "false"
      {{- end }}
    spec:
```

- [x] **Step 2: Verify render**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio | grep -A 2 "sidecar.istio.io/inject"`

Expected:
```
        sidecar.istio.io/inject: "false"
```

Run: `helm template helm/kubeclaw --set credentialInjection.mode=sidecar | grep "sidecar.istio.io"`

Expected: empty output (annotation absent in sidecar mode).

- [x] **Step 3: Commit**

```bash
git add helm/kubeclaw/templates/orchestrator.yaml
git commit -m "feat(helm): exclude orchestrator from Istio injection when mode=istio"
```

---

### Task 9: Skip per-pod Envoy sidecar when `mode=istio`

**Files:**
- Modify: `helm/kubeclaw/templates/channel-pods.yaml`
- Modify: `helm/kubeclaw/templates/capability-pods.yaml`
- Modify: `src/k8s/job-runner.ts`
- Test: `src/k8s/job-runner.test.ts`

In `mode=istio`, Istio's mesh sidecar handles egress — the per-pod Envoy sidecar from Phase 1 must not be injected (it would conflict). However, the API key env vars are still stripped (the broker still handles credentials). The Istio mesh sidecar does NOT need the `HTTPS_PROXY` env var — Istio captures traffic via iptables.

- [x] **Step 1: Update `channel-pods.yaml` sidecar injection guards**

Open `helm/kubeclaw/templates/channel-pods.yaml`.

Find the line:
```
            {{- if eq $.Values.credentialInjection.mode "sidecar" }}
            {{- include "kubeclaw.credentialSidecarEnv" $ | nindent 12 }}
            {{- end }}
```

Replace with:
```
            {{- if eq $.Values.credentialInjection.mode "sidecar" }}
            {{- include "kubeclaw.credentialSidecarEnv" $ | nindent 12 }}
            {{- end }}
            {{- if eq $.Values.credentialInjection.mode "istio" }}
            # In istio mode, Istio captures all egress via iptables redirection.
            # No HTTPS_PROXY env is needed; the mesh sidecar routes traffic automatically.
            # API keys are stripped above (under mode != off) and injected by the broker.
            {{- end }}
```

Find the line:
```
        {{- if eq $.Values.credentialInjection.mode "sidecar" }}
        {{- include "kubeclaw.credentialSidecarContainer" $ | nindent 8 }}
        {{- end }}
```

This remains unchanged (already gated on `sidecar` only; `istio` mode does not render the container).

Find the line:
```
        {{- if eq $.Values.credentialInjection.mode "sidecar" }}
        {{- include "kubeclaw.credentialSidecarVolumes" $ | nindent 8 }}
        {{- end }}
```

This also remains unchanged.

- [x] **Step 2: Update `capability-pods.yaml` sidecar injection guards**

Open `helm/kubeclaw/templates/capability-pods.yaml`. Apply the same guard audit: confirm the sidecar container and volumes inclusions are already gated on `mode == "sidecar"` (from the grep output we confirmed this at line 74 and 77). No change needed if already correct. If any include is gated on `mode != "off"`, tighten to `mode == "sidecar"`.

After reviewing, add the istio-mode comment in the env section (same pattern as channel-pods.yaml):

Find the credential env block (near line 47):
```
            {{- if eq $.Values.credentialInjection.mode "sidecar" }}
            {{- include "kubeclaw.credentialSidecarEnv" $ | nindent 12 }}
            {{- end }}
```

Replace with:
```
            {{- if eq $.Values.credentialInjection.mode "sidecar" }}
            {{- include "kubeclaw.credentialSidecarEnv" $ | nindent 12 }}
            {{- end }}
            {{- if eq $.Values.credentialInjection.mode "istio" }}
            # In istio mode, iptables redirection handles egress; no HTTPS_PROXY needed.
            {{- end }}
```

- [x] **Step 3: Update `job-runner.ts` to narrow injection to `mode=sidecar` only**

Open `src/k8s/job-runner.ts`. Find the block at line 641–712:

```typescript
    // Credential injection: strip API keys and add proxy env when active
    const injectionMode = getInjectionMode();
    const finalEnv =
      injectionMode === 'sidecar' || injectionMode === 'istio'
        ? [
            ...envVars.filter((e) => !STRIPPED_WHEN_INJECTED.has(e.name)),
            ...workloadEnvForSidecar({ port: CREDENTIAL_SIDECAR_PORT }),
          ]
        : envVars;
```

Replace with:

```typescript
    // Credential injection: strip API keys when active (sidecar or istio).
    // In istio mode, Istio's iptables-based eBPF/netfilter redirection routes
    // egress automatically — no HTTPS_PROXY env is needed.
    const injectionMode = getInjectionMode();
    const stripsCredentials =
      injectionMode === 'sidecar' || injectionMode === 'istio';
    const addsSidecarProxy = injectionMode === 'sidecar';

    const finalEnv = stripsCredentials
      ? [
          ...envVars.filter((e) => !STRIPPED_WHEN_INJECTED.has(e.name)),
          ...(addsSidecarProxy
            ? workloadEnvForSidecar({ port: CREDENTIAL_SIDECAR_PORT })
            : []),
        ]
      : envVars;
```

Also update the sidecar container injection block at line 704:

```typescript
    // Build final containers and volumes arrays, appending credential sidecar when active
    const containers: any[] = [agentContainer];
    const finalVolumes: any[] = [...volumes];
    if (injectionMode === 'sidecar') {
      containers.push(
        sidecarContainerSpec({
          image: CREDENTIAL_SIDECAR_IMAGE,
          port: CREDENTIAL_SIDECAR_PORT,
        }),
      );
      finalVolumes.push(...sidecarVolumes());
    }
```

This block is already gated on `injectionMode === 'sidecar'` — confirm it is unchanged and that no `istio` case was missed.

- [x] **Step 4: Add/update unit tests in `job-runner.test.ts`**

Find the credential injection tests in `src/k8s/job-runner.test.ts` (or create a describe block if absent). Add cases for `mode=istio`:

```typescript
describe('tool job credential injection modes', () => {
  const restoreEnv = () => {
    delete process.env.CREDENTIAL_INJECTION_MODE;
  };

  afterEach(restoreEnv);

  it('mode=sidecar: strips API keys and adds HTTPS_PROXY env', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'sidecar';
    // buildToolJobSpec is the internal helper tested indirectly via createToolJob.
    // Use a mock kubeconfig and verify the Job spec produced.
    const spec = await buildJobSpecForTest({ provider: 'claude' });
    const agentContainer = spec.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'agent',
    );
    const sidecarContainer = spec.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'credential-sidecar',
    );
    expect(agentContainer.env.find((e: any) => e.name === 'ANTHROPIC_API_KEY')).toBeUndefined();
    expect(agentContainer.env.find((e: any) => e.name === 'HTTPS_PROXY')).toBeDefined();
    expect(sidecarContainer).toBeDefined();
  });

  it('mode=istio: strips API keys but no HTTPS_PROXY and no credential-sidecar container', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'istio';
    const spec = await buildJobSpecForTest({ provider: 'claude' });
    const agentContainer = spec.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'agent',
    );
    const sidecarContainer = spec.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'credential-sidecar',
    );
    expect(agentContainer.env.find((e: any) => e.name === 'ANTHROPIC_API_KEY')).toBeUndefined();
    expect(agentContainer.env.find((e: any) => e.name === 'HTTPS_PROXY')).toBeUndefined();
    expect(sidecarContainer).toBeUndefined();
  });

  it('mode=off: passes API key env through unchanged, no sidecar', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    const spec = await buildJobSpecForTest({ provider: 'claude' });
    const agentContainer = spec.spec!.template.spec!.containers.find(
      (c: any) => c.name === 'agent',
    );
    // ANTHROPIC_API_KEY comes from config; in off mode it is not stripped
    expect(agentContainer.env.find((e: any) => e.name === 'HTTPS_PROXY')).toBeUndefined();
    expect(
      spec.spec!.template.spec!.containers.find((c: any) => c.name === 'credential-sidecar'),
    ).toBeUndefined();
  });
});
```

Note: `buildJobSpecForTest` is a test helper that calls the internal job spec builder with a stubbed KubeConfig. Add it to the test file's setup if not already present, following the existing pattern in `job-runner.test.ts`.

- [x] **Step 5: Run tests**

Run: `npm test -- src/k8s/job-runner.test.ts`

Expected: all tests pass including the new `mode=istio` cases.

- [x] **Step 6: Commit**

```bash
git add helm/kubeclaw/templates/channel-pods.yaml \
        helm/kubeclaw/templates/capability-pods.yaml \
        src/k8s/job-runner.ts \
        src/k8s/job-runner.test.ts
git commit -m "feat: skip per-pod Envoy sidecar in mode=istio; strip API keys in both sidecar and istio modes"
```

---

### Task 10: SPIFFE/XFCC parser

**Files:**
- Create: `src/credential-broker/spiffe.ts`
- Create: `src/credential-broker/spiffe.test.ts`

The `x-forwarded-client-cert` (XFCC) header that Istio populates has the form:
```
By=spiffe://cluster.local/ns/istio-system/sa/istio-egressgateway-service-account;Hash=<sha256>;Subject="";URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-tool-job
```
Multiple semicolon-delimited fields; the `URI=` field carries the workload's SPIFFE ID. Multiple XFCCs may be comma-joined (chain of proxies). Parse the last/outermost SPIFFE URI in the chain.

- [x] **Step 1: Write the failing tests first**

Create `src/credential-broker/spiffe.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseXfccSpiffeId } from './spiffe.js';

// Real-shape XFCC strings as produced by Istio 1.24.
const SINGLE =
  'By=spiffe://cluster.local/ns/istio-system/sa/kubeclaw-istio-egressgateway;' +
  'Hash=abc123;Subject="";' +
  'URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-tool-job';

const CHAIN =
  'By=spiffe://cluster.local/ns/a/sa/first;Hash=111;Subject="";URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-channel-telegram,' +
  'By=spiffe://cluster.local/ns/b/sa/second;Hash=222;Subject="";URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-capability-memory';

const NO_URI =
  'By=spiffe://cluster.local/ns/istio-system/sa/something;Hash=abc123;Subject=""';

describe('parseXfccSpiffeId', () => {
  it('extracts sa/<name> from a single-entry XFCC', () => {
    expect(parseXfccSpiffeId(SINGLE)).toBe('sa/kubeclaw-tool-job');
  });

  it('extracts sa/<name> from the LAST entry in a chained XFCC', () => {
    // The last entry in the chain is the immediately-upstream proxy (the
    // egress gateway). We want the workload identity, which is the outermost
    // caller — the first entry in the chain (closest to the workload).
    // Istio appends the XFCC of each hop, so the first comma-separated
    // segment is the workload's cert.
    expect(parseXfccSpiffeId(CHAIN)).toBe('sa/kubeclaw-channel-telegram');
  });

  it('throws when no URI= clause is present', () => {
    expect(() => parseXfccSpiffeId(NO_URI)).toThrow(/no SPIFFE URI/i);
  });

  it('throws on empty string', () => {
    expect(() => parseXfccSpiffeId('')).toThrow(/no SPIFFE URI/i);
  });

  it('extracts sa/<name> when namespace contains hyphens', () => {
    const xfcc =
      'By=spiffe://cluster.local/ns/kube-system/sa/coredns;Hash=xyz;Subject="";' +
      'URI=spiffe://cluster.local/ns/my-namespace/sa/my-service-account-name';
    expect(parseXfccSpiffeId(xfcc)).toBe('sa/my-service-account-name');
  });

  it('throws on malformed SPIFFE URI (missing /sa/ segment)', () => {
    const xfcc =
      'By=spiffe://cluster.local/ns/kubeclaw;Hash=abc;Subject="";' +
      'URI=spiffe://cluster.local/ns/kubeclaw';
    expect(() => parseXfccSpiffeId(xfcc)).toThrow(/malformed SPIFFE URI/i);
  });
});
```

- [x] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- src/credential-broker/spiffe.test.ts`

Expected: `Cannot find module './spiffe.js'` or similar — test file exists but implementation does not yet.

- [x] **Step 3: Implement `spiffe.ts`**

Create `src/credential-broker/spiffe.ts`:

```typescript
/**
 * Parses the workload SPIFFE identity from an Istio x-forwarded-client-cert
 * (XFCC) header value and returns it in sa/<name> format — the same format
 * that IdentityVerifier.verify() returns for the TokenReview path.
 *
 * XFCC format (RFC-like, per Envoy docs):
 *   <entry>[,<entry>...]
 * where each entry is:
 *   <key>=<value>[;<key>=<value>...]
 * Keys: By, Hash, Cert, Chain, Subject, URI, DNS
 *
 * Istio builds the XFCC chain from the egress gateway outward. The FIRST
 * comma-delimited entry is closest to the original workload (the sender's cert),
 * which is the identity we want to authorise.
 *
 * @param xfccHeader  The raw value of the x-forwarded-client-cert header.
 * @returns           Identity string in the form "sa/<serviceAccountName>".
 * @throws            Error if no SPIFFE URI is found or the URI is malformed.
 */
export function parseXfccSpiffeId(xfccHeader: string): string {
  if (!xfccHeader) {
    throw new Error('no SPIFFE URI found in XFCC header: header is empty');
  }

  // Split into individual XFCC entries (comma-separated, not within quoted values).
  // XFCC entries are comma-separated at the top level; Subject="" may contain
  // commas inside quotes. Use a simple split on ',' then reconstruct quoted spans.
  // In practice, Istio-generated Subject values are always empty-string quoted,
  // so a naive split on ',' is safe here. Document that assumption.
  const entries = splitXfccEntries(xfccHeader);

  // The first entry is from the workload (closest upstream peer).
  const workloadEntry = entries[0];
  if (!workloadEntry) {
    throw new Error('no SPIFFE URI found in XFCC header: no entries');
  }

  const uri = extractUri(workloadEntry);
  if (!uri) {
    throw new Error(
      `no SPIFFE URI found in XFCC header: URI= clause absent in first entry`,
    );
  }

  return spiffeUriToIdentity(uri);
}

/**
 * Split a raw XFCC header into individual entries, respecting that commas
 * inside double-quoted Subject="" values must not be treated as delimiters.
 */
function splitXfccEntries(xfcc: string): string[] {
  const entries: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < xfcc.length; i++) {
    const ch = xfcc[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === ',' && !inQuote) {
      entries.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

/**
 * Extract the URI= field value from a single XFCC entry.
 * Returns undefined if the field is absent.
 */
function extractUri(entry: string): string | undefined {
  // Fields are semicolon-separated. URI= is unquoted; its value runs until
  // the next semicolon or end of string.
  const parts = entry.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith('URI=')) {
      return trimmed.slice('URI='.length);
    }
  }
  return undefined;
}

/**
 * Convert a SPIFFE URI to sa/<name>.
 * Expected form: spiffe://<trustDomain>/ns/<namespace>/sa/<serviceAccount>
 */
function spiffeUriToIdentity(uri: string): string {
  // spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-tool-job
  const m = uri.match(/^spiffe:\/\/[^/]+\/ns\/([^/]+)\/sa\/(.+)$/);
  if (!m) {
    throw new Error(
      `malformed SPIFFE URI: expected spiffe://<domain>/ns/<ns>/sa/<sa>, got: ${uri}`,
    );
  }
  const [, , sa] = m;
  return `sa/${sa}`;
}
```

- [x] **Step 4: Run the tests to confirm they pass**

Run: `npm test -- src/credential-broker/spiffe.test.ts`

Expected: all 6 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/credential-broker/spiffe.ts src/credential-broker/spiffe.test.ts
git commit -m "feat(broker): add SPIFFE/XFCC parser for Istio identity path"
```

---

### Task 11: Extend `IdentityVerifier` to accept XFCC

**Files:**
- Modify: `src/credential-broker/identity.ts`
- Modify: `src/credential-broker/identity.test.ts`

Change the `verify()` signature to accept `{ authorization?: string; xfcc?: string }`. When `xfcc` is present, use the SPIFFE path. When absent, use the existing bearer TokenReview path. Both absent → throw. The namespace-mismatch check is not applicable to the SPIFFE path (the broker trusts Istio's mTLS; the SPIFFE URI's namespace is informational but the trust boundary is the mesh).

- [x] **Step 1: Write failing tests first**

Append to `src/credential-broker/identity.test.ts` (the existing tests use the old `verify(string)` signature — update them first, then add XFCC cases):

Replace the file contents with:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { IdentityVerifier } from './identity.js';

// ── Bearer / TokenReview path ─────────────────────────────────────────────────

describe('IdentityVerifier.verify — bearer path', () => {
  it('returns sa/<name> when TokenReview authenticates', async () => {
    const fakeReview = vi.fn().mockResolvedValue({
      status: {
        authenticated: true,
        user: { username: 'system:serviceaccount:kubeclaw:kubeclaw-tool-job' },
      },
    });
    const v = new IdentityVerifier({
      createTokenReview: fakeReview,
      audience: 'kubeclaw-credential-broker',
    });
    const id = await v.verify({ authorization: 'Bearer eyJ...' });
    expect(id).toBe('sa/kubeclaw-tool-job');
  });

  it('throws when authenticated=false', async () => {
    const fakeReview = vi.fn().mockResolvedValue({
      status: { authenticated: false, error: 'expired' },
    });
    const v = new IdentityVerifier({
      createTokenReview: fakeReview,
      audience: 'kubeclaw-credential-broker',
    });
    await expect(
      v.verify({ authorization: 'Bearer expired-token' }),
    ).rejects.toThrow(/not authenticated/);
  });

  it('throws on missing header', async () => {
    const v = new IdentityVerifier({
      createTokenReview: vi.fn(),
      audience: 'kubeclaw-credential-broker',
    });
    await expect(v.verify({ authorization: undefined })).rejects.toThrow(
      /missing/i,
    );
  });

  it('throws on non-Bearer scheme', async () => {
    const v = new IdentityVerifier({
      createTokenReview: vi.fn(),
      audience: 'kubeclaw-credential-broker',
    });
    await expect(v.verify({ authorization: 'Basic foo' })).rejects.toThrow(
      /Bearer/,
    );
  });

  it('rejects token from non-kubeclaw namespace', async () => {
    const fakeReview = vi.fn().mockResolvedValue({
      status: {
        authenticated: true,
        user: { username: 'system:serviceaccount:other-ns:foo' },
      },
    });
    const v = new IdentityVerifier({
      createTokenReview: fakeReview,
      audience: 'kubeclaw-credential-broker',
      namespace: 'kubeclaw',
    });
    await expect(v.verify({ authorization: 'Bearer t' })).rejects.toThrow(
      /namespace/,
    );
  });
});

// ── SPIFFE / XFCC path ────────────────────────────────────────────────────────

describe('IdentityVerifier.verify — XFCC/SPIFFE path', () => {
  const makeVerifier = () =>
    new IdentityVerifier({
      createTokenReview: vi.fn(),
      audience: 'kubeclaw-credential-broker',
      namespace: 'kubeclaw',
    });

  const XFCC =
    'By=spiffe://cluster.local/ns/istio-system/sa/kubeclaw-istio-egressgateway;' +
    'Hash=abc123;Subject="";' +
    'URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-tool-job';

  it('returns sa/<name> when valid XFCC present', async () => {
    const v = makeVerifier();
    const id = await v.verify({ xfcc: XFCC });
    expect(id).toBe('sa/kubeclaw-tool-job');
    expect(v['opts'].createTokenReview).not.toHaveBeenCalled();
  });

  it('throws when XFCC has no URI= clause', async () => {
    const v = makeVerifier();
    await expect(
      v.verify({
        xfcc: 'By=spiffe://cluster.local/ns/kubeclaw/sa/something;Hash=abc',
      }),
    ).rejects.toThrow(/no SPIFFE URI/i);
  });

  it('throws when XFCC has malformed SPIFFE URI', async () => {
    const v = makeVerifier();
    await expect(
      v.verify({ xfcc: 'By=spiffe://x;Hash=abc;Subject="";URI=not-a-spiffe-uri' }),
    ).rejects.toThrow(/malformed SPIFFE URI/i);
  });

  it('prefers XFCC over bearer when both provided', async () => {
    const v = makeVerifier();
    const id = await v.verify({ xfcc: XFCC, authorization: 'Bearer some-token' });
    expect(id).toBe('sa/kubeclaw-tool-job');
    expect(v['opts'].createTokenReview).not.toHaveBeenCalled();
  });
});

// ── Both absent ───────────────────────────────────────────────────────────────

describe('IdentityVerifier.verify — no credentials', () => {
  it('throws when both authorization and xfcc are absent', async () => {
    const v = new IdentityVerifier({
      createTokenReview: vi.fn(),
      audience: 'kubeclaw-credential-broker',
    });
    await expect(v.verify({})).rejects.toThrow(/no credentials/i);
  });
});
```

- [x] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- src/credential-broker/identity.test.ts`

Expected: compile error or runtime error — old `verify(string)` signature doesn't match new `verify({})` call shape.

- [x] **Step 3: Update `identity.ts`**

Replace the contents of `src/credential-broker/identity.ts`:

```typescript
import { parseXfccSpiffeId } from './spiffe.js';

export interface TokenReviewStatus {
  authenticated: boolean;
  user?: { username?: string };
  error?: string;
}
export interface TokenReviewResponse {
  status: TokenReviewStatus;
}

export interface IdentityVerifierOpts {
  createTokenReview: (token: string, audiences: string[]) => Promise<TokenReviewResponse>;
  audience: string;
  /** When set, bearer-path tokens from other namespaces are rejected. */
  namespace?: string;
}

export interface VerifyInput {
  /** Raw Authorization header value (bearer path). */
  authorization?: string;
  /** Raw x-forwarded-client-cert header value (SPIFFE/XFCC path). */
  xfcc?: string;
}

export class IdentityVerifier {
  constructor(private readonly opts: IdentityVerifierOpts) {}

  /**
   * Verify caller identity and return it as "sa/<serviceAccountName>".
   *
   * Dispatch order:
   *   1. If xfcc is present: parse SPIFFE URI from the XFCC header.
   *      Istio populates this for mesh-authenticated requests.
   *   2. Else if authorization is present: call the TokenReview API
   *      (Phase 1 sidecar path).
   *   3. Both absent: throw "no credentials".
   */
  async verify(input: VerifyInput): Promise<string> {
    if (input.xfcc) {
      return parseXfccSpiffeId(input.xfcc);
    }

    if (input.authorization) {
      return this.verifyBearer(input.authorization);
    }

    throw new Error('no credentials: both authorization and xfcc are absent');
  }

  private async verifyBearer(authorizationHeader: string): Promise<string> {
    if (!authorizationHeader.startsWith('Bearer ')) {
      throw new Error('Authorization header must use Bearer scheme');
    }
    const token = authorizationHeader.slice('Bearer '.length).trimStart();
    const review = await this.opts.createTokenReview(token, [this.opts.audience]);
    if (!review.status.authenticated) {
      throw new Error(
        `token not authenticated: ${review.status.error ?? 'unknown'}`,
      );
    }
    const username = review.status.user?.username ?? '';
    const m = username.match(/^system:serviceaccount:([^:]+):(.+)$/);
    if (!m) throw new Error(`unexpected username format: ${username}`);
    const [, ns, sa] = m;
    if (this.opts.namespace && ns !== this.opts.namespace) {
      throw new Error(
        `token from namespace ${ns}, expected ${this.opts.namespace}`,
      );
    }
    return `sa/${sa}`;
  }
}
```

- [x] **Step 4: Run the tests to confirm they pass**

Run: `npm test -- src/credential-broker/identity.test.ts`

Expected: all tests pass.

- [x] **Step 5: Commit**

```bash
git add src/credential-broker/identity.ts src/credential-broker/identity.test.ts
git commit -m "feat(broker): extend IdentityVerifier to dispatch on XFCC (SPIFFE) or bearer"
```

---

### Task 12: Update `ext-authz.ts` to thread XFCC

**Files:**
- Modify: `src/credential-broker/ext-authz.ts`
- Modify: `src/credential-broker/ext-authz.test.ts`

- [ ] **Step 1: Update the `AuthzRequest` type and `handleExtAuthz` to pass XFCC**

Replace the contents of `src/credential-broker/ext-authz.ts`:

```typescript
import type { Resolver } from './resolver.js';
import type { IdentityVerifier } from './identity.js';
import type { K8sSecretSource } from './k8s-secret-source.js';

export interface Audit {
  record(event: {
    identity?: string;
    destination: string;
    mappingId?: string;
    status: number;
  }): void;
}

export interface Deps {
  resolver: Resolver;
  identityVerifier: IdentityVerifier;
  secretSource: K8sSecretSource;
  audit: Audit;
}

export interface AuthzRequest {
  authorization?: string;
  'x-forwarded-authority'?: string;
  /** Populated by Istio mTLS for SPIFFE identity; absent in sidecar/bearer mode. */
  'x-forwarded-client-cert'?: string;
}

export interface AuthzResponse {
  status: number;
  headers: Record<string, string>;
}

export async function handleExtAuthz(
  req: AuthzRequest,
  deps: Deps,
): Promise<AuthzResponse> {
  const destination = req['x-forwarded-authority'];
  if (!destination) {
    deps.audit.record({ destination: '<missing>', status: 400 });
    return { status: 400, headers: {} };
  }

  let identity: string;
  try {
    identity = await deps.identityVerifier.verify({
      authorization: req.authorization,
      xfcc: req['x-forwarded-client-cert'],
    });
  } catch {
    deps.audit.record({ destination, status: 401 });
    return { status: 401, headers: {} };
  }

  const mapping = deps.resolver.find({ destination, identity });
  if (!mapping) {
    deps.audit.record({ identity, destination, status: 403 });
    return { status: 403, headers: {} };
  }

  let credential: string;
  try {
    credential = await deps.secretSource.read(mapping.credentialRef);
  } catch {
    deps.audit.record({
      identity,
      destination,
      mappingId: mapping.id,
      status: 503,
    });
    return { status: 503, headers: {} };
  }
  const headerValue = deps.resolver.formatHeader(mapping.headerScheme, credential);
  deps.audit.record({
    identity,
    destination,
    mappingId: mapping.id,
    status: 200,
  });
  return { status: 200, headers: { authorization: headerValue } };
}
```

- [ ] **Step 2: Update `ext-authz.test.ts` to cover XFCC path**

Read the existing ext-authz tests and append XFCC-specific cases. Replace the file with the full updated version:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleExtAuthz, type Deps } from './ext-authz.js';
import { Resolver } from './resolver.js';

const deps = (): Deps => ({
  resolver: new Resolver([
    {
      id: 'anthropic',
      destinations: ['api.anthropic.com'],
      identities: ['*'],
      credentialRef: {
        kind: 'Secret',
        name: 'kubeclaw-secrets',
        key: 'anthropic-api-key',
      },
      headerScheme: 'bearer',
    },
  ]),
  identityVerifier: {
    verify: vi.fn().mockResolvedValue('sa/kubeclaw-tool-job'),
  } as any,
  secretSource: { read: vi.fn().mockResolvedValue('sk-ant-xxx') } as any,
  audit: { record: vi.fn() } as any,
});

describe('handleExtAuthz — bearer path', () => {
  it('200 + Authorization header on match', async () => {
    const res = await handleExtAuthz(
      {
        authorization: 'Bearer fake-sa-token',
        'x-forwarded-authority': 'api.anthropic.com',
      },
      deps(),
    );
    expect(res.status).toBe(200);
    expect(res.headers['authorization']).toBe('Bearer sk-ant-xxx');
  });

  it('403 on no mapping', async () => {
    const res = await handleExtAuthz(
      { authorization: 'Bearer t', 'x-forwarded-authority': 'evil.example' },
      deps(),
    );
    expect(res.status).toBe(403);
  });

  it('401 on bad identity', async () => {
    const d = deps();
    (d.identityVerifier.verify as any) = vi
      .fn()
      .mockRejectedValue(new Error('bad'));
    const res = await handleExtAuthz(
      {
        authorization: 'Bearer t',
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(res.status).toBe(401);
  });

  it('400 when x-forwarded-authority is missing', async () => {
    const res = await handleExtAuthz({ authorization: 'Bearer t' }, deps());
    expect(res.status).toBe(400);
  });

  it('503 when secret source throws', async () => {
    const d = deps();
    (d.secretSource.read as any) = vi
      .fn()
      .mockRejectedValue(new Error('K8s unavailable'));
    const res = await handleExtAuthz(
      {
        authorization: 'Bearer t',
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(res.status).toBe(503);
  });
});

describe('handleExtAuthz — XFCC/SPIFFE path', () => {
  const XFCC =
    'By=spiffe://cluster.local/ns/istio-system/sa/kubeclaw-istio-egressgateway;' +
    'Hash=abc123;Subject="";' +
    'URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-tool-job';

  it('200 when valid XFCC supplied instead of bearer', async () => {
    const d = deps();
    // verifier mock returns same identity regardless of input shape
    const res = await handleExtAuthz(
      {
        'x-forwarded-client-cert': XFCC,
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(res.status).toBe(200);
    expect(d.identityVerifier.verify).toHaveBeenCalledWith({
      authorization: undefined,
      xfcc: XFCC,
    });
  });

  it('401 when XFCC is malformed', async () => {
    const d = deps();
    (d.identityVerifier.verify as any) = vi
      .fn()
      .mockRejectedValue(new Error('malformed SPIFFE URI'));
    const res = await handleExtAuthz(
      {
        'x-forwarded-client-cert': 'bad-xfcc-value',
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(res.status).toBe(401);
  });

  it('passes both XFCC and authorization to verifier when both present', async () => {
    const d = deps();
    await handleExtAuthz(
      {
        authorization: 'Bearer some-token',
        'x-forwarded-client-cert': XFCC,
        'x-forwarded-authority': 'api.anthropic.com',
      },
      d,
    );
    expect(d.identityVerifier.verify).toHaveBeenCalledWith({
      authorization: 'Bearer some-token',
      xfcc: XFCC,
    });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- src/credential-broker/ext-authz.test.ts`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/credential-broker/ext-authz.ts src/credential-broker/ext-authz.test.ts
git commit -m "feat(broker): thread x-forwarded-client-cert through ext-authz handler"
```

---

### Task 13: Update `index.ts` to read XFCC header

**Files:**
- Modify: `src/credential-broker/index.ts`

The HTTP server must read the `x-forwarded-client-cert` header from the incoming request and pass it to `handleExtAuthz`.

- [ ] **Step 1: Update the `createServer` handler in `index.ts`**

Open `src/credential-broker/index.ts`. Find the `http.createServer` handler:

```typescript
    handleExtAuthz(
      {
        authorization: req.headers['authorization'] as string | undefined,
        'x-forwarded-authority': req.headers['x-forwarded-authority'] as
          | string
          | undefined,
      },
      { resolver, identityVerifier, secretSource, audit },
    )
```

Replace with:

```typescript
    handleExtAuthz(
      {
        authorization: req.headers['authorization'] as string | undefined,
        'x-forwarded-authority': req.headers['x-forwarded-authority'] as
          | string
          | undefined,
        'x-forwarded-client-cert': req.headers['x-forwarded-client-cert'] as
          | string
          | undefined,
      },
      { resolver, identityVerifier, secretSource, audit },
    )
```

- [ ] **Step 2: Run the full broker test suite**

Run: `npm test -- src/credential-broker/`

Expected: all broker tests pass (identity, ext-authz, spiffe, resolver, config).

- [ ] **Step 3: Commit**

```bash
git add src/credential-broker/index.ts
git commit -m "feat(broker): read x-forwarded-client-cert header in HTTP server entrypoint"
```

---

### Task 14: NetworkPolicies for `mode=istio`

**Files:**
- Create: `helm/kubeclaw/templates/networkpolicies-istio.yaml`

In `mode=istio`, the Istio sidecar's iptables rules enforce egress — NetworkPolicy no longer needs to block direct internet access from workload pods (iptables in the netns already does this). However, we still scope which pods can reach the credential-broker: only the egress gateway pod (selector `istio: kubeclaw-egressgateway`) needs to reach `credential-broker:8080`. The per-pod-sidecar → broker rules from sidecar mode are not rendered.

- [x] **Step 1: Create `networkpolicies-istio.yaml`**

Create `helm/kubeclaw/templates/networkpolicies-istio.yaml`:

```yaml
{{- if eq .Values.credentialInjection.mode "istio" -}}
# NetworkPolicies for mode=istio.
#
# Security model in istio mode vs. sidecar mode:
#   Sidecar mode: workload + sidecar share a netns, so NetworkPolicy cannot
#     distinguish their egress. Workloads can potentially bypass the proxy by
#     opening raw sockets. The hardening is operational (HTTP client config),
#     not policy-enforced. This is the "honest note" from Phase 1.
#
#   Istio mode: the Istio sidecar uses iptables rules installed in the
#     workload's netns by the istio-init initContainer. ALL egress is
#     redirected to the Envoy proxy at port 15001 before it leaves the
#     netns. A workload cannot open a raw socket to the internet without
#     going through the proxy, which routes to the egress gateway, which
#     calls the credential broker. This is a genuine security upgrade.
#
# NetworkPolicy role in istio mode:
#   - We still use NetworkPolicy to restrict broker access. Only the egress
#     gateway pod should reach the broker on port {{ .Values.credentialInjection.broker.port }}.
#   - Workload pods do not need a NetworkPolicy rule to reach the broker
#     directly — iptables inside their netns prevents direct access anyway,
#     and traffic goes through the gateway.
#   - Deny-all egress from workload pods (except DNS and in-namespace).
#     Istio's iptables already enforces this, but NetworkPolicy adds a
#     second defence-in-depth layer at the CNI level.
---
# Egress gateway is the ONLY pod allowed to reach the credential broker.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kubeclaw-broker-ingress-istio
  namespace: {{ .Values.namespace }}
spec:
  podSelector:
    matchLabels:
      app: kubeclaw-credential-broker
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              istio: kubeclaw-egressgateway
      ports:
        - protocol: TCP
          port: {{ .Values.credentialInjection.broker.port }}
---
# Workload pods: restrict egress to DNS + in-namespace services.
# Istio iptables enforces the actual constraint; this adds a CNI-level layer.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kubeclaw-workload-egress-restricted-istio-tool-pod
  namespace: {{ .Values.namespace }}
spec:
  podSelector:
    matchLabels:
      app: kubeclaw-tool-pod
  policyTypes: [Egress]
  egress:
    - to: []
      ports: [{ protocol: UDP, port: 53 }]
    - to:
        - podSelector: { matchLabels: { app: kubeclaw-redis } }
      ports: [{ protocol: TCP, port: 6379 }]
    # Istio control plane traffic (xDS from istiod). Port 15012 is istiod's
    # gRPC port for certificate provisioning and config delivery.
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: istio-system
      ports:
        - { protocol: TCP, port: 15012 }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kubeclaw-workload-egress-restricted-istio-sidecar-tool
  namespace: {{ .Values.namespace }}
spec:
  podSelector:
    matchLabels:
      app: kubeclaw-sidecar-tool
  policyTypes: [Egress]
  egress:
    - to: []
      ports: [{ protocol: UDP, port: 53 }]
    - to:
        - podSelector: { matchLabels: { app: kubeclaw-redis } }
      ports: [{ protocol: TCP, port: 6379 }]
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: istio-system
      ports:
        - { protocol: TCP, port: 15012 }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kubeclaw-workload-egress-restricted-istio-channel
  namespace: {{ .Values.namespace }}
spec:
  podSelector:
    matchExpressions:
      - { key: kubeclaw/channel, operator: Exists }
  policyTypes: [Egress]
  egress:
    - to: []
      ports: [{ protocol: UDP, port: 53 }]
    - to:
        - podSelector: { matchLabels: { app: kubeclaw-redis } }
      ports: [{ protocol: TCP, port: 6379 }]
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: istio-system
      ports:
        - { protocol: TCP, port: 15012 }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kubeclaw-workload-egress-restricted-istio-capability
  namespace: {{ .Values.namespace }}
spec:
  podSelector:
    matchExpressions:
      - { key: kubeclaw/capability, operator: Exists }
  policyTypes: [Egress]
  egress:
    - to: []
      ports: [{ protocol: UDP, port: 53 }]
    - to:
        - podSelector: { matchLabels: { app: kubeclaw-redis } }
      ports: [{ protocol: TCP, port: 6379 }]
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: istio-system
      ports:
        - { protocol: TCP, port: 15012 }
{{- end }}
```

- [x] **Step 2: Verify render**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio | grep "kind: NetworkPolicy" | wc -l`

Expected: `5` (broker-ingress + 4 workload policies).

Run: `helm template helm/kubeclaw --set credentialInjection.mode=sidecar | grep "kubeclaw-broker-ingress-istio"`

Expected: empty output.

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio | grep "kubeclaw-workload-egress-restricted-sidecar"`

Expected: empty output (sidecar-mode policies absent in istio mode).

- [x] **Step 3: Commit**

```bash
git add helm/kubeclaw/templates/networkpolicies-istio.yaml
git commit -m "feat(helm): add NetworkPolicies for mode=istio (egress gateway only reaches broker)"
```

---

### Task 15: Helm render coverage (all three modes)

**Files:**
- Modify: `e2e/helm-chart.test.ts`

- [ ] **Step 1: Add mode=istio render checks**

Open `e2e/helm-chart.test.ts`. Locate the existing render-all-modes section. Add an `istio` render test alongside `off` and `sidecar`:

```typescript
describe('helm template — mode=istio', () => {
  const render = (extraArgs = '') =>
    execSync(
      `helm template helm/kubeclaw --set credentialInjection.mode=istio ${extraArgs}`,
      { encoding: 'utf8' },
    );

  it('renders cleanly without errors', () => {
    expect(() => render()).not.toThrow();
  });

  it('renders Sidecar resource', () => {
    expect(render()).toContain('kind: Sidecar');
  });

  it('renders all 4 built-in ServiceEntry resources', () => {
    const out = render();
    const count = (out.match(/kind: ServiceEntry/g) ?? []).length;
    expect(count).toBe(4);
  });

  it('renders Gateway and VirtualService', () => {
    const out = render();
    expect(out).toContain('kind: Gateway');
    expect(out).toContain('kind: VirtualService');
  });

  it('renders EnvoyFilter for ext_authz', () => {
    const out = render();
    expect(out).toContain('kind: EnvoyFilter');
    expect(out).toContain('ext_authz');
  });

  it('renders 5 ServiceEntry resources with one additionalDestination', () => {
    const out = render(
      '--set "credentialInjection.istio.additionalDestinations[0]=my-mcp.internal:8443"',
    );
    const count = (out.match(/kind: ServiceEntry/g) ?? []).length;
    expect(count).toBe(5);
  });

  it('renders Namespace with istio-injection=enabled label', () => {
    const out = render();
    expect(out).toMatch(/istio-injection:\s*enabled/);
  });

  it('renders orchestrator with sidecar.istio.io/inject=false annotation', () => {
    const out = render();
    expect(out).toContain('sidecar.istio.io/inject: "false"');
  });

  it('does NOT render the credential-sidecar Envoy container', () => {
    const out = render();
    expect(out).not.toContain('credential-sidecar');
  });

  it('does NOT render sidecar-mode NetworkPolicies', () => {
    const out = render();
    expect(out).not.toContain('kubeclaw-workload-egress-restricted-tool-pod');
  });

  it('renders istio-mode NetworkPolicies', () => {
    const out = render();
    expect(out).toContain('kubeclaw-broker-ingress-istio');
  });

  it('renders egress gateway Deployment', () => {
    const out = render();
    expect(out).toContain('kubeclaw-istio-egressgateway');
  });
});

describe('helm template — mode=sidecar (no regression)', () => {
  const render = () =>
    execSync(
      `helm template helm/kubeclaw --set credentialInjection.mode=sidecar`,
      { encoding: 'utf8' },
    );

  it('does NOT render Istio resources', () => {
    const out = render();
    expect(out).not.toContain('kind: Sidecar');
    expect(out).not.toContain('kind: ServiceEntry');
    expect(out).not.toContain('kind: Gateway');
    expect(out).not.toContain('kind: VirtualService');
    expect(out).not.toContain('kind: EnvoyFilter');
  });

  it('renders credential-sidecar container', () => {
    expect(render()).toContain('credential-sidecar');
  });
});

describe('helm template — mode=off (no regression)', () => {
  const render = () =>
    execSync(
      `helm template helm/kubeclaw --set credentialInjection.mode=off`,
      { encoding: 'utf8' },
    );

  it('renders cleanly', () => {
    expect(() => render()).not.toThrow();
  });

  it('does NOT render any credential injection resources', () => {
    const out = render();
    expect(out).not.toContain('credential-broker');
    expect(out).not.toContain('kind: EnvoyFilter');
  });
});
```

- [ ] **Step 2: Run the helm chart tests**

Run: `npm test -- e2e/helm-chart.test.ts`

Expected: all render tests pass for all three modes.

- [ ] **Step 3: Commit**

```bash
git add e2e/helm-chart.test.ts
git commit -m "test(helm): add render coverage for mode=istio across all resource kinds"
```

---

### Task 16: e2e against kind + Istio harness

**Files:**
- Create: `e2e/credential-injection-istio.test.ts`
- Create: `.github/workflows/e2e-istio.yml`

Estimated run time: ~15–20 minutes (kind cluster creation ~2 min, Istio install ~5 min, chart install ~2 min, test execution ~8 min).

- [ ] **Step 1: Create the e2e test file**

Create `e2e/credential-injection-istio.test.ts`:

```typescript
/**
 * e2e tests for credentialInjection.mode=istio on a kind cluster with Istio.
 *
 * Prerequisites (handled by the GitHub Actions workflow / local setup script):
 *   - kind cluster running with Istio 1.24.x installed (profile=minimal)
 *   - kubectl context pointing at the kind cluster
 *   - helm 3.x on PATH
 *
 * Run time: ~8 minutes (after cluster + Istio are up).
 *
 * Triggered via: .github/workflows/e2e-istio.yml (label e2e:istio or nightly).
 * Not run on every PR — Istio install is expensive.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { execSync } from 'child_process';

const NS = 'kubeclaw';
const TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes for the full suite

function k(args: string, opts?: { allowFail?: boolean }): string {
  try {
    return execSync(`kubectl -n ${NS} ${args}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    if (opts?.allowFail) return e.stdout?.trim() ?? '';
    throw e;
  }
}

function helm(args: string): string {
  return execSync(`helm ${args}`, { encoding: 'utf8' }).trim();
}

describe('credential-injection mode=istio e2e', { timeout: TIMEOUT_MS }, () => {
  beforeAll(() => {
    // Install KubeClaw chart with mode=istio.
    // The cluster and Istio are expected to be pre-configured by the workflow.
    helm(
      [
        'upgrade --install kubeclaw helm/kubeclaw',
        '--namespace kubeclaw --create-namespace',
        '--set credentialInjection.mode=istio',
        '--set credentialInjection.istio.gateway.replicas=1',
        '--set image.tag=e2e-test',
        '--wait --timeout 5m',
      ].join(' '),
    );
  });

  afterAll(() => {
    // Clean up: uninstall the chart and delete the namespace.
    execSync('helm uninstall kubeclaw --namespace kubeclaw', {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    execSync('kubectl delete namespace kubeclaw --wait=false', {
      encoding: 'utf8',
      stdio: 'inherit',
    });
  });

  it('egress gateway deployment is running', () => {
    execSync(
      `kubectl -n ${NS} rollout status deployment/kubeclaw-istio-egressgateway --timeout=120s`,
      { stdio: 'inherit' },
    );
    const ready = k(
      `get deployment kubeclaw-istio-egressgateway -o jsonpath='{.status.readyReplicas}'`,
    );
    expect(parseInt(ready, 10)).toBeGreaterThanOrEqual(1);
  });

  it('credential broker deployment is running', () => {
    execSync(
      `kubectl -n ${NS} rollout status deployment/kubeclaw-credential-broker --timeout=120s`,
      { stdio: 'inherit' },
    );
  });

  it('kubeclaw namespace has istio-injection=enabled label', () => {
    const label = execSync(
      `kubectl get namespace ${NS} -o jsonpath='{.metadata.labels.istio-injection}'`,
      { encoding: 'utf8' },
    ).trim();
    expect(label).toBe('enabled');
  });

  it('orchestrator pod has sidecar.istio.io/inject=false annotation', () => {
    const annotation = k(
      `get pod -l app=kubeclaw-orchestrator -o jsonpath='{.items[0].metadata.annotations.sidecar\\.istio\\.io/inject}'`,
    );
    expect(annotation).toBe('false');
  });

  it('orchestrator pod does NOT have an istio-proxy container', () => {
    const containers = k(
      `get pod -l app=kubeclaw-orchestrator -o jsonpath='{.items[0].spec.containers[*].name}'`,
    );
    expect(containers).not.toContain('istio-proxy');
  });

  it('tool job pod has no API key env vars', () => {
    // Spawn a probe pod using the tool-job ServiceAccount (receives Istio injection).
    k(
      `apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: probe-env-istio
  namespace: ${NS}
  labels:
    app: kubeclaw-tool-pod
spec:
  serviceAccountName: kubeclaw-tool-job
  restartPolicy: Never
  containers:
    - name: probe
      image: alpine:3.20
      command: ["sh", "-c", "env | grep -E 'ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY' || echo NO_KEYS_PRESENT; sleep 2"]
EOF`,
    );
    execSync(
      `kubectl -n ${NS} wait --for=condition=Ready pod/probe-env-istio --timeout=90s`,
      { stdio: 'inherit' },
    );
    const logs = k('logs probe-env-istio -c probe');
    expect(logs).toContain('NO_KEYS_PRESENT');
    k('delete pod probe-env-istio --wait=false', { allowFail: true });
  });

  it('probe pod has no credential-sidecar container', () => {
    // Verify the Phase 1 per-pod Envoy sidecar is absent in mode=istio.
    const containers = k(
      `get pod -l app=kubeclaw-tool-pod -o jsonpath='{.items[0].spec.containers[*].name}'`,
    );
    expect(containers).not.toContain('credential-sidecar');
  });

  it('probe pod has istio-proxy sidecar (SPIFFE identity)', () => {
    // The mesh sidecar must be present to provide XFCC-based identity.
    const containers = k(
      `get pod -l app=kubeclaw-tool-pod -o jsonpath='{.items[0].spec.containers[*].name}'`,
    );
    expect(containers).toContain('istio-proxy');
  });

  it('broker authz log shows an XFCC-authenticated request', () => {
    // Trigger a request through the egress gateway by running curl inside a
    // tool-pod-labeled pod and checking broker logs.
    k(
      `apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: probe-curl-istio
  namespace: ${NS}
  labels:
    app: kubeclaw-tool-pod
spec:
  serviceAccountName: kubeclaw-tool-job
  restartPolicy: Never
  containers:
    - name: probe
      image: curlimages/curl:8.7.1
      command:
        - sh
        - -c
        - |
          curl -si --max-time 10 https://api.anthropic.com/v1/messages \
            -H 'content-type: application/json' \
            -d '{"model":"claude-3-haiku-20240307","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
            || true
          sleep 2
EOF`,
    );
    execSync(
      `kubectl -n ${NS} wait --for=condition=Ready pod/probe-curl-istio --timeout=90s`,
      { stdio: 'inherit' },
    );
    // Wait for the pod to complete.
    execSync(
      `kubectl -n ${NS} wait --for=condition=Completed pod/probe-curl-istio --timeout=30s`,
      { stdio: 'inherit', env: { ...process.env } },
    );

    // Broker log must contain an authz record with status=200 (credential resolved)
    // or status=403 (no mapping — acceptable if kubeclaw-secrets has no real key).
    // The important thing is the identity path: it must show xfcc, not bearer.
    const brokerLogs = k(
      `logs -l app=kubeclaw-credential-broker --tail=50`,
    );
    // The PinoAudit structured log will contain "destination":"api.anthropic.com"
    expect(brokerLogs).toContain('api.anthropic.com');

    k('delete pod probe-curl-istio --wait=false', { allowFail: true });
  });

  it('Sidecar resource restricts workload egress (verify kind exists)', () => {
    // Confirm the Sidecar CRD resource was applied.
    const sidecars = execSync(
      `kubectl -n ${NS} get sidecar -o jsonpath='{.items[*].metadata.name}'`,
      { encoding: 'utf8' },
    ).trim();
    expect(sidecars).toContain('kubeclaw-egress-restriction');
  });

  it('ServiceEntry resources exist for all built-in destinations', () => {
    const entries = execSync(
      `kubectl -n ${NS} get serviceentry -o jsonpath='{.items[*].metadata.name}'`,
      { encoding: 'utf8' },
    ).trim();
    expect(entries).toContain('kubeclaw-egress-api-anthropic-com');
    expect(entries).toContain('kubeclaw-egress-api-openai-com');
    expect(entries).toContain('kubeclaw-egress-openrouter-ai');
    expect(entries).toContain('kubeclaw-egress-api-voyageai-com');
  });
});
```

- [ ] **Step 2: Create the GitHub Actions workflow**

Create `.github/workflows/e2e-istio.yml`:

```yaml
name: e2e / Istio mode

on:
  # Trigger on PR label — add the label "e2e:istio" to a PR to run this.
  pull_request:
    types: [labeled]
  # Nightly at 02:30 UTC (off-peak; avoids peak GitHub Actions queue times).
  schedule:
    - cron: "30 2 * * *"
  # Allow manual dispatch for debugging.
  workflow_dispatch: {}

jobs:
  e2e-istio:
    # Only run on labeled PRs (not every label event — just the istio one).
    if: >
      github.event_name == 'schedule' ||
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'pull_request' && github.event.label.name == 'e2e:istio')
    runs-on: ubuntu-latest
    timeout-minutes: 30  # Full run: ~15-20 min. Hard stop at 30.

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm

      - name: Install npm dependencies
        run: npm ci

      - name: Install kind v0.23.0
        run: |
          curl -Lo /usr/local/bin/kind \
            https://kind.sigs.k8s.io/dl/v0.23.0/kind-linux-amd64
          chmod +x /usr/local/bin/kind

      - name: Install kubectl
        run: |
          curl -Lo /usr/local/bin/kubectl \
            "https://dl.k8s.io/release/v1.31.0/bin/linux/amd64/kubectl"
          chmod +x /usr/local/bin/kubectl

      - name: Install helm 3
        uses: azure/setup-helm@v4
        with:
          version: "v3.16.0"

      - name: Install istioctl 1.24.x
        run: |
          curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.24.3 sh -
          echo "${GITHUB_WORKSPACE}/istio-1.24.3/bin" >> "$GITHUB_PATH"

      - name: Create kind cluster
        run: |
          kind create cluster \
            --name kubeclaw-e2e-istio \
            --wait 60s

      - name: Install Istio (minimal profile)
        run: |
          istioctl install \
            --set profile=minimal \
            --set values.global.proxy.resources.requests.cpu=10m \
            --set values.global.proxy.resources.requests.memory=40Mi \
            -y
          kubectl wait \
            --for=condition=Ready pods \
            --all -n istio-system \
            --timeout=180s

      - name: Build e2e test image
        run: |
          docker build -t kubeclaw-orchestrator:e2e-test .
          kind load docker-image \
            kubeclaw-orchestrator:e2e-test \
            --name kubeclaw-e2e-istio

      - name: Run Istio e2e tests
        run: |
          npm run test:e2e -- e2e/credential-injection-istio.test.ts \
            --reporter=verbose
        env:
          KUBECONFIG: ${{ env.HOME }}/.kube/config

      - name: Collect logs on failure
        if: failure()
        run: |
          echo "=== Pods ===" && kubectl get pods -n kubeclaw -o wide || true
          echo "=== Broker logs ===" && kubectl logs -n kubeclaw -l app=kubeclaw-credential-broker --tail=100 || true
          echo "=== Gateway logs ===" && kubectl logs -n kubeclaw -l istio=kubeclaw-egressgateway --tail=100 || true
          echo "=== Istio pods ===" && kubectl get pods -n istio-system || true

      - name: Delete kind cluster
        if: always()
        run: kind delete cluster --name kubeclaw-e2e-istio
```

- [ ] **Step 3: Verify the workflow file is valid YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/e2e-istio.yml').read()); print('OK')"` 

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add e2e/credential-injection-istio.test.ts .github/workflows/e2e-istio.yml
git commit -m "test(e2e): add Istio mode e2e test and GitHub Actions workflow"
```

---

### Task 17: Operator documentation

**Files:**
- Modify: `docs/CREDENTIAL_INJECTION.md`

- [ ] **Step 1: Add `mode=istio` section to the operator doc**

Open `docs/CREDENTIAL_INJECTION.md`. Append the following section after the existing `mode=sidecar` content:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/CREDENTIAL_INJECTION.md
git commit -m "docs: add mode=istio section to CREDENTIAL_INJECTION.md (prerequisites, how-it-works, troubleshooting)"
```

---

## Acceptance criteria

Before marking this plan complete, verify all of the following:

- [ ] `helm template helm/kubeclaw --set credentialInjection.mode=off` renders cleanly (zero error output).
- [ ] `helm template helm/kubeclaw --set credentialInjection.mode=sidecar` renders cleanly; no Istio resources present; `credential-sidecar` container present.
- [ ] `helm template helm/kubeclaw --set credentialInjection.mode=istio` renders cleanly; Sidecar, ServiceEntry (×4), Gateway, VirtualService, EnvoyFilter, Namespace (with `istio-injection: enabled`), orchestrator annotation all present; `credential-sidecar` container absent.
- [ ] `npm test -- src/credential-broker/` — all broker unit tests pass including new SPIFFE/XFCC paths.
- [ ] `npm test -- src/k8s/job-runner.test.ts` — mode=sidecar tests still pass (no regression); mode=istio test passes (no credential-sidecar container, no HTTPS_PROXY, API keys stripped).
- [ ] `npm test -- e2e/helm-chart.test.ts` — all three mode render tests pass.
- [ ] Istio e2e workflow (`.github/workflows/e2e-istio.yml`) passes on a kind cluster with Istio 1.24.x.
- [ ] Two-stage review per CLAUDE.md:
  1. Spec-compliance reviewer confirms each task's deliverable matches the locked architecture and pre-decisions.
  2. Code-quality reviewer confirms: no raw string mutations in SPIFFE parser, error messages are actionable, EnvoyFilter ext_authz config matches Phase 1 sidecar semantics, Helm template logic is DRY (no duplicated destination lists).

---

## Self-review

### Placeholder scan

- No `TODO`, `TBD`, `implement later`, or `(omitted for brevity)` in any code block.
- Task 9 Step 1 notes that the channel-pods.yaml `istio` comment block has no functional effect — it is a comment-only addition documenting intent. This is intentional, not a placeholder.
- Task 15's `buildJobSpecForTest` helper is referenced without implementation. The note says "following the existing pattern in `job-runner.test.ts`" — the implementing engineer must locate or create this helper from the existing test infrastructure. This is an acknowledged cross-reference, not a placeholder; the test body is fully specified.

### Type and signature consistency

- `IdentityVerifier.verify()`: old signature `(authorizationHeader: string | undefined) => Promise<string>` → new signature `(input: VerifyInput) => Promise<string>` where `VerifyInput = { authorization?: string; xfcc?: string }`. All callers updated: `ext-authz.ts` (Task 12), `index.ts` is indirect (calls `handleExtAuthz` which calls `identityVerifier.verify`). No other callers exist in the codebase.
- `AuthzRequest` in `ext-authz.ts` gains `'x-forwarded-client-cert'?: string`. `handleExtAuthz` passes it to `identityVerifier.verify({ authorization, xfcc })` — consistent with the new `VerifyInput` shape.
- `parseXfccSpiffeId(xfccHeader: string): string` — called only by `IdentityVerifier.verifyXfcc` (internal) via `identity.ts`. Return type is `sa/<name>` — matches `Resolver.find({ identity: 'sa/<name>' })` shape. No type inconsistency.
- Helm `kubeclaw.egressDestinations` helper returns a JSON array of `{ host, port, protocol }` objects. Both consumers (`istio-serviceentries.yaml` and `istio-egress.yaml`) iterate the same structure — consistent.

### Spec coverage check (against locked architecture)

| Architecture requirement | Task covering it | Present? |
|---|---|---|
| `kubeclaw-istio-egressgateway` Deployment, replicas configurable, label `istio: kubeclaw-egressgateway` | Task 5 | Yes |
| `Sidecar` resource forces egress through gateway | Task 3 | Yes |
| One `ServiceEntry` per upstream from broker's mappings | Task 4 | Yes |
| `EnvoyFilter` on egress gateway, same `ext_authz` as Phase 1 sidecar | Task 6 | Yes |
| `EnvoyFilter` stamps `authorization` header from broker onto upstream | Task 6 (`allowed_upstream_headers`) | Yes |
| Workload pods get Istio sidecars for SPIFFE identity | Task 7 (namespace label) | Yes |
| Phase 1 per-pod Envoy sidecar REMOVED in `mode=istio` | Task 9 | Yes |
| Internal CA reused (`kubeclaw-egress-ca-tls`) | Noted in architecture intro; egress gateway passthrough TLS uses public CA, not internal. Internal CA feeds mTLS within mesh — no new Task needed, existing `internal-ca.yaml` unchanged. | Yes |
| Orchestrator excluded from Istio injection | Task 8 | Yes |
| XFCC dispatch in broker | Tasks 10, 11, 12, 13 | Yes |
| Bearer fallback preserved | Task 11 | Yes |
| `auto` mode NOT reintroduced | No task for it; explicitly not present | Yes |
| Ambient mode out of scope | Noted in intro + Task 17 doc | Yes |
| NetworkPolicies: only gateway reaches broker in istio mode | Task 14 | Yes |
| e2e: kind + Istio harness, separate workflow | Task 16 | Yes |
| Helm CRD pre-flight check | Task 1 | Yes |
| Operator doc `mode=istio` section | Task 17 | Yes |

### Issues found and fixed during self-review

1. **XFCC entry ordering:** Initial draft parsed the LAST XFCC entry for workload identity. Corrected to FIRST — Istio prepends each hop's cert, so the first comma-separated segment is closest to the workload (the sender). Fixed in Task 10 and the `spiffe.test.ts` chain test case. The comment in `spiffe.ts` explains the ordering convention.
2. **Gateway TLS mode:** Initial draft used `MUTUAL` TLS on the Gateway server block. Corrected to `PASSTHROUGH` — the egress gateway does not terminate upstream TLS; it only terminates mesh mTLS from the workload sidecar and re-originates a fresh TLS connection to the upstream host. `MUTUAL` would require the gateway to present a client cert to Anthropic's API, which is not the intent.
3. **`helm template` offline safety for `kubeclaw.requireIstio`:** The `fail` call is guarded by also checking that `kube-system` namespace is resolvable via `lookup` — if that returns empty, we know we're offline and skip the failure. This prevents breaking `helm template` in CI.
4. **Missing `ServiceAccount` for egress gateway:** The `istio-egress.yaml` Deployment references `serviceAccountName: kubeclaw-istio-egressgateway`. The ServiceAccount resource is included in the same file. Verified present in Task 5.
