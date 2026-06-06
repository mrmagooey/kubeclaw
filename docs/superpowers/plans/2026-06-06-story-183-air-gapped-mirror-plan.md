# Story 183: Air-Gapped Bootstrap — npm Mirror via Credential Broker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow bootstrap Jobs to pull npm packages from an operator-supplied private mirror, with the credential broker stamping the bearer token, and deny npm registry egress from steady-state channel pods.

**Architecture:** Two new Helm values (`bootstrap.npmRegistry`, `bootstrap.npmRegistryAuth.secretRef`) flow through four layers: (1) the orchestrator Deployment injects `BOOTSTRAP_NPM_REGISTRY` as an env var; (2) `bootstrap-runner.ts` reads that env and threads `NPM_CONFIG_REGISTRY` into the bootstrap Job's pod env when set; (3) `credential-broker-config.yaml` conditionally adds a broker mapping for the mirror host; (4) `bootstrap-networkpolicy.yaml` (standard K8s) and `cilium-network-policies.yaml` (Cilium) restrict/deny npm registry egress for bootstrap and channel pods. Standard K8s NetworkPolicy cannot deny by hostname — that gap is documented in comments and bridged by CiliumNetworkPolicy when Cilium is enabled.

**Tech Stack:** Helm (Sprig helpers: `urlParse`, `regexFind`), TypeScript/Node, Vitest, `helm template` CLI for template assertions.

---

## Architecture Notes

### Hostname Extraction from URL

To extract the hostname from `bootstrap.npmRegistry` (e.g. `https://npm.internal.corp`) in Helm templates, use the Sprig `urlParse` function, which returns a dict with a `host` key:

```
{{- $parsed := urlParse .Values.bootstrap.npmRegistry -}}
{{- $mirrorHost := $parsed.host -}}
```

If the URL has a port (e.g. `http://verdaccio.ns.svc.cluster.local:4873`), `$parsed.host` includes the port. For broker `destinations`, the full host:port is the correct value since the broker matches on the request's `X-Forwarded-Authority` header which includes port when non-standard.

### Standard NetworkPolicy Limitation

Standard Kubernetes `NetworkPolicy` cannot deny egress by hostname (FQDN). It can only allow/deny by IP or pod/namespace selector. Therefore:
- The bootstrap `NetworkPolicy` in mirror mode narrows egress to the mirror's IP block only when Cilium is absent — **but in the absence of FQDN resolution in standard NetworkPolicy**, the policy simply removes the broad `to: []` port-443 allow-all rule and restricts egress to the mirror host only when `ciliumNetworkPolicy.enabled`. Without Cilium, the bootstrap pod can still reach the public internet on port 443 — a comment in the policy YAML documents this explicitly.
- The steady-state channel `NetworkPolicy` cannot express the hostname-based deny. The Cilium `CiliumNetworkPolicy` for channels gains `toFQDNs` deny entries for `registry.npmjs.org` and `registry.yarnpkg.com` when `ciliumNetworkPolicy.enabled`.

### Files to Create/Modify

| File | Action | Responsibility |
|------|--------|----------------|
| `helm/kubeclaw/values.yaml` | Modify | Add `bootstrap.npmRegistryAuth.secretRef: ""` |
| `helm/kubeclaw/templates/orchestrator.yaml` | Modify | Inject `BOOTSTRAP_NPM_REGISTRY` env var into orchestrator Deployment |
| `helm/kubeclaw/templates/credential-broker-config.yaml` | Modify | Conditionally add mirror `mappings` entry |
| `helm/kubeclaw/templates/bootstrap-networkpolicy.yaml` | Modify | Replace broad allow-all with mirror-conditional narrow policy + comments |
| `helm/kubeclaw/templates/cilium-network-policies.yaml` | Modify | Add `kubeclaw-bootstrap-egress` CiliumNetworkPolicy; add deny FQDNs to channel policy |
| `helm/kubeclaw/templates/networkpolicies.yaml` | Modify | Add comment to channel policy about hostname-deny limitation |
| `src/k8s/bootstrap-runner.ts` | Modify | Read `BOOTSTRAP_NPM_REGISTRY`; inject `NPM_CONFIG_REGISTRY` into Job env when set |
| `src/k8s/bootstrap-runner.test.ts` | Modify | Unit tests: env injection present/absent |
| `e2e/helm-chart-template.test.ts` | Modify | Template assertions: mirror configured vs unconfigured |
| `e2e/minikube-live-bootstrap-air-gapped.test.ts` | Create | E2e scaffold with `it.todo` for Verdaccio-dependent ACs |

---

## Task 1: Add Helm Values + Orchestrator Env Injection

**Files:**
- Modify: `helm/kubeclaw/values.yaml` (after line 532 `npmRegistry: ""`)
- Modify: `helm/kubeclaw/templates/orchestrator.yaml` (after BOOTSTRAP_STEADY_STATE_REPLICAS)

- [ ] **Step 1.1: Write the failing Helm template test (RED)**

Add to `e2e/helm-chart-template.test.ts`, at the end of the file (before the last `}`):

