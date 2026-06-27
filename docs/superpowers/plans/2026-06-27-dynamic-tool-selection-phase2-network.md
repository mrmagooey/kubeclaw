# Dynamic Tool Selection — Phase 2: Network Containment & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every tool pod a per-tool, default-deny egress allowlist enforced by the strongest substrate the cluster supports (Cilium `toFQDNs` or Istio egress gateway), enforce egress↔credential coherence, harden tool-pod `securityContext`, and fix the dead-label NetworkPolicy bug — so untrusted tools (and the Phase 3 discovery probe) run inside real containment.

**Architecture:** Add an optional `allowedEgress` field to `ToolSpec`. At sidecar-tool-pod creation time the orchestrator dynamically creates a per-pod egress policy object (a `CiliumNetworkPolicy` with `toFQDNs`, or an Istio `ServiceEntry`+`Sidecar` scoped by pod label) selecting that job's pod via its existing `kubeclaw/tool` label, and applies hardened pod/container `securityContext`. A pure validation function enforces that a tool's `allowedEgress` is a subset of its credential's catalog host(s). The substrate is detected at runtime; when neither hard substrate is present, vetted tiers still run (best-effort plain NetworkPolicy) but the system exposes a capability flag that Phase 3 reads to hard-gate discovery.

**Tech Stack:** TypeScript, `@kubernetes/client-node` (existing in `src/k8s`), Helm, Cilium/Istio CRDs, Vitest.

## Global Constraints

- `allowedEgress` must be added to `ALLOWED_KEYS` and validated in `validateTool()` (`src/tools/types.ts`) or registration silently drops it.
- Per-pod egress objects must select pods by the labels `job-runner.ts` already sets on sidecar tool pods: `app: kubeclaw-sidecar-tool`, `kubeclaw/tool: <name>`, `kubeclaw/agent-job: <id>` (`src/k8s/job-runner.ts:1894-1913`). Do NOT invent new label schemes.
- Hardened `securityContext` must keep the existing writable mounts working: `/shared` (emptyDir IPC) and, for `mount: group`, `/work` (group PVC). `readOnlyRootFilesystem: true` is allowed only because those are separate volume mounts.
- Egress enforcement substrate is detected from the same signals Helm uses: `credentialInjection.mode` (`getInjectionMode()`, `src/credential-injection/mode.ts`) and a new `CILIUM_NETWORK_POLICY_ENABLED` env mirroring `.Values.ciliumNetworkPolicy.enabled`.
- This phase changes NO selection logic; it consumes `ToolSpec.allowedEgress` and hardens pods. Phase 1 must be merged first.

---

## File Structure

| File | Responsibility | Create/Modify |
| ---- | -------------- | ------------- |
| `src/tools/types.ts` | Add `allowedEgress?: EgressRule[]`; `ALLOWED_KEYS`; validation | Modify |
| `src/k8s/egress/coherence.ts` | Pure check: `allowedEgress ⊆ credential catalog hosts` | Create |
| `src/k8s/egress/substrate.ts` | Detect enforcement substrate (`cilium`/`istio`/`none`) | Create |
| `src/k8s/egress/cilium-policy.ts` | Build a per-pod `CiliumNetworkPolicy` object from `allowedEgress` | Create |
| `src/k8s/egress/istio-policy.ts` | Build per-pod Istio `ServiceEntry` + `Sidecar` objects | Create |
| `src/k8s/egress/apply.ts` | Create/delete the egress object for a job via the k8s client | Create |
| `src/k8s/security-context.ts` | Hardened pod + container `securityContext` defaults for tool pods | Create |
| `src/k8s/job-runner.ts` | Apply hardened securityContext + create per-pod egress object on sidecar tool job; tear down on completion | Modify |
| `helm/kubeclaw/templates/networkpolicies-injection.yaml` | Fix dead label `kubeclaw-tool-pod` → `kubeclaw-sidecar-tool` | Modify |
| `helm/kubeclaw/templates/networkpolicies-istio.yaml` | Same dead-label fix | Modify |
| `helm/kubeclaw/templates/rbac.yaml` | Grant orchestrator RBAC to manage `CiliumNetworkPolicy` / Istio `ServiceEntry`+`Sidecar` | Modify |

---

## Task 1: Dead-label NetworkPolicy fix (regression-first)

