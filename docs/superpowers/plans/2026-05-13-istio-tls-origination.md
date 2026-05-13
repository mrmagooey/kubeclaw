# Istio TLS Origination + Egress E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the istio-mode credential-injection chain (the gateway must run an HTTP listener so the `ext_authz` HTTP filter actually attaches; per-host `DestinationRule`s originate TLS to the real upstream) and add an end-to-end test that proves a broker-stamped `Authorization` header reaches an in-cluster mock upstream.

**Architecture:** Workloads use `http://<host>` URLs. Mesh sidecars wrap that HTTP in mTLS to the egress gateway. The gateway terminates mesh mTLS, runs HCM, dispatches `ext_authz` to the broker, which returns the credential. Envoy stamps it onto the request, then originates TLS to the real upstream via a per-host `DestinationRule` (`tls.mode: SIMPLE`).

**Tech Stack:** Helm 3 (chart templates), Istio 1.24 (`Gateway`, `VirtualService`, `ServiceEntry`, `DestinationRule`, `EnvoyFilter`), TypeScript (orchestrator job-runner), Vitest (unit + integration + e2e), GitHub Actions, kind, kubectl.

**Working branch / worktree.** All work happens on branch `feat/istio-tls-origination` in the worktree at `/home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination`. Run every command from that worktree's root.

**Spec.** `docs/superpowers/specs/2026-05-13-istio-tls-origination-and-egress-e2e-design.md`. Spec sections are the source of truth — when in doubt, check there.

---

## Task 1: Add failing helm render assertions for the new chart shape

**Why first.** The chart change is structural; the only meaningful "unit test" is a `helm template` render assertion. We TDD by adding the assertions that describe the desired output, watching them fail against the current chart, then changing the chart until they pass.

**Files:**
- Modify: `e2e/helm-chart.test.ts:764` (`helm template — mode=istio` suite) and `e2e/helm-chart.test.ts:831` (`helm template — mode=sidecar (no Istio regression)` suite).

- [ ] **Step 1: Add render assertions for the new Gateway / VirtualService / DestinationRule shape**

Open `e2e/helm-chart.test.ts`. Inside the existing `describe('helm template — mode=istio', () => { ... })` block (currently starting at line 764), add the following `it` cases at the end of the block, before its closing `})`:

```ts
  it('renders Gateway with HTTP listener on port 80 (not HTTPS PASSTHROUGH)', () => {
    const out = render();
    // Gateway must declare protocol HTTP on port 80; tls block must be absent
    // for the workload-facing listener.
    expect(out).toMatch(/protocol:\s*HTTP\b(?!S)/);
    expect(out).toContain('number: 80');
    // The old PASSTHROUGH config must be gone.
    expect(out).not.toContain('mode: PASSTHROUGH');
  });

  it('renders VirtualService http: routes (not tls:)', () => {
    const out = render();
    expect(out).toContain('kind: VirtualService');
    expect(out).toMatch(/kind:\s*VirtualService[\s\S]+http:/);
    // The old tls: block in the VS must be gone.
    expect(out).not.toMatch(/kind:\s*VirtualService[\s\S]+\n\s+tls:/);
  });

  it('renders one DestinationRule per built-in HTTPS destination', () => {
    const out = render();
    for (const slug of [
      'api-anthropic-com',
      'api-openai-com',
      'openrouter-ai',
      'api-voyageai-com',
    ]) {
      expect(out).toContain(`kubeclaw-egress-tls-${slug}`);
    }
    expect(out).toMatch(/mode:\s*SIMPLE/);
    expect(out).toMatch(/caCertificates:\s*\/etc\/ssl\/certs\/ca-certificates\.crt/);
  });

  it('renders ServiceEntry with two ports per destination (workload http + upstream tls)', () => {
    const out = render();
    // For each ServiceEntry block, both port-80/HTTP and port-443/HTTPS entries
    // must be present. A single regex spanning both keeps the test resistant to
    // formatting drift while still asserting both ports.
    expect(out).toMatch(
      /name:\s*kubeclaw-egress-api-openai-com[\s\S]+number:\s*80[\s\S]+protocol:\s*HTTP[\s\S]+number:\s*443[\s\S]+protocol:\s*HTTPS/,
    );
  });

  it('Service kubeclaw-istio-egressgateway exposes port 80 (not 443)', () => {
    const out = render();
    expect(out).toMatch(
      /name:\s*kubeclaw-istio-egressgateway[\s\S]+?ports:\s*\n\s+-\s*name:\s*http\s*\n\s+port:\s*80/,
    );
  });
```

Then inside `describe('helm template — mode=istio')` add a new sub-block at the very end (still inside the parent describe), guarded by a separate render with `testFixture.enabled=true`:

```ts
  describe('with testFixture.enabled=true', () => {
    let renderWithFixture: () => string;
    beforeAll(() => {
      renderWithFixture = () =>
        execSync(
          `helm template helm/kubeclaw \
            --set credentialInjection.mode=istio \
            --set namespace=kubeclaw \
            --set credentialInjection.istio.testFixture.enabled=true`,
          { encoding: 'utf8' },
        );
    });

    it('renders the mock-upstream Deployment and Service', () => {
      const out = renderWithFixture();
      expect(out).toContain('name: kubeclaw-mock-upstream');
      expect(out).toContain('mendhak/http-https-echo');
      expect(out).toContain('sidecar.istio.io/inject: "false"');
    });

    it('appends a ServiceEntry + Gateway server + VS routes for mock-upstream.kubeclaw-test', () => {
      const out = renderWithFixture();
      expect(out).toContain('mock-upstream.kubeclaw-test');
      expect(out).toContain('kubeclaw-egress-mock-upstream-kubeclaw-test');
    });

    it('appends a test-mock mapping to the broker ConfigMap', () => {
      const out = renderWithFixture();
      expect(out).toMatch(/id:\s*test-mock/);
      expect(out).toContain('mock-upstream.kubeclaw-test');
      expect(out).toContain('test-mock-token');
    });

    it('renders test-mock-token in the kubeclaw-secrets Secret', () => {
      const out = renderWithFixture();
      // The value is a literal string; Helm base64-encodes it. Match either
      // the plaintext (stringData) or the base64 form depending on chart choice.
      expect(out).toMatch(/test-mock-token:\s*(test-token-12345|dGVzdC10b2tlbi0xMjM0NQ==)/);
    });

    it('does NOT render a DestinationRule for the mock (HTTP upstream)', () => {
      const out = renderWithFixture();
      expect(out).not.toContain('kubeclaw-egress-tls-mock-upstream-kubeclaw-test');
    });
  });
```