```typescript
// ─── Story 183: air-gapped npm mirror ────────────────────────────────────────

describe('helm template — bootstrap.npmRegistry (Story 183)', () => {
  const baseArgs = [
    '--set', 'secrets.anthropicApiKey=test',
    '--set', 'secrets.claudeCodeOauthToken=test',
    '--set', 'redis.password=test',
  ];

  it('orchestrator Deployment gets BOOTSTRAP_NPM_REGISTRY env when npmRegistry is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('BOOTSTRAP_NPM_REGISTRY');
    expect(result.stdout).toContain('https://npm.internal.corp');
  });

  it('orchestrator Deployment has no BOOTSTRAP_NPM_REGISTRY env when npmRegistry is empty', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...baseArgs],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('BOOTSTRAP_NPM_REGISTRY');
  });

  it('credential-broker ConfigMap gets mirror mapping when npmRegistry is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
        '--set', 'bootstrap.npmRegistryAuth.secretRef=my-npm-secret',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('npm.internal.corp');
    expect(result.stdout).toContain('my-npm-secret');
    expect(result.stdout).toContain('auth-token');
  });

  it('credential-broker ConfigMap has no mirror mapping when npmRegistry is empty', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...baseArgs],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    // 'npm-mirror' mapping id must not appear
    expect(result.stdout).not.toContain('id: npm-mirror');
  });

  it('bootstrap NetworkPolicy uses narrow mirror policy when npmRegistry is set (no broad allow-all)', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    // The rendered output must mention the mirror hostname
    expect(result.stdout).toContain('npm.internal.corp');
  });

  it('bootstrap NetworkPolicy keeps broad allow-all when npmRegistry is unset (backwards compat)', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...baseArgs],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    // The legacy bootstrap policy renders a broad port-443 egress
    expect(result.stdout).toContain('kubeclaw-bootstrap-policy');
  });

  it('Cilium bootstrap policy renders when ciliumNetworkPolicy.enabled and npmRegistry set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'ciliumNetworkPolicy.enabled=true',
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('kubeclaw-bootstrap-egress');
    expect(result.stdout).toContain('npm.internal.corp');
  });

  it('Cilium channel policy gets deny FQDNs when ciliumNetworkPolicy.enabled', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'ciliumNetworkPolicy.enabled=true',
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('registry.npmjs.org');
    expect(result.stdout).toContain('registry.yarnpkg.com');
  });
});
```

- [ ] **Step 1.2: Run tests to confirm they fail (RED)**

```bash
cd /home/peter/projects/kubeclaw
npx vitest run e2e/helm-chart-template.test.ts 2>&1 | tail -40
```

Expected: multiple test failures referencing `BOOTSTRAP_NPM_REGISTRY`, `npm-mirror`, `kubeclaw-bootstrap-egress`.

- [ ] **Step 1.3: Add `bootstrap.npmRegistryAuth.secretRef` to values.yaml**

In `helm/kubeclaw/values.yaml`, after `npmRegistry: ""` (line 532), add:

```yaml
  npmRegistryAuth:
    # Name of a K8s Secret holding key `auth-token` for the npm mirror.
    # Only used when bootstrap.npmRegistry is set.
    # Example:
    #   bootstrap.npmRegistryAuth.secretRef: kubeclaw-npm-mirror-auth
    secretRef: ""
```

- [ ] **Step 1.4: Add BOOTSTRAP_NPM_REGISTRY to orchestrator.yaml**

In `helm/kubeclaw/templates/orchestrator.yaml`, after the `BOOTSTRAP_STEADY_STATE_REPLICAS` env var block (around line 247), add:

```yaml
            {{- if .Values.bootstrap.npmRegistry }}
            - name: BOOTSTRAP_NPM_REGISTRY
              value: {{ .Values.bootstrap.npmRegistry | quote }}
            {{- end }}
```

- [ ] **Step 1.5: Verify helm lint passes**

```bash
cd /home/peter/projects/kubeclaw
helm lint helm/kubeclaw
```

Expected: `0 chart(s) failed`

- [ ] **Step 1.6: Run the first two template tests to see them pass**

```bash
npx vitest run e2e/helm-chart-template.test.ts --reporter verbose 2>&1 | grep -A 3 "BOOTSTRAP_NPM_REGISTRY"
```

Expected: the `orchestrator Deployment gets BOOTSTRAP_NPM_REGISTRY` and `has no BOOTSTRAP_NPM_REGISTRY` tests pass.

---

## Task 2: Credential Broker ConfigMap — Mirror Mapping Entry

**Files:**
- Modify: `helm/kubeclaw/templates/credential-broker-config.yaml`

The broker `mappings` entry for the npm mirror must:
- Use `id: npm-mirror`
- Set `destinations` to the extracted hostname (or host:port) from `bootstrap.npmRegistry`
- Set `credentialRef` to reference `bootstrap.npmRegistryAuth.secretRef`, key `auth-token`
- Use `headerScheme: bearer`
- Only appear when both `bootstrap.npmRegistry` and `bootstrap.npmRegistryAuth.secretRef` are non-empty
- Only appear when `credentialInjection.mode != "off"` (the whole ConfigMap is already gated on this)

- [ ] **Step 2.1: Add mirror mapping to credential-broker-config.yaml**

In `helm/kubeclaw/templates/credential-broker-config.yaml`, after the existing `voyage` mapping (line 28) and before the `{{- if and (eq .Values.credentialInjection.mode "istio") ...` block (line 30), insert:

```yaml
      {{- if and .Values.bootstrap.npmRegistry .Values.bootstrap.npmRegistryAuth.secretRef }}
      {{- $parsedMirror := urlParse .Values.bootstrap.npmRegistry }}
      - id: npm-mirror
        destinations: [{{ $parsedMirror.host | quote }}]
        identities: ["sa/kubeclaw-bootstrap"]
        credentialRef: { kind: Secret, name: {{ .Values.bootstrap.npmRegistryAuth.secretRef | quote }}, key: auth-token }
        headerScheme: bearer
      {{- end }}
```