**Files:**
- Modify: `helm/kubeclaw/templates/networkpolicies-injection.yaml:27`
- Modify: `helm/kubeclaw/templates/networkpolicies-istio.yaml:70`
- Test: `helm/kubeclaw/tests/networkpolicy-label.test.*` (match the repo's existing helm test harness)

**Interfaces:** none (manifest fix).

- [ ] **Step 1: Write the failing render assertion**

Add a helm test (or a shell assertion in the repo's helm test runner) that renders with `credentialInjection.mode=sidecar` and asserts NO NetworkPolicy selects the dead label:

```bash
helm template helm/kubeclaw --set credentialInjection.mode=sidecar \
  | grep -c 'kubeclaw-tool-pod'
```
Expected (currently): a count > 0 (the bug). After the fix: `0`.

- [ ] **Step 2: Confirm it currently fails (count > 0)**

Run the command above. Expected now: prints a non-zero number (the dead label is present).

- [ ] **Step 3: Fix both manifests** — change the `podSelector.matchLabels` value:

In `networkpolicies-injection.yaml` (~line 27) and `networkpolicies-istio.yaml` (~line 70):

```yaml
  podSelector:
    matchLabels:
      app: kubeclaw-sidecar-tool
```

- [ ] **Step 4: Verify the render now excludes the dead label**

Run:
```bash
helm template helm/kubeclaw --set credentialInjection.mode=sidecar | grep -c 'kubeclaw-tool-pod'
helm template helm/kubeclaw --set credentialInjection.mode=istio   | grep -c 'kubeclaw-tool-pod'
```
Expected: `0` for both (the live Cilium policy intentionally lists both labels via `matchExpressions` and is a different file — confirm the grep targets the two fixed files, or assert the rendered NetworkPolicy `podSelector` equals `kubeclaw-sidecar-tool`).

- [ ] **Step 5: Commit**

```bash
git add helm/kubeclaw/templates/networkpolicies-injection.yaml helm/kubeclaw/templates/networkpolicies-istio.yaml helm/kubeclaw/tests/
git commit -m "fix(netpol): bind sidecar/istio egress policies to live kubeclaw-sidecar-tool label"
```

---

## Task 2: `allowedEgress` field + validation

**Files:**
- Modify: `src/tools/types.ts` (interface, `ALLOWED_KEYS`, `validateTool`)
- Test: `src/tools/types.test.ts`

**Interfaces:**
- Produces:
  - `interface EgressRule { host: string; ports?: number[] }`
  - `ToolSpec.allowedEgress?: EgressRule[]`
  - `validateTool` rejects: non-array `allowedEgress`; entries missing `host`; non-FQDN-looking host; ports outside 1–65535.

- [ ] **Step 1: Write the failing test**

```typescript
import { validateTool } from './types';

const base = { name: 'x', description: 'd', parameters: { type: 'object' }, image: 'i', pattern: 'http' };

describe('allowedEgress validation', () => {
  it('accepts a valid egress rule', () => {
    expect(validateTool({ ...base, allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }] }).ok).toBe(true);
  });
  it('accepts an empty egress list (no external access)', () => {
    expect(validateTool({ ...base, pattern: 'file', allowedEgress: [] }).ok).toBe(true);
  });
  it('rejects a non-array', () => {
    const r = validateTool({ ...base, allowedEgress: 'nope' });
    expect(r.ok).toBe(false);
  });
  it('rejects an entry with no host', () => {
    const r = validateTool({ ...base, allowedEgress: [{ ports: [443] }] });
    expect(r.ok).toBe(false);
  });
  it('rejects an out-of-range port', () => {
    const r = validateTool({ ...base, allowedEgress: [{ host: 'h.example.com', ports: [70000] }] });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/types.test.ts -t allowedEgress`
Expected: FAIL — `unknown field: allowedEgress` (rejected by `ALLOWED_KEYS`).

- [ ] **Step 3: Implement** — add to the interface, the `ALLOWED_KEYS` set, and `validateTool`:

```typescript
// interface (near credentials)
export interface EgressRule {
  host: string;
  ports?: number[];
}
// ToolSpec:
//   allowedEgress?: EgressRule[];

// ALLOWED_KEYS: add 'allowedEgress'

// validateTool, before `return { ok: true }`:
if (obj.allowedEgress !== undefined) {
  if (!Array.isArray(obj.allowedEgress)) {
    return { ok: false, error: 'allowedEgress must be an array' };
  }
  for (const rule of obj.allowedEgress as unknown[]) {
    if (typeof rule !== 'object' || rule === null) {
      return { ok: false, error: 'each allowedEgress entry must be an object' };
    }
    const r = rule as Record<string, unknown>;
    if (typeof r.host !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(r.host)) {
      return { ok: false, error: 'allowedEgress host must be a valid hostname' };
    }
    if (r.ports !== undefined) {
      if (!Array.isArray(r.ports) || r.ports.some((p) => typeof p !== 'number' || p < 1 || p > 65535)) {
        return { ok: false, error: 'allowedEgress ports must be integers 1-65535' };
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/types.test.ts -t allowedEgress`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/types.ts src/tools/types.test.ts
git commit -m "feat(tools): add allowedEgress field with validation to ToolSpec"
```

---

## Task 3: Egress↔credential coherence check

**Files:**
- Create: `src/k8s/egress/coherence.ts`
- Test: `src/k8s/egress/coherence.test.ts`

**Interfaces:**
- Consumes: `ToolSpec`, `EgressRule`.
- Produces:
  - `interface CoherenceResult { ok: boolean; error?: string }`
  - `function checkEgressCredentialCoherence(spec: ToolSpec, catalogHostLookup: (id: string) => string | undefined): CoherenceResult` — if the tool has credentials, EVERY `allowedEgress.host` must equal one of the credentials' catalog hosts; and a credentialed tool MUST declare `allowedEgress` (no implicit open egress with a secret).

- [ ] **Step 1: Write the failing test**

```typescript
import { checkEgressCredentialCoherence } from './coherence';
import type { ToolSpec } from '../../tools/types';

const lookup = (id: string) => ({ 'brave-search': 'api.search.brave.com', openai: 'api.openai.com' }[id]);

describe('egress/credential coherence', () => {
  it('passes a credential-free tool regardless of egress', () => {
    const spec: ToolSpec = { name: 't', description: 'd', parameters: {}, image: 'i', pattern: 'file' };
    expect(checkEgressCredentialCoherence(spec, lookup).ok).toBe(true);
  });

  it('passes when egress matches the credential host', () => {
    const spec: ToolSpec = {
      name: 't', description: 'd', parameters: {}, image: 'i', pattern: 'http',
      credentials: ['brave-search'], allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
    };
    expect(checkEgressCredentialCoherence(spec, lookup).ok).toBe(true);
  });

  it('fails when egress includes a host outside the credential host', () => {
    const spec: ToolSpec = {
      name: 't', description: 'd', parameters: {}, image: 'i', pattern: 'http',
      credentials: ['brave-search'], allowedEgress: [{ host: 'evil.example.com' }],
    };
    expect(checkEgressCredentialCoherence(spec, lookup).ok).toBe(false);
  });

  it('fails a credentialed tool that declares no egress', () => {
    const spec: ToolSpec = {
      name: 't', description: 'd', parameters: {}, image: 'i', pattern: 'http',
      credentials: ['brave-search'],
    };
    expect(checkEgressCredentialCoherence(spec, lookup).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/k8s/egress/coherence.test.ts`
Expected: FAIL — cannot find module `./coherence`.

- [ ] **Step 3: Implement**

```typescript
import type { ToolSpec } from '../../tools/types';

export interface CoherenceResult {
  ok: boolean;
  error?: string;
}

export function checkEgressCredentialCoherence(
  spec: ToolSpec,
  catalogHostLookup: (id: string) => string | undefined,
): CoherenceResult {
  const creds = spec.credentials ?? [];
  if (creds.length === 0) return { ok: true };

  const allowedHosts = new Set<string>();
  for (const id of creds) {
    const host = catalogHostLookup(id);
    if (!host) return { ok: false, error: `unknown credential catalog id: ${id}` };
    allowedHosts.add(host);
  }

  const egress = spec.allowedEgress ?? [];
  if (egress.length === 0) {
    return { ok: false, error: 'a credentialed tool must declare allowedEgress (no implicit open egress)' };
  }
  for (const rule of egress) {
    if (!allowedHosts.has(rule.host)) {
      return { ok: false, error: `egress host ${rule.host} is not among credential hosts [${[...allowedHosts].join(', ')}]` };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/k8s/egress/coherence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/egress/coherence.ts src/k8s/egress/coherence.test.ts
git commit -m "feat(egress): enforce allowedEgress ⊆ credential catalog hosts"
```

---

## Task 4: Substrate detection

**Files:**
- Create: `src/k8s/egress/substrate.ts`
- Test: `src/k8s/egress/substrate.test.ts`

**Interfaces:**
- Consumes: `getInjectionMode` (`src/credential-injection/mode.ts`); env `CILIUM_NETWORK_POLICY_ENABLED`.
- Produces:
  - `type EgressSubstrate = 'cilium' | 'istio' | 'none'`
  - `function detectEgressSubstrate(env?: NodeJS.ProcessEnv): EgressSubstrate`
  - `function hasHardEgressEnforcement(env?: NodeJS.ProcessEnv): boolean` (true iff `cilium` or `istio`) — Phase 3 reads this to hard-gate discovery.

- [ ] **Step 1: Write the failing test**

```typescript
import { detectEgressSubstrate, hasHardEgressEnforcement } from './substrate';

describe('egress substrate detection', () => {
  it('prefers cilium when enabled', () => {
    expect(detectEgressSubstrate({ CILIUM_NETWORK_POLICY_ENABLED: 'true', CREDENTIAL_INJECTION_MODE: 'sidecar' })).toBe('cilium');
  });
  it('falls back to istio when in istio mode without cilium', () => {
    expect(detectEgressSubstrate({ CREDENTIAL_INJECTION_MODE: 'istio' })).toBe('istio');
  });
  it('is none otherwise', () => {
    expect(detectEgressSubstrate({ CREDENTIAL_INJECTION_MODE: 'sidecar' })).toBe('none');
    expect(hasHardEgressEnforcement({ CREDENTIAL_INJECTION_MODE: 'off' })).toBe(false);
  });
  it('reports hard enforcement for cilium and istio', () => {
    expect(hasHardEgressEnforcement({ CILIUM_NETWORK_POLICY_ENABLED: 'true' })).toBe(true);
    expect(hasHardEgressEnforcement({ CREDENTIAL_INJECTION_MODE: 'istio' })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/k8s/egress/substrate.test.ts`
Expected: FAIL — cannot find module `./substrate`.

- [ ] **Step 3: Implement**

```typescript
export type EgressSubstrate = 'cilium' | 'istio' | 'none';

export function detectEgressSubstrate(env: NodeJS.ProcessEnv = process.env): EgressSubstrate {
  if (env.CILIUM_NETWORK_POLICY_ENABLED === 'true') return 'cilium';
  if ((env.CREDENTIAL_INJECTION_MODE ?? 'off') === 'istio') return 'istio';
  return 'none';
}

export function hasHardEgressEnforcement(env: NodeJS.ProcessEnv = process.env): boolean {
  return detectEgressSubstrate(env) !== 'none';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/k8s/egress/substrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/egress/substrate.ts src/k8s/egress/substrate.test.ts
git commit -m "feat(egress): runtime substrate detection (cilium/istio/none)"
```

---

## Task 5: Cilium per-pod policy builder

**Files:**
- Create: `src/k8s/egress/cilium-policy.ts`
- Test: `src/k8s/egress/cilium-policy.test.ts`

**Interfaces:**
- Consumes: `EgressRule`.
- Produces:
  - `function buildCiliumEgressPolicy(args: { name: string; namespace: string; jobLabel: string; allowedEgress: EgressRule[]; redisNamespace: string }): object` — returns a `CiliumNetworkPolicy` object selecting `kubeclaw/agent-job: <jobLabel>`, allowing DNS (kube-dns) + Redis + each `toFQDNs` host on its ports (default [443]). An empty `allowedEgress` yields DNS+Redis only (no external egress).

- [ ] **Step 1: Write the failing test**

```typescript
import { buildCiliumEgressPolicy } from './cilium-policy';

describe('buildCiliumEgressPolicy', () => {
  const base = { name: 'egress-job1', namespace: 'kubeclaw', jobLabel: 'job1', redisNamespace: 'kubeclaw' };

  it('renders toFQDNs for each allowed host', () => {
    const p: any = buildCiliumEgressPolicy({ ...base, allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }] });
    expect(p.kind).toBe('CiliumNetworkPolicy');
    expect(p.spec.endpointSelector.matchLabels['kubeclaw/agent-job']).toBe('job1');
    const fqdnRule = p.spec.egress.find((e: any) => e.toFQDNs);
    expect(fqdnRule.toFQDNs).toContainEqual({ matchName: 'api.search.brave.com' });
  });

  it('omits any toFQDNs rule when allowedEgress is empty (DNS+Redis only)', () => {
    const p: any = buildCiliumEgressPolicy({ ...base, allowedEgress: [] });
    expect(p.spec.egress.some((e: any) => e.toFQDNs)).toBe(false);
    // DNS + Redis still present
    expect(p.spec.egress.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/k8s/egress/cilium-policy.test.ts`
Expected: FAIL — cannot find module `./cilium-policy`.

- [ ] **Step 3: Implement** (mirror the structure in `helm/kubeclaw/templates/cilium-network-policies.yaml:150-204`)

```typescript
import type { EgressRule } from '../../tools/types';

export function buildCiliumEgressPolicy(args: {
  name: string;
  namespace: string;
  jobLabel: string;
  allowedEgress: EgressRule[];
  redisNamespace: string;
}): object {
  const egress: object[] = [
    {
      toEndpoints: [
        { matchLabels: { 'k8s:io.kubernetes.pod.namespace': 'kube-system', 'k8s-app': 'kube-dns' } },
      ],
      toPorts: [{ ports: [{ port: '53', protocol: 'UDP' }, { port: '53', protocol: 'TCP' }] }],
    },
    {
      toEndpoints: [
        { matchLabels: { 'k8s:io.kubernetes.pod.namespace': args.redisNamespace, app: 'kubeclaw-redis' } },
      ],
      toPorts: [{ ports: [{ port: '6379', protocol: 'TCP' }] }],
    },
  ];

  if (args.allowedEgress.length > 0) {
    const ports = new Set<number>();
    for (const r of args.allowedEgress) for (const p of r.ports ?? [443]) ports.add(p);
    egress.push({
      toFQDNs: args.allowedEgress.map((r) => ({ matchName: r.host })),
      toPorts: [{ ports: [...ports].map((p) => ({ port: String(p), protocol: 'TCP' })) }],
    });
  }

  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: { name: args.name, namespace: args.namespace },
    spec: {
      endpointSelector: { matchLabels: { 'kubeclaw/agent-job': args.jobLabel } },
      egress,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/k8s/egress/cilium-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/egress/cilium-policy.ts src/k8s/egress/cilium-policy.test.ts
git commit -m "feat(egress): per-pod Cilium toFQDNs policy builder"
```

---

## Task 6: Istio per-pod policy builder

**Files:**
- Create: `src/k8s/egress/istio-policy.ts`
- Test: `src/k8s/egress/istio-policy.test.ts`

**Interfaces:**
- Consumes: `EgressRule`.
- Produces:
  - `function buildIstioEgressObjects(args: { name: string; namespace: string; jobLabel: string; allowedEgress: EgressRule[] }): object[]` — returns a per-pod `Sidecar` (workloadSelector on `kubeclaw/agent-job`, egress restricted to in-namespace + the declared hosts) plus one `ServiceEntry` per host. Empty `allowedEgress` → only the `Sidecar` restricting to in-namespace (no external hosts).

- [ ] **Step 1: Write the failing test**

```typescript
import { buildIstioEgressObjects } from './istio-policy';

describe('buildIstioEgressObjects', () => {
  it('creates a Sidecar and a ServiceEntry per host', () => {
    const objs: any[] = buildIstioEgressObjects({
      name: 'job1', namespace: 'kubeclaw', jobLabel: 'job1',
      allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
    });
    const sidecar = objs.find((o) => o.kind === 'Sidecar');
    const se = objs.find((o) => o.kind === 'ServiceEntry');
    expect(sidecar.spec.workloadSelector.labels['kubeclaw/agent-job']).toBe('job1');
    expect(se.spec.hosts).toContain('api.search.brave.com');
  });

  it('creates only a Sidecar (in-namespace only) when egress is empty', () => {
    const objs: any[] = buildIstioEgressObjects({ name: 'j', namespace: 'kubeclaw', jobLabel: 'j', allowedEgress: [] });
    expect(objs.filter((o) => o.kind === 'ServiceEntry')).toHaveLength(0);
    expect(objs.find((o) => o.kind === 'Sidecar').spec.egress[0].hosts).toContain('./*');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/k8s/egress/istio-policy.test.ts`
Expected: FAIL — cannot find module `./istio-policy`.

- [ ] **Step 3: Implement** (mirror `istio-serviceentries.yaml` + `istio-sidecar.yaml`)

```typescript
import type { EgressRule } from '../../tools/types';

export function buildIstioEgressObjects(args: {
  name: string;
  namespace: string;
  jobLabel: string;
  allowedEgress: EgressRule[];
}): object[] {
  const hostsForSidecar = ['./*', 'istio-system/*', ...args.allowedEgress.map((r) => `${args.namespace}/${r.host}`)];

  const sidecar = {
    apiVersion: 'networking.istio.io/v1',
    kind: 'Sidecar',
    metadata: { name: `${args.name}-egress`, namespace: args.namespace },
    spec: {
      workloadSelector: { labels: { 'kubeclaw/agent-job': args.jobLabel } },
      egress: [{ hosts: hostsForSidecar }],
    },
  };

  const serviceEntries = args.allowedEgress.map((r) => ({
    apiVersion: 'networking.istio.io/v1',
    kind: 'ServiceEntry',
    metadata: { name: `${args.name}-${r.host.replace(/\./g, '-')}`, namespace: args.namespace },
    spec: {
      hosts: [r.host],
      ports: (r.ports ?? [443]).map((p) => ({ number: p, name: `tls-${p}`, protocol: 'TLS' })),
      location: 'MESH_EXTERNAL',
      resolution: 'DNS',
    },
  }));

  return [sidecar, ...serviceEntries];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/k8s/egress/istio-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/egress/istio-policy.ts src/k8s/egress/istio-policy.test.ts
git commit -m "feat(egress): per-pod Istio Sidecar + ServiceEntry builder"
```

---

## Task 7: Hardened securityContext defaults

**Files:**
- Create: `src/k8s/security-context.ts`
- Test: `src/k8s/security-context.test.ts`

**Interfaces:**
- Produces:
  - `function hardenedPodSecurityContext(): object` → `{ runAsNonRoot: true, runAsUser: 65534, fsGroup: 2000, fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' } }`
  - `function hardenedContainerSecurityContext(): object` → `{ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } }`

> Keeps the existing `fsGroup: 2000` (so `/shared` stays group-writable, `src/k8s/job-runner.ts:1928`) and adds the missing hardening the broker/orchestrator already use.

- [ ] **Step 1: Write the failing test**

```typescript
import { hardenedPodSecurityContext, hardenedContainerSecurityContext } from './security-context';

describe('hardened securityContext', () => {
  it('pod context requires non-root and keeps fsGroup 2000', () => {
    const ctx: any = hardenedPodSecurityContext();
    expect(ctx.runAsNonRoot).toBe(true);
    expect(ctx.fsGroup).toBe(2000);
    expect(ctx.seccompProfile.type).toBe('RuntimeDefault');
  });
  it('container context drops all caps and is read-only root', () => {
    const ctx: any = hardenedContainerSecurityContext();
    expect(ctx.allowPrivilegeEscalation).toBe(false);
    expect(ctx.readOnlyRootFilesystem).toBe(true);
    expect(ctx.capabilities.drop).toEqual(['ALL']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/k8s/security-context.test.ts`
Expected: FAIL — cannot find module `./security-context`.

- [ ] **Step 3: Implement**

```typescript
export function hardenedPodSecurityContext(): object {
  return {
    runAsNonRoot: true,
    runAsUser: 65534,
    fsGroup: 2000,
    fsGroupChangePolicy: 'OnRootMismatch',
    seccompProfile: { type: 'RuntimeDefault' },
  };
}

export function hardenedContainerSecurityContext(): object {
  return {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/k8s/security-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/security-context.ts src/k8s/security-context.test.ts
git commit -m "feat(k8s): hardened securityContext defaults for tool pods"
```

---

## Task 8: Egress apply/teardown via the k8s client

**Files:**
- Create: `src/k8s/egress/apply.ts`
- Test: `src/k8s/egress/apply.test.ts`

**Interfaces:**
- Consumes: `buildCiliumEgressPolicy` (Task 5); `buildIstioEgressObjects` (Task 6); `detectEgressSubstrate` (Task 4); a `CustomObjectsApi`-like client (injected for tests).
- Produces:
  - `interface EgressApplier { applyForJob(args: { jobName: string; jobLabel: string; namespace: string; allowedEgress: EgressRule[] }): Promise<void>; deleteForJob(args: { jobName: string; namespace: string }): Promise<void> }`
  - `function makeEgressApplier(deps: { substrate: EgressSubstrate; customObjects: CustomObjectsClient; redisNamespace: string }): EgressApplier`

`CustomObjectsClient` is the minimal interface this module needs:
```typescript
export interface CustomObjectsClient {
  create(group: string, version: string, namespace: string, plural: string, body: object): Promise<void>;
  delete(group: string, version: string, namespace: string, plural: string, name: string): Promise<void>;
}
```

- [ ] **Step 1: Write the failing test**

```typescript
import { makeEgressApplier, type CustomObjectsClient } from './apply';

function fakeClient(): { client: CustomObjectsClient; created: any[]; deleted: any[] } {
  const created: any[] = [];
  const deleted: any[] = [];
  return {
    created, deleted,
    client: {
      create: async (g, v, ns, plural, body) => { created.push({ g, v, plural, body }); },
      delete: async (g, v, ns, plural, name) => { deleted.push({ plural, name }); },
    },
  };
}

describe('egress applier', () => {
  it('creates a CiliumNetworkPolicy under the cilium substrate', async () => {
    const f = fakeClient();
    const applier = makeEgressApplier({ substrate: 'cilium', customObjects: f.client, redisNamespace: 'kubeclaw' });
    await applier.applyForJob({ jobName: 'j1', jobLabel: 'j1', namespace: 'kubeclaw', allowedEgress: [{ host: 'api.search.brave.com' }] });
    expect(f.created).toHaveLength(1);
    expect(f.created[0].plural).toBe('ciliumnetworkpolicies');
  });

  it('creates Sidecar + ServiceEntry under the istio substrate', async () => {
    const f = fakeClient();
    const applier = makeEgressApplier({ substrate: 'istio', customObjects: f.client, redisNamespace: 'kubeclaw' });
    await applier.applyForJob({ jobName: 'j1', jobLabel: 'j1', namespace: 'kubeclaw', allowedEgress: [{ host: 'api.openai.com' }] });
    const plurals = f.created.map((c) => c.plural).sort();
    expect(plurals).toEqual(['serviceentries', 'sidecars']);
  });

  it('is a no-op create under the none substrate', async () => {
    const f = fakeClient();
    const applier = makeEgressApplier({ substrate: 'none', customObjects: f.client, redisNamespace: 'kubeclaw' });
    await applier.applyForJob({ jobName: 'j1', jobLabel: 'j1', namespace: 'kubeclaw', allowedEgress: [{ host: 'h.example.com' }] });
    expect(f.created).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/k8s/egress/apply.test.ts`
Expected: FAIL — cannot find module `./apply`.

- [ ] **Step 3: Implement**

```typescript
import type { EgressRule } from '../../tools/types';
import type { EgressSubstrate } from './substrate';
import { buildCiliumEgressPolicy } from './cilium-policy';
import { buildIstioEgressObjects } from './istio-policy';

export interface CustomObjectsClient {
  create(group: string, version: string, namespace: string, plural: string, body: object): Promise<void>;
  delete(group: string, version: string, namespace: string, plural: string, name: string): Promise<void>;
}

export interface EgressApplier {
  applyForJob(args: { jobName: string; jobLabel: string; namespace: string; allowedEgress: EgressRule[] }): Promise<void>;
  deleteForJob(args: { jobName: string; namespace: string }): Promise<void>;
}

const CILIUM = { group: 'cilium.io', version: 'v2', plural: 'ciliumnetworkpolicies' };
const ISTIO = { group: 'networking.istio.io', version: 'v1' };

export function makeEgressApplier(deps: {
  substrate: EgressSubstrate;
  customObjects: CustomObjectsClient;
  redisNamespace: string;
}): EgressApplier {
  return {
    async applyForJob({ jobName, jobLabel, namespace, allowedEgress }) {
      if (deps.substrate === 'cilium') {
        const policy = buildCiliumEgressPolicy({
          name: `egress-${jobName}`, namespace, jobLabel, allowedEgress, redisNamespace: deps.redisNamespace,
        });
        await deps.customObjects.create(CILIUM.group, CILIUM.version, namespace, CILIUM.plural, policy);
      } else if (deps.substrate === 'istio') {
        const objs = buildIstioEgressObjects({ name: `egress-${jobName}`, namespace, jobLabel, allowedEgress });
        for (const o of objs) {
          const plural = (o as { kind: string }).kind === 'Sidecar' ? 'sidecars' : 'serviceentries';
          await deps.customObjects.create(ISTIO.group, ISTIO.version, namespace, plural, o);
        }
      }
      // 'none': no hard substrate; nothing to create here (vetted-tier best-effort handled by Helm NetworkPolicy).
    },

    async deleteForJob({ jobName, namespace }) {
      const name = `egress-${jobName}`;
      try {
        if (deps.substrate === 'cilium') {
          await deps.customObjects.delete(CILIUM.group, CILIUM.version, namespace, CILIUM.plural, name);
        } else if (deps.substrate === 'istio') {
          await deps.customObjects.delete(ISTIO.group, ISTIO.version, namespace, 'sidecars', `${name}-egress`);
          // ServiceEntries are GC'd by ownerReference (set at create time in job-runner); see Task 9.
        }
      } catch {
        // best-effort teardown; pod-scoped policies are harmless if they linger briefly
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/k8s/egress/apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/egress/apply.ts src/k8s/egress/apply.test.ts
git commit -m "feat(egress): substrate-aware per-job egress applier"
```

---

## Task 9: Wire hardening + egress into `createSidecarToolPodJob`

**Files:**
- Modify: `src/k8s/job-runner.ts` (`createSidecarToolPodJob`, ~1620-1995)
- Test: `src/k8s/job-runner.egress.test.ts` (drive the spec-building path; assert securityContext + that the applier is invoked with the tool's `allowedEgress`)

**Interfaces:**
- Consumes: `hardenedPodSecurityContext`/`hardenedContainerSecurityContext` (Task 7); an injected `EgressApplier` (Task 8). Set `ownerReferences` on egress objects to the Job so Kubernetes GCs them when the Job is deleted (belt-and-suspenders with `deleteForJob`).

- [ ] **Step 1: Write the failing test** (factor the egress/securityContext wiring so it is testable; assert (a) pod template uses the hardened pod context, (b) the user-tool container uses the hardened container context, (c) `applier.applyForJob` is called with `spec.toolSpec.allowedEgress ?? []`)

```typescript
// Pseudocode shape — adapt to how job-runner exposes/accepts an injected applier in tests.
import { JobRunner } from './job-runner';
import type { ToolSpec } from '../tools/types';

it('applies hardened securityContext and per-pod egress for a sidecar tool job', async () => {
  const applied: any[] = [];
  const runner = new JobRunner(/* test deps */);
  runner.egressApplier = { applyForJob: async (a) => { applied.push(a); }, deleteForJob: async () => {} };
  const toolSpec: ToolSpec = {
    name: 'image_search', description: 'd', parameters: {}, image: 'i', pattern: 'http',
    credentials: ['brave-search'], allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
  };
  const built = await runner.buildSidecarToolPodJobForTest({ agentJobId: 'job1', groupFolder: 'g', toolName: 'image_search', toolSpec, timeout: 60000 });
  const podSpec = built.spec.template.spec;
  expect(podSpec.securityContext.runAsNonRoot).toBe(true);
  const userContainer = podSpec.containers.find((c: any) => c.name === 'user-tool');
  expect(userContainer.securityContext.readOnlyRootFilesystem).toBe(true);
  expect(applied[0].allowedEgress).toEqual([{ host: 'api.search.brave.com', ports: [443] }]);
});
```

> If `JobRunner` is not currently structured for injection, add a minimal seam: an `egressApplier` field defaulting to one built from `detectEgressSubstrate()` + the existing `CustomObjectsApi`, and a thin `buildSidecarToolPodJobForTest` wrapper exposing the manifest pre-create. Keep the change surgical.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/k8s/job-runner.egress.test.ts`
Expected: FAIL — hardened context / applier not wired.

- [ ] **Step 3: Implement the wiring**

In `createSidecarToolPodJob`:
1. Set the pod-level `securityContext` to `hardenedPodSecurityContext()` (replacing the current `{ fsGroup: 2000, fsGroupChangePolicy }` literal at ~1928).
2. Set the user-tool container's `securityContext` to `hardenedContainerSecurityContext()`.
3. After the Job is created (so its UID exists) — or by setting `ownerReferences` referencing the Job — call:

```typescript
await this.egressApplier.applyForJob({
  jobName,
  jobLabel: spec.agentJobId,
  namespace: this.namespace,
  allowedEgress: spec.toolSpec.allowedEgress ?? [],
});
```

4. In the Job's completion/cleanup path (where finished sidecar tool jobs are reaped), call `this.egressApplier.deleteForJob({ jobName, namespace: this.namespace })`.

> NOTE: hardening assumes the seeded library images run as non-root. The `kubeclaw/exiftool` and `kubeclaw/image-search` images built in Phase 1/3 MUST declare a non-root `USER`. Add that requirement to those Dockerfiles; if a discovered image cannot run non-root, the Phase 3 probe will fail it (correct behavior).

- [ ] **Step 4: Run test + full build**

Run: `npx vitest run src/k8s/job-runner.egress.test.ts && npm run build`
Expected: PASS and clean compile.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/job-runner.ts src/k8s/job-runner.egress.test.ts
git commit -m "feat(k8s): harden tool-pod securityContext + apply per-pod egress on spawn"
```

---

## Task 10: RBAC + coherence enforcement at registration

**Files:**
- Modify: `helm/kubeclaw/templates/rbac.yaml` (orchestrator role: manage Cilium/Istio CRDs)
- Modify: `src/skills/orchestrator/tool-registry.ts` `registerTool`/`editTool` — reject specs failing `checkEgressCredentialCoherence`
- Test: `src/skills/orchestrator/tool-registry.test.ts` (add coherence cases)

**Interfaces:**
- Consumes: `checkEgressCredentialCoherence` (Task 3). `registerTool`/`editTool` gain an optional `catalogHostLookup` parameter so coherence can be checked; when omitted, coherence is skipped (preserves existing callers/tests). The orchestrator passes a real lookup.

- [ ] **Step 1: Write the failing test**

```typescript
import { registerTool } from './tool-registry';
import { resetDbForTest } from '../../db';
import type { ToolSpec } from '../../tools/types';

const lookup = (id: string) => (id === 'brave-search' ? 'api.search.brave.com' : undefined);

describe('registerTool coherence', () => {
  beforeEach(() => resetDbForTest());

  it('rejects a credentialed tool whose egress escapes the credential host', () => {
    const spec: ToolSpec = {
      name: 'leaky', description: 'd', parameters: { type: 'object' }, image: 'i', pattern: 'http',
      credentials: ['brave-search'], allowedEgress: [{ host: 'evil.example.com' }],
    };
    const r = registerTool(spec, undefined, lookup);
    expect(r.ok).toBe(false);
  });

  it('accepts a coherent credentialed tool', () => {
    const spec: ToolSpec = {
      name: 'ok_tool', description: 'd', parameters: { type: 'object' }, image: 'i', pattern: 'http',
      credentials: ['brave-search'], allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
    };
    expect(registerTool(spec, undefined, lookup).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/skills/orchestrator/tool-registry.test.ts -t coherence`
Expected: FAIL — `registerTool` takes only 2 args / coherence not enforced.

- [ ] **Step 3: Implement** — extend `registerTool` (and `editTool`) signature and add the check after `validateTool`:

```typescript
import { checkEgressCredentialCoherence } from '../../k8s/egress/coherence';

export function registerTool(
  t: ToolSpec,
  reconcile?: ReconcileFn,
  catalogHostLookup?: (id: string) => string | undefined,
): Result {
  const v = validateTool(t);
  if (!v.ok) return v;
  if (catalogHostLookup) {
    const c = checkEgressCredentialCoherence(t, catalogHostLookup);
    if (!c.ok) return { ok: false, error: c.error ?? 'egress/credential coherence failed' };
  }
  // ... existing insert + reconcile ...
}
```

Update the TSA (`src/tool-selection/agent.ts`) and the approval finalizer to pass `deps.catalogHostLookup` into `registerTool`.

- [ ] **Step 4: Add RBAC** in `helm/kubeclaw/templates/rbac.yaml` (orchestrator ClusterRole/Role rules):

```yaml
- apiGroups: ["cilium.io"]
  resources: ["ciliumnetworkpolicies"]
  verbs: ["create", "delete", "get", "list"]
- apiGroups: ["networking.istio.io"]
  resources: ["serviceentries", "sidecars"]
  verbs: ["create", "delete", "get", "list"]
```

- [ ] **Step 5: Run tests + build + helm lint**

Run: `npx vitest run src/skills/orchestrator/tool-registry.test.ts && npm run build && helm lint helm/kubeclaw`
Expected: PASS, clean compile, helm lint OK.

- [ ] **Step 6: Commit**

```bash
git add src/skills/orchestrator/tool-registry.ts src/tool-selection/agent.ts helm/kubeclaw/templates/rbac.yaml src/skills/orchestrator/tool-registry.test.ts
git commit -m "feat(egress): enforce coherence at registration + grant CRD RBAC"
```

---

## Task 11: Integration test — egress object created for a credentialed tool

**Files:**
- Create: `src/k8s/egress/integration.test.ts`

**Interfaces:**
- Consumes: `makeEgressApplier` + a fake `CustomObjectsClient`; `buildCiliumEgressPolicy`.

- [ ] **Step 1: Write the integration test**

```typescript
import { makeEgressApplier, type CustomObjectsClient } from './apply';

it('cilium: credentialed image_search yields a toFQDNs policy for exactly its host', async () => {
  const created: any[] = [];
  const client: CustomObjectsClient = {
    create: async (_g, _v, _ns, plural, body) => { created.push({ plural, body }); },
    delete: async () => {},
  };
  const applier = makeEgressApplier({ substrate: 'cilium', customObjects: client, redisNamespace: 'kubeclaw' });
  await applier.applyForJob({
    jobName: 'job-xyz', jobLabel: 'job-xyz', namespace: 'kubeclaw',
    allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
  });
  const policy = created[0].body;
  const fqdn = policy.spec.egress.find((e: any) => e.toFQDNs);
  expect(fqdn.toFQDNs).toEqual([{ matchName: 'api.search.brave.com' }]);
  expect(policy.spec.egress.some((e: any) => e.toFQDNs?.some((f: any) => f.matchName !== 'api.search.brave.com'))).toBe(false);
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/k8s/egress/integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/k8s/egress/integration.test.ts
git commit -m "test(egress): integration test for per-tool FQDN allowlist rendering"
```

---

## Task 12: E2E — hardened tier-2 cat workflow (minikube/CI)

**Files:**
- Create/extend: the repo's e2e suite (match existing `test:e2e` / minikube harness)

**Interfaces:** exercises the full Phase 1 + Phase 2 path.

- [ ] **Step 1: Write the e2e** — on a minikube with Cilium enabled (or Istio mode), through a channel:
  1. User asks the assistant to fetch a cat photo and extract its metadata.
  2. `find_tools("extract EXIF metadata...")` → activates `extract_metadata` (no credentials → autonomous, `allowedEgress: []`).
  3. Assert the tool pod runs with `runAsNonRoot` and a per-pod egress policy exists with NO `toFQDNs` (EXIF needs no external egress).
  4. `find_tools("search the web for a cat image and download it")` → `pending_credential` for `brave-search`; simulate user approval → `approve_tool_credential` → tool activated with a `toFQDNs` policy for `api.search.brave.com` only.
  5. Assert the downloaded file lands in the group PVC and the metadata is reported.

- [ ] **Step 2: Run it** (CI / 8Gi minikube — NOT the dev host, per the live-e2e memory constraint)

Run: `npm run test:e2e -- --grep 'dynamic tool selection'` (match the actual e2e invocation)
Expected: PASS on CI.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/
git commit -m "test(e2e): hardened tier-2 dynamic-tool-selection cat workflow"
```

> **Completion report must state** whether the e2e ran on CI/8Gi minikube or was only authored (the dev host cannot run live e2e). Do not claim e2e pass without the CI run output.

---

## Self-Review Notes (addressed)

- **Spec coverage:** per-tool `allowedEgress` (Tasks 2,5,6), default-deny via empty allowlist (Tasks 5,6 tests), egress↔credential coherence (Tasks 3,10), substrate-agnostic rendering (Tasks 4,8), securityContext hardening (Tasks 7,9), dead-label fix (Task 1), `hasHardEgressEnforcement` exported for Phase 3's hard-gate (Task 4). Tier-3 discovery itself is Phase 3.
- **Type consistency:** `EgressRule` defined once in `src/tools/types.ts` and imported everywhere; `EgressSubstrate`, `CustomObjectsClient`, `EgressApplier` defined once; `registerTool` third-param `catalogHostLookup` matches Phase 1's `catalogHostLookup` shape (`(id: string) => string | undefined`).
- **Placeholders:** none — code complete. Two seams (`JobRunner` test injection, e2e harness invocation) are described as surgical adaptations to existing structure, not deferred work.