In the existing `describe('helm template — mode=sidecar (no Istio regression)', () => { ... })` block (line 831), append one more `it`:

```ts
  it('does NOT render the test fixture even if requested', () => {
    const out = execSync(
      `helm template helm/kubeclaw \
        --set credentialInjection.mode=sidecar \
        --set namespace=kubeclaw \
        --set credentialInjection.istio.testFixture.enabled=true`,
      { encoding: 'utf8' },
    );
    expect(out).not.toContain('name: kubeclaw-mock-upstream');
    expect(out).not.toContain('mock-upstream.kubeclaw-test');
    expect(out).not.toMatch(/id:\s*test-mock/);
  });
```

- [ ] **Step 2: Run the new assertions and verify they fail against the current chart**

Run: `npm run test:e2e -- e2e/helm-chart.test.ts --reporter=verbose`

Expected: the new tests fail (current chart still uses PASSTHROUGH/HTTPS and has no DestinationRule/testFixture).

- [ ] **Step 3: Commit the failing tests**

```bash
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination add e2e/helm-chart.test.ts
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination commit -m "$(cat <<'EOF'
test(helm): add failing render assertions for istio HTTP listener + DestinationRule

Adds assertions that describe the corrected istio-mode chart shape:
- Gateway with HTTP listener on port 80, no PASSTHROUGH
- VirtualService with http: routes
- One DestinationRule per built-in HTTPS destination (tls.mode SIMPLE)
- ServiceEntry with two ports (workload http + upstream tls)
- Test fixture renders mock-upstream + broker mapping when enabled
- Test fixture is suppressed in mode=sidecar (regression guard)

These fail against the current PASSTHROUGH chart; subsequent tasks make
them pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Update `kubeclaw.egressDestinations` helper to the new record shape

**Files:**
- Modify: `helm/kubeclaw/templates/_helpers.tpl:127` (the `kubeclaw.egressDestinations` definition).

- [ ] **Step 1: Replace the helper definition with the new record shape**

Open `helm/kubeclaw/templates/_helpers.tpl`. Replace the entire `{{- define "kubeclaw.egressDestinations" -}}` block (lines 126–152 in the current file) with:

```
{{/*
kubeclaw.egressDestinations — returns a JSON object {"items":[...]} containing
all egress destinations the credential broker handles. Each item has keys:
  host             string  — destination hostname
  port             number  — workload-facing port (always 80, HTTP)
  upstreamPort     number  — port the gateway originates TLS to (443 default)
  upstreamProtocol string  — "HTTPS" (built-ins, additionalDestinations) or
                             "HTTP" (test fixture mock upstream only)
  endpointAddress  string  — optional STATIC/DNS endpoint override (test fixture)

Built-ins are anthropic/openai/openrouter/voyage. additionalDestinations
contributes entries with configurable upstreamPort (default 443).
When credentialInjection.istio.testFixture.enabled=true, one extra entry is
appended for the in-cluster mock-upstream.

Wrapped in {"items":[...]} so fromJson produces a traversable map rather
than a bare slice (Helm's fromJson cannot range over a top-level JSON array).
*/}}
{{- define "kubeclaw.egressDestinations" -}}
{{- $built_in := list
      (dict "host" "api.anthropic.com" "port" 80 "upstreamPort" 443 "upstreamProtocol" "HTTPS")
      (dict "host" "api.openai.com"    "port" 80 "upstreamPort" 443 "upstreamProtocol" "HTTPS")
      (dict "host" "openrouter.ai"     "port" 80 "upstreamPort" 443 "upstreamProtocol" "HTTPS")
      (dict "host" "api.voyageai.com"  "port" 80 "upstreamPort" 443 "upstreamProtocol" "HTTPS") -}}
{{- $extra := list -}}
{{- range .Values.credentialInjection.istio.additionalDestinations -}}
  {{- $parts := splitList ":" . -}}
  {{- $h := index $parts 0 -}}
  {{- $up := 443 -}}
  {{- if gt (len $parts) 1 -}}
    {{- $up = index $parts 1 | int -}}
  {{- end -}}
  {{- $extra = append $extra (dict "host" $h "port" 80 "upstreamPort" $up "upstreamProtocol" "HTTPS") -}}
{{- end -}}
{{- $test := list -}}
{{- if .Values.credentialInjection.istio.testFixture.enabled -}}
  {{- $test = list (dict
        "host" "mock-upstream.kubeclaw-test"
        "port" 80
        "upstreamPort" 80
        "upstreamProtocol" "HTTP"
        "endpointAddress" (printf "kubeclaw-mock-upstream.%s.svc.cluster.local" .Values.namespace)) -}}
{{- end -}}
{{- toJson (dict "items" (concat $built_in $extra $test)) -}}
{{- end -}}
```

- [ ] **Step 2: Add the `kubeclaw.istioBaseUrlEnv` helper**

In the same file, immediately after the `kubeclaw.egressDestinations` definition, append:

```
{{/*
kubeclaw.istioBaseUrlEnv — emits an env block setting the four built-in
provider base URLs to http:// hostnames, for pods that egress through the
istio gateway. Render only when credentialInjection.mode == "istio" and
credentialInjection.auditOnly == false.
*/}}
{{- define "kubeclaw.istioBaseUrlEnv" -}}
- { name: OPENAI_BASE_URL,     value: "http://api.openai.com" }
- { name: ANTHROPIC_BASE_URL,  value: "http://api.anthropic.com" }
- { name: OPENROUTER_BASE_URL, value: "http://openrouter.ai" }
{{- end -}}
```

- [ ] **Step 3: Verify the chart still renders without errors after the helper change**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio --set namespace=kubeclaw > /tmp/render-istio.yaml && echo OK`

Expected: prints `OK`. (Downstream templates still reference the old record fields `port`/`protocol`, so the render output is structurally wrong — but Helm itself must not error. Subsequent tasks fix the templates.)

- [ ] **Step 4: Commit**