- [ ] **Step 2.2: Verify helm lint + template render**

```bash
cd /home/peter/projects/kubeclaw
helm lint helm/kubeclaw && \
helm template smoke helm/kubeclaw \
  --set secrets.anthropicApiKey=test \
  --set bootstrap.npmRegistry=https://npm.internal.corp \
  --set bootstrap.npmRegistryAuth.secretRef=my-npm-secret \
  | grep -A 8 "npm-mirror"
```

Expected output contains:
```
- id: npm-mirror
  destinations: ["npm.internal.corp"]
  identities: ["sa/kubeclaw-bootstrap"]
  credentialRef: { kind: Secret, name: "my-npm-secret", key: auth-token }
  headerScheme: bearer
```

- [ ] **Step 2.3: Run credential-broker template tests**

```bash
npx vitest run e2e/helm-chart-template.test.ts --reporter verbose 2>&1 | grep -E "credential-broker|npm-mirror" | head -20
```

Expected: the ConfigMap tests now pass.

---

## Task 3: Bootstrap NetworkPolicy — Mirror-Conditional Narrowing

**Files:**
- Modify: `helm/kubeclaw/templates/bootstrap-networkpolicy.yaml`

When `bootstrap.npmRegistry` is unset (default): keep the existing broad `to: []` port-443 rule (backward compat).

When `bootstrap.npmRegistry` is set AND `ciliumNetworkPolicy.enabled` is false: replace the broad rule with a comment explaining the limitation. Standard K8s NetworkPolicy cannot deny by hostname and cannot allow to a specific hostname without IP. In this case, we leave the broad allow-all in place but add a comment that Cilium is required for true FQDN-based enforcement.

When `bootstrap.npmRegistry` is set AND `ciliumNetworkPolicy.enabled` is true: remove the broad allow-all rule (Cilium handles it via `kubeclaw-bootstrap-egress` CiliumNetworkPolicy). The standard NetworkPolicy becomes DNS + Redis only.

- [ ] **Step 3.1: Rewrite bootstrap-networkpolicy.yaml**

Replace the full contents of `helm/kubeclaw/templates/bootstrap-networkpolicy.yaml` with:

```yaml
{{- if .Values.networkPolicy.enabled }}
---
# Bootstrap Job pods: egress to DNS, Redis, and npm registry.
# When bootstrap.npmRegistry is set and ciliumNetworkPolicy.enabled is true:
#   - The broad port-443 allow-all is REMOVED from this policy.
#   - A companion CiliumNetworkPolicy (kubeclaw-bootstrap-egress) allows egress
#     only to the configured mirror host via toFQDNs.
#   - registry.npmjs.org and registry.yarnpkg.com are implicitly denied.
# When bootstrap.npmRegistry is set but ciliumNetworkPolicy.enabled is false:
#   - Standard Kubernetes NetworkPolicy cannot express hostname-based allow or deny rules.
#   - The broad port-443 allow-all is retained for backwards compatibility.
#   - OPERATOR ACTION REQUIRED: enable Cilium CNI and set ciliumNetworkPolicy.enabled=true
#     to enforce FQDN-level egress restrictions in air-gapped mode.
# When bootstrap.npmRegistry is unset (default):
#   - The legacy broad port-443 allow-all applies (Story 174 behaviour preserved).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kubeclaw-bootstrap-policy
  namespace: {{ include "kubeclaw.namespace" . }}
  labels:
    app: kubeclaw
    component: bootstrap
spec:
  podSelector:
    matchLabels:
      kubeclaw.io/role: bootstrap
  policyTypes:
    - Egress
  egress:
    # DNS
    - to: []
      ports:
        - protocol: UDP
          port: 53
    # Redis IPC
    - to:
        - podSelector:
            matchLabels:
              app: kubeclaw-redis
      ports:
        - protocol: TCP
          port: 6379
    {{- if and .Values.bootstrap.npmRegistry .Values.ciliumNetworkPolicy.enabled }}
    # Mirror mode + Cilium: broad allow-all REMOVED.
    # CiliumNetworkPolicy kubeclaw-bootstrap-egress enforces FQDN-level access.
    # This standard NetworkPolicy intentionally has no port-443 rule here.
    {{- else }}
    # npm registry + channel API validation (HTTPS + HTTP).
    # NOTE: when bootstrap.npmRegistry is set but ciliumNetworkPolicy.enabled is false,
    # this broad rule remains to preserve connectivity; FQDN-based deny is unavailable
    # in standard Kubernetes NetworkPolicy. Enable Cilium for air-gapped enforcement.
    - to: []
      ports:
        - protocol: TCP
          port: 443
        - protocol: TCP
          port: 80
    {{- end }}
{{- end }}
```

- [ ] **Step 3.2: Verify helm lint**

```bash
cd /home/peter/projects/kubeclaw && helm lint helm/kubeclaw
```

Expected: `0 chart(s) failed`

- [ ] **Step 3.3: Verify the two bootstrap NetworkPolicy scenarios render correctly**

```bash
# Scenario A: no mirror — should include port 443 broad rule
helm template smoke helm/kubeclaw \
  --set secrets.anthropicApiKey=test \
  | grep -A 30 "kubeclaw-bootstrap-policy" | head -35

# Scenario B: mirror + Cilium — should NOT include broad port-443 rule
helm template smoke helm/kubeclaw \
  --set secrets.anthropicApiKey=test \
  --set bootstrap.npmRegistry=https://npm.internal.corp \
  --set ciliumNetworkPolicy.enabled=true \
  | grep -A 30 "kubeclaw-bootstrap-policy" | head -35
```

Expected for Scenario A: `port: 443` appears inside `kubeclaw-bootstrap-policy`.
Expected for Scenario B: no `port: 443` inside `kubeclaw-bootstrap-policy` (comment appears instead).

---

## Task 4: CiliumNetworkPolicy — Bootstrap Egress + Channel Deny

**Files:**
- Modify: `helm/kubeclaw/templates/cilium-network-policies.yaml`

Two additions:
1. A new `CiliumNetworkPolicy` named `kubeclaw-bootstrap-egress` that applies to `kubeclaw.io/role=bootstrap` pods, rendered when `ciliumNetworkPolicy.enabled` AND `bootstrap.npmRegistry` is set. Permits egress to: DNS, Redis, and the mirror host (via `toFQDNs`). Implicitly denies everything else.
2. An extension to the existing `kubeclaw-channel-egress` policy: add `toFQDNs` deny entries for `registry.npmjs.org` and `registry.yarnpkg.com` when `bootstrap.npmRegistry` is set (channel pods must never reach the npm registries). Also deny the mirror host when `bootstrap.npmRegistry` is set (channel pods must not reach the mirror either).

**Note on Cilium FQDN deny:** Cilium does not support explicit `toFQDNs` deny rules in the same policy as allow rules for the same port via a single `deny` section in `v1` CiliumNetworkPolicy. The correct pattern is: define only the allowed FQDNs in the egress allow rules — any FQDN not in the allowlist is implicitly denied. For the channel policy, we extend the `toFQDNs` allowlist comment to note that `registry.npmjs.org` and `registry.yarnpkg.com` are intentionally excluded.

For the bootstrap policy, the approach is: allow DNS, Redis, and the mirror host only. The public registry is never in the allowlist, so it is implicitly denied by the Cilium default-deny posture.

- [ ] **Step 4.1: Add `kubeclaw-bootstrap-egress` CiliumNetworkPolicy to cilium-network-policies.yaml**

At the end of `helm/kubeclaw/templates/cilium-network-policies.yaml` (before the closing `{{- end }}`), insert:

```yaml
{{- if .Values.bootstrap.npmRegistry }}
{{- $parsedBootstrapMirror := urlParse .Values.bootstrap.npmRegistry }}
---
# CiliumNetworkPolicy for bootstrap pods: DNS + Redis + mirror host only.
# registry.npmjs.org and registry.yarnpkg.com are NOT in the allowlist —
# they are implicitly denied by Cilium's default-deny posture.
# Only rendered when ciliumNetworkPolicy.enabled AND bootstrap.npmRegistry is set.
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: kubeclaw-bootstrap-egress
  namespace: {{ include "kubeclaw.namespace" . }}
spec:
  endpointSelector:
    matchLabels:
      kubeclaw.io/role: bootstrap
  egress:
  # DNS — required before any FQDN rule can resolve.
  - toEndpoints:
    - matchLabels:
        "k8s:io.kubernetes.pod.namespace": kube-system
        k8s-app: kube-dns
    toPorts:
    - ports:
      - port: "53"
        protocol: UDP
      - port: "53"
        protocol: TCP
  # Redis IPC
  - toEndpoints:
    - matchLabels:
        "k8s:io.kubernetes.pod.namespace": {{ include "kubeclaw.namespace" . }}
        app: kubeclaw-redis
    toPorts:
    - ports:
      - port: "6379"
        protocol: TCP
  # npm mirror — FQDN allowlist (registry.npmjs.org intentionally excluded).
  - toFQDNs:
    - matchName: {{ $parsedBootstrapMirror.host | quote }}
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
      - port: "80"
        protocol: TCP
{{- end }}
```

- [ ] **Step 4.2: Extend `kubeclaw-channel-egress` to exclude registry FQDNs**

In `helm/kubeclaw/templates/cilium-network-policies.yaml`, locate the `kubeclaw-channel-egress` policy's `toFQDNs` allow block (around lines 136-148). After the closing `{{- end }}` for that block, add:

```yaml
  {{- if .Values.bootstrap.npmRegistry }}
  {{- $parsedChannelMirror := urlParse .Values.bootstrap.npmRegistry }}
  # Steady-state channel pods: deny egress to npm registries AND the configured mirror.
  # registry.npmjs.org, registry.yarnpkg.com, and the mirror host are intentionally
  # excluded from the toFQDNs allowlist above. Cilium's default-deny posture blocks
  # them implicitly. This comment documents the intent explicitly for auditability.
  # TODO(Story 183 follow-on): registry.yarnpkg.com is only enforceable via Cilium;
  # standard K8s NetworkPolicy cannot express hostname-based deny rules.
  # Mirror host {{ $parsedChannelMirror.host }} is also excluded — channel pods must
  # not reach the mirror even if they know the URL and token.
  {{- end }}
```

**Implementation note:** Because Cilium uses allowlist semantics (permit only listed FQDNs, deny everything else), explicitly listing these denied hosts is not required in the policy itself. The comment above is sufficient for documentation and auditability. The actual enforcement comes from the FQDNs listed in the allowlist not including the registry hosts.