```bash
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination add helm/kubeclaw/templates/_helpers.tpl
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination commit -m "$(cat <<'EOF'
feat(helm): update egressDestinations helper to two-port record shape

Record now carries workload-facing port (always 80) + upstreamPort +
upstreamProtocol. testFixture.enabled appends a mock-upstream record with
an explicit endpointAddress so the gateway can resolve the in-cluster
Service. Adds istioBaseUrlEnv helper for use in pod specs.

Downstream templates (serviceentries, egress, channel/capability pods)
are updated in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rewrite `istio-serviceentries.yaml` to emit two ports

**Files:**
- Modify: `helm/kubeclaw/templates/istio-serviceentries.yaml` (full rewrite of the per-destination block).

- [ ] **Step 1: Replace the file contents**

Open `helm/kubeclaw/templates/istio-serviceentries.yaml` and replace its full contents with:

```
{{- if eq .Values.credentialInjection.mode "istio" -}}
{{- $destinations := (include "kubeclaw.egressDestinations" . | fromJson).items -}}
{{- range $dest := $destinations }}
---
# ServiceEntry for {{ index $dest "host" }} — registers this host in the Istio
# mesh registry. Workloads call it as http://{{ index $dest "host" }} (port 80);
# the gateway originates TLS to port {{ index $dest "upstreamPort" }} upstream.
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: kubeclaw-egress-{{ index $dest "host" | replace "." "-" | replace ":" "-" }}
  namespace: {{ $.Values.namespace }}
spec:
  hosts:
    - {{ index $dest "host" }}
  ports:
    - number: {{ index $dest "port" }}
      name: http
      protocol: HTTP
    - number: {{ index $dest "upstreamPort" }}
      name: tls
      protocol: {{ index $dest "upstreamProtocol" }}
  location: MESH_EXTERNAL
  resolution: DNS
  {{- if hasKey $dest "endpointAddress" }}
  endpoints:
    - address: {{ index $dest "endpointAddress" }}
  {{- end }}
{{- end }}
{{- end }}
```

- [ ] **Step 2: Verify chart renders cleanly**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio --set namespace=kubeclaw > /tmp/render-istio.yaml && grep -c "kind: ServiceEntry" /tmp/render-istio.yaml`

Expected: prints `4` (one per built-in).

Run with test fixture: `helm template helm/kubeclaw --set credentialInjection.mode=istio --set namespace=kubeclaw --set credentialInjection.istio.testFixture.enabled=true | grep -c "kind: ServiceEntry"`

Expected: prints `5` (built-ins + mock-upstream).

- [ ] **Step 3: Commit**

```bash
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination add helm/kubeclaw/templates/istio-serviceentries.yaml
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination commit -m "$(cat <<'EOF'
feat(helm): two-port ServiceEntry per egress destination

Workload-facing HTTP on port 80; upstream HTTPS on configurable port.
endpointAddress is rendered when present (test fixture only — points the
mock-upstream hostname at the in-cluster Service).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Rewrite `istio-egress.yaml` — HTTP Gateway listener, HTTP VirtualService, DestinationRules

**Files:**
- Modify: `helm/kubeclaw/templates/istio-egress.yaml` (full rewrite).

- [ ] **Step 1: Replace the file contents**

Open `helm/kubeclaw/templates/istio-egress.yaml` and replace its contents with:

```
{{- if eq .Values.credentialInjection.mode "istio" -}}
{{- $destinations := (include "kubeclaw.egressDestinations" . | fromJson).items -}}
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
        sidecar.istio.io/inject: "true"
    spec:
      serviceAccountName: kubeclaw-istio-egressgateway
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: istio-proxy
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
    - name: http
      port: 80
      targetPort: 8080
---
# Gateway — HTTP listener on port 80. Workload sidecars route to this gateway
# over mesh mTLS; the gateway terminates that mTLS and presents plaintext HTTP
# to its filter chain (where ext_authz fires per the EnvoyFilter), then
# originates TLS to the real upstream per the per-host DestinationRules.
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
        number: {{ index $dest "port" }}
        name: http-{{ index $dest "host" | replace "." "-" }}
        protocol: HTTP
      hosts:
        - {{ index $dest "host" }}
{{- end }}
---
# VirtualService — routes traffic for each external host from the mesh through
# the egress gateway. The mesh leg matches workload-side HTTP and forwards to
# the gateway Service; the gateway leg matches inside the gateway pod and
# routes to the upstream host on its upstreamPort.
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: kubeclaw-egress-routing
  namespace: {{ .Values.namespace }}
spec:
  hosts:
{{- range $dest := $destinations }}
    - {{ index $dest "host" }}
{{- end }}
  gateways:
    - mesh
    - kubeclaw-egressgateway
  http:
{{- range $dest := $destinations }}
    - match:
        - gateways: [mesh]
          port: {{ index $dest "port" }}
          authority:
            exact: {{ index $dest "host" }}
      route:
        - destination:
            host: kubeclaw-istio-egressgateway.{{ $.Values.namespace }}.svc.cluster.local
            port: { number: 80 }
    - match:
        - gateways: [kubeclaw-egressgateway]
          port: {{ index $dest "port" }}
          authority:
            exact: {{ index $dest "host" }}
      route:
        - destination:
            host: {{ index $dest "host" }}
            port: { number: {{ index $dest "upstreamPort" }} }
{{- end }}
{{- range $dest := $destinations }}
{{- if eq (index $dest "upstreamProtocol") "HTTPS" }}
---
# DestinationRule — gateway originates TLS to the real upstream on
# upstreamPort. SNI must match the destination host so upstream's cert is
# accepted; the gateway pod's filesystem ships the standard public CA bundle
# at /etc/ssl/certs/ca-certificates.crt.
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: kubeclaw-egress-tls-{{ index $dest "host" | replace "." "-" | replace ":" "-" }}
  namespace: {{ $.Values.namespace }}
spec:
  host: {{ index $dest "host" }}
  trafficPolicy:
    portLevelSettings:
      - port:
          number: {{ index $dest "upstreamPort" }}
        tls:
          mode: SIMPLE
          sni: {{ index $dest "host" }}
          caCertificates: /etc/ssl/certs/ca-certificates.crt
{{- end }}
{{- end }}
{{- end }}
```

- [ ] **Step 2: Verify chart renders cleanly**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio --set namespace=kubeclaw > /tmp/render-istio.yaml && grep -c "kind: DestinationRule" /tmp/render-istio.yaml`