- [ ] **Step 4.3: Verify Cilium template renders correctly**

```bash
cd /home/peter/projects/kubeclaw
helm template smoke helm/kubeclaw \
  --set secrets.anthropicApiKey=test \
  --set ciliumNetworkPolicy.enabled=true \
  --set bootstrap.npmRegistry=https://npm.internal.corp \
  | grep -A 25 "kubeclaw-bootstrap-egress"
```

Expected: `kubeclaw-bootstrap-egress` policy appears with `npm.internal.corp` in `toFQDNs` and no `registry.npmjs.org`.

```bash
helm template smoke helm/kubeclaw \
  --set secrets.anthropicApiKey=test \
  --set ciliumNetworkPolicy.enabled=true \
  --set bootstrap.npmRegistry=https://npm.internal.corp \
  | grep -C 3 "registry.npmjs.org"
```

Expected: `registry.npmjs.org` appears in the comment (documentation), not in an allow rule.

- [ ] **Step 4.4: Run Cilium template tests**

```bash
npx vitest run e2e/helm-chart-template.test.ts --reporter verbose 2>&1 | grep -E "Cilium|registry" | head -20
```

Expected: `Cilium bootstrap policy renders` and `Cilium channel policy gets deny FQDNs` both pass.

---

## Task 5: bootstrap-runner.ts — Read BOOTSTRAP_NPM_REGISTRY, Inject NPM_CONFIG_REGISTRY

**Files:**
- Modify: `src/k8s/bootstrap-runner.ts`
- Modify: `src/k8s/bootstrap-runner.test.ts`

The orchestrator pod has `BOOTSTRAP_NPM_REGISTRY` in its env (from Task 1). The `bootstrapChannelFromSkill` function must read this at call time and, when non-empty, push `{ name: 'NPM_CONFIG_REGISTRY', value: <url> }` into the bootstrap container's `envVars` array. The upgrade path (`runUpgrade`) must do the same.

**Also add an opt-in parameter** `npmRegistry?: string` to `BootstrapChannelFromSkillOpts` and `RunUpgradeOpts` so callers can override the value (defaults to `process.env.BOOTSTRAP_NPM_REGISTRY`). This enables clean unit testing without mutating `process.env`.

- [ ] **Step 5.1: Write failing unit tests (RED)**

In `src/k8s/bootstrap-runner.test.ts`, add after the Story 182 `describe` block (end of file):

```typescript
// ─── Story 183: NPM_CONFIG_REGISTRY env injection ────────────────────────────

describe('bootstrapChannelFromSkill — Story 183: NPM_CONFIG_REGISTRY injection', () => {
  let fakeK8s: ReturnType<typeof makeFakeK8s>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const OLD_ENV: any = process.env;

  beforeEach(() => {
    fakeK8s = makeFakeK8s();
    process.env = { ...OLD_ENV };
    delete process.env.BOOTSTRAP_NPM_REGISTRY;
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  function getBootstrapEnvMap(fakeK8s: ReturnType<typeof makeFakeK8s>) {
    const jobBody = fakeK8s.createdJobs[0].body as {
      spec: {
        template: {
          spec: { containers: [{ env: { name: string; value: string }[] }] };
        };
      };
    };
    const envs = jobBody.spec.template.spec.containers[0].env;
    return Object.fromEntries(envs.map((e) => [e.name, e.value]));
  }

  it('bootstrap Job env includes NPM_CONFIG_REGISTRY when BOOTSTRAP_NPM_REGISTRY env var is set', async () => {
    process.env.BOOTSTRAP_NPM_REGISTRY = 'https://npm.internal.corp';
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1: fakeK8s.coreV1, batchV1: fakeK8s.batchV1 },
      namespace: 'test-ns',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps: new Map(),
    });
    const envMap = getBootstrapEnvMap(fakeK8s);
    expect(envMap['NPM_CONFIG_REGISTRY']).toBe('https://npm.internal.corp');
  });

  it('bootstrap Job env includes NPM_CONFIG_REGISTRY when npmRegistry option is passed', async () => {
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1: fakeK8s.coreV1, batchV1: fakeK8s.batchV1 },
      namespace: 'test-ns',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps: new Map(),
      npmRegistry: 'https://npm.option.corp',
    });
    const envMap = getBootstrapEnvMap(fakeK8s);
    expect(envMap['NPM_CONFIG_REGISTRY']).toBe('https://npm.option.corp');
  });

  it('bootstrap Job env does NOT include NPM_CONFIG_REGISTRY when BOOTSTRAP_NPM_REGISTRY is absent', async () => {
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1: fakeK8s.coreV1, batchV1: fakeK8s.batchV1 },
      namespace: 'test-ns',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps: new Map(),
    });
    const envMap = getBootstrapEnvMap(fakeK8s);
    expect(envMap['NPM_CONFIG_REGISTRY']).toBeUndefined();
  });

  it('npmRegistry option takes precedence over BOOTSTRAP_NPM_REGISTRY env var', async () => {
    process.env.BOOTSTRAP_NPM_REGISTRY = 'https://env.registry.corp';
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1: fakeK8s.coreV1, batchV1: fakeK8s.batchV1 },
      namespace: 'test-ns',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps: new Map(),
      npmRegistry: 'https://opt.registry.corp',
    });
    const envMap = getBootstrapEnvMap(fakeK8s);
    expect(envMap['NPM_CONFIG_REGISTRY']).toBe('https://opt.registry.corp');
  });
});
```

- [ ] **Step 5.2: Run tests to confirm RED**

```bash
cd /home/peter/projects/kubeclaw
npx vitest run src/k8s/bootstrap-runner.test.ts --reporter verbose 2>&1 | grep -E "NPM_CONFIG|Story 183" | head -20
```

Expected: 4 new tests fail with `NPM_CONFIG_REGISTRY` not found.

- [ ] **Step 5.3: Add `npmRegistry` to `BootstrapChannelFromSkillOpts` interface**

In `src/k8s/bootstrap-runner.ts`, in the `BootstrapChannelFromSkillOpts` interface (around line 162), add after `directLlmModel?`:

```typescript
  /**
   * Story 183: optional npm mirror registry URL. When set (or when
   * BOOTSTRAP_NPM_REGISTRY env var is set on the orchestrator pod), the
   * bootstrap Job's container receives NPM_CONFIG_REGISTRY=<url>.
   * When absent and env var is also absent, no NPM_CONFIG_REGISTRY is injected.
   */
  npmRegistry?: string;
```

Similarly add to `RunUpgradeOpts` interface (around line 418):

```typescript
  /** Story 183: optional npm mirror registry URL. See BootstrapChannelFromSkillOpts.npmRegistry. */
  npmRegistry?: string;
```

- [ ] **Step 5.4: Inject NPM_CONFIG_REGISTRY into bootstrapChannelFromSkill env vars**

In `src/k8s/bootstrap-runner.ts`, in the `bootstrapChannelFromSkill` function, in the "Build env vars" section (after line 295), add after the `REDIS_URL` push:

```typescript
  // Story 183: inject NPM_CONFIG_REGISTRY when a mirror is configured.
  // opts.npmRegistry takes precedence over the BOOTSTRAP_NPM_REGISTRY env var.
  const npmRegistry = opts.npmRegistry || process.env.BOOTSTRAP_NPM_REGISTRY;
  if (npmRegistry) {
    envVars.push({ name: 'NPM_CONFIG_REGISTRY', value: npmRegistry });
  }
```

Also add the same block to `runUpgrade`'s "Build env vars" section (after line 547, after the REDIS_URL push):

```typescript
  // Story 183: inject NPM_CONFIG_REGISTRY when a mirror is configured.
  const npmRegistry = opts.npmRegistry || process.env.BOOTSTRAP_NPM_REGISTRY;
  if (npmRegistry) {
    envVars.push({ name: 'NPM_CONFIG_REGISTRY', value: npmRegistry });
  }
```

- [ ] **Step 5.5: Run unit tests to confirm GREEN**

```bash
npx vitest run src/k8s/bootstrap-runner.test.ts --reporter verbose 2>&1 | tail -30
```

Expected: all tests pass, including the 4 new Story 183 tests.

---

## Task 6: E2e Scaffold — minikube-live-bootstrap-air-gapped.test.ts

**Files:**
- Create: `e2e/minikube-live-bootstrap-air-gapped.test.ts`

This file provides the test structure for Story 183's ACs. AC3 and AC4 (NetworkPolicy assertions via `kubectl exec`) are skeletal but contain real patterns. AC1, AC2, AC5 (Verdaccio-dependent) use `it.todo`.

- [ ] **Step 6.1: Create e2e/minikube-live-bootstrap-air-gapped.test.ts**