Expected: prints `4` (one per built-in HTTPS destination).

Run: `grep -c "kind: Gateway" /tmp/render-istio.yaml && grep -c "kind: VirtualService" /tmp/render-istio.yaml`

Expected: `1` and `1`.

- [ ] **Step 3: Verify no PASSTHROUGH remains**

Run: `grep PASSTHROUGH /tmp/render-istio.yaml`

Expected: no output (grep exit 1).

- [ ] **Step 4: Commit**

```bash
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination add helm/kubeclaw/templates/istio-egress.yaml
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination commit -m "$(cat <<'EOF'
fix(helm): istio gateway runs HTTP listener; add per-host DestinationRule

Replaces the HTTPS+PASSTHROUGH Gateway server with an HTTP listener on
port 80 so the ext_authz HTTP filter can actually attach. Routes in the
VirtualService are now http: (not tls:). Adds a DestinationRule per
HTTPS destination with tls.mode SIMPLE and SNI matching the host — the
gateway originates TLS to the real upstream using the public CA bundle.

This corrects the 2026-05-10 plan's PASSTHROUGH decision, which silently
prevented ext_authz from being instantiated on the gateway listener.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add `testFixture.enabled` flag + render mock-upstream + extend broker config + Secret entry

**Files:**
- Modify: `helm/kubeclaw/values.yaml` (add testFixture sub-block under credentialInjection.istio).
- Create: `helm/kubeclaw/templates/istio-test-fixture.yaml`.
- Modify: `helm/kubeclaw/templates/credential-broker-config.yaml` (append test-mock mapping when flag is true).
- Modify: `helm/kubeclaw/templates/secrets.yaml` (append test-mock-token entry when flag is true).

- [ ] **Step 1: Add the flag to values.yaml**

Open `helm/kubeclaw/values.yaml`. Find the `credentialInjection.istio` block (around line 311). Immediately after the existing `additionalDestinations: []` line, add:

```yaml
    # testFixture: e2e-only knob. Renders an in-cluster mock upstream and
    # adds a broker mapping for it. Never enable in production — the broker
    # mapping accepts the kubeclaw-tool-job identity and stamps a literal
    # test token, which is harmless in isolation but pollutes the audit log.
    testFixture:
      enabled: false