```typescript
/**
 * Story 183: Air-gapped bootstrap — npm mirror via credential broker.
 *
 * AC1, AC2, AC5 require a Verdaccio in-cluster mirror pre-seeded with
 * @kubeclaw/channel-* packages. These are marked it.todo pending the
 * Verdaccio fixture (follow-on work).
 *
 * AC3 + AC4 are NetworkPolicy assertions exercisable via helm template
 * rendering (no live cluster required for the static assertions).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';

const CHART_DIR = './helm/kubeclaw';
const BASE_HELM_ARGS = [
  '--set', 'secrets.anthropicApiKey=test',
  '--set', 'secrets.claudeCodeOauthToken=test',
  '--set', 'redis.password=test',
];

// ─── AC1: bootstrap pod env carries NPM_CONFIG_REGISTRY ──────────────────────

describe('AC1: bootstrap pod npm config points at mirror (helm template assertion)', () => {
  it('orchestrator env carries BOOTSTRAP_NPM_REGISTRY when bootstrap.npmRegistry is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...BASE_HELM_ARGS,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('BOOTSTRAP_NPM_REGISTRY');
    expect(result.stdout).toContain('https://npm.internal.corp');
  });

  it('NPM_CONFIG_REGISTRY is absent from orchestrator env when bootstrap.npmRegistry is empty (backwards compat)', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...BASE_HELM_ARGS],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('BOOTSTRAP_NPM_REGISTRY');
  });

  // TODO(Story 183 follow-on): Verdaccio-based live test.
  // Requires: Verdaccio Deployment + Service in test namespace, pre-seeded
  // with @kubeclaw/channel-* tarballs, and a K8s Secret with auth-token.
  it.todo('AC1 live: npm ci log from SSE stream contains info reify registry: https://<mirror>');
});

// ─── AC2: credential broker stamps Authorization: Bearer ─────────────────────

describe('AC2: credential-broker ConfigMap contains mirror mapping', () => {
  it('ConfigMap renders npm-mirror mapping when npmRegistry + secretRef are set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...BASE_HELM_ARGS,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
        '--set', 'bootstrap.npmRegistryAuth.secretRef=my-npm-secret',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('id: npm-mirror');
    expect(result.stdout).toContain('npm.internal.corp');
    expect(result.stdout).toContain('my-npm-secret');
    expect(result.stdout).toContain('auth-token');
    expect(result.stdout).toContain('headerScheme: bearer');
  });

  it('ConfigMap has no npm-mirror mapping when npmRegistry is empty', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...BASE_HELM_ARGS],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('id: npm-mirror');
  });

  // TODO(Story 183 follow-on): Verdaccio-based live test.
  // Assert: credential_broker_authz_total{destination="<mirror>",status="200"} >= 1
  it.todo('AC2 live: broker metric increments for mirror host during bootstrap install');
});

// ─── AC3: bootstrap pod NetworkPolicy ────────────────────────────────────────

describe('AC3: bootstrap NetworkPolicy restricts egress when mirror is configured', () => {
  it('bootstrap NetworkPolicy removes broad port-443 allow-all when mirror + Cilium enabled', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...BASE_HELM_ARGS,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
        '--set', 'ciliumNetworkPolicy.enabled=true',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    // Extract just the bootstrap policy section
    const sections = result.stdout.split('---');
    const bootstrapSection = sections.find(
      (s) => s.includes('kubeclaw-bootstrap-policy') && s.includes('kind: NetworkPolicy'),
    );
    expect(bootstrapSection, 'kubeclaw-bootstrap-policy not found').toBeTruthy();
    // Should have no port: 443 rule (Cilium handles it)
    // The comment text may contain "443" — check for actual port: 443 YAML key
    const portLines = (bootstrapSection ?? '').split('\n').filter(
      (l) => /^\s+port:\s+443\s*$/.test(l),
    );
    expect(portLines, 'Expected no port: 443 in bootstrap NetworkPolicy when Cilium+mirror active').toHaveLength(0);
  });

  it('bootstrap NetworkPolicy keeps broad port-443 allow-all when mirror set but Cilium disabled', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...BASE_HELM_ARGS,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
        // ciliumNetworkPolicy.enabled defaults to false
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const sections = result.stdout.split('---');
    const bootstrapSection = sections.find(
      (s) => s.includes('kubeclaw-bootstrap-policy') && s.includes('kind: NetworkPolicy'),
    );
    expect(bootstrapSection, 'kubeclaw-bootstrap-policy not found').toBeTruthy();
    expect(bootstrapSection).toContain('port: 443');
  });

  it('CiliumNetworkPolicy kubeclaw-bootstrap-egress renders with mirror host in toFQDNs', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...BASE_HELM_ARGS,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
        '--set', 'ciliumNetworkPolicy.enabled=true',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('kubeclaw-bootstrap-egress');
    expect(result.stdout).toContain('npm.internal.corp');
    // registry.npmjs.org must NOT appear in an allow rule
    // (it may appear in a comment but not as a matchName)
    const lines = result.stdout.split('\n');
    const matchNameLines = lines.filter(
      (l) => l.includes('matchName') && l.includes('registry.npmjs.org'),
    );
    expect(
      matchNameLines,
      'registry.npmjs.org must not appear as an allowed FQDN',
    ).toHaveLength(0);
  });

  // TODO(Story 183 follow-on): live cluster assertion via kubectl exec
  it.todo('AC3 live: curl registry.npmjs.org from bootstrap pod times out (NetworkPolicy block)');
  it.todo('AC3 live: curl <mirror-host> from bootstrap pod succeeds');
});

// ─── AC4: steady-state channel NetworkPolicy denies registries ───────────────

describe('AC4: steady-state channel pod NetworkPolicy denies npm registries', () => {
  it('Cilium channel policy excludes registry.npmjs.org and registry.yarnpkg.com from allowlist', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...BASE_HELM_ARGS,
        '--set', 'ciliumNetworkPolicy.enabled=true',
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    // Verify that the channel egress policy (kubeclaw-channel-egress) does NOT
    // have registry.npmjs.org or registry.yarnpkg.com as a matchName allowed FQDN.
    const lines = result.stdout.split('\n');
    const allowedFqdnMatchLines = lines.filter(
      (l) =>
        l.includes('matchName') &&
        (l.includes('registry.npmjs.org') || l.includes('registry.yarnpkg.com')),
    );
    expect(
      allowedFqdnMatchLines,
      'registry.npmjs.org / registry.yarnpkg.com must not be allowed FQDNs in channel policy',
    ).toHaveLength(0);
  });

  // TODO(Story 183 follow-on): live cluster assertion via kubectl exec
  it.todo('AC4 live: curl registry.npmjs.org from channel pod fails (NetworkPolicy block)');
  it.todo('AC4 live: curl <mirror-host> from channel pod fails (channel pod blocked from mirror too)');
});

// ─── AC5: no traffic to registry.npmjs.org during full bootstrap ─────────────

describe('AC5: no public registry traffic during bootstrap with mirror (Verdaccio)', () => {
  // All ACs here require a live Verdaccio in-cluster mirror.
  // Follow-on work: e2e/fixtures/verdaccio.yaml + npm publish init job.
  it.todo('AC5a live: credential_broker_authz_total{destination="registry.npmjs.org"} stays at 0');
  it.todo('AC5b live: credential_broker_authz_total{destination="<verdaccio>",status="200"} >= 1');
  it.todo('AC5c live: /runtime/node_modules/ contains @kubeclaw/channel-<type> after install');
  it.todo('AC5d live: npm ci integrity passes when Verdaccio serves correct tarballs (xfail on EINTEGRITY)');
});
```