```

- [ ] **Step 2: Create the test-fixture template**

Create `helm/kubeclaw/templates/istio-test-fixture.yaml`:

```
{{- if and (eq .Values.credentialInjection.mode "istio") .Values.credentialInjection.istio.testFixture.enabled -}}
# Mock upstream for the e2e egress test — renders only when
# credentialInjection.istio.testFixture.enabled is true. The Service is
# referenced by name from the kubeclaw.egressDestinations helper, which
# appends a record for mock-upstream.kubeclaw-test pointing at this Service.
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kubeclaw-mock-upstream
  namespace: {{ .Values.namespace }}
  labels:
    app: kubeclaw-mock-upstream
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kubeclaw-mock-upstream
  template:
    metadata:
      labels:
        app: kubeclaw-mock-upstream
      annotations:
        # The mock is "outside" the mesh from the gateway's POV. We don't
        # want a sidecar on it (it would route via mesh mTLS rather than
        # accept the gateway's plain HTTP).
        sidecar.istio.io/inject: "false"
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: echo
          image: mendhak/http-https-echo:31
          imagePullPolicy: IfNotPresent
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          env:
            - { name: HTTP_PORT,  value: "8080" }
            - { name: HTTPS_PORT, value: "8443" }
          ports:
            - { name: http, containerPort: 8080 }
          readinessProbe:
            httpGet: { path: /, port: http }
            initialDelaySeconds: 1
          resources:
            requests: { cpu: 10m, memory: 32Mi }
            limits:   { cpu: 100m, memory: 64Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: kubeclaw-mock-upstream
  namespace: {{ .Values.namespace }}
spec:
  selector:
    app: kubeclaw-mock-upstream
  ports:
    - name: http
      port: 80
      targetPort: 8080
{{- end }}
```

- [ ] **Step 3: Append the broker mapping when testFixture is enabled**

Open `helm/kubeclaw/templates/credential-broker-config.yaml`. After the `voyage` mapping block (the last existing mapping), insert before the closing `{{- end }}`:

```
      {{- if .Values.credentialInjection.istio.testFixture.enabled }}
      - id: test-mock
        destinations: ["mock-upstream.kubeclaw-test"]
        identities: ["sa/kubeclaw-tool-job"]
        credentialRef: { kind: Secret, name: kubeclaw-secrets, key: test-mock-token }
        headerScheme: bearer
      {{- end }}
```

The exact placement: this goes inside the `data.config.yaml` heredoc, after the `voyage` block (whose last line is `headerScheme: bearer`) and before the outer `{{- end }}` that closes the `if ne .Values.credentialInjection.mode "off"` guard.

- [ ] **Step 4: Add the test-mock-token Secret entry**

Read the file: open `helm/kubeclaw/templates/secrets.yaml` to confirm its structure. Most charts in this repo use `stringData:` for the Secret. Append a conditional block inside the `stringData:` map (or `data:` map; mirror the surrounding style):

```
  {{- if .Values.credentialInjection.istio.testFixture.enabled }}
  test-mock-token: "test-token-12345"
  {{- end }}
```

If the Secret template uses `data:` (base64), encode it: `dGVzdC10b2tlbi0xMjM0NQ==`. Match whichever convention the existing file uses for other fixed-value entries.

- [ ] **Step 5: Verify chart renders cleanly with and without the flag**

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio --set namespace=kubeclaw | grep -E "(mock-upstream|test-mock)" || echo "NONE"`

Expected: prints `NONE` (fixture disabled by default).

Run: `helm template helm/kubeclaw --set credentialInjection.mode=istio --set namespace=kubeclaw --set credentialInjection.istio.testFixture.enabled=true | grep -E "kubeclaw-mock-upstream|id: test-mock|test-mock-token" | wc -l`

Expected: prints a count ≥ 4 (Deployment name, Service name, broker mapping id, Secret entry).

- [ ] **Step 6: Commit**

```bash
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination add helm/kubeclaw/values.yaml helm/kubeclaw/templates/istio-test-fixture.yaml helm/kubeclaw/templates/credential-broker-config.yaml helm/kubeclaw/templates/secrets.yaml
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination commit -m "$(cat <<'EOF'
feat(helm): add e2e test fixture (mock upstream + broker mapping)

Adds credentialInjection.istio.testFixture.enabled (default false). When
true, renders a kubeclaw-mock-upstream Deployment/Service running the
mendhak/http-https-echo image, appends a test-mock broker mapping for
mock-upstream.kubeclaw-test scoped to sa/kubeclaw-tool-job, and seeds a
literal test-mock-token Secret entry. The egressDestinations helper
already appends a record for the mock host (Task 2), so ServiceEntry +
Gateway server + VirtualService routes follow automatically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Run the helm render assertions; verify the failing tests from Task 1 now pass

- [ ] **Step 1: Run the helm-chart suite**

Run: `npm run test:e2e -- e2e/helm-chart.test.ts --reporter=verbose`

Expected: all tests pass, including:
- The 5 new `mode=istio` assertions added in Task 1
- The new `with testFixture.enabled=true` sub-block (5 cases)
- The new "does NOT render the test fixture" sidecar-regression case
- All pre-existing assertions in both suites

If any fail, fix the helm template until they pass. Do not move on with red.

- [ ] **Step 2: No commit** — this is a verification gate, not a code change.

---

## Task 7: Inject `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `OPENROUTER_BASE_URL` into channel + capability pods (helm) in istio mode

**Files:**
- Modify: `helm/kubeclaw/templates/channel-pods.yaml:126-133` (the `mode=istio` env-injection conditional).
- Modify: `helm/kubeclaw/templates/capability-pods.yaml` (the equivalent `mode=istio` block — locate via grep below).
- Modify: `e2e/helm-chart.test.ts` (add render assertions for the new envs).

- [ ] **Step 1: Locate the istio-mode env block in capability-pods.yaml**

Run: `grep -n "credentialInjection.mode \"istio\"" helm/kubeclaw/templates/capability-pods.yaml`

Note the line number; this is where the equivalent block lives.

- [ ] **Step 2: Add a failing render assertion**

Inside the existing `describe('helm template — mode=istio', () => { ... })` block in `e2e/helm-chart.test.ts`, add:

```ts
  it('injects http:// base URL envs into channel and capability pods', () => {
    const out = render();
    expect(out).toContain('value: "http://api.openai.com"');
    expect(out).toContain('value: "http://api.anthropic.com"');
    expect(out).toContain('value: "http://openrouter.ai"');
    // Both pod families must carry them; the simplest check is two distinct
    // occurrences of OPENAI_BASE_URL in the rendered output.
    expect((out.match(/OPENAI_BASE_URL/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
```

Run: `npm run test:e2e -- e2e/helm-chart.test.ts --reporter=verbose -t "injects http:// base URL"`

Expected: FAIL (envs are not yet rendered).

- [ ] **Step 3: Add the env inclusion to channel-pods.yaml**

Open `helm/kubeclaw/templates/channel-pods.yaml`. Locate the istio mode comment block (lines 129–133 in the current file). Replace those lines with:

```
            {{- if eq $.Values.credentialInjection.mode "istio" }}
            # Istio captures all egress via iptables redirection; no
            # HTTPS_PROXY is needed. The base URL overrides below route
            # workload SDKs through the egress gateway, which stamps the
            # broker-supplied Authorization header.
            {{- include "kubeclaw.istioBaseUrlEnv" $ | nindent 12 }}
            {{- end }}
```

- [ ] **Step 4: Add the equivalent block to capability-pods.yaml**

Open `helm/kubeclaw/templates/capability-pods.yaml`. Find the istio-mode block identified in Step 1. Replace it with the same template snippet as Step 3 (adjust the `nindent` value if surrounding indentation differs — check the existing block; the inclusion must align with sibling env entries).

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm run test:e2e -- e2e/helm-chart.test.ts --reporter=verbose -t "injects http:// base URL"`

Expected: PASS.

- [ ] **Step 6: Run the full helm-chart suite (regression check)**

Run: `npm run test:e2e -- e2e/helm-chart.test.ts --reporter=verbose`

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination add helm/kubeclaw/templates/channel-pods.yaml helm/kubeclaw/templates/capability-pods.yaml e2e/helm-chart.test.ts
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination commit -m "$(cat <<'EOF'
feat(helm): inject http:// provider base URLs into channel + capability pods in istio mode

Channel and capability pods now carry OPENAI_BASE_URL,
ANTHROPIC_BASE_URL, OPENROUTER_BASE_URL pointing at http:// hostnames
when credentialInjection.mode=istio, so SDK calls route through the
egress gateway for credential stamping.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Substitute placeholder API keys + http:// base URLs in `job-runner.ts` for tool jobs (istio mode)

**Files:**
- Modify: `src/k8s/job-runner.ts` (the tool-job env construction).
- Modify: `src/k8s/job-runner.test.ts` (the existing `generateJobManifest — credential injection mode=istio` block at line 1488).

- [ ] **Step 1: Add failing unit tests**

Open `src/k8s/job-runner.test.ts`. Inside the existing `describe('generateJobManifest — credential injection mode=istio', () => { ... })` block (line 1488), add:

```ts
    it('substitutes API key envs with the literal "injected-by-broker" placeholder', () => {
      const manifest = generateJobManifest(/* same input as adjacent tests */);
      const env = manifest.spec.template.spec.containers[0].env ?? [];
      const named = (n: string) => env.find((e: any) => e.name === n);
      for (const key of [
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'OPENROUTER_API_KEY',
        'VOYAGE_API_KEY',
      ]) {
        const entry = named(key);
        expect(entry, `${key} entry exists`).toBeDefined();
        expect(entry).toMatchObject({ name: key, value: 'injected-by-broker' });
        expect(entry.valueFrom).toBeUndefined();
      }
    });

    it('substitutes BASE_URL envs with http:// literal values', () => {
      const manifest = generateJobManifest(/* same input as adjacent tests */);
      const env = manifest.spec.template.spec.containers[0].env ?? [];
      const named = (n: string) => env.find((e: any) => e.name === n);
      expect(named('OPENAI_BASE_URL')).toMatchObject({ value: 'http://api.openai.com' });
      expect(named('ANTHROPIC_BASE_URL')).toMatchObject({ value: 'http://api.anthropic.com' });
      expect(named('OPENROUTER_BASE_URL')).toMatchObject({ value: 'http://openrouter.ai' });
      for (const key of ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'OPENROUTER_BASE_URL']) {
        expect(named(key).valueFrom).toBeUndefined();
      }
    });

    it('does NOT substitute when auditOnly=true (preserves valueFrom secretKeyRefs)', () => {
      vi.mocked(configModule.getAuditOnly).mockReturnValue(true);
      const manifest = generateJobManifest(/* same input as adjacent tests */);
      const env = manifest.spec.template.spec.containers[0].env ?? [];
      const openai = env.find((e: any) => e.name === 'OPENAI_API_KEY');
      expect(openai?.valueFrom?.secretKeyRef).toBeDefined();
      expect(openai?.value).toBeUndefined();
    });
```

For the `same input as adjacent tests` placeholder: copy the exact spec object the surrounding tests use (look two `it`s above — they share an input pattern). If the test uses a `defaultSpec()` helper, call it; if it inlines the spec, inline it identically here.

- [ ] **Step 2: Run the new tests; verify they fail**

Run: `npm test -- src/k8s/job-runner.test.ts --reporter=verbose -t "credential injection mode=istio"`

Expected: the three new tests fail (current impl strips entries; doesn't substitute). The existing four `mode=istio` tests in that block should still pass.

- [ ] **Step 3: Read the istio-mode env logic in job-runner.ts**

Run: `grep -n "credentialInjectionMode\|getInjectionMode\|stripCredentialEnvs\|injected-by-broker" src/k8s/job-runner.ts`

Read the section that builds the tool-job env (around line 400–650; the file is large). Identify the function or branch that handles the `mode=istio` env transformation today (this is the code that currently strips API keys).

- [ ] **Step 4: Modify the istio-mode env transformation**

Replace the current stripping logic with substitution. The exact code change depends on the structure of `job-runner.ts` (the existing function might be a filter-then-append pattern, or a map). Apply this transformation:

1. **API keys.** For each entry in the env list whose `name` is one of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `VOYAGE_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` and whose `valueFrom.secretKeyRef` is set: replace the entry with `{ name, value: 'injected-by-broker' }` (no `valueFrom`).
2. **Base URLs.** For each entry whose `name` is one of `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENROUTER_BASE_URL`: replace the entry with `{ name, value: <http URL> }` per the mapping:
   ```ts
   const ISTIO_BASE_URLS: Record<string, string> = {
     OPENAI_BASE_URL: 'http://api.openai.com',
     ANTHROPIC_BASE_URL: 'http://api.anthropic.com',
     OPENROUTER_BASE_URL: 'http://openrouter.ai',
   };
   ```
3. **Audit-only branch.** Both transformations gated on `!getAuditOnly()`. When auditOnly is true, leave the env list unchanged.

Concrete code shape (insert as a helper near the existing istio-mode handling):

```ts
const ISTIO_API_KEY_PLACEHOLDER = 'injected-by-broker';
const ISTIO_PLACEHOLDER_KEYS = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'VOYAGE_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
]);
const ISTIO_BASE_URLS: Record<string, string> = {
  OPENAI_BASE_URL: 'http://api.openai.com',
  ANTHROPIC_BASE_URL: 'http://api.anthropic.com',
  OPENROUTER_BASE_URL: 'http://openrouter.ai',
};

function applyIstioModeEnvSubstitution(env: V1EnvVar[]): V1EnvVar[] {
  return env.map((e) => {
    if (ISTIO_PLACEHOLDER_KEYS.has(e.name) && e.valueFrom?.secretKeyRef) {
      return { name: e.name, value: ISTIO_API_KEY_PLACEHOLDER };
    }
    if (e.name in ISTIO_BASE_URLS) {
      return { name: e.name, value: ISTIO_BASE_URLS[e.name] };
    }
    return e;
  });
}
```

Call this from the istio-mode branch only when `!getAuditOnly()`. Replace whatever the previous "strip" call was with this `map`-based transformation.

Replace any existing helper that *strips* these envs in istio mode with the new substituting helper; remove the old code so no dual implementation remains.

- [ ] **Step 5: Run the unit tests and verify they pass**

Run: `npm test -- src/k8s/job-runner.test.ts --reporter=verbose -t "credential injection mode=istio"`

Expected: all seven tests in the istio-mode block pass.

Run: `npm test -- src/k8s/job-runner.test.ts --reporter=verbose`

Expected: all tests in the file pass.

- [ ] **Step 6: Run the broader unit suite (regression check)**

Run: `npm test -- --reporter=verbose --bail 1`

Expected: full unit + integration suite passes. Fix any regressions.

- [ ] **Step 7: Commit**

```bash
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination add src/k8s/job-runner.ts src/k8s/job-runner.test.ts
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination commit -m "$(cat <<'EOF'
feat(job-runner): substitute placeholder envs in istio mode (not strip)