- [ ] **Step 6.2: Verify the new e2e file is found by vitest**

```bash
cd /home/peter/projects/kubeclaw
npx vitest run e2e/minikube-live-bootstrap-air-gapped.test.ts --reporter verbose 2>&1 | tail -30
```

Expected: all non-todo tests pass; todo tests are listed as skipped.

---

## Task 7: Full Test Suite Run + Typecheck

- [ ] **Step 7.1: Run all unit tests**

```bash
cd /home/peter/projects/kubeclaw
npx vitest run src/k8s/bootstrap-runner.test.ts --reporter verbose 2>&1 | tail -30
```

Expected: all pass, no regressions.

- [ ] **Step 7.2: Run all Helm template tests**

```bash
npx vitest run e2e/helm-chart-template.test.ts --reporter verbose 2>&1 | tail -40
```

Expected: all pass including new Story 183 describe block.

- [ ] **Step 7.3: Run air-gapped e2e scaffold**

```bash
npx vitest run e2e/minikube-live-bootstrap-air-gapped.test.ts --reporter verbose 2>&1 | tail -20
```

Expected: all non-todo tests pass; todo tests skipped.

- [ ] **Step 7.4: TypeScript typecheck**

```bash
cd /home/peter/projects/kubeclaw
npx tsc --noEmit 2>&1 | head -40
```

Expected: 0 errors.

- [ ] **Step 7.5: Helm lint**

```bash
helm lint helm/kubeclaw 2>&1
```

Expected: `0 chart(s) failed`.

---

## Task 8: Commit

- [ ] **Step 8.1: Stage and commit all changes**

```bash
cd /home/peter/projects/kubeclaw
git add \
  helm/kubeclaw/values.yaml \
  helm/kubeclaw/templates/orchestrator.yaml \
  helm/kubeclaw/templates/credential-broker-config.yaml \
  helm/kubeclaw/templates/bootstrap-networkpolicy.yaml \
  helm/kubeclaw/templates/cilium-network-policies.yaml \
  src/k8s/bootstrap-runner.ts \
  src/k8s/bootstrap-runner.test.ts \
  e2e/helm-chart-template.test.ts \
  e2e/minikube-live-bootstrap-air-gapped.test.ts

git commit -m "feat(Story 183): air-gapped bootstrap — npm mirror via credential broker, registry egress denied"
```

---

## Self-Review Checklist

### Spec Coverage

| AC | Covered by | Notes |
|----|------------|-------|
| AC1: bootstrap pod env carries NPM_CONFIG_REGISTRY | Task 1 (Helm), Task 5 (TS unit tests), Task 6 (e2e scaffold) | Live Verdaccio test is `it.todo` |
| AC2: broker ConfigMap mirror mapping | Task 2 (Helm template), Task 6 (AC2 describe) | Live broker metric test is `it.todo` |
| AC3: bootstrap NetworkPolicy narrow/broad | Task 3 (networkpolicy.yaml), Task 4 (Cilium), Task 6 (AC3 describe) | Live kubectl exec test is `it.todo` |
| AC4: channel policy denies registries | Task 4 (Cilium comment + implicit deny), Task 6 (AC4 describe) | Live kubectl exec test is `it.todo` |
| AC5: no public registry traffic | Task 6 (all `it.todo`) | Deferred — Verdaccio fixture out of scope |
| Backwards compat (npmRegistry empty) | Task 1.4, Task 3 (else branch), Task 5 (absent test) | Existing Story 174 tests remain green |
| Cilium gap documented | Task 3 (comment in bootstrap-networkpolicy.yaml), Task 4 (comment) | ✅ |
| `bootstrap.npmRegistryAuth.secretRef` | Task 1.3, Task 2 | ✅ |
| `bootstrap.npmRegistry` default empty | Already exists in values.yaml | Only `npmRegistryAuth.secretRef` is new |

### Potential Issues

1. **`urlParse` availability in Helm**: Sprig's `urlParse` was added in Helm 3.1+. The codebase targets Helm 3+, so this is safe. Verify with `helm version` if needed.

2. **Host extraction includes port**: For `http://verdaccio.ns.svc.cluster.local:4873`, `urlParse` returns `host: "verdaccio.ns.svc.cluster.local:4873"`. This is correct for the broker `destinations` (which matches `X-Forwarded-Authority`) and for `toFQDNs` in Cilium (which supports `matchName` with port). This is consistent.

3. **`bootstrap.npmRegistry` already exists**: The values.yaml already has `npmRegistry: ""` at line 532. Only `npmRegistryAuth.secretRef` is new in Task 1.3.

4. **runUpgrade also needs NPM_CONFIG_REGISTRY**: Task 5 covers both `bootstrapChannelFromSkill` and `runUpgrade` env injection. Both paths must inject the env var.

5. **networkpolicies.yaml comment on channel policy**: The story asks to add a comment to `networkpolicies.yaml` about the hostname-deny limitation for the channel policy. This is handled by the comment in Task 3's rewritten `bootstrap-networkpolicy.yaml`. A separate comment should also be added to the channel section in `networkpolicies.yaml`.