In mode=istio with auditOnly=false: API key envs are now set to the
literal "injected-by-broker" string (so SDK constructors that enforce
client-side key presence don't throw), and provider BASE_URL envs are
set to http:// hostnames so SDKs route through the egress gateway.
The gateway's ext_authz response overwrites the Authorization header
on every request, so the placeholder never leaves the cluster.

In mode=istio with auditOnly=true: env list is unchanged
(audit-only semantics preserved).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Add the end-to-end egress test

**Files:**
- Modify: `e2e/credential-injection-istio.test.ts` (extend `beforeAll`, add one new `it`).

- [ ] **Step 1: Extend `beforeAll` to enable the test fixture and wait for mock-upstream**

Open `e2e/credential-injection-istio.test.ts`. In the existing `beforeAll`, add `--set credentialInjection.istio.testFixture.enabled=true` to the helm install arguments. After the install completes, add a rollout-status wait:

Locate the `helm(...)` call inside `beforeAll`. Append the new `--set` flag to the array of args (currently lines 38–46):

```ts
    helm(
      [
        'upgrade --install kubeclaw helm/kubeclaw',
        '--namespace kubeclaw --create-namespace',
        '--set credentialInjection.mode=istio',
        '--set credentialInjection.istio.gateway.replicas=1',
        '--set credentialInjection.istio.testFixture.enabled=true',
        '--set image.tag=e2e-test',
        '--wait --timeout 5m',
      ].join(' '),
    );
    execSync(
      `kubectl -n ${NS} rollout status deployment/kubeclaw-mock-upstream --timeout=120s`,
      { stdio: 'inherit' },
    );
```

- [ ] **Step 2: Add the new test case at the end of the describe block**

After the last existing `it` in the file (the ServiceEntry assertion, line 108), and before the closing `});` of the describe block (line 118), add:

```ts
  it('tool-job egress is broker-stamped end-to-end', () => {
    const probeName = 'kubeclaw-egress-probe';
    // Clean any stale probe from a previous test run.
    execSync(`kubectl -n ${NS} delete pod ${probeName} --ignore-not-found --wait=true`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });

    const overrides = JSON.stringify({
      spec: { serviceAccountName: 'kubeclaw-tool-job' },
    });
    const script = [
      'set -e',
      'resp=$(curl -sS -H "Authorization: Bearer placeholder" http://mock-upstream.kubeclaw-test/echo)',
      'echo RESPONSE_BEGIN',
      'echo "$resp"',
      'echo RESPONSE_END',
      // Tell the istio-proxy sidecar to exit so the pod can reach Succeeded.
      'curl -sS -X POST http://localhost:15020/quitquitquit || true',
    ].join('; ');

    execSync(
      `kubectl run ${probeName} -n ${NS} \
        --image=curlimages/curl:8.10.1 \
        --restart=Never \
        --overrides='${overrides}' \
        --command -- sh -c '${script}'`,
      { stdio: 'inherit' },
    );

    // Poll for the pod to reach Succeeded or Failed; cap at 60s.
    let phase = '';
    for (let i = 0; i < 60; i++) {
      phase = execSync(
        `kubectl -n ${NS} get pod ${probeName} -o jsonpath='{.status.phase}'`,
        { encoding: 'utf8' },
      ).trim();
      if (phase === 'Succeeded' || phase === 'Failed') break;
      execSync('sleep 1');
    }
    expect(phase, 'probe pod reached terminal phase').toMatch(/^(Succeeded|Failed)$/);

    const logs = execSync(`kubectl -n ${NS} logs ${probeName} -c kubeclaw-egress-probe`, {
      encoding: 'utf8',
    });
    const begin = logs.indexOf('RESPONSE_BEGIN');
    const end = logs.indexOf('RESPONSE_END');
    expect(begin, 'probe response begin marker present').toBeGreaterThanOrEqual(0);
    expect(end, 'probe response end marker present').toBeGreaterThan(begin);
    const body = logs.slice(begin + 'RESPONSE_BEGIN'.length, end).trim();
    const parsed = JSON.parse(body);

    // Primary assertion: gateway overwrote the placeholder with the broker's value.
    const auth = parsed.headers?.authorization ?? parsed.headers?.Authorization;
    expect(auth, 'broker-stamped Authorization header arrived at mock').toBe(
      'Bearer test-token-12345',
    );

    // Secondary assertion: broker audit log records the expected fields.
    const brokerLogs = execSync(
      `kubectl -n ${NS} logs deployment/kubeclaw-credential-broker --since=120s`,
      { encoding: 'utf8' },
    );
    const auditLine = brokerLogs
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find(
        (j) =>
          j &&
          j.identity === 'sa/kubeclaw-tool-job' &&
          j.destination === 'mock-upstream.kubeclaw-test' &&
          j.mappingId === 'test-mock' &&
          j.status === 200,
      );
    expect(auditLine, 'broker audit line matches expected identity + destination + mapping').toBeDefined();

    // Cleanup.
    execSync(`kubectl -n ${NS} delete pod ${probeName} --wait=false`, {
      stdio: 'inherit',
    });
  });
```

- [ ] **Step 3: Type-check (the e2e test is TypeScript)**

Run: `npm run build` (or whatever the project's tsc invocation is — check `package.json` for the `build` script).

Expected: clean build, no type errors. If `kubectl run --overrides` ends up needing escape adjustments for the shell, fix here.

- [ ] **Step 4: Note that this test cannot be run locally without a kind+Istio cluster**

The test runs in CI via `.github/workflows/e2e-istio.yml` (Task 10). Optionally run locally if you have a kind cluster with Istio installed:

```bash
npm run test:e2e -- e2e/credential-injection-istio.test.ts --reporter=verbose
```

Expected (if running locally with cluster): all tests in the suite pass, including the new egress test.

- [ ] **Step 5: Commit**

```bash
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination add e2e/credential-injection-istio.test.ts
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination commit -m "$(cat <<'EOF'
test(e2e): assert tool-job egress is broker-stamped end-to-end (istio mode)

Spawns a probe pod with the kubeclaw-tool-job SA in the kubeclaw
namespace, curls http://mock-upstream.kubeclaw-test through the Istio
egress chain with a placeholder Authorization header, and asserts:
  (a) the mock receives Authorization: Bearer test-token-12345 — proving
      the gateway's ext_authz overwrote the placeholder with the
      broker-supplied credential
  (b) the broker audit log records identity=sa/kubeclaw-tool-job,
      destination=mock-upstream.kubeclaw-test, mappingId=test-mock,
      status=200 — proving the broker saw the workload's SPIFFE identity
      via XFCC.

Closes the test gap that allowed the PASSTHROUGH defect to ship.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Preload curl + echo images in the e2e-istio workflow

**Files:**
- Modify: `.github/workflows/e2e-istio.yml` (add image preload steps before the test-run step).

- [ ] **Step 1: Insert two `kind load` steps**

Open `.github/workflows/e2e-istio.yml`. Locate the existing "Build e2e test image" step (around line 71). Immediately after it (and before "Run Istio e2e tests"), insert:

```yaml
      - name: Preload curl + echo images into kind
        run: |
          docker pull mendhak/http-https-echo:31
          kind load docker-image mendhak/http-https-echo:31 \
            --name kubeclaw-e2e-istio
          docker pull curlimages/curl:8.10.1
          kind load docker-image curlimages/curl:8.10.1 \
            --name kubeclaw-e2e-istio
```

- [ ] **Step 2: Commit**

```bash
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination add .github/workflows/e2e-istio.yml
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination commit -m "$(cat <<'EOF'
ci(e2e-istio): preload curl + echo images into kind

Makes the new tool-job egress test deterministic — the test depends on
curlimages/curl (probe pod) and mendhak/http-https-echo (mock upstream).
Both are loaded into kind before the test run instead of being pulled
on-demand by the cluster, which is flaky on slow CI nodes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Document the http:// + upstreamPort pattern in `docs/CREDENTIAL_INJECTION.md`

**Files:**
- Modify: `docs/CREDENTIAL_INJECTION.md` (extend the existing mode=istio section).

- [ ] **Step 1: Read the current istio section**

Run: `grep -n -i "istio\|additionalDestinations" docs/CREDENTIAL_INJECTION.md`

Note the lines covering `additionalDestinations` and the istio-mode walkthrough.

- [ ] **Step 2: Add a "How requests flow" subsection**

Inside the istio-mode section, add (or augment) a subsection covering the request-path mechanics. Use this exact text:

```markdown
### How requests flow in `mode=istio`

Workloads in pods with the Istio sidecar (anything in the `kubeclaw`
namespace except the orchestrator) make outbound requests as plain HTTP
to the destination hostname:

```
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
```

(If the existing doc has a different structural convention — e.g. uses a different heading level or table style — adapt to match. The content is what matters.)

- [ ] **Step 3: Commit**

```bash
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination add docs/CREDENTIAL_INJECTION.md
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination commit -m "$(cat <<'EOF'
docs(credential-injection): document http:// + upstreamPort pattern (istio mode)

Adds a "How requests flow in mode=istio" subsection covering the
http://-at-the-workload pattern, the auto-injected BASE_URL envs, the
placeholder API-key substitution, and the new additionalDestinations
"host[:upstreamPort]" syntax.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Add the "Superseded — 2026-05-13" addendum to the original plan

**Files:**
- Modify: `docs/superpowers/plans/2026-05-10-credential-injection-istio.md` (append addendum at end).

- [ ] **Step 1: Append the addendum**

Append the following block to the end of `docs/superpowers/plans/2026-05-10-credential-injection-istio.md` (do not edit any earlier text — leaving the PASSTHROUGH rationale in place preserves the history):

```markdown
---

## Addendum — 2026-05-13: Superseded by TLS-origination spec

The "Gateway TLS mode: PASSTHROUGH" decision in §2497 of this plan was
incorrect. PASSTHROUGH listeners in Envoy are realised as a
`tcp_proxy` + `tls_inspector` filter chain, with no
`http_connection_manager`; the EnvoyFilter that installs `ext_authz`
matches an HCM-based filter chain that never exists on that listener,
so ext_authz was never instantiated and no `Authorization` stamping
occurred. No e2e test exercised the request path, so the defect shipped
unobserved.

The corrected design — HTTP listener at the gateway, per-host
`DestinationRule` for upstream TLS origination, workload SDKs using
`http://` URLs, end-to-end test against an in-cluster mock upstream —
is specified in:

→ `docs/superpowers/specs/2026-05-13-istio-tls-origination-and-egress-e2e-design.md`

and implemented per:

→ `docs/superpowers/plans/2026-05-13-istio-tls-origination.md`

Sections of this plan that remain correct: Sidecar resource, namespace
egress restriction, NetworkPolicy shape, SPIFFE-via-XFCC dispatch in
the broker, ambient-mode exclusion, additionalDestinations concept.
Sections superseded: Gateway TLS mode (§2497), Tasks 5–6 acceptance
criteria specifics, and the rendered-manifest-only validation strategy.
```

- [ ] **Step 2: Commit**

```bash
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination add docs/superpowers/plans/2026-05-10-credential-injection-istio.md
git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination commit -m "$(cat <<'EOF'
docs(plans): superseded addendum for the PASSTHROUGH decision

Adds an addendum at the end of the 2026-05-10 istio plan documenting
that the Gateway TLS mode decision (PASSTHROUGH) was wrong and pointing
to the corrected spec and implementation plan. Original text is left
in place to preserve the decision history.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Run the full test suite and confirm everything green

- [ ] **Step 1: Run unit + integration tests**

Run: `npm test -- --reporter=verbose`

Expected: all pass. Fix anything that regressed.

- [ ] **Step 2: Run the helm-chart e2e suite**

Run: `npm run test:e2e -- e2e/helm-chart.test.ts --reporter=verbose`

Expected: all pass.

- [ ] **Step 3: (Optional, requires kind+Istio locally)** Run the istio e2e

Run: `npm run test:e2e -- e2e/credential-injection-istio.test.ts --reporter=verbose`

Expected: all pass, including the new egress test.

- [ ] **Step 4: Confirm clean git state**

Run: `git -C /home/peter/projects/kubeclaw/.claude/worktrees/istio-tls-origination status`

Expected: clean tree, branch ahead of `main` by 11 commits (one per task).

---

## Self-review against the spec

Mapping each spec section/requirement to a task that implements it:

| Spec requirement | Task |
|---|---|
| Architecture: HTTP listener + per-host DestinationRule + TLS origination | Task 4 |
| `egressDestinations` record shape with port/upstreamPort/upstreamProtocol | Task 2 |
| `istioBaseUrlEnv` helper | Task 2 |
| ServiceEntry with two ports | Task 3 |
| Gateway HTTP listener, VirtualService http: routes, DestinationRules | Task 4 |
| `testFixture.enabled` flag + mock-upstream Deployment/Service | Task 5 |
| Broker mapping + Secret entry for test-mock | Task 5 |
| EnvoyFilter unchanged (verified to still match HCM) | Task 6 (verification, no edit) |
| job-runner: BASE_URL substitution to http:// | Task 8 |
| job-runner: API key substitution to "injected-by-broker" | Task 8 |
| job-runner: audit-only branch leaves env list unchanged | Task 8 |
| Channel + capability pods get http:// BASE_URL envs | Task 7 |
| Orchestrator pod NOT modified (no sidecar, no egress to LLM APIs) | (Implicit — no template changed for orchestrator) |
| New e2e test (mock-upstream echo + broker audit-log assertions) | Task 9 |
| CI workflow preloads images | Task 10 |
| `docs/CREDENTIAL_INJECTION.md` updated | Task 11 |
| Plan-doc addendum at end of 2026-05-10 plan | Task 12 |
| Unit-test coverage for substitution behaviour | Task 8 (Step 1) |
| Integration helm-render coverage for new shape | Task 1 + Task 7 (Step 2) |
| Sidecar-mode regression assertion (no testFixture leakage) | Task 1 (last `it`) |

No spec requirement is unmapped. No task references undefined helpers, types, or files.
